/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequestGate } from '../src/operation.mjs'

test('coalesces concurrent refresh requests and releases the gate after completion', async () => {
  const gate = createRequestGate()
  let calls = 0
  let resolve
  const pending = new Promise((resolvePending) => {
    resolve = resolvePending
  })
  const request = () => {
    calls++
    return pending
  }

  const first = gate.run(request)
  const second = gate.run(request)
  assert.strictEqual(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  resolve('accounts')
  assert.equal(await first, 'accounts')

  const third = gate.run(async () => {
    calls++
    return 'fresh accounts'
  })
  assert.equal(await third, 'fresh accounts')
  assert.equal(calls, 2)
})
