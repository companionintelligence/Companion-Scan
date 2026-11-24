/**
 * Wave 14 integration: a keyframe upload answered 408 or 429 is tried again; any other 4xx is not.
 *
 * The keyframe uploader (src/capture/keyframes.ts) treated every 4xx as final. 408 Request Timeout and 429 Too Many
 * Requests mean "try again later", so a frame refused by a busy server was dropped instead of retried after the
 * back-off.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-integration-keyframe-retry.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { keyframeUploadRetryable } from '../../../src/capture/keyframes.ts'

test('408 and 429 are retried, as a 5xx is', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(keyframeUploadRetryable(status), true, String(status))
})

test('every other 4xx is the request\'s own fault, and is not retried', () => {
  for (const status of [400, 401, 403, 404, 409, 413, 415, 422]) assert.equal(keyframeUploadRetryable(status), false, String(status))
})

test('the upload loop asks the rule rather than testing the status range itself', () => {
  const source = readFileSync(new URL('../../../src/capture/keyframes.ts', import.meta.url), 'utf8')
  assert.match(source, /if \(!keyframeUploadRetryable\(resp\.status\)\) return false/)
  assert.doesNotMatch(source, /resp\.status >= 400 && resp\.status < 500/)
})
