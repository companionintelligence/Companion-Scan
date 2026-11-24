/**
 * The Gimbal control page's rules (subsystems/osmo-ble/web/page-state.mjs), which backend-client.mjs
 * applies to the DOM. Inventory findings F-50 and FN-178 to FN-191:
 *
 * - the Capture choice is sent;
 * - Stop works while sweeping and while parked;
 * - a parked run unlocks what the backend allows;
 * - the plan is checked against the backend's arc;
 * - nothing re-enables blindly, and Run unlocks on one tier;
 * - the progress bar moves on every position;
 * - the status dot is green while telemetry streams;
 * - the test matrix knows when its routes are off.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/gimbal_page_state.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  controlStates,
  statusDotOn,
  progressPercent,
  gridRequestBody,
  axisValues,
  panColumns,
  presetFields,
  planSummary,
  stationCount,
  SCAN_PRESETS,
  MAX_STEPS_PER_AXIS,
} from '../../../subsystems/osmo-ble/web/page-state.mjs'
import { DEFAULT_PAN_ARC, makeArc, unreachablePans } from '../../../subsystems/osmo-ble/protocol/dome.mjs'

const STREAMING = { backendUp: true, linked: true, streaming: true, testRoutes: true }

// ── Which controls are live ───────────────────────────────────────────────────────────────────

test('idle and streaming: everything is live except Stop', () => {
  const c = controlStates(STREAMING)
  assert.deepEqual(c, { linkControls: true, manual: true, photo: true, tests: true, run: true, stop: false })
})

test('linked but not streaming: writes stay (the joystick can still stop latched motors); reads do not', () => {
  const c = controlStates({ backendUp: true, linked: true, streaming: false, testRoutes: true })
  assert.equal(c.manual, true, 'the joystick stays: a silent gimbal may still be driving')
  assert.equal(c.photo, true)
  assert.equal(c.run, false, 'a closed-loop run needs telemetry')
  assert.equal(c.tests, false, 'a probe verdict is a pose comparison')
})

test('sweeping: manual motion, photos, tests and Run are locked; Stop is live', () => {
  const c = controlStates({ ...STREAMING, scanning: true })
  assert.equal(c.manual, false)
  assert.equal(c.photo, false)
  assert.equal(c.tests, false)
  assert.equal(c.run, false)
  assert.equal(c.stop, true)
})

test('parked between stations: the manual controls the backend allows come back; Photo and Run do not', () => {
  const c = controlStates({ ...STREAMING, scanning: true, parked: true })
  assert.equal(c.manual, true, 'joystick, Center, orientation, stick, raw: the backend lets them through while parked')
  assert.equal(c.tests, true, 'the probes are outside motions the parked backend also allows')
  assert.equal(c.photo, false, "a camera run holds the phone's one MCP session the whole time")
  assert.equal(c.run, false, 'one capture at a time')
  assert.equal(c.stop, true, 'and Stop ends it here, on a clean seam')
})

test('Stop needs the backend, not the gimbal link: a capture whose link dropped can still be stopped', () => {
  assert.equal(controlStates({ backendUp: true, scanning: true }).stop, true)
  assert.equal(controlStates({ backendUp: false, scanning: true }).stop, false)
})

test('one tier for Run: an unreachable plan, a busy request or a mere link keeps it off', () => {
  assert.equal(controlStates({ ...STREAMING, planReachable: false }).run, false)
  assert.equal(controlStates({ ...STREAMING, busy: { run: true } }).run, false)
  assert.equal(controlStates({ backendUp: true, linked: true }).run, false, 'linked is not enough')
})

test('a request in flight keeps its own button off, and nothing else', () => {
  const c = controlStates({ ...STREAMING, busy: { photo: true } })
  assert.equal(c.photo, false)
  assert.equal(c.manual, true)
  assert.equal(controlStates({ ...STREAMING, scanning: true, busy: { stop: true } }).stop, false)
})

test('test routes off: the matrix stays off whatever the link', () => {
  assert.equal(controlStates({ ...STREAMING, testRoutes: false }).tests, false)
})

test('disconnected: nothing that talks to the gimbal is live', () => {
  const c = controlStates({ backendUp: true })
  assert.equal(c.linkControls || c.manual || c.photo || c.tests || c.run || c.stop, false)
})

// ── The status dot ────────────────────────────────────────────────────────────────────────────

test('status dot: green while telemetry streams, paired or not', () => {
  assert.equal(statusDotOn({ link: 'streaming', text: 'backend: streaming telemetry' }), true)
  assert.equal(statusDotOn({ text: 'backend: streaming telemetry' }), true, 'the text rule alone, which used to say no')
})

test('status dot: "LINKED BUT NOT STREAMING" is not green, by attribute or by text', () => {
  assert.equal(statusDotOn({ link: 'linked', text: 'backend: LINKED BUT NOT STREAMING — no notify' }), false)
  assert.equal(statusDotOn({ text: 'backend: LINKED BUT NOT STREAMING — no notify' }), false)
})

test('status dot: the attribute decides over the text, and covers both pathways', () => {
  assert.equal(statusDotOn({ link: 'connected', text: 'Connected: OM6' }), true, 'Direct pathway')
  assert.equal(statusDotOn({ link: 'disconnected', text: 'backend connected' }), false)
  assert.equal(statusDotOn({ link: 'unknown', text: 'backend connected' }), false, 'no gimbal state yet')
  for (const text of ['Disconnected', 'Not connected', 'backend not reachable at x', 'backend refused this page: ...']) {
    assert.equal(statusDotOn({ text }), false, text)
  }
})

// ── The progress bar ──────────────────────────────────────────────────────────────────────────

test('progress: moving moves the bar too (that half used to be unreachable), and a new run starts at 0', () => {
  assert.equal(progressPercent({ phase: 'start', total: 8 }), 0)
  assert.equal(progressPercent({ phase: 'moving', position: 2, total: 8 }), 25)
  assert.equal(progressPercent({ phase: 'capturing', position: 2, total: 8 }), 25)
  assert.equal(progressPercent({ phase: 'captured', position: 3, total: 8 }), 38)
  assert.equal(progressPercent({ phase: 'awaiting-station', nextStation: 2 }), null, 'a pause leaves it where it is')
  assert.equal(progressPercent({ phase: 'done', complete: true }), 100)
  assert.equal(progressPercent({ phase: 'done', complete: false }), null, 'a partial run is not shown as full')
  assert.equal(progressPercent({ phase: 'moving', position: 1, total: 0 }), null)
})

// ── What Run scan sends ───────────────────────────────────────────────────────────────────────

test('Run scan sends the Capture choice: Scanner app means no photos and no second orientation', () => {
  const plan = { pans: [96, 121], tilts: [-25, 5], stations: 4 }
  assert.deepEqual(gridRequestBody({ ...plan, captureMode: 'scanner', bothOrientations: true }), {
    ...plan, capturePhotos: false, bothOrientations: false,
  })
  assert.deepEqual(gridRequestBody({ ...plan, captureMode: 'camera', bothOrientations: true }), {
    ...plan, capturePhotos: true, bothOrientations: true,
  })
  assert.equal(gridRequestBody({ ...plan, captureMode: 'camera' }).bothOrientations, false)
})

// ── The plan, against the arc the backend uses ────────────────────────────────────────────────

test('presets on the built-in arc keep the columns the fixed presets had: 7, 4 and 9', () => {
  assert.deepEqual(presetFields('dome', DEFAULT_PAN_ARC)?.pan, { from: 96, to: -114, step: 25 })
  assert.deepEqual(presetFields('quick25', DEFAULT_PAN_ARC)?.pan, { from: 111, to: -129, step: 40 })
  assert.deepEqual(presetFields('band', DEFAULT_PAN_ARC)?.pan, { from: 91, to: -109, step: 20 })
  assert.equal(presetFields('custom', DEFAULT_PAN_ARC), null)
  assert.deepEqual(Object.keys(SCAN_PRESETS), ['dome', 'quick25', 'band'])
  // The fixed presets at e897380, walked the way the page walks them. Same column counts, every
  // column reachable, and the last column on the far end of the span.
  const old = { dome: { from: 96, to: -114, step: 25 }, quick25: { from: 111, to: -129, step: 40 }, band: { from: 92, to: -104, step: 20 } }
  for (const name of Object.keys(old) as (keyof typeof old)[]) {
    const now = panColumns(presetFields(name, DEFAULT_PAN_ARC)!.pan, DEFAULT_PAN_ARC)
    assert.equal(now.length, panColumns(old[name], DEFAULT_PAN_ARC).length, `${name} keeps its column count`)
    assert.deepEqual(unreachablePans(now, DEFAULT_PAN_ARC), [], name)
    assert.equal(now.at(-1), presetFields(name, DEFAULT_PAN_ARC)!.pan.to, `${name}'s last column is its far end`)
  }
})

test('preset ends round inward, so a measured arc with fractional stops never puts one past a stop', () => {
  // Rounded to the nearest degree, 10.4 became 10, which is outside this arc. Read along the arc
  // that is the far side of the dead zone, and Dome came out mostly unreachable with Run disabled.
  for (const [startDeg, endDeg] of [[10.4, 150.6], [10.4, 160.4], [-1.5, 163.5], [100.6, -120.6]]) {
    const arc = makeArc({ startDeg, endDeg, source: 'measured', measuredAt: 1 })
    for (const name of Object.keys(SCAN_PRESETS)) {
      const pans = panColumns(presetFields(name, arc)!.pan, arc)
      assert.ok(pans.length >= 2, `${name} on ${startDeg}..${endDeg} has columns: ${pans}`)
      assert.deepEqual(unreachablePans(pans, arc), [], `${name} on ${startDeg}..${endDeg}: ${pans}`)
    }
  }
})

test('the Dome preset is 7 x 2 = 14 positions per station, which the docs now say', () => {
  const f = presetFields('dome', DEFAULT_PAN_ARC)!
  assert.equal(panColumns(f.pan, DEFAULT_PAN_ARC).length, 7)
  assert.equal(axisValues(f.tilt).length, 2)
})

test('after a probe measures the arc elsewhere, every preset still fits inside it', () => {
  const measured = makeArc({ startDeg: -1, endDeg: 163, source: 'measured', measuredAt: 1 })
  for (const name of Object.keys(SCAN_PRESETS)) {
    const f = presetFields(name, measured)!
    const pans = panColumns(f.pan, measured)
    assert.deepEqual(unreachablePans(pans, measured), [], name)
    // The same fields judged against the fallback would have looked fine or wrong for the wrong reason.
  }
  const dome = panColumns(presetFields('dome', measured)!.pan, measured)
  assert.ok(dome.includes(81), 'centred on the measured arc (-1..163, centre 81), not on the fallback (171)')
})

test('the columns are built and checked along the backend arc: the fallback dome is refused on a measured arc', () => {
  const measured = makeArc({ startDeg: -1, endDeg: 163, source: 'measured', measuredAt: 1 })
  const fallbackDome = panColumns({ from: 96, to: -114, step: 25 }, DEFAULT_PAN_ARC)
  const summary = planSummary({ pans: fallbackDome, tilts: [-25, 5], stations: 4, arc: measured })
  assert.equal(summary.reachable, false, 'the page used to accept this, checking against the fallback')
  assert.match(summary.warnings[0], /past a stop of the arc in use .* measured from this tripod position/)
})

test('plan summary: counts, the one-station warning, the scanner threshold and the cap', () => {
  const ok = planSummary({ pans: [96, 121, 146], tilts: [-25, 5], stations: 4, arc: DEFAULT_PAN_ARC, captureMode: 'camera', panStep: 25, tiltStep: 30 })
  assert.deepEqual(ok, { perStation: 6, total: 24, reachable: true, warnings: [], capped: false })
  const one = planSummary({ pans: [171], tilts: [0], stations: 1, arc: DEFAULT_PAN_ARC })
  assert.match(one.warnings.join(' '), /one station is pure rotation/)
  const fine = planSummary({ pans: [171], tilts: [0], stations: 3, arc: DEFAULT_PAN_ARC, captureMode: 'scanner', panStep: 15, tiltStep: 30 })
  assert.match(fine.warnings.join(' '), /pan 15° below the scanner's 20° keyframe threshold/)
  const sameInCamera = planSummary({ pans: [171], tilts: [0], stations: 3, arc: DEFAULT_PAN_ARC, captureMode: 'camera', panStep: 15 })
  assert.deepEqual(sameInCamera.warnings, [], 'camera mode has no keyframe threshold')
  // The stride floors at 1 degree, so 62 values were asked for here.
  const many = axisValues({ from: -45, to: 16, step: 1 })
  assert.equal(many.length, MAX_STEPS_PER_AXIS)
  assert.equal(planSummary({ pans: [171], tilts: many, stations: 3, arc: DEFAULT_PAN_ARC }).capped, true)
})

test('station count: floored at 1, capped at 12 like the backend, and an empty field is not zero', () => {
  assert.equal(stationCount(''), 1)
  assert.equal(stationCount('0'), 1)
  assert.equal(stationCount('4'), 4)
  assert.equal(stationCount('4.9'), 4)
  assert.equal(stationCount('99'), 12)
  assert.equal(stationCount('abc'), 1)
})
