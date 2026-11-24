/**
 * The native runtime choice at boot (src/ar/runtime-select.ts): the first answer, asked again while ARCore still
 * reports 'checking', then the runtime and the 8th Wall status note. The answers are the ones the ScanAR plugin's
 * capabilities() gives (mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/native_ar_runtime_select.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { NativeARCapabilities } from '../../../src/ar/native-bridge.ts'
import {
  NATIVE_RECHECKS,
  NATIVE_RECHECK_MS,
  buildForcedRuntime,
  chooseNativeRuntime,
  pageForcedRuntime,
  settleNativeProbe,
} from '../../../src/ar/runtime-select.ts'

test('a build made with VITE_AR_RUNTIME=8thwall or webxr forces that runtime, and no other value forces anything', () => {
  assert.equal(buildForcedRuntime('8thwall'), '8thwall')
  assert.equal(buildForcedRuntime('webxr'), 'webxr', 'the XREAL Aura build')
  assert.equal(buildForcedRuntime('native'), null)
  assert.equal(buildForcedRuntime('WebXR'), null, 'the values are exact')
  assert.equal(buildForcedRuntime(''), null)
  assert.equal(buildForcedRuntime(undefined), null)
  assert.equal(buildForcedRuntime(null), null)
  const supported: NativeARCapabilities = { platform: 'android', engine: 'arcore', supported: true, depth: true, checking: false }
  assert.deepEqual(chooseNativeRuntime(buildForcedRuntime('8thwall'), supported), { native: false, note: null })
  assert.deepEqual(chooseNativeRuntime(buildForcedRuntime('webxr'), supported), { native: false, note: null },
    'a device whose ARCore could run still never starts a native session in the WebXR build')
})

test('the URL picks the runtime over an 8th Wall build, and never over a WebXR build, which carries no engine', () => {
  // No build value: the URL alone, as before.
  assert.equal(pageForcedRuntime(null, undefined), null)
  assert.equal(pageForcedRuntime('webxr', undefined), 'webxr')
  assert.equal(pageForcedRuntime('8thwall', undefined), '8thwall')
  // The 8th Wall APK: the build's runtime when the URL names none, and ?ar=webxr still reaches WebXR.
  assert.equal(pageForcedRuntime(null, '8thwall'), '8thwall')
  assert.equal(pageForcedRuntime('webxr', '8thwall'), 'webxr')
  // The XREAL Aura APK: WebXR whatever the URL says, since its bundle leaves the 8th Wall engine out.
  assert.equal(pageForcedRuntime(null, 'webxr'), 'webxr')
  assert.equal(pageForcedRuntime('8thwall', 'webxr'), 'webxr')
  assert.equal(pageForcedRuntime('anything', 'webxr'), 'webxr')
  // A value buildForcedRuntime does not act on forces nothing, so the URL decides.
  assert.equal(pageForcedRuntime(null, 'native'), null)
  assert.equal(pageForcedRuntime('8thwall', 'native'), '8thwall')
})

const SUPPORTED: NativeARCapabilities = { platform: 'android', engine: 'arcore', supported: true, depth: true, checking: false }
const CHECKING: NativeARCapabilities = {
  platform: 'android',
  engine: 'none',
  supported: false,
  depth: false,
  checking: true,
  reason: 'ARCore is still checking this device. Try again in a moment.',
}
const NOT_INSTALLED: NativeARCapabilities = {
  platform: 'android',
  engine: 'arcore',
  supported: false,
  depth: false,
  checking: false,
  reason: 'ARCore is not installed. Install or update Google Play Services for AR.',
}
const NEEDS_UPDATE: NativeARCapabilities = {
  platform: 'android',
  engine: 'arcore',
  supported: false,
  depth: false,
  checking: false,
  reason: 'ARCore needs an update. Update Google Play Services for AR.',
}
const UNSUPPORTED_DEVICE: NativeARCapabilities = {
  platform: 'android',
  engine: 'none',
  supported: false,
  depth: false,
  checking: false,
  reason: 'This device does not support ARCore.',
}

/**
 * A native layer that answers the asks after the first, in turn, and then keeps giving the last answer. The first
 * answer is passed to settleNativeProbe() directly, so it is not one of these. Its calls are counted.
 */
