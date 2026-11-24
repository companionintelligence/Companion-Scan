/**
 * Wave 14, ticket 0004 (F-40, FN-035): one set of unsure tracking reasons, src/ar/tracking-reasons.ts, read by the frame
 * tracker (`classifyTracking`) and by the calibration tap's check (`trackingIsStableForPlacement`), with the native
 * layers' reasons in it; and the burst's jump limit taken from the tracker's instead of kept equal to it by hand.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-tracking-reasons.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REASON_RELOCALIZING, UNSTABLE_TRACKING_REASONS, isUnstableTrackingReason } from '../../../src/ar/tracking-reasons.ts'
import { FRAME_JUMP_TRANSLATION_M, REASON_RELOCALIZING as FRAME_EPOCH_RELOCALIZING, classifyTracking } from '../../../src/ar/frame-epoch.ts'
import { BURST_POSE_JUMP_M, trackingIsStableForPlacement } from '../../../src/ar/tracking-quality.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

test('the one set: what 8th Wall documents, what it might report, and the native layers\' words', () => {
  assert.deepEqual([...UNSTABLE_TRACKING_REASONS].sort(), [
    'EXCESSIVE_MOTION',
    'INITIALIZING',
    'INSUFFICIENT_FEATURES',
    'NOT_ENOUGH_TEXTURE',
    'RELOCALIZING',
    'TOO_MUCH_MOTION',
  ])
  assert.equal(REASON_RELOCALIZING, 'RELOCALIZING')
  assert.equal(FRAME_EPOCH_RELOCALIZING, REASON_RELOCALIZING, 'frame-epoch still exports it, where the native codec reads it')
  for (const none of [undefined, null, '', 'UNSPECIFIED', 'NONE', 'INSUFFICIENT_LIGHT', 'relocalizing']) {
    assert.equal(isUnstableTrackingReason(none), false, String(none))
  }
})

test('both readers ask the same set: a NORMAL frame is degraded exactly when a tap in it is refused', () => {
  const reasons = [...UNSTABLE_TRACKING_REASONS, 'UNSPECIFIED', 'NONE', 'SOME_FUTURE_REASON', '', undefined]
  for (const reason of reasons) {
    const degraded = classifyTracking('NORMAL', reason) === 'degraded'
    const refused = !trackingIsStableForPlacement('NORMAL', reason)
    assert.equal(degraded, refused, String(reason))
    assert.equal(degraded, isUnstableTrackingReason(reason), String(reason))
  }
})

test('every reason the native codec emits is in the set, so the two readers know the native layers\' words', () => {
  // What `trackingReasonFromNative` (src/ar/native-codec.ts, another session's file) answered at e897380 for its four
  // `limited.*` states, as literals so that file can change without this test pinning it.
  for (const reason of ['RELOCALIZING', 'INITIALIZING', 'EXCESSIVE_MOTION', 'INSUFFICIENT_FEATURES']) {
    assert.ok(isUnstableTrackingReason(reason), reason)
    assert.equal(trackingIsStableForPlacement('NORMAL', reason), false)
  }
})

test('a reason never makes a refused status pass', () => {
  for (const status of ['LIMITED', 'NOT_AVAILABLE', 'INITIALIZING', 'UNSPECIFIED']) {
    for (const reason of [undefined, 'UNSPECIFIED', ...UNSTABLE_TRACKING_REASONS]) {
      assert.equal(trackingIsStableForPlacement(status, reason), false, `${status} ${reason}`)
    }
  }
})

test('the burst\'s jump limit is the tracker\'s, taken from it rather than kept equal by hand', () => {
  assert.equal(BURST_POSE_JUMP_M, FRAME_JUMP_TRANSLATION_M)
  assert.equal(BURST_POSE_JUMP_M, 0.3)
  assert.match(read('src/ar/tracking-quality.ts'), /export const BURST_POSE_JUMP_M = FRAME_JUMP_TRANSLATION_M\b/)
})

test('no other module in src/ar spells out the set', () => {
  assert.doesNotMatch(read('src/ar/frame-epoch.ts'), /DEGRADED_REASONS|'TOO_MUCH_MOTION'|'NOT_ENOUGH_TEXTURE'/)
  assert.doesNotMatch(read('src/ar/tracking-quality.ts'), /UNSTABLE_REASONS|'TOO_MUCH_MOTION'|'NOT_ENOUGH_TEXTURE'/)
  assert.doesNotMatch(read('src/ar/tracking-reasons.ts'), /^import /m, 'a leaf: both readers import it without importing each other')
})
