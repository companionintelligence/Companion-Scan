/**
 * Wave 14, ticket 0003 (scanner-ui): the scanner boot (src/main.ts) and its start screen.
 *
 * main() touches the DOM when it loads, so node cannot import main.ts. As in desktop_engine_state.test.ts, the
 * pieces that decide something are run here from main.ts's own text against stand-ins, and the order of the boot
 * is read from the source:
 *
 *  - F-14 and FN-002: onboarding, the help button and the shell sign-in return are wired before main() can return,
 *    and the help button sits above the start screen;
 *  - F-16: an 8th Wall provider that fails, then a WebXR that fails, ends in the no-runtime path;
 *  - F-17: a read-only tab says why on the start screen;
 *  - FN-019: the desktop app's start screen says live capture needs a phone, from the start;
 *  - FN-009: device advice and the motion refusal are chosen per app before per browser;
 *  - F-06: the test hooks are installed only in a dev build or under ?mock=;
 *  - FN-012, FN-015, FN-017, FN-022, FN-028.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-scanner-ui-boot.test.ts
 * Also run by npm run test:wave.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { isClientId, isTakeId, newClientId, newTakeId } from '../../../src/shared/take-id.ts'
import {
  IOS_APP_MOTION_DENIAL,
  SAFARI_MOTION_DENIAL,
  appShell,
  motionDenialNotice,
} from '../../../src/ui/platform-advice.ts'
import { showArHelpWordsMax } from '../../support/startup-budget.ts'

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
const main = read('src/main.ts')
const html = read('index.html')

/** The text of `source` from `from` up to, not including, `to`. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `main.ts has: ${from}`)
  const end = source.indexOf(to, start)
  assert.notEqual(end, -1, `main.ts has, after it: ${to}`)
  return source.slice(start, end)
}

/** A top-level function of main.ts, from its `function` line to the closing brace at column 0. */
function topLevelFunction(name: string): string {
  const from = [`\nfunction ${name}(`, `\nasync function ${name}(`].map((head) => main.indexOf(head)).find((at) => at !== -1) ?? -1
  assert.notEqual(from, -1, `main.ts declares ${name}`)
  const to = main.indexOf('\n}\n', from)
  return main.slice(from + 1, to + 3)
}

const mainBody = between(main, 'async function main() {', '\n// ─── Helpers')
const at = (needle: string) => {
  const index = mainBody.indexOf(needle)
  assert.notEqual(index, -1, `main() has: ${needle}`)
  return index
}
const insecureReturn = () => at('if (!window.isSecureContext) {')
const noRuntimeReturn = () => at("console.error('[main] No AR runtime available:', e)")

// ── F-14: what has to work before the boot can give up ───────────────────────────────────────────

