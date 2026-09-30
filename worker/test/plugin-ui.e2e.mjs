import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const dist = process.env.UI_DIST || fileURLToPath(new URL('../../frontend/dist/', import.meta.url))

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
            return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ id: 'fixture-task', running: false, cancelled: false, items: [] })).buffer }
          }
        }
        return { status: 400, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ error: { message: 'fixture request' } })).buffer }
      },
    }
    window.__accountsReady = new Promise(resolve => { window.__releaseAccounts = resolve })
  }, { accountData: { items: [{ id: 'fixture', email: 'fixture@example.com', status: 'normal', saved: true, needsReauth: false }] } })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)

  const refresh = page.locator('button').filter({ hasText: /刷新账号|刷新中/ }).first()
  await refresh.waitFor()
  await page.evaluate(() => window.__releaseAccounts())
  await page.getByText('fixture@example.com', { exact: true }).waitFor()
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
  await page.waitForTimeout(20)
})
