import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { makeUpstream } from '../src/app.mjs'
import { PublicError } from '../src/core.mjs'

const origin = 'https://fixture.example'
const cookie = 'cpr_session=private-fixture-session'
const publicMessage = '502: Codex Proxy 接口请求失败，请检查服务和登录状态'

async function fixture(t, outcomes, options = {}) {
  const requests = []
  const timers = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, cookie: request.headers.cookie, origin: request.headers.origin, time: performance.now() })
    request.resume()
    const outcome = outcomes[Math.min(requests.length - 1, outcomes.length - 1)]
    if (outcome === 'disconnect') {
      request.socket.destroy()
      return
    }
    const status = typeof outcome === 'number' ? outcome : outcome.status
    const body = JSON.stringify({ code: status, message: cookie, data: { authenticated: true } })
    const send = () => {
      if (response.destroyed) return
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
      if (outcome.delayBodyMs) {
        response.write(body.slice(0, Math.floor(body.length / 2)))
        timers.push(setTimeout(() => response.end(body.slice(Math.floor(body.length / 2))), outcome.delayBodyMs))
      } else response.end(body)
    }
    if (outcome.delayHeadersMs) timers.push(setTimeout(send, outcome.delayHeadersMs))
    else send()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    for (const timer of timers) clearTimeout(timer)
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return { requests, upstream: makeUpstream(`http://127.0.0.1:${server.address().port}`, origin, { retryDelayMs: 5, ...options }) }
}

function safeError(error, status = 502) {
  assert.ok(error instanceof PublicError)
  assert.equal(error.statusCode, status)
  assert.equal(error.message, publicMessage.replace(/^502/, String(status)))
  assert.ok(!JSON.stringify(error).includes(cookie))
  assert.equal(error.cause, undefined)
  return true
}

for (const status of [502, 503, 504]) {
  test(`GET recovers after a transient HTTP ${status} response`, async t => {
    const { requests, upstream } = await fixture(t, [status, 200])
    assert.deepEqual(await upstream('/api/auth/status', cookie), { authenticated: true })
    assert.equal(requests.length, 2)
    assert.deepEqual(requests.map(({ method, path, cookie: session, origin: source }) => ({ method, path, session, source })), [1, 2].map(() => ({ method: 'GET', path: '/api/auth/status', session: cookie, source: origin })))
  })
}

test('GET recovers after a transient connection reset', async t => {
  const { requests, upstream } = await fixture(t, ['disconnect', 200])
  assert.deepEqual(await upstream('/api/admin/accounts?page=1&pageSize=100', cookie), { authenticated: true })
  assert.equal(requests.length, 2)
})

test('GET stops after three HTTP attempts and waits longer before the third', async t => {
  const { requests, upstream } = await fixture(t, [503])
  await assert.rejects(upstream('/api/auth/status', cookie), safeError)
  assert.equal(requests.length, 3)
  assert.ok(requests[1].time - requests[0].time >= 4)
  assert.ok(requests[2].time - requests[1].time >= 9)
})

test('GET stops after three connection resets with a stable public error', async t => {
  const { requests, upstream } = await fixture(t, ['disconnect'])
  await assert.rejects(upstream('/api/auth/status', cookie), safeError)
  assert.equal(requests.length, 3)
})

for (const status of [401, 403, 404, 422, 429, 500]) {
  test(`GET does not retry HTTP ${status}`, async t => {
    const { requests, upstream } = await fixture(t, [status, 200])
    await assert.rejects(upstream('/api/auth/status', cookie), error => safeError(error, [401, 403, 404].includes(status) ? status : 502))
    assert.equal(requests.length, 1)
  })
}

for (const path of ['/api/admin/accounts/oauth/start', '/api/admin/accounts/oauth/complete']) {
  test(`POST ${path} is never repeated after HTTP 503`, async t => {
    const { requests, upstream } = await fixture(t, [503, 200])
    await assert.rejects(upstream(path, cookie, { state: 'fixture-state', password: 'private-fixture-password' }), safeError)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
  })
}

test('POST is never repeated after a connection reset', async t => {
  const { requests, upstream } = await fixture(t, ['disconnect', 200])
  await assert.rejects(upstream('/api/admin/accounts/oauth/complete', cookie, { code: 'private-fixture-code' }), safeError)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
})

for (const delayPhase of ['delayHeadersMs', 'delayBodyMs']) {
  test(`GET retries a slow ${delayPhase} response after the attempt timeout`, async t => {
    const { requests, upstream } = await fixture(t, [{ status: 200, [delayPhase]: 250 }, 200], { requestTimeoutMs: 300, attemptTimeoutMs: 40 })
    assert.deepEqual(await upstream('/api/auth/status', cookie), { authenticated: true })
    assert.equal(requests.length, 2)
  })

  test(`GET shares one total deadline across slow ${delayPhase} attempts`, async t => {
    const { requests, upstream } = await fixture(t, [{ status: 200, [delayPhase]: 250 }], { requestTimeoutMs: 90, attemptTimeoutMs: 50 })
    const started = performance.now()
    await assert.rejects(upstream('/api/auth/status', cookie), safeError)
    const elapsed = performance.now() - started
    assert.ok(elapsed >= 75)
    assert.ok(elapsed < 180)
    assert.equal(requests.length, 2)
  })
}

test('GET cancels backoff when the total deadline expires without starting another attempt', async t => {
  const { requests, upstream } = await fixture(t, [503, 200], { requestTimeoutMs: 50, attemptTimeoutMs: 40, retryDelayMs: 250 })
  const started = performance.now()
  await assert.rejects(upstream('/api/auth/status', cookie), safeError)
  const elapsed = performance.now() - started
  assert.equal(requests.length, 1)
  assert.ok(elapsed >= 40)
  assert.ok(elapsed < 150)
})

test('POST retains its single 30-second attempt independent of GET timeout options', async t => {
  const { requests, upstream } = await fixture(t, [{ status: 200, delayBodyMs: 80 }], { requestTimeoutMs: 20, attemptTimeoutMs: 10 })
  assert.deepEqual(await upstream('/api/admin/accounts/oauth/complete', cookie, { code: 'fixture-code' }), { authenticated: true })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
})