test('F-14: onboarding, the help button and the sign-in return are wired before main() can return', () => {
  const wired = at('wireOnboarding(skipOnboarding)')
  assert.ok(wired < insecureReturn(), 'before the insecure-context return')
  assert.ok(wired < noRuntimeReturn(), 'before the no-runtime return')
  const wire = topLevelFunction('wireOnboarding')
  assert.match(wire, /void initShellSignIn\(\(signedIn\) => \{/, 'the shell sign-in return')
  assert.match(wire, /if \(!skip && !localStorage\.getItem\(ONBOARDING_KEY\)\) void runOnboarding\(\)/, 'first run, not awaited')
  assert.match(wire, /helpBtn\.classList\.add\('visible'\)/, 'the help button')
  assert.equal(main.split('void initShellSignIn(').length, 2, 'the sign-in return is wired once')
  assert.doesNotMatch(mainBody, /await runOnboarding/, 'the boot waits on nothing the overlay does')
})

test('F-14: the help button paints above the start screen and below the overlay it opens', () => {
  const z = (selector: string) => {
    const rule = new RegExp(`${selector.replace('#', '#')} \\{[^}]*?z-index: (\\d+)`).exec(html)
    assert.ok(rule, `index.html has a z-index for ${selector}`)
    return Number(rule[1])
  }
  assert.ok(z('#help-btn') > z('#start-screen'), 'tappable on the start screen')
  assert.ok(z('#help-btn') < z('#onboarding-overlay'), 'under the overlay it opens')
})

// ── F-16: the fallback from 8th Wall to WebXR ────────────────────────────────────────────────────

const FALLBACK = between(main, '    let webRuntime: ARProvider | null = null', '    provider = webRuntime') + '    provider = webRuntime'
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<Record<string, unknown>>

interface Boot {
  xr8Available: boolean
  eighthWall: () => Promise<unknown>
  webxr: () => Promise<unknown>
  desktopApp?: boolean
  xr8Load?: string
  /** The runtime the build forces (VITE_AR_RUNTIME), which the block hands to showArHelp. */
  buildRuntime?: string | null
}

async function runFallback(b: Boot) {
  const help: string[] = []
  const statuses: string[] = []
  // The block returns from main() on a double failure, so it is run as the body of a function of its own.
  const block = stripTypeScriptTypes(`const block = async () => {\n${FALLBACK}\n}`)
  const run = new AsyncFunction(
    'xr8Available', 'createEighthWallProvider', 'createWebXRProvider', 'overlay', 'nativeChoice', 'forcedMode', 'xr8Load',
    'desktopApp', 'showArHelp', 'console', 'buildRuntime',
    `let use8thWall = false
     let arRuntimeError = null
     let provider = null
     ${block}
     await block()
     return { use8thWall, arRuntimeError, provider }`,
  )
  const out = await run(
    b.xr8Available, b.eighthWall, b.webxr,
    { setStatus: (text: string) => { statuses.push(text) } },
    { note: null }, null, b.xr8Load ?? (b.xr8Available ? 'ready' : 'absent'),
    b.desktopApp ?? false, (reason: string) => { help.push(reason) },
    { warn() {}, error() {} },
    b.buildRuntime ?? null,
  )
  return { ...out, help, statuses }
}

const fails = () => Promise.reject(new Error('no'))

test('F-16: 8th Wall fails, then WebXR fails: the reason reaches the start screen and arRuntimeError', async () => {
  const r = await runFallback({ xr8Available: true, eighthWall: fails, webxr: fails })
  assert.equal(r.arRuntimeError, 'AR not available on this device')
  assert.deepEqual(r.help, ['AR not available on this device'], 'showArHelp(reason): #ar-help and the Start button')
  assert.equal(r.provider, null, 'the boot returned before a provider was set')
  assert.equal(r.use8thWall, false)
})

test('F-16: 8th Wall fails and WebXR works: the session runs on WebXR, and says so', async () => {
  const webxr = { kind: 'webxr' }
  const r = await runFallback({ xr8Available: true, eighthWall: fails, webxr: async () => webxr })
  assert.equal(r.provider, webxr)
  assert.equal(r.arRuntimeError, null)
  assert.equal(r.use8thWall, false)
  assert.deepEqual(r.statuses, ['✓ WebXR ready'])
})

test('F-16: 8th Wall works: WebXR is not asked', async () => {
  const eighthWall = { kind: '8thwall' }
  let asked = false
  const r = await runFallback({ xr8Available: true, eighthWall: async () => eighthWall, webxr: async () => { asked = true; return {} } })
  assert.equal(r.provider, eighthWall)
  assert.equal(r.use8thWall, true)
  assert.equal(asked, false)
})

test('F-16: no engine and no WebXR: the ladder\'s reason, as before', async () => {
  const r = await runFallback({ xr8Available: false, xr8Load: 'timeout', eighthWall: fails, webxr: fails })
  assert.equal(r.arRuntimeError, 'The AR engine did not load in time\n• Reload the page to try again')
})

test('FN-019: the desktop app keeps its own start-screen line when the runtime checks fail', async () => {
  const r = await runFallback({ xr8Available: false, eighthWall: fails, webxr: fails, desktopApp: true })
  assert.deepEqual(r.help, [], 'the desktop line from the top of main() stays')
  assert.equal(r.arRuntimeError, 'AR not available on this device', 'and the Place picker gate is still armed')
})

// ── The start screen's help line, per app ────────────────────────────────────────────────────────

function showArHelp(reason: string, shell: string | null, userAgent = 'Mozilla/5.0', buildRuntime: string | null = null) {
  const help = { textContent: '', innerHTML: '', hidden: true }
  const labels: Array<string | undefined> = []
  new Function(
    'reason', 'buildRuntime', 'setStartButtonState', 'navigator', 'location', 'document', 'showPermissionBanner', 'appShell',
    stripTypeScriptTypes(`${topLevelFunction('showArHelp')}\nshowArHelp(reason, buildRuntime)`),
  )(
    reason,
    buildRuntime,
    (_state: string, label?: string) => { labels.push(label) },
    { userAgent },
    { origin: 'https://scanner.invalid' },
    { getElementById: (id: string) => (id === 'ar-help' ? help : null) },
    () => {},
    () => shell,
  )
  return { labels, text: help.textContent || help.innerHTML, shown: !help.hidden }
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'

test('FN-009: a phone app is told about its own AR, not about a browser to switch to', () => {
  const ios = showArHelp('AR not available on this device', 'ios', IPHONE)
  assert.equal(ios.text, 'Live capture needs an iPhone or iPad that supports ARKit.')
  assert.doesNotMatch(ios.text, /Safari|HelloXR/)
  const android = showArHelp('AR not available on this device', 'android', ANDROID)
  assert.equal(android.text, 'Live capture needs Google Play Services for AR on this phone.')
  assert.doesNotMatch(android.text, /Chrome/)
})

test("the Android app's WebXR-only build sends the reader to the browser, not to Google Play Services for AR", () => {
  // As the XREAL Aura showed on 2026-11-24: that build never starts ARCore, and the puck's WebView has no WebXR.
  const webxr = showArHelp('WebXR is not available here', 'android', ANDROID, 'webxr')
  assert.deepEqual(webxr.labels, ['WebXR is not available here'], 'the headline stays the Start button label')
  assert.equal(webxr.text, "To capture, open your Scan server's /webxr.html page in the browser.")
  assert.doesNotMatch(webxr.text, /Play Services|ARCore/)
  assert.ok(webxr.shown)
  // The ARCore build, and the 8th Wall build, keep their line.
  assert.equal(showArHelp('AR not available on this device', 'android', ANDROID, null).text, 'Live capture needs Google Play Services for AR on this phone.')
  assert.equal(showArHelp('AR not available on this device', 'android', ANDROID, '8thwall').text, 'Live capture needs Google Play Services for AR on this phone.')
  // The call site passes the build's runtime.
  assert.ok(main.includes('if (!desktopApp) showArHelp(reason, buildRuntime)'), 'main() hands showArHelp the build runtime')
})

test('FN-009: a browser is still told by its user agent', () => {
  assert.match(showArHelp('AR not available on this device', null, IPHONE).text, /use the main scanner, or install <a href="https:\/\/apps\.apple\.com/)
  assert.equal(showArHelp('AR not available on this device', null, ANDROID).text, 'Live capture needs Chrome with Play Services for AR.')
})

test('FN-009: the app lines fit the start screen\'s budget for this line', () => {
  for (const line of ['Live capture needs an iPhone or iPad that supports ARKit.', 'Live capture needs Google Play Services for AR on this phone.', "To capture, open your Scan server's /webxr.html page in the browser."]) {
    assert.ok(line.split(/\s+/).length <= showArHelpWordsMax(), line)
  }
})

test('FN-019: the desktop app says live capture needs a phone, on the Start button and in #ar-help', () => {
  const reason = /const DESKTOP_NO_LIVE_CAPTURE = '([^']+)'/.exec(main)?.[1]
  assert.equal(reason, 'Live capture needs a phone')
  const screen = showArHelp(reason!, 'desktop')
  assert.deepEqual(screen.labels, ['Live capture needs a phone'])
  assert.equal(screen.text, 'The desktop app cannot capture. Scan on a phone.')
  assert.ok(screen.shown)
  const said = at('if (desktopApp) showArHelp(DESKTOP_NO_LIVE_CAPTURE)')
  assert.ok(said < insecureReturn(), 'before anything can return')
  assert.match(mainBody, /if \(!desktopApp\) setStartButtonState\('ready'\)/, 'and the Start button is not made ready again')
})

test('FN-009: the motion refusal names Safari\'s setting in a browser and the app\'s remedy in the iOS app', () => {
  assert.equal(motionDenialNotice(null), SAFARI_MOTION_DENIAL)
  assert.equal(motionDenialNotice('ios'), IOS_APP_MOTION_DENIAL)
  assert.doesNotMatch(IOS_APP_MOTION_DENIAL, /Safari/)
  assert.match(SAFARI_MOTION_DENIAL, /Motion & Orientation/, 'tests/mock-motion-permission.spec.ts reads this')
  assert.match(mainBody, /const denialNotice = motionDenialNotice\(appShell\(\)\)/)
})

test('FN-009: appShell reads what each shell injects', () => {
  const g = globalThis as unknown as Record<string, unknown>
  try {
    assert.equal(appShell(), null, 'a browser')
    g['Capacitor'] = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    assert.equal(appShell(), 'ios')
    g['Capacitor'] = { isNativePlatform: () => true, getPlatform: () => 'android' }
    assert.equal(appShell(), 'android')
    delete g['Capacitor']
    g['__TAURI_INTERNALS__'] = {}
    assert.equal(appShell(), 'desktop')
  } finally {
    delete g['Capacitor']
    delete g['__TAURI_INTERNALS__']
  }
})

// ── F-17: the read-only notice ───────────────────────────────────────────────────────────────────

test('F-17: a read-only tab says why on the start screen, from the start and on each refused tap', () => {
  const shown = at('if (readOnlyScanner) showStartScreenNotice(READ_ONLY_NOTICE)')
  assert.ok(shown < at('wireContentUpload(readOnlyScanner)'), 'before the cards are wired')
  assert.match(mainBody, /const showReadOnlyNotice = \(\) => \{\n\s+overlay\.setStatus\(READ_ONLY_NOTICE, 'sticky'\)\n\s+showStartScreenNotice\(READ_ONLY_NOTICE\)\n\s+\}/)
  assert.equal(main.split("const READ_ONLY_NOTICE = 'Scanner is open in another tab.").length, 2, 'one notice')
})

test('F-17: the start-screen line is written only while the start screen stands', () => {
  const run = (startScreen: boolean) => {
    const line = { textContent: '' }
    new Function('document', 'text', `${stripTypeScriptTypes(topLevelFunction('showStartScreenNotice'))}\nshowStartScreenNotice(text)`)(
      { getElementById: (id: string) => (id === 'start-screen' ? (startScreen ? {} : null) : id === 'upload-video-progress' ? line : null) },
      'Scanner is open in another tab.',
    )
    return line.textContent
  }
  assert.equal(run(true), 'Scanner is open in another tab.')
  assert.equal(run(false), '', 'once AR runs the status line is the place')
})

// ── F-06: the test hooks ─────────────────────────────────────────────────────────────────────────

test('F-06: the hooks are installed in a dev build or under ?mock=, and nowhere else', () => {
  const allowed = new Function('dev', 'search', `${stripTypeScriptTypes(topLevelFunction('testHooksAllowed'))}\nreturn testHooksAllowed(dev, search)`) as
    (dev: boolean, search: URLSearchParams) => boolean
  assert.equal(allowed(false, new URLSearchParams('')), false, 'a production page')
  assert.equal(allowed(false, new URLSearchParams('?project=p')), false)
  assert.equal(allowed(false, new URLSearchParams('?mock=xr8')), true, 'a mock spec')
  assert.equal(allowed(true, new URLSearchParams('')), true, 'the dev server tests/ar-scan.spec.ts drives')
  assert.match(mainBody, /if \(testHooksAllowed\(import\.meta\.env\.DEV, searchParams\) && typeof \(window as any\)\.__playwright_hooks === 'undefined'\) \{/)
})

// ── The smaller items ────────────────────────────────────────────────────────────────────────────

test('FN-012: a capture result gets the dialog\'s own title back after a server action renamed it', () => {
  const title = /const INFER_DIALOG_TITLE = '([^']+)'/.exec(main)?.[1]
  assert.ok(title && html.includes(`<span id="infer-dialog-title">${title}</span>`), 'the markup\'s own title')
  const dialog = topLevelFunction('showInferDialog')
  assert.match(dialog, /if \(title\) title\.textContent = INFER_DIALOG_TITLE/)
  assert.ok(dialog.indexOf('INFER_DIALOG_TITLE') > dialog.indexOf('if (dets.length === 0) return'), 'only when there is a result to title')
})

test('FN-015: the starting Place is read from sessionStorage only, where it is written', () => {
  const resolve = topLevelFunction('resolveInitialProject')
  assert.match(resolve, /storedSelection: sessionStorage\.getItem\(PLACE_SELECTION_SESSION_KEY\),/)
  assert.doesNotMatch(resolve, /localStorage\.getItem/)
})

test('F-44, FN-014: the Place picker reads the list through fetchPlaceList, and main.ts has no reader of its own', () => {
  assert.doesNotMatch(main, /function fetchProjects\(/)
  assert.doesNotMatch(main, /fetch\(apiUrl\('\/projects'\)\)/, 'no bare GET /projects')
  assert.match(main, /const list = await fetchPlaceList\(\)\n\s+const listFailed = !list\.ok\n\s+const listed = list\.places/)
})

test('FN-022: the live feed is wired before the calibration; the camera-frame default and the probe log stay after it', () => {
  const calibrate = at('await calibrateScan()')
  assert.ok(at('if (WEBRTC_LIVE_ENABLED) {') < calibrate, 'the broadcaster')
  assert.ok(at('cameraFrames.autoStart(selectedProject !== null)') > calibrate, 'the default stream follows the Place the calibration settles')
  assert.ok(at('installProbeLog({') > calibrate, 'a probe tap is never a point the frame was built from')
})

test('FN-028, FN-108: a person clip is recorded and uploaded in a take, with this page\'s member id', () => {
  const mint = new Function('newTakeId', 'newClientId', 'console', `${stripTypeScriptTypes(topLevelFunction('mintClipTake'))}\nreturn mintClipTake`)(
    newTakeId, newClientId, { warn() {} },
  ) as (clientId: string | null) => { takeId: string, clientId: string } | null
  const first = mint(null)!
  assert.ok(isTakeId(first.takeId) && isClientId(first.clientId), 'ids the server accepts (server/main.ts validates both)')
  const second = mint(first.clientId)!
  assert.equal(second.clientId, first.clientId, 'one member id per page')
  assert.notEqual(second.takeId, first.takeId, 'a new take per recording')
  const noCrypto = new Function('newTakeId', 'newClientId', 'console', `${stripTypeScriptTypes(topLevelFunction('mintClipTake'))}\nreturn mintClipTake`)(
    () => { throw new TypeError('crypto.randomUUID is not a function') }, newClientId, { warn() {} },
  ) as (clientId: string | null) => unknown
  assert.equal(noCrypto(null), null, 'a browser that cannot mint ids sends the clip without a take, as before')
  assert.match(mainBody, /new ClipRecorder\(provider, \{ takeId: take\?\.takeId \?\? null, clientId: take\?\.clientId \?\? null \}\)/)
  assert.match(mainBody, /takeId: take\?\.takeId \?\? null,\n\s+clientId: take\?\.clientId \?\? null,\n\s+onProgress:/, 'the upload names the same take')
})

test('FN-017: the dead CSS rule and the never-visible placeholders are gone; #gimbal-link stays, and is listed', () => {
  assert.doesNotMatch(html, /#geo-accuracy\s*\{/)
  assert.match(html, /<span id="geo-address"><\/span>/)
  assert.match(html, /<span id="geo-coords"><\/span>/)
  assert.match(html, /id="gimbal-link" hidden/, 'left in place: a deletion candidate, not deleted')
})
