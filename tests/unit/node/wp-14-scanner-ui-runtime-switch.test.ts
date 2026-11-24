/**
 * Wave 14, ticket 0003 (scanner-ui):
 *  - F-18 and FN-013: the scanner's runtime switch keeps the page's other query parameters
 *    (runtimeSwitchHref in src/ar/runtime-select.ts). The default runtime is unchanged.
 *  - FN-007: `?debug=geo` is a debug-flags token (src/shared/debug-flags.ts), so it combines with others.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-scanner-ui-runtime-switch.test.ts
 * Also run by npm run test:wave.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildForcedRuntime, preferNativeRuntime, runtimeSwitchHref } from '../../../src/ar/runtime-select.ts'
import { hasDebugFlag } from '../../../src/shared/debug-flags.ts'

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

test('switching to WebXR keeps every other parameter and sets ar=webxr last', () => {
  assert.equal(runtimeSwitchHref('?debug=pose&project=p-1', 'webxr'), '/?debug=pose&project=p-1&ar=webxr')
  assert.equal(runtimeSwitchHref('', 'webxr'), '/?ar=webxr')
  assert.equal(runtimeSwitchHref('?ar=8thwall&world=w', 'webxr'), '/?world=w&ar=webxr', 'the switch wins over an ar the page had')
})

test('switching back drops ar, which is the default runtime, and keeps the rest', () => {
  assert.equal(runtimeSwitchHref('?ar=webxr&debug=pose%2Cremote', 'default'), '/?debug=pose%2Cremote')
  assert.equal(runtimeSwitchHref('?ar=webxr', 'default'), '/', 'what the switch always pointed at')
  assert.equal(runtimeSwitchHref('', 'default'), '/')
})

test('the switch carries the parameters as webxr.html does, so the two entries to WebXR agree', () => {
  const html = read('webxr.html')
  assert.match(html, /const params = new URLSearchParams\(location\.search\)\n\s+params\.set\('ar', 'webxr'\)\n\s+return '\/\?' \+ params\.toString\(\)/)
  const search = '?debug=pose&mock=webxr'
  const viaPage = (() => { const p = new URLSearchParams(search); p.set('ar', 'webxr'); return `/?${p}` })()
  assert.equal(runtimeSwitchHref(search, 'webxr'), viaPage)
})

test('F-18: the default runtime is unchanged — only a URL or a build picks WebXR or 8th Wall over native', () => {
  assert.equal(preferNativeRuntime({ forced: null, nativeSupported: true }), true)
  assert.equal(preferNativeRuntime({ forced: 'webxr', nativeSupported: true }), false)
  assert.equal(buildForcedRuntime(undefined), null, 'a web build forces nothing, so 8th Wall stays first where xr.js loads')
})

test('source shape: the scanner points the switch through runtimeSwitchHref in both directions', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('function updateXrModeLink(')
  const body = main.slice(start, main.indexOf('\n}\n', start))
  assert.match(body, /link\.href = runtimeSwitchHref\(location\.search, 'webxr'\)/)
  assert.match(body, /link\.href = runtimeSwitchHref\(location\.search, 'default'\)/)
  assert.doesNotMatch(body, /link\.href = '\//, 'no fixed href is left')
})

test('a build that forces WebXR (the WebXR-only APK) hides the switch: its bundle has no 8th Wall to switch to', () => {
  const main = read('src/main.ts')
  assert.match(main, /const buildRuntime = buildForcedRuntime\(import\.meta\.env\.VITE_AR_RUNTIME\)\n\s+const forcedMode = pageForcedRuntime\(searchParams\.get\('ar'\), import\.meta\.env\.VITE_AR_RUNTIME\)\n\s+if \(buildRuntime === 'webxr'\) \{\n\s+const modeLink = document\.getElementById\('xr-mode-link'\)\n\s+if \(modeLink\) modeLink\.style\.display = 'none'\n\s+\}/,
    'hidden before the runtime is chosen, so a device with no WebXR, which returns early, never shows it either')
  assert.match(main, /if \(nativeActive \|\| buildRuntime === 'webxr'\) \{\n(?:\s+\/\/[^\n]*\n)*\s+const modeLink = document\.getElementById\('xr-mode-link'\)\n\s+if \(modeLink\) modeLink\.style\.display = 'none'\n\s+\} else \{\n\s+updateXrModeLink\(use8thWall, webxrSupported\)/,
    'and kept hidden once WebXR has started, where updateXrModeLink would offer the way back to 8th Wall')
})

test('FN-007: geo is a debug token like the others, so ?debug=geo,pose arms both', () => {
  assert.equal(hasDebugFlag('geo', '?debug=geo,pose'), true)
  assert.equal(hasDebugFlag('pose', '?debug=geo,pose'), true)
  assert.equal(hasDebugFlag('geo', '?debug=GEO'), true)
  assert.equal(hasDebugFlag('geo', '?debug=pose'), false)
  const main = read('src/main.ts')
  assert.match(main, /coords\.classList\.toggle\('debug-armed', hasDebugFlag\('geo'\)\)/)
  assert.doesNotMatch(main, /get\('debug'\) === /, 'no exact match on the whole value is left')
})
