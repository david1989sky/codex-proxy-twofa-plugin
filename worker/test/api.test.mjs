import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.mjs'
import { PublicError } from '../src/core.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openVault } from '../src/vault.mjs'

const origin = 'https://fixture.example'
const prefix = '/api/admin/twofa'
const payload = { text: 'fixture@example.com----private-password----JBSWY3DPEHPK3PXP', submissionId: 'test', settings: { enabled: true, concurrencyLimit: null, weight: 1, groupIds: [] } }
const headers = { origin, cookie: 'cpr_session=admin', 'x-cpr-twofa': '1' }
const upstream = async (path, cookie) => {
  if (path === '/api/auth/status') return { authenticated: !!cookie, session: { role: cookie.includes('admin') ? 'admin' : 'key' } }
  return {}
}

test('saved account summaries are paginated, filtered, and credential-free', async t => {
  const accounts = [
    { id: 'invalid', email: 'invalid@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'error', errorReason: 'credential_invalid', errorMessage: 'private upstream error', updatedAt: '2026-09-30T00:00:00.000Z' },
    { id: 'expired', email: 'expired@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'error', errorReason: 'credential_expired', errorMessage: 'private upstream error', updatedAt: '2026-09-30T00:01:00.000Z' },
    { id: 'healthy', email: 'healthy@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'active', errorReason: null, errorMessage: null, updatedAt: '2026-09-30T00:02:00.000Z' },
    { id: 'revoked', email: 'revoked@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'error', errorReason: 'credential_revoked', errorMessage: 'private upstream error', updatedAt: '2026-09-30T00:03:00.000Z' },
    { id: 'unknown-error', email: 'unknown@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'error', errorReason: null, errorMessage: 'private upstream error', updatedAt: '2026-09-30T00:03:30.000Z' },
    { id: 'api-key', email: 'key@example.com', provider: 'openai', authenticationKind: 'api_key', status: 'active', updatedAt: '2026-09-30T00:04:00.000Z' },
    { id: 'xai', email: 'xai@example.com', provider: 'xai', authenticationKind: 'oauth', status: 'error', errorReason: 'credential_invalid', updatedAt: '2026-09-30T00:05:00.000Z' },
  ]
  const upstreamWithAccounts = async (path, cookie) => {
    if (path === '/api/auth/status') return upstream(path, cookie)
    if (path === '/api/admin/accounts?page=1&pageSize=100') return { items: accounts.slice(0, 3), page: { totalPages: 2 } }
    if (path === '/api/admin/accounts?page=2&pageSize=100') return { items: accounts.slice(3), page: { totalPages: 2 } }
    throw new Error(`unexpected upstream request: ${path}`)
  }
  const saved = new Set(['invalid', 'expired', 'revoked', 'unknown-error'])
  const app = await createApp({
    origin,
    upstream: upstreamWithAccounts,
    run: async () => ({}),
    vault: { get: async id => saved.has(id) ? { credentials: { email: `${id}@example.com`, password: 'private-password', totpSecret: 'PRIVATE-TOTP' }, updatedAt: `vault-${id}` } : null },
  })
  t.after(() => app.close())
  const response = await app.inject({ method: 'GET', url: `${prefix}/accounts`, headers })
  assert.equal(response.statusCode, 200)
  const items = response.json().data.items
  assert.deepEqual(items.map(item => item.id), ['invalid', 'expired', 'healthy', 'revoked', 'unknown-error'])
  assert.equal(items.find(item => item.id === 'invalid').needsReauth, true)
  assert.equal(items.find(item => item.id === 'expired').needsReauth, true)
  assert.equal(items.find(item => item.id === 'revoked').needsReauth, true)
  assert.equal(items.find(item => item.id === 'unknown-error').needsReauth, true)
  assert.equal(items.find(item => item.id === 'healthy').needsReauth, false)
  assert.equal(items.find(item => item.id === 'healthy').saved, false)
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ['email', 'errorReason', 'id', 'needsReauth', 'saved', 'status', 'updatedAt'].filter(key => item[key] !== undefined).sort())
  }
  assert.ok(!response.body.includes('private-password'))
  assert.ok(!response.body.includes('PRIVATE-TOTP'))
  assert.ok(!response.body.includes('private upstream error'))
  assert.ok(!response.body.includes('credential_revoked'))
})

test('target reauthorization HTTP 401 marks a normal RS account as needing reauthorization until explicit success', async t => {
  let attempts = 0
  const account = { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'active', errorReason: null, outboundProxyEndpoint: null }
  const record = {
    credentials: { email: account.email, password: 'private-password', totpSecret: 'JBSWY3DPEHPK3PXP' },
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
  let markAttempts = 0
  const vault = {
    get: async id => id === account.id ? structuredClone(record) : null,
    markFailure: async id => {
      markAttempts++
      if (markAttempts < 3) throw new Error('temporary fixture write failure')
      if (id === account.id) record.reauthFailure = { reason: 'credential_invalid', updatedAt: '2026-10-04T00:00:00.000Z' }
    },
    clearFailure: async id => { if (id === account.id) delete record.reauthFailure },
    put: async (id, credentials) => { record.credentials = structuredClone(credentials); delete record.reauthFailure },
    delete: async () => {},
  }
  const reauthUpstream = async (path, cookie) => {
    if (path === '/api/auth/status') return upstream(path, cookie)
    if (path.startsWith('/api/admin/accounts/detail')) return { account }
    if (path === '/api/admin/accounts?page=1&pageSize=100') return { items: [account], page: { totalPages: 1 } }
    if (path.startsWith('/api/admin/proxies')) return { items: [], page: { totalPages: 1 } }
    throw new Error(`unexpected upstream request: ${path}`)
  }
  const app = await createApp({
    origin,
    upstream: reauthUpstream,
    vault,
    run: async () => {
      if (++attempts === 1) throw new PublicError(401, 'Codex Proxy 接口请求失败，请检查服务和登录状态')
      return { accountId: account.id }
    },
  })
  t.after(() => app.close())
  async function wait(id) {
    for (let i = 0; i < 150; i++) {
      const result = (await app.inject({ url: `${prefix}/tasks/${id}`, headers })).json().data
      if (!result.running) return result
      await delay(5)
    }
    assert.fail('task did not settle')
  }
  let response = await app.inject({ method: 'POST', url: `${prefix}/accounts/${account.id}/reauthorize`, headers, payload: { submissionId: '401-failure' } })
  assert.equal(response.statusCode, 200)
  assert.equal((await wait(response.json().data.id)).items[0].status, 'failed')
  assert.equal(markAttempts, 3)

  response = await app.inject({ method: 'GET', url: `${prefix}/accounts`, headers })
  const failed = response.json().data.items[0]
  assert.equal(failed.status, 'error')
  assert.equal(failed.errorReason, 'credential_invalid')
  assert.equal(failed.needsReauth, true)

  account.updatedAt = '2026-10-05T00:00:00.000Z'
  response = await app.inject({ method: 'GET', url: `${prefix}/accounts`, headers })
  const stillFailed = response.json().data.items[0]
  assert.equal(stillFailed.status, 'error')
  assert.equal(stillFailed.needsReauth, true)

  account.status = 'quota_exhausted'
  response = await app.inject({ method: 'GET', url: `${prefix}/accounts`, headers })
  const quotaLimited = response.json().data.items[0]
  assert.equal(quotaLimited.status, 'quota_exhausted')
  assert.equal(quotaLimited.needsReauth, false)
  account.status = 'active'

  response = await app.inject({ method: 'POST', url: `${prefix}/accounts/${account.id}/reauthorize`, headers, payload: { submissionId: '401-recovery' } })
  assert.equal(response.statusCode, 200)
  assert.equal((await wait(response.json().data.id)).items[0].status, 'succeeded')
  response = await app.inject({ method: 'GET', url: `${prefix}/accounts`, headers })
  const recovered = response.json().data.items[0]
  assert.equal(recovered.status, 'active')
  assert.equal(recovered.errorReason, undefined)
  assert.equal(recovered.needsReauth, false)
})

test('target 401 is not recorded when the administrator session has expired', async t => {
  const account = { id: 'expired-session', email: 'expired-session@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'active', updatedAt: '2026-10-01T00:00:00.000Z', outboundProxyEndpoint: null }
  let authChecks = 0
  let markAttempts = 0
  const vault = {
    get: async id => id === account.id ? { credentials: { email: account.email, password: 'private-password', totpSecret: 'JBSWY3DPEHPK3PXP' } } : null,
    markFailure: async () => { markAttempts++ },
    delete: async () => {},
  }
  const fixtureUpstream = async (path, cookie) => {
    if (path === '/api/auth/status') return ++authChecks === 2 ? { authenticated: false } : upstream(path, cookie)
    if (path.startsWith('/api/admin/accounts/detail')) return { account }
    if (path === '/api/admin/accounts?page=1&pageSize=100') return { items: [account], page: { totalPages: 1 } }
    if (path.startsWith('/api/admin/proxies')) return { items: [], page: { totalPages: 1 } }
    throw new Error(`unexpected upstream request: ${path}`)
  }
  const app = await createApp({ origin, upstream: fixtureUpstream, vault, run: async () => { throw new PublicError(401, 'fixture') } })
  t.after(() => app.close())
  const task = (await app.inject({ method: 'POST', url: `${prefix}/accounts/${account.id}/reauthorize`, headers, payload: { submissionId: 'expired-session' } })).json().data
  for (let i = 0; i < 50; i++) {
    if (!(await app.inject({ url: `${prefix}/tasks/${task.id}`, headers })).json().data.running) break
    await delay(5)
  }
  const response = await app.inject({ method: 'GET', url: `${prefix}/accounts`, headers })
  assert.equal(response.json().data.items[0].status, 'active')
  assert.equal(response.json().data.items[0].needsReauth, false)
  assert.equal(markAttempts, 0)
})

test('target 401 does not overwrite a newer account authorization', async t => {
  const account = { id: 'changed-account', email: 'changed-account@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'active', updatedAt: '2026-10-01T00:00:00.000Z', outboundProxyEndpoint: null }
  let markAttempts = 0
  const vault = {
    get: async id => id === account.id ? { credentials: { email: account.email, password: 'private-password', totpSecret: 'JBSWY3DPEHPK3PXP' } } : null,
    markFailure: async () => { markAttempts++ },
    delete: async () => {},
  }
  const fixtureUpstream = async (path, cookie) => {
    if (path === '/api/auth/status') return upstream(path, cookie)
    if (path.startsWith('/api/admin/accounts/detail')) return { account }
    if (path === '/api/admin/accounts?page=1&pageSize=100') return { items: [account], page: { totalPages: 1 } }
    if (path.startsWith('/api/admin/proxies')) return { items: [], page: { totalPages: 1 } }
    throw new Error(`unexpected upstream request: ${path}`)
  }
  const app = await createApp({
    origin,
    upstream: fixtureUpstream,
    vault,
    run: async () => {
      account.updatedAt = '2026-10-05T00:00:00.000Z'
      throw new PublicError(401, 'fixture')
    },
  })
  t.after(() => app.close())
  const task = (await app.inject({ method: 'POST', url: `${prefix}/accounts/${account.id}/reauthorize`, headers, payload: { submissionId: 'changed-account' } })).json().data
  for (let i = 0; i < 50; i++) {
    if (!(await app.inject({ url: `${prefix}/tasks/${task.id}`, headers })).json().data.running) break
    await delay(5)
  }
  const response = await app.inject({ method: 'GET', url: `${prefix}/accounts`, headers })
  assert.equal(response.json().data.items[0].status, 'active')
  assert.equal(response.json().data.items[0].needsReauth, false)
  assert.equal(markAttempts, 0)
})

test('admin guard rejects anonymous/key sessions and cross-origin/missing CSRF headers', async t => {
  const app = await createApp({ origin, upstream, run: async () => ({ accountId: 'ok' }) })
  t.after(() => app.close())
  for (const h of [{ origin, 'x-cpr-twofa': '1' }, { ...headers, cookie: 'cpr_session=key' }, { ...headers, origin: 'https://other.example' }, { origin, cookie: headers.cookie }]) {
    const response = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers: h, payload })
    assert.ok([401, 403].includes(response.statusCode))
    assert.ok(!response.body.includes('private-password'))
  }
})

test('import saves account credentials; saved reauthorization binds original account, uses current proxy, and returns metadata only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cpr-api-vault-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vaultOptions = { directory: join(directory, 'data'), keyFile: join(directory, 'key') }
  await writeFile(vaultOptions.keyFile, randomBytes(32))
  const vault = await openVault(vaultOptions)
  let deleted = false
  let account = { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth', outboundProxyEndpoint: null }
  const calls = []
  const official = async (path, cookie) => {
    if (path.startsWith('/api/admin/accounts/detail')) {
      if (deleted) throw new PublicError(404, '账号不存在')
      return { account }
    }
    if (path.startsWith('/api/admin/proxies')) return { items: [{ id: 'current-proxy', endpoint: 'http://127.0.0.1:9999', lastTest: { success: false }, hasAuthentication: false }], page: { totalPages: 1 } }
    return upstream(path, cookie)
  }
  const options = { origin, upstream: official, vault, run: async input => { calls.push({ targetAccountId: input.targetAccountId, proxy: input.proxy, password: input.credentials.password }); return { accountId: 'original' } } }
  let app = await createApp(options)
  t.after(() => app.close())
  async function wait(id) {
    for (let i = 0; i < 50; i++) {
      const result = (await app.inject({ url: `${prefix}/tasks/${id}`, headers })).json().data
      if (!result.running) return result
      await delay(5)
    }
    assert.fail('task did not settle')
  }
  let response = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers, payload })
  assert.equal(response.statusCode, 200)
  const result = await wait(response.json().data.id)
  assert.equal(result.items[0].credentialsSaved, true)
  assert.equal((await vault.get('original')).credentials.password, 'private-password')
  await app.close()
  app = await createApp({ ...options, vault: await openVault(vaultOptions) })
  response = await app.inject({ url: `${prefix}/accounts/original`, headers })
  assert.equal(response.json().data.saved, true)
  assert.ok(!response.body.includes('private-password'))
  assert.ok(!response.body.includes('JBSWY'))
  account.outboundProxyEndpoint = 'http://127.0.0.1:9999'
  response = await app.inject({ method: 'POST', url: `${prefix}/accounts/original/reauthorize`, headers, payload: { submissionId: 'reauth' } })
  assert.equal(response.statusCode, 200)
  assert.equal((await wait(response.json().data.id)).items[0].status, 'succeeded')
  assert.equal(calls[1].targetAccountId, 'original')
  assert.equal(calls[1].proxy.server, 'http://127.0.0.1:9999')
  assert.equal(calls[1].password, 'private-password')
  response = await app.inject({ method: 'POST', url: `${prefix}/accounts/original/reauthorize`, headers, payload: { submissionId: 'mismatch', text: payload.text.replace('fixture@', 'wrong@') } })
  assert.equal(response.statusCode, 400)
  account.provider = 'xai'
  response = await app.inject({ method: 'POST', url: `${prefix}/accounts/original/reauthorize`, headers, payload: { submissionId: 'wrong-provider' } })
  assert.equal(response.statusCode, 400)
  account.provider = 'openai'
  deleted = true
  response = await app.inject({ url: `${prefix}/accounts/original`, headers })
  assert.equal(response.statusCode, 404)
  assert.equal(await vault.get('original'), null)
})

test('clear cannot race an in-flight saved-credential read and silently resurrect credentials', async t => {
  let release
  let started
  const reading = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let deletes = 0
  const app = await createApp({ origin, upstream: async (path, cookie) => path.startsWith('/api/admin/accounts/detail')
    ? { account: { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth' } } : upstream(path, cookie),
  run: async () => ({ accountId: 'original' }), vault: {
    get: async () => { started(); await gate; return { credentials: { email: 'fixture@example.com', password: 'fixture-password', totpSecret: 'JBSWY3DPEHPK3PXP' } } },
    put: async () => {}, delete: async () => { deletes++ },
  } })
  t.after(() => app.close())
  const pending = app.inject({ method: 'POST', url: `${prefix}/accounts/original/reauthorize`, headers, payload: { submissionId: 'read-race' } }).then(result => result)
  await reading
  const result = await app.inject({ method: 'DELETE', url: `${prefix}/accounts/original`, headers: { ...headers, cookie: 'cpr_session=admin-other' } })
  release()
  await pending
  assert.equal(result.statusCode, 409)
  assert.equal(deletes, 0)
})

test('clear invalidates failed reauthorization retry credentials before asynchronous disk deletion', async t => {
  let release
  let started
  const deleting = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let runs = 0
  const app = await createApp({ origin, upstream: async (path, cookie) => path.startsWith('/api/admin/accounts/detail')
    ? { account: { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth' } } : upstream(path, cookie),
  run: async () => { runs++; throw new Error('fixture login failure') }, vault: {
    get: async () => ({ credentials: { email: 'fixture@example.com', password: 'fixture-password', totpSecret: 'JBSWY3DPEHPK3PXP' } }),
    put: async () => {}, delete: async () => { started(); await gate },
  } })
  t.after(() => app.close())
  const task = (await app.inject({ method: 'POST', url: `${prefix}/accounts/original/reauthorize`, headers, payload: { submissionId: 'retry-race' } })).json().data
  for (let i = 0; i < 50; i++) {
    const status = (await app.inject({ url: `${prefix}/tasks/${task.id}`, headers })).json().data
    if (!status.running) break
    await delay(5)
  }
  const removal = app.inject({ method: 'DELETE', url: `${prefix}/accounts/original`, headers: { ...headers, cookie: 'cpr_session=admin-other' } }).then(result => result)
  await deleting
  const retry = await app.inject({ method: 'POST', url: `${prefix}/tasks/${task.id}/retry`, headers })
  release()
  assert.equal((await removal).statusCode, 200)
  assert.equal(retry.statusCode, 409)
  assert.equal(runs, 1)
})

test('saved credential endpoints enforce admin and CSRF and allow removal without exposing secrets', async t => {
  let removed = false
  const app = await createApp({ origin, upstream, run: async () => ({}), vault: { get: async () => ({ credentials: { password: 'private-password' } }), delete: async () => { removed = true } } })
  t.after(() => app.close())
  for (const method of ['GET', 'DELETE', 'POST']) {
    const url = `${prefix}/accounts/original${method === 'POST' ? '/reauthorize' : ''}`
    for (const h of [{}, { ...headers, origin: 'https://other.example' }, { ...headers, cookie: 'cpr_session=key' }]) {
      const result = await app.inject({ method, url, headers: h, ...(method === 'POST' ? { payload: { submissionId: 'x' } } : {}) })
      assert.ok([401, 403].includes(result.statusCode))
      assert.ok(!result.body.includes('private-password'))
    }
  }
  const result = await app.inject({ method: 'DELETE', url: `${prefix}/accounts/original`, headers })
  assert.equal(result.statusCode, 200)
  assert.equal(removed, true)
})

test('deleting an account removes the RS account and its saved credentials', async t => {
  let deletedRequest
  let credentialsDeleted = false
  const account = { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'active' }
  const app = await createApp({
    origin,
    upstream: async (path, cookie, body) => {
      if (path === '/api/auth/status') return upstream(path, cookie)
      if (path.startsWith('/api/admin/accounts/detail')) return { account }
      if (path === '/api/admin/accounts/delete') {
        deletedRequest = body
        return { deletedCount: 1, accountIds: [account.id] }
      }
      throw new Error(`unexpected upstream request: ${path}`)
    },
    run: async () => ({ accountId: account.id }),
    vault: {
      get: async () => ({ credentials: { email: account.email, password: 'private-password', totpSecret: 'PRIVATE-TOTP' } }),
      delete: async id => { if (id === account.id) credentialsDeleted = true },
    },
  })
  t.after(() => app.close())
  const response = await app.inject({ method: 'DELETE', url: `${prefix}/accounts/${account.id}/delete`, headers })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(deletedRequest, { provider: 'openai', accountIds: [account.id] })
  assert.equal(credentialsDeleted, true)
  assert.ok(!response.body.includes('private-password'))
})

test('RS deletion failure preserves saved credentials', async t => {
  let credentialsDeleted = false
  const app = await createApp({
    origin,
    upstream: async (path, cookie) => {
      if (path === '/api/auth/status') return upstream(path, cookie)
      if (path.startsWith('/api/admin/accounts/detail')) return { account: { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth' } }
      if (path === '/api/admin/accounts/delete') throw new PublicError(502, 'RS 删除失败')
      throw new Error(`unexpected upstream request: ${path}`)
    },
    run: async () => ({}),
    vault: { delete: async () => { credentialsDeleted = true } },
  })
  t.after(() => app.close())
  const response = await app.inject({ method: 'DELETE', url: `${prefix}/accounts/original/delete`, headers })
  assert.equal(response.statusCode, 502)
  assert.equal(credentialsDeleted, false)
})

test('RS deletion failure leaves a failed reauthorization task retryable', async t => {
  const account = { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth', status: 'active' }
  let attempts = 0
  const app = await createApp({
    origin,
    upstream: async (path, cookie) => {
      if (path === '/api/auth/status') return upstream(path, cookie)
      if (path.startsWith('/api/admin/accounts/detail')) return { account }
      if (path === '/api/admin/accounts/delete') throw new PublicError(502, 'RS 删除失败')
      throw new Error(`unexpected upstream request: ${path}`)
    },
    run: async () => { attempts++; throw new PublicError(502, 'fixture authorization failure') },
    vault: { get: async () => ({ credentials: { email: account.email, password: 'private-password', totpSecret: 'JBSWY3DPEHPK3PXP' } }), delete: async () => {} },
  })
  t.after(() => app.close())
  const started = await app.inject({ method: 'POST', url: `${prefix}/accounts/${account.id}/reauthorize`, headers, payload: { submissionId: 'retryable' } })
  assert.equal(started.statusCode, 200)
  const taskId = started.json().data.id
  for (let index = 0; index < 100; index++) {
    const current = (await app.inject({ url: `${prefix}/tasks/${taskId}`, headers })).json().data
    if (!current.running) break
    await delay(5)
  }
  assert.equal(attempts, 1)
  const deleted = await app.inject({ method: 'DELETE', url: `${prefix}/accounts/${account.id}/delete`, headers })
  assert.equal(deleted.statusCode, 502)
  const retried = await app.inject({ method: 'POST', url: `${prefix}/tasks/${taskId}/retry`, headers })
  assert.equal(retried.statusCode, 200)
})

test('retrying deletion cleans saved credentials after the RS account is gone', async t => {
  let credentialsDeleted = false
  const app = await createApp({
    origin,
    upstream: async (path, cookie) => {
      if (path === '/api/auth/status') return upstream(path, cookie)
      if (path.startsWith('/api/admin/accounts/detail')) throw new PublicError(404, '账号不存在')
      throw new Error(`unexpected upstream request: ${path}`)
    },
    run: async () => ({}),
    vault: { delete: async () => { credentialsDeleted = true } },
  })
  t.after(() => app.close())
  const response = await app.inject({ method: 'DELETE', url: `${prefix}/accounts/original/delete`, headers })
  assert.equal(response.statusCode, 200)
  assert.equal(credentialsDeleted, true)
})

test('account list retries credential cleanup after RS deletion succeeded but vault deletion failed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cpr-delete-reconcile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { directory: join(root, 'vault'), keyFile: join(root, 'key') }
  await writeFile(options.keyFile, randomBytes(32), { mode: 0o600 })
  const vault = await openVault(options)
  const account = { id: 'original', email: 'fixture@example.com', provider: 'openai', authenticationKind: 'oauth' }
  await vault.put(account.id, { email: account.email, password: 'private-password', totpSecret: 'JBSWY3DPEHPK3PXP' })
  let exists = true
  const upstreamWithDeletion = async (path, cookie) => {
    if (path === '/api/auth/status') return upstream(path, cookie)
    if (path.startsWith('/api/admin/accounts/detail')) {
      if (!exists) throw new PublicError(404, '账号不存在')
      return { account }
    }
    if (path === '/api/admin/accounts/delete') { exists = false; return { deletedCount: 1, accountIds: [account.id] } }
    if (path.startsWith('/api/admin/accounts?page=')) return { items: exists ? [account] : [], page: { totalPages: 1 } }
    throw new Error(`unexpected upstream request: ${path}`)
  }
  let failOnce = true
  const failingVault = {
    ...vault,
    delete: async id => {
      if (failOnce) { failOnce = false; throw new Error('fixture disk failure') }
      await vault.delete(id)
    },
  }
  const first = await createApp({ origin, upstream: upstreamWithDeletion, run: async () => ({}), vault: failingVault })
  const deletion = await first.inject({ method: 'DELETE', url: `${prefix}/accounts/${account.id}/delete`, headers })
  assert.equal(deletion.statusCode, 500)
  await first.close()
  assert.ok(await vault.get(account.id))
  const second = await createApp({ origin, upstream: upstreamWithDeletion, run: async () => ({}), vault: await openVault(options) })
  t.after(() => second.close())
  const listed = await second.inject({ url: `${prefix}/accounts`, headers })
  assert.equal(listed.statusCode, 200)
  assert.deepEqual(listed.json().data.items, [])
  assert.equal(await vault.get(account.id), null)
  assert.deepEqual(await vault.pendingDeletions(), [])
})

test('JSON errors never echo secrets and tasks are session-isolated', async t => {
  const app = await createApp({ origin, upstream, run: async () => ({ accountId: 'ok' }) })
  t.after(() => app.close())
  const bad = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers: { ...headers, 'content-type': 'application/json' }, payload: '{"private-password"' })
  assert.equal(bad.statusCode, 400)
  assert.ok(!bad.body.includes('private-password'))
  const response = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers, payload })
  assert.equal(response.statusCode, 200)
  const id = response.json().data.id
  assert.ok(!response.body.includes('JBSWY'))
  const foreign = await app.inject({ method: 'GET', url: `${prefix}/tasks/${id}`, headers: { ...headers, cookie: 'cpr_session=admin-other' } })
  assert.equal(foreign.statusCode, 404)
  const status = await app.inject({ method: 'GET', url: `${prefix}/tasks/${id}`, headers })
  assert.equal(status.headers['cache-control'], 'no-store')
})