function scriptedLayer(answers: (NativeARCapabilities | null)[]) {
  const calls = { probes: 0, sleeps: [] as number[] }
  let next = 0
  return {
    calls,
    probe: async (): Promise<NativeARCapabilities | null> => {
      calls.probes += 1
      const answer = answers[Math.min(next, answers.length - 1)] ?? null
      next += 1
      return answer
    },
    sleep: async (ms: number): Promise<void> => {
      calls.sleeps.push(ms)
    },
  }
}

test('a settled native answer is final: supported starts native, with no status note and no ask again', async () => {
  const layer = scriptedLayer([SUPPORTED])
  const settled = await settleNativeProbe(null, SUPPORTED, layer.probe, layer.sleep)
  assert.deepEqual(layer.calls, { probes: 0, sleeps: [] })
  assert.deepEqual(chooseNativeRuntime(null, settled), { native: true, note: null })
})

test('ARCore not installed, or needing an update: the web runtimes start, and the status line says why', () => {
  assert.deepEqual(chooseNativeRuntime(null, NOT_INSTALLED), { native: false, note: 'ARCore is not installed, using 8th Wall' })
  assert.deepEqual(chooseNativeRuntime(null, NEEDS_UPDATE), { native: false, note: 'ARCore needs an update, using 8th Wall' })
})

test('still checking, then supported: the page asks again, once a second, and starts native', async () => {
  const layer = scriptedLayer([CHECKING, SUPPORTED])
  const settled = await settleNativeProbe(null, CHECKING, layer.probe, layer.sleep)
  assert.deepEqual(layer.calls, { probes: 2, sleeps: [NATIVE_RECHECK_MS, NATIVE_RECHECK_MS] })
  assert.deepEqual(chooseNativeRuntime(null, settled), { native: true, note: null })
})

test('still checking on every ask: the wait is bounded, and the page falls back to the web runtimes with the status unchanged', async () => {
  const layer = scriptedLayer([CHECKING])
  const settled = await settleNativeProbe(null, CHECKING, layer.probe, layer.sleep)
  assert.equal(NATIVE_RECHECKS, 5)
  assert.deepEqual(layer.calls, { probes: NATIVE_RECHECKS, sleeps: Array(NATIVE_RECHECKS).fill(NATIVE_RECHECK_MS) })
  assert.deepEqual(chooseNativeRuntime(null, settled), { native: false, note: null })
})

test('checking, then not installed: the final answer decides, and the status says why', async () => {
  const layer = scriptedLayer([NOT_INSTALLED])
  const settled = await settleNativeProbe(null, CHECKING, layer.probe, layer.sleep)
  assert.deepEqual(chooseNativeRuntime(null, settled), { native: false, note: 'ARCore is not installed, using 8th Wall' })
})

test('a native layer that fails while the page waits ends the asks, and reads as no native layer', async () => {
  const layer = scriptedLayer([null])
  const settled = await settleNativeProbe(null, CHECKING, layer.probe, layer.sleep)
  assert.deepEqual(layer.calls, { probes: 1, sleeps: [NATIVE_RECHECK_MS] })
  assert.deepEqual(chooseNativeRuntime(null, settled), { native: false, note: null })
})

test('the web switches never wait for native, and their status line stays as it was', async () => {
  for (const forced of ['webxr', '8thwall']) {
    const layer = scriptedLayer([CHECKING, SUPPORTED])
    const settled = await settleNativeProbe(forced, CHECKING, layer.probe, layer.sleep)
    assert.deepEqual(layer.calls, { probes: 0, sleeps: [] }, forced)
    assert.deepEqual(chooseNativeRuntime(forced, settled), { native: false, note: null }, forced)
    assert.deepEqual(chooseNativeRuntime(forced, NOT_INSTALLED), { native: false, note: null }, forced)
  }
})

test('no native layer, or a device that cannot run ARCore, keeps the status as it was', () => {
  assert.deepEqual(chooseNativeRuntime(null, null), { native: false, note: null })
  assert.deepEqual(chooseNativeRuntime(null, UNSUPPORTED_DEVICE), { native: false, note: null })
})
