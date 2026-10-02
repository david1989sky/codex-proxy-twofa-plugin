import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const dist = process.env.UI_DIST || fileURLToPath(new URL('../../frontend/dist/', import.meta.url))
const output = process.env.UI_SCREENSHOTS || '/tmp/cpr-twofa-ui-verification'

test('plugin UI coalesces refreshes and shows operation feedback', async t => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://local').pathname
    const file = path === '/' ? 'index.html' : path.slice(1)
    try {
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
      res.end(await readFile(`${dist}/${file}`))
    }
    catch {
      res.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, reducedMotion: 'reduce' })
  t.after(() => page.close())
  const calls = []
  await page.exposeFunction('recordPluginRequest', input => {
    calls.push(input)
  })
  await page.addInitScript(({ accountData }) => {
    window.codexProxyPlugin = {
      version: 2,
      request: async input => {
        window.recordPluginRequest(input)
        if (input.method === 'GET' && input.path === 'api/status') return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ ready: true, workerImageDigest: 'fixture', legacyVaultMounted: true })).buffer }
        if (input.method === 'GET' && input.path === 'api/migration') return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ legacyVaultMounted: true, imported: true })).buffer }
        if (input.method === 'GET' && input.path === 'api/accounts') {
          await window.__accountsReady
          return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(accountData)).buffer }
        }
        if (input.method === 'POST' && input.path === 'api/request') {
          const body = JSON.parse(input.body)
          if (body.operation === 'startTask') {
            if (window.__startReady) await window.__startReady
            return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ id: 'fixture-task', running: true, cancelled: false, items: [{ id: 'one', email: 'task@example.com', status: 'login', attempts: 1 }] })).buffer }
          }
          if (body.operation === 'getTask') {
            const stage = window.__taskStage || 'password'
            if (window.__pollReady) await window.__pollReady
            return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ id: 'fixture-task', running: true, cancelled: false, items: [{ id: 'one', email: 'task@example.com', status: stage, attempts: 1 }] })).buffer }
          }
          if (body.operation === 'getScreen') {
            const canvas = document.createElement('canvas')
            canvas.width = 1024
            canvas.height = 768
            const context = canvas.getContext('2d')
            context.fillStyle = window.__screenColor || '#ffffff'
            context.fillRect(0, 0, 1024, 768)
            return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ image: canvas.toDataURL('image/png') })).buffer }
          }
          if (body.operation === 'sendInput') {
            return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ accepted: true })).buffer }
          }
          if (body.operation === 'cancelTask') {
            if (window.__cancelReady) await window.__cancelReady
            return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ id: 'fixture-task', running: false, cancelled: true, items: [{ id: 'one', email: 'task@example.com', status: 'cancelled', attempts: 1 }] })).buffer }
          }
        }
        return { status: 400, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ error: { message: 'fixture request' } })).buffer }
      },
    }
    window.__accountsReady = new Promise(resolve => { window.__releaseAccounts = resolve })
  }, { accountData: { items: [
    { id: 'fixture', email: 'fixture@example.com', status: 'normal', saved: true, needsReauth: false },
    { id: 'reauthorize', email: 'reauthorize@example.com', status: 'error', errorReason: 'credential_revoked', saved: true, needsReauth: true },
  ] } })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)

  const refresh = page.locator('button').filter({ hasText: /刷新账号|刷新中/ }).first()
  await refresh.waitFor()
  await page.evaluate(() => window.__releaseAccounts())
  await page.getByText('fixture@example.com', { exact: true }).waitFor()
  await page.getByRole('button', { name: '一键重新授权', exact: true }).waitFor()
  const accountCallsBefore = calls.filter(call => call.path === 'api/accounts').length

  await page.evaluate(() => {
    window.__accountsReady = new Promise(resolve => { window.__releaseAccounts = resolve })
  })
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent?.includes('刷新账号'))
    button?.click()
    button?.click()
  })
  await page.getByRole('button', { name: '刷新中…' }).waitFor()
  assert.equal(calls.filter(call => call.path === 'api/accounts').length, accountCallsBefore + 1)
  await page.evaluate(() => window.__releaseAccounts())
  await page.getByText('fixture@example.com', { exact: true }).waitFor()
  assert.equal(calls.filter(call => call.path === 'api/accounts').length, accountCallsBefore + 1)

  await page.getByLabel('账号列表').fill('fixture@example.com----fixture-password----JBSWY3DPEHPK3PXP')
  await page.evaluate(() => { window.__startReady = new Promise(resolve => { window.__releaseStart = resolve }) })
  await page.getByRole('button', { name: '开始授权登录' }).click()
  await page.getByRole('button', { name: '启动中…' }).waitFor()
  assert.equal(await page.locator('.cp-spin').count() > 0, true)
  assert.equal(await page.locator('.cp-spin').first().evaluate(node => getComputedStyle(node).animationName), 'none')
  await page.evaluate(() => window.__releaseStart())
  await page.getByText('task@example.com', { exact: true }).waitFor()

  await t.test('refresh preserves the table and its horizontal scroll position', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => {
      window.__tableContainer = document.querySelector('table').parentElement
      window.__tableContainer.scrollLeft = 100
      window.__accountsReady = new Promise(resolve => { window.__releaseAccounts = resolve })
    })
    await page.getByRole('button', { name: '刷新账号', exact: true }).click()
    await page.getByRole('button', { name: '刷新中…' }).waitFor()
    await page.evaluate(() => window.__releaseAccounts())
    await page.getByRole('button', { name: '刷新账号', exact: true }).waitFor()
    await page.waitForTimeout(240)
    assert.equal(await page.evaluate(() => window.__tableContainer.isConnected), true)
    assert.equal(await page.evaluate(() => window.__tableContainer.scrollLeft), 100)
  })

  await t.test('a task stage change keeps one row mounted', async () => {
    const rows = page.getByText('task@example.com', { exact: true })
    await page.getByText('验证密码', { exact: true }).waitFor()
    assert.equal(await rows.count(), 1)
    await mkdir(output, { recursive: true })
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: `${output}/operations-${width}.png`, fullPage: true })
    }
  })

  await t.test('updating a manual screenshot preserves its clickable image', async () => {
    await page.evaluate(() => { window.__taskStage = 'waiting' })
    const image = page.getByAltText('等待人工验证的浏览器画面')
    await image.waitFor()
    await page.evaluate(() => {
      window.__screenNode = document.querySelector('img')
      window.__screenSource = window.__screenNode.src
      window.__screenColor = '#22aa55'
    })
    await page.waitForFunction(() => document.querySelector('img')?.src !== window.__screenSource)
    assert.equal(await page.evaluate(() => document.querySelector('img') === window.__screenNode), true)
    await image.click()
    await page.getByText('人工操作已发送', { exact: true }).waitFor()
    const sent = calls.filter(call => call.body && JSON.parse(call.body).operation === 'sendInput')
    assert.equal(sent.length, 1)
    assert.equal(JSON.parse(sent[0].body).data.kind, 'click')
  })

  await t.test('cancel displays only the cancel loading state', async () => {
    await page.evaluate(() => { window.__pollReady = new Promise(resolve => { window.__releasePoll = resolve }) })
    const pollsBefore = calls.filter(call => call.body && JSON.parse(call.body).operation === 'getTask').length
    await page.waitForFunction(() => window.__pollReady !== undefined)
    for (let n = 0; n < 30 && calls.filter(call => call.body && JSON.parse(call.body).operation === 'getTask').length === pollsBefore; n++)
      await page.waitForTimeout(100)
    assert.ok(calls.filter(call => call.body && JSON.parse(call.body).operation === 'getTask').length > pollsBefore)
    await page.evaluate(() => { window.__cancelReady = new Promise(resolve => { window.__releaseCancel = resolve }) })
    await page.getByRole('button', { name: '取消任务', exact: true }).click()
    await page.getByRole('button', { name: '取消中…', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '启动中…', exact: true }).count(), 0)
    await page.evaluate(() => window.__releaseCancel())
    await page.getByRole('button', { name: '取消任务', exact: true }).waitFor()
    await page.evaluate(() => window.__releasePoll())
    await page.waitForTimeout(250)
    assert.equal(await page.getByText('已取消', { exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '取消任务', exact: true }).isDisabled(), true)
  })
})
