/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageClickToViewport } from '../src/manual-input.mjs'

function image({ left = 0, top = 0, width, height, naturalWidth = 1024, naturalHeight = 768 }) {
  return {
    naturalWidth,
    naturalHeight,
    getBoundingClientRect: () => ({ left, top, width, height }),
  }
}

test('maps a displayed screenshot click to browser viewport coordinates', () => {
  const result = imageClickToViewport(
    { clientX: 256, clientY: 192 },
    image({ width: 512, height: 384 }),
  )

  assert.deepEqual(result, { kind: 'click', x: 512, y: 384 })
})

test('ignores clicks in object-contain letterbox areas', () => {
  const result = imageClickToViewport(
    { clientX: 10, clientY: 10 },
    image({ width: 512, height: 512 }),
  )

  assert.equal(result, undefined)
})
