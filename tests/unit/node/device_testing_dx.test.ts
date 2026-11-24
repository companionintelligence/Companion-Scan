/**
 * docs/testing/DEVICE_TESTING.md, the arms of Procedure 3 (DX1), the handedness column of Procedure 2 (DX2), and
 * Procedure 6 (DX6), held to the code they send a person to. Procedure 8 (DX8) arrived with the printed-marker reader it
 * measures, and tests/unit/node/fiducial_device_doc.test.ts holds it to that code; this file keeps the probe run Procedure 8
 * leaves for the marker step, and the rule on debug flags that every procedure here is held to.
 *
 * A device procedure is only as good as its instrument. One that names a scale string the build never writes, a log line
 * the build never prints, or a debug flag that does not exist sends someone to read a number that is not there, on a day
 * that needs a phone and a tape. Procedure 6 is written ahead of the package whose readouts it uses (WP-17b), so a second
 * rule holds it honest: anything the build does not write yet is marked "after WP-xx" in the same table row or paragraph,
 * and anything unmarked has to exist. The existing test, device_testing_probe.test.ts, holds
 * every `line.<field>` to the probe line; this one holds the rest.
 *
 * That the procedures are followable is for a person with a phone. These tests hold what a person cannot check afterwards:
 * the strings, the log lines, the numbers that must agree with each other and with the constants they are judged against, the
 * arithmetic a step asks a person to do (the change in Δ across a loss, the floor mark laid with two tapes, the totals of
 * negative candidates), and the claims a step makes about the build (what moves the reference of Δ, what a refused anchor request
 * carries, which features the build asks for), so that a change to the build that makes a sentence false fails here.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/device_testing_dx.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ENGINE_SCALE,
  EngineScaleSession,
  ORIGIN_Y_MAX_M,
  ORIGIN_Y_MIN_M,
  resolveOriginY,
} from '../../../src/ar/engine-config.ts'
import {
  ANCHOR_REQUEST_TIMEOUT_MS,
  ANCHORS_FEATURE,
  MAX_PERSISTENT_ANCHORS,
  createPersistentAnchorStore,
  persistAnchor,
  type AnchorCapability,
} from '../../../src/ar/anchors.ts'
import { formatPoseDelta, poseDelta } from '../../../src/capture/pose-delta.ts'
import { PROBE_KEYS } from '../../../src/capture/probe-log.ts'
import { FRAME_JUMP_TRANSLATION_M, FRAME_LOG_MAX, describeTracking } from '../../../src/ar/frame-epoch.ts'
import { asScaleMode } from '../../../src/world/scale-mode.ts'
import { DEFAULT_SEPARATION_TOLERANCE_M, MIN_POINT_SEPARATION_M, transformPoint, twoPointToProjectTransform } from '../../../src/world/geo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DOC = readFileSync(join(ROOT, 'docs/testing/DEVICE_TESTING.md'), 'utf8')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** The text of one section: from its heading to the next heading of the same or a higher level. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n${heading}\n`)
  assert.ok(start !== -1, `DEVICE_TESTING.md has no section "${heading}"`)
  const level = heading.match(/^#+/)![0].length
  const rest = DOC.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'))
  return next === -1 ? rest : rest.slice(0, next)
}

/** A table row or a paragraph of a section, so that "after WP-xx" can be required in the same place as what it marks. */
function chunks(text: string): string[] {
  const out: string[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) out.push(paragraph.join(' '))
    paragraph = []
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') flush()
    else if (line.startsWith('|')) {
      flush()
      out.push(line)
    } else paragraph.push(line.trim())
  }
  flush()
  return out
}

const flat = (text: string): string => text.replace(/\s+/g, ' ')

const PROC2 = '### Procedure 2 — probe-point protocol (DX2)'
const PROC3 = '### Procedure 3 — units tape test (DX1)'
const PROC6 = '### Procedure 6 — WebXR runtimes: resets, tracking loss and anchors (DX6)'
const PROC8 = '### Procedure 8 — reading a printed marker (DX8)'

// ── DX1: the arms ────────────────────────────────────────────────────────────────────────────

/** The address in the first backticks of an arm's row of the arms table. */
function armAddress(arm: 'R0' | 'A' | 'R1'): string {
  const row = section(PROC3).split('\n').find((line) => line.startsWith(`| **${arm}** |`))
  assert.ok(row, `the arms table has no row for arm ${arm}`)
  const address = /^\| \*\*\w+\*\* \| `([^`]+)`/.exec(row)?.[1]
  assert.ok(address, `arm ${arm} gives no address`)
  return address
}

/** What the `line.scale` cell of an arm's row says. */
function armScaleCell(arm: 'R0' | 'A' | 'R1'): string {
  const row = section(PROC3).split('\n').find((line) => line.startsWith(`| **${arm}** |`))!
  return row.split('|')[3]!
}

const silent = (t: test.TestContext): void => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
}

test('every scale string Procedure 3 names is a mode the build can write', () => {
  const named = [...section(PROC3).matchAll(/`((?:responsive|absolute|webxr|native)-[A-Za-z]+(?::[0-9.]+)?)`/g)].map((m) => m[1]!)
  assert.ok(named.length >= 8, 'the arms table and its notes name the strings a run can read')
  for (const mode of named) assert.ok(asScaleMode(mode), `"${mode}" is not a scale mode: the document sends a person to read a string the line never holds`)
})

test('arm R0: the address the document gives leaves the engine alone, and the line reads what the document says', (t) => {
  silent(t)
  const calls: string[] = []
  const engine = { XrController: { configure: () => calls.push('configure'), updateCameraProjectionMatrix: () => calls.push('origin') } }
  const session = new EngineScaleSession()
  session.configure(engine, `?${armAddress('R0').replace(/^\?/, '')}`)
  assert.deepEqual(calls, [], 'arm R0 is the build as it is: no call is made to the engine')
  assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  assert.ok(armScaleCell('R0').includes('`responsive-unconfigured`') && armScaleCell('R0').includes('`webxr-metric`'))
  assert.ok(asScaleMode('webxr-metric'), 'the metric control reads a mode that exists')
})

test('arm A: the address asks for absolute scale, and the line reads absolute-ready only while tracking is NORMAL', (t) => {
  silent(t)
  const address = armAddress('A')
  assert.match(address, /^\?scale=absolute&/, 'the first parameter is the switch')
  // Arm A has a person read `pos` off the pose readout and the status lines off the relay: those are `pose` and `verbose`. The other arms
  // read neither, and `verbose` fills the relay's 50-message buffer with the scanner's ticks, so they leave it out.
  const flagsOf = (arm: 'R0' | 'A' | 'R1'): string[] => /debug=([A-Za-z,]+)/.exec(armAddress(arm))![1]!.split(',')
  assert.ok(flagsOf('A').includes('pose') && flagsOf('A').includes('verbose') && flagsOf('A').includes('probe') && flagsOf('A').includes('remote'))
  assert.ok(!flagsOf('R0').includes('verbose') && !flagsOf('R1').includes('verbose'))
  const armA = flat(section(PROC3))
  assert.ok(armA.includes('read `pos` (the second number is the height) in the `?debug=pose` readout'))
  assert.ok(armA.includes('`[8thwall] trackingStatus: NORMAL` line'))
  const configured: unknown[] = []
  const session = new EngineScaleSession()
  session.configure({ XrController: { configure: (config: unknown) => configured.push(config) } }, address)
  assert.deepEqual(configured, [{ scale: 'absolute' }])
  assert.equal(session.mode('NORMAL'), 'absolute-ready')
  assert.equal(session.mode('LIMITED'), 'absolute-notready')
  const refused = new EngineScaleSession()
  refused.configure({ XrController: { configure: () => { throw new Error('refused') } } }, address)
  assert.equal(refused.mode('NORMAL'), 'absolute-notapplied', 'a run whose setting was refused is not an arm A run')
  const cell = armScaleCell('A')
  assert.ok(cell.includes('`absolute-ready`') && cell.includes('`absolute-notready`'))
  assert.ok(flat(section(PROC3)).includes('`absolute-notapplied` in arm A means the engine did not take the setting'))
})

test('arm R1: for each start height the address sets the origin height and the line reads responsive-originY with that height', (t) => {
  silent(t)
  const address = armAddress('R1')
  assert.match(address, /^\?originY=<h>&/, 'the first parameter is the switch')
  const cell = armScaleCell('R1')
  for (const height of ['1.0', '1.3', '1.6']) {
    const applied: unknown[] = []
    const engine = { XrController: { updateCameraProjectionMatrix: (args: unknown) => applied.push(args) } }
    const session = new EngineScaleSession()
    session.configure(engine, address.replace('<h>', height))
    assert.equal(session.applyOrigin(engine, { position: { set: () => {} } }), true, `a start height of ${height} m is accepted`)
    const expected = `responsive-originY:${Number(height)}`
    assert.equal(session.mode('NORMAL'), expected)
    assert.ok(cell.includes(`\`${expected}\``), `the arms table does not say arm R1 reads ${expected}`)
    assert.equal(applied.length, 1)
  }
  const ignored = new EngineScaleSession()
  ignored.configure({}, address.replace('<h>', '14'))
  assert.equal(ignored.mode('NORMAL'), 'responsive-unconfigured', 'a height outside the range is not applied: the document says to run it again')
})

test('arm R1: <h> is the nominal height typed into the address, the camera is held to it within 2 cm, and that tolerance costs less than the 3% the arm is judged by', (t) => {
  silent(t)
  const text = flat(section(PROC3))
  assert.ok(text.includes('with `<h>` the nominal start height of the run (1.0, 1.3 or 1.6), typed into the address before the run'))
  assert.ok(text.includes('In arm R1 `<h>` is the nominal height, and the camera is held to it, not the other way round: the arm treats `<h>` as the true start height, so every centimetre between the two is an error in the unit (2 cm at 1.0 m is 2%, against the 3% this procedure judges by).'))
  assert.ok(text.includes('hold the camera within 2 cm of `<h>` by the tape before **Start AR** (adopted, not measured), hold it again if it is not, and write the tape reading beside `<h>`'))
  // The arm's own premise: the unit is height held over height typed. At 2 cm the worst case is 2% (at the lowest start height), under the 3% line.
  const worstUnitError = Math.max(...[1.0, 1.3, 1.6].map((nominal) => 0.02 / nominal))
  assert.equal(Math.round(worstUnitError * 1000) / 10, 2)
  assert.ok(worstUnitError < 0.03)
  assert.ok(text.includes('within 3% of the tape (between 2.910 and 3.090 m)'))
  // A height typed from a tape reading is not one of the three arms' strings, which is why the address carries the nominal one.
  const read = (search: string): string => {
    const engine = { XrController: { updateCameraProjectionMatrix: () => {} } }
    const session = new EngineScaleSession()
    session.configure(engine, search)
    session.applyOrigin(engine, { position: { set: () => {} } })
    return session.mode('NORMAL')
  }
  assert.equal(read('?originY=1.3&debug=remote,probe'), 'responsive-originY:1.3')
  assert.equal(read('?originY=1.27&debug=remote,probe'), 'responsive-originY:1.27', 'a measured height reads as a fourth string, which the arm\'s must-read cell does not list')
  assert.ok(text.includes('`npm run qr -- "?originY=1.3&debug=remote,probe"`'))
})

test('arm A: the live cue is the calibration card\'s tracking line, which reads what the document says, and the arm asks for motion where the other arms ask for stillness', () => {
  assert.ok(describeTracking({ status: 'NORMAL', poseJumps: 0, lastJumpM: 0 }).text.startsWith('Tracking NORMAL'), 'the card\'s line begins with the word the document tells a person to wait for')
  assert.ok(describeTracking({ status: 'LIMITED', poseJumps: 0, lastJumpM: 0 }).text.startsWith('Tracking LIMITED'))
  // The card shows it through the one formatter the document's cue is checked against.
  assert.match(read('src/ar/project-calibration.ts'), /describeTracking\(/)
  const text = flat(section(PROC3))
  assert.ok(text.includes('**In arm A** the engine settles its estimate while the phone is moved, so step 2\'s "keep still" does not apply: after **Start AR** move the phone gently back and forth until the calibration card\'s tracking line reads `Tracking NORMAL`, then bring it back to the start height and hold it still. That line is the live cue (start a stopwatch at the tap and stop it there; the log has the exact times afterwards).'))
  assert.ok(text.includes('and keep still until it tracks (in arm A the phone is moved instead, as the arm says below)'))
  assert.ok(text.includes('Niantic describes the phone as moved back and forth until it settles ([announcement](https://info.nianticspatial.com/blog/introducing-absolute-scale))'), 'the movement is attributed to the page that says it, not to the configure page')
  // The per-run table has a place for every reading the four items ask for, and a notes column.
  const header = section(PROC3).split('\n').find((line) => line.startsWith('| Run | Runtime | Start height: nominal / tape (m) | Time to NORMAL (s)'))
  assert.ok(header, 'the arm A table exists')
  for (const column of ['Time to NORMAL (s)', '`trackingStatus` lines before it that were not NORMAL', 'Camera height after NORMAL (m, `pos`)', 'Time to tap-ready (s) and the motion asked for', 'Discontinuity lines in the 60 s (`cause`, `translationM`, `yawDeg`)', '`line.sepM` (m)', '`line.scale`', 'Notes']) {
    assert.ok(header.includes(column), `the arm A table has no column for: ${column}`)
  }
  // Every run is a row: three heights of five runs.
  const rows = section(PROC3).split('\n').filter((line) => /^\| \d+ \| \| \d\.\d \/ \|/.test(line))
  assert.equal(rows.length, 15)
})

test('Procedure 3 states the range ?originY= accepts and the start heights it uses, and they agree with the code', () => {
  const text = flat(section(PROC3))
  const range = /`\?originY=` takes ([\d.]+) to ([\d.]+) m/.exec(text)
  assert.ok(range, 'the arms table is followed by the range ?originY= takes')
  assert.deepEqual([Number(range[1]), Number(range[2])], [ORIGIN_Y_MIN_M, ORIGIN_Y_MAX_M])
  for (const height of [1.0, 1.3, 1.6]) assert.equal(resolveOriginY(`?originY=${height}`), height, `${height} m is a height ?originY= accepts`)
  assert.match(text, /ignored in absolute scale/)
})

test('the pass rule for flipping the default is the adopted one, in the document and in the constants it is judged against', () => {
  const text = flat(section(PROC3))
  assert.ok(text.includes('**Decision for arm A: flipping the default.**'))
  assert.ok(text.includes('**adopted, not measured** (ADR 0005 rule 5)'), 'the figures say they are not measurements')
  for (const stated of [
    'within 3% of the tape and the spread is under 2% at every start height',
    'At least 4 of the 5 runs at each height reach NORMAL within 20 s of the camera starting',
    'median time to NORMAL is 10 s or less',
    'within 5 cm of the start height you measured with the tape',
    'No `frame discontinuity` line in the 60 s hold after the first NORMAL',
  ]) assert.ok(text.includes(stated), `the pass rule no longer says "${stated}"`)
  // The jump the last bullet calls a jump is the one the build's own epoch rule uses, so the two cannot drift apart.
  assert.equal(FRAME_JUMP_TRANSLATION_M, 0.3)
  assert.ok(text.includes('0.30 m a jump: `FRAME_JUMP_TRANSLATION_M` in `src/ar/frame-epoch.ts`'))
  // The flip is one line, in the file and under the name the document gives, and the default has not been flipped.
  assert.equal(DEFAULT_ENGINE_SCALE, 'responsive', 'the default is flipped by the owner (D3) after the table, not before')
  assert.ok(text.includes('`DEFAULT_ENGINE_SCALE` in `src/ar/engine-config.ts`'))
  assert.ok(read('src/ar/engine-config.ts').includes('export const DEFAULT_ENGINE_SCALE'))
})

// ── DX2: handedness ──────────────────────────────────────────────────────────────────────────

/**
 * What the Place frame says of a mark 4 m along and 2.5 m to one side of the line from A to B, for a session where B lies along `heading`
 * (degrees, any direction): standing on A and looking at B, the left-hand side is +Y x forward, that is (forward.z, 0, -forward.x).
 */
function placeFrameXOfSides(heading: number): { onLeft: { x: number; z: number }; onRight: { x: number; z: number } } {
  const a = (heading * Math.PI) / 180
  const forward = { x: Math.sin(a), z: Math.cos(a) }
  const left = { x: forward.z, z: -forward.x }
  const A = { x: 1.5, y: -1.2, z: -0.7 }
  const B = { x: A.x + 2 * forward.x, y: A.y, z: A.z + 2 * forward.z }
  const toPlace = twoPointToProjectTransform(A, B)
  return {
    onLeft: transformPoint(toPlace, { x: A.x + 4 * forward.x + 2.5 * left.x, y: A.y, z: A.z + 4 * forward.z + 2.5 * left.z }),
    onRight: transformPoint(toPlace, { x: A.x + 4 * forward.x - 2.5 * left.x, y: A.y, z: A.z + 4 * forward.z - 2.5 * left.z }),
  }
}

test('Procedure 2: a mark on the left of A to B, looking from A at B, has a positive x in the Place frame', () => {
  const text = flat(section(PROC2))
  assert.match(text, /a mark on your left must come out with a positive `line\.px` and one on your right with a negative one/)
  assert.match(text, /Which side\.\*\* For C and for D also write down which side of the line from A to B/)
  // The Place frame puts A at the origin and B on +Z, so a point on the left must read x > 0 and one on the right x < 0, whichever way B lies.
  for (const heading of [0, 37, 90, 135, 180, 251, 300]) {
    const { onLeft, onRight } = placeFrameXOfSides(heading)
    assert.ok(onLeft.x > 2.49 && Math.abs(onLeft.z - 4) < 1e-9, `heading ${heading}: left of A to B reads x ${onLeft.x}`)
    assert.ok(onRight.x < -2.49 && Math.abs(onRight.z - 4) < 1e-9, `heading ${heading}: right of A to B reads x ${onRight.x}`)
  }
})

test('Procedure 2 reads handedness the way the geometry gives it (left is positive), calls a disagreement a mirrored frame, and takes the spread as the sample standard deviation', () => {
  const text = flat(section(PROC2))
  // The sentence that says how to read the side against the sign names the same sides the geometry does, in both places it says so.
  const rule = /5\. \*\*Handedness\.\*\* Put the side you wrote down for each mark beside the sign of its five `line\.px`\. They agree when (\w+) is positive and (\w+) is negative in every session\. If they disagree on a runtime, its Place frame comes out mirrored: that is the finding, and its x errors are not to be read until it is explained\./.exec(text)
  assert.ok(rule, 'the handedness step no longer says what agreement is, and what a disagreement means')
  const { onLeft, onRight } = placeFrameXOfSides(63)
  const positive = onLeft.x > 0 && onRight.x < 0 ? 'left' : 'right'
  assert.deepEqual([rule[1], rule[2]], [positive, positive === 'left' ? 'right' : 'left'])
  assert.match(text, /a mark on your left must come out with a positive `line\.px` and one on your right with a negative one/)
  assert.match(text, /Handedness \(left positive, right negative, every session\)\? ______/)
  // The spread of five sessions is the sample standard deviation: dividing by n instead reads 10.6% too small (1 - sqrt(4/5)), a spread that looks better than it is.
  assert.ok(text.includes('**Spread** is the sample standard deviation (n − 1) of the five `line.px` and of the five `line.pz`. Call them σx and σz.'))
  assert.ok(Math.abs(1 - Math.sqrt(4 / 5) - 0.1056) < 1e-3)
  assert.ok(Math.abs(Math.sqrt(5 / 4) - 1) > 0.11)
})

test('Procedure 2 records the side beside every session and asks for the comparison, and keeps what it already had', () => {
  const text = section(PROC2)
  assert.match(text, /\| Session \| Mark \| Side of A→B \(L or R\) \| `line\.n` \| `line\.px` \(m\) \|/)
  assert.match(text, /\| Mark \| σx \(cm\) \| σz \(cm\) \| Bias x \(cm\) \| Bias z \(cm\) \| Largest of five errors \(cm\) \| Side agrees with the sign of `line\.px` in all five\? \|/)
  assert.match(flat(text), /5\. \*\*Handedness\.\*\* Put the side you wrote down for each mark beside the sign of its five `line\.px`/)
  assert.match(text, /Handedness \(left positive, right negative, every session\)\? ______/)
})

// ── The figures a procedure repeats, held to each other and to the code ──────────────────────────────

/** How many messages the remote-log relay keeps, from its own source. */
function relayBufferSize(): number {
  return Number(/const MAX_BUFFERED = (\d+)/.exec(read('src/debug/remote-log.ts'))![1])
}

test('Procedure 3: the run counts, the tape length, the start heights and the figures it repeats agree with each other and with the code', () => {
  const text = flat(section(PROC3))
  // 5 runs at each of 3 start heights is 15 a runtime, and 45 over the 3 runtimes.
  assert.equal(5 * 3, 15)
  assert.equal(5 * 3 * 3, 45)
  assert.ok(text.includes('Do **5 runs at each of three start heights, 1.0 m, 1.3 m and 1.6 m, on each runtime**: 45 runs for the arm described by the steps below'))
  assert.ok(text.includes('Each arm is 15 runs per runtime, 5 at each start height.'))
  assert.ok(text.includes('(the means at 1.0, 1.3 and 1.6 m move together with the height)'))
  // One tape length, wherever it is written: the tolerances are 3%, 2% and 5% of it.
  const lengths = [...text.matchAll(/(\d+\.000)/g)].map((m) => m[1])
  assert.ok(lengths.length >= 3 && lengths.every((length) => length === '3.000'), `the tape length is written as ${[...new Set(lengths)]}`)
  assert.deepEqual([3 * 0.97, 3 * 1.03, 3 * 0.02, 3 * 0.05].map((n) => n.toFixed(3)), ['2.910', '3.090', '0.060', '0.150'])
  // The 0.15 m the introduction names is the scanner's own separation gate, and the tap range is the one Procedure 2 uses.
  assert.equal(DEFAULT_SEPARATION_TOLERANCE_M, 0.15)
  assert.ok(text.includes('from the 0.15 m separation gate'))
  assert.ok(text.includes('One tap each, from no more than 2 m away, the phone looking steeply down.'))
  assert.ok(flat(section(PROC2)).includes('One tap each, from no more than 2 m away, the phone looking steeply down and held still while the ring on the card fills'))
  // The 60 s of arm A are the same 60 s in the item and in the rule for flipping the default, and the relay buffer is the relay's.
  assert.ok(text.includes('appears in the 60 s after the first NORMAL') && text.includes('in the 60 s hold after the first NORMAL'))
  assert.equal(relayBufferSize(), 50)
  assert.ok(text.includes("fills the relay's 50-message buffer with the scanner's ticks"))
})

test('Procedure 6: the holds, the walk, the distances and the buffer it names agree with each other and with the code', () => {
  const text = flat(section(PROC6))
  const steps = stepCells(PROC6)
  // The 60 s hold of step 2 is the 60 s its pass line judges, and the 60 s and 10 min of step 8 are the ones its pass line judges.
  assert.ok(steps[1]![1]!.endsWith('Then hold still for 60 s') && steps[1]![2]!.includes('`Δ` at the end of the 60 s') && steps[1]![3]!.startsWith('No line in the 60 s.'))
  assert.ok(steps[7]![1]!.includes('stay still for 60 s, then walk step 4\'s route') && steps[7]![2]!.includes('at 60 s, at each return and at 10 min') && steps[7]![3]!.includes('at 10 min (the drift flag WP-17b adopts)'))
  // The walk is 10 minutes with a return every 2 to 3 minutes.
  assert.ok(steps[3]![1]!.includes('Walk 10 minutes through three rooms, back to A with the same facing every 2 to 3 minutes'))
  // Mark E lies beyond the 8 m of Google's guidance and mark D within it, which is what the comparison is for.
  const e = Number(/mark E (\d+) m from A/.exec(steps[7]![1]!)![1])
  const d = Number(/mark D within (\d+) m/.exec(steps[7]![1]!)![1])
  assert.ok(e > 8 && d <= 8 && text.includes('the 8 m guidance is Google\'s'), `E at ${e} m and D within ${d} m do not straddle the 8 m`)
  // The relay buffer, the cap the document quotes as reports, and the timeout of Chrome's own that step 7 cites with its source.
  assert.ok(text.includes("fills the relay's 50-message buffer") && relayBufferSize() === 50)
  assert.ok(text.includes('(reports say 5, 6 and 8)'))
  assert.match(read('src/ar/anchors.ts'), /So the cap may be 5, 6 or 8/)
  assert.ok(text.includes("what happens to a request that has waited 3 s (Chrome's own limit: its ARCore code fails a creation request older than that, `kOutdatedAnchorCreationRequestThreshold` in `device/vr/android/arcore/arcore_impl.cc`)"))
})

test('Procedure 2: the 15 cm line, the baselines, the session count and the product target it repeats agree with each other and with the code', () => {
  const text = flat(section(PROC2))
  // Five sessions of each of 3 baselines on each of 3 runtimes.
  assert.equal(5 * 3 * 3, 45)
  assert.ok(text.includes('Baselines of 2 m, 1.2 m and 4 m, five sessions each') && text.includes('That is 45 sessions'))
  // The 15 cm pass line is one number in all four places, and the product's 30.5 cm is the one design doc gives as 0.305 m.
  assert.equal([...text.matchAll(/\b15 cm\b/g)].length, 3, 'the pass line is written as 15 cm in the rule, in the fail line and in the results block')
  assert.ok(text.includes('15 cm or less') && text.includes('an error between 15 and 30.5 cm meets the product target and fails this one') && text.includes('**Fail** when it is more than 15 cm') && text.includes('Pass (largest error at D ≤ 15 cm)?'))
  assert.match(read('docs/product/PLACE_SCAN_DESIGN.md'), /less than one foot \(0\.305 m\) relative error/)
  // The short baseline leaves the scanner's own minimum a margin of 20 cm.
  assert.ok(Math.abs(1.2 - MIN_POINT_SEPARATION_M - 0.2) < 1e-12 && text.includes('1.2 m leaves 20 cm'))
})

// ── DX6 ──────────────────────────────────────────────────────────────────────────────────────

test('Procedure 6 step 1: the feature check answers as the document says on a phone, on a headset and where there is no WebXR', () => {
  const snippet = /run `(\[typeof self\.XRAnchor[^`]+\])`/.exec(section(PROC6))?.[1]
  assert.ok(snippet, 'step 1 gives the console snippet')
  const run = (self: object): unknown => new Function('self', `return ${snippet}`)(self)
  class PhoneAnchor { delete(): void {} }
  class PhoneSession {}
  class HeadsetAnchor { delete(): void {}; requestPersistentHandle(): void {} }
  class HeadsetSession { restorePersistentAnchor(): void {} }
  assert.deepEqual(run({ XRAnchor: PhoneAnchor, XRSession: PhoneSession }), ['function', 'undefined', 'undefined'])
  assert.deepEqual(run({ XRAnchor: HeadsetAnchor, XRSession: HeadsetSession }), ['function', 'function', 'function'])
  assert.deepEqual(run({}), ['undefined', 'undefined', 'undefined'], 'a browser with no WebXR anchors throws nothing')
  const text = flat(section(PROC6))
  assert.ok(text.includes('The phone answers `function`, `undefined`, `undefined` and the headset `function`, `function`, `function`'))
  // The members the snippet probes are the ones the build itself feature-detects.
  const anchors = read('src/ar/anchors.ts')
  assert.ok(anchors.includes("typeof session.restorePersistentAnchor === 'function'"))
  assert.ok(anchors.includes('requestPersistentHandle'))
})

test('every log line Procedures 3 and 6 name is one the build prints, at the level the document says', () => {
  const sources = ['src/ar/webxr.ts', 'src/ar/eighthwall.ts', 'src/main.ts'].map(read).join('\n')
  const text = flat([PROC3, PROC6].map(section).join('\n'))
  const named = new Set<string>()
  for (const match of text.matchAll(/`(\[(?:webxr|8thwall|scan)\](?:\[aspect\])?[^`]*)`/g)) {
    // Cut at the first placeholder, colon or bracketed value: what is left is the text the build writes verbatim.
    const prefix = match[1]!.split(/ <|: | \(<|\(/)[0]!.trim()
    if (prefix !== '[webxr]' && prefix !== '[8thwall]') named.add(prefix)
  }
  const expected = ['[webxr] frame discontinuity', '[webxr] trackingStatus', '[8thwall] trackingStatus', '[8thwall] Camera status', '[8thwall] frame discontinuity', '[scan] tracking degraded', '[scan] tracking recovered']
  for (const line of expected) assert.ok(named.has(line), `the procedures no longer name ${line}`)
  for (const line of named) assert.ok(sources.includes(line), `the document names the log line ${line}, which the build does not print`)
  // The levels: the relay carries console.warn under `remote` alone and console.log only under `verbose`.
  assert.match(sources, /console\.warn\(`\[webxr\] frame discontinuity/)
  assert.match(sources, /console\.warn\(`\[8thwall\] frame discontinuity/)
  assert.match(sources, /console\.warn\(recordingPaused/)
  assert.match(sources, /console\.log\('\[webxr\] trackingStatus:'/)
  assert.match(sources, /console\.log\('\[8thwall\] trackingStatus:'/)
  const proc6 = flat(section(PROC6))
  assert.ok(proc6.includes('Lines the page writes with `console.warn` reach `npm run logs:watch` and `scans/client-logs.jsonl` under `remote` alone'))
  assert.ok(proc6.includes('Add `verbose` only to see every status change (`[webxr] trackingStatus: ...`)'))
})

test('the fields of a discontinuity Procedure 6 names, and the causes, are the ones the build writes', () => {
  const epoch = read('src/ar/frame-epoch.ts')
  const causes = /export type FrameDiscontinuityCause = ([^\n]+)/.exec(epoch)?.[1]!.match(/'(\w+)'/g)!.map((c) => c.slice(1, -1)).sort()
  assert.ok(causes && causes.length >= 4)
  // Four causes are in the build today. WP-17b adds `anchor`, and the document says so where it names them, marked as arriving with that
  // package: a build that has it (WP-17b merged) still agrees with the document, and a build with a cause the document does not name does not.
  for (const today of ['jump', 'recovered', 'reset', 'resumed']) assert.ok(causes.includes(today), `the build lost the cause ${today}`)
  const named = ['jump', 'recovered', 'reset', 'resumed', 'anchor']
  assert.deepEqual(causes.filter((cause) => !named.includes(cause)), [], 'the build has a cause the document does not name')
  const text = flat(section(PROC6))
  assert.ok(text.includes('`cause` is `reset`, `recovered`, `resumed` or `jump`, and with WP-17b also `anchor` (an anchor stepped, or the runtime stopped locating one) *(after WP-17b)*'))
  const event = epoch.slice(epoch.indexOf('export interface FrameDiscontinuity {'), epoch.indexOf('/** Counts of values by size'))
  for (const field of ['cause', 'transform', 'degradedMs', 'hiddenMs', 'translationM', 'yawDeg']) {
    assert.ok(new RegExp(`\\b${field}\\??:`).test(event), `FrameDiscontinuity has no ${field}`)
    assert.ok(text.includes(`\`${field}\``), `Procedure 6 does not name ${field}`)
  }
  assert.match(event, /transform\?: FrameTransform \| null/, 'a reset can carry a null transform, as the document says')
  // The sidecar record the document points at.
  assert.match(epoch, /jumps: FrameJumpRecord\[\]/)
  assert.match(epoch, /motion: MotionStats \| null/)
  assert.match(epoch, /dtMs: MotionHistogram/)
  assert.ok(text.includes('`frameEpochs.jumps`') && text.includes('`frameEpochs.motion.dtMs`'))
  // The log keeps the most recent FRAME_LOG_MAX discontinuities, and the document says how many.
  assert.ok(text.includes(`(the most recent ${FRAME_LOG_MAX}, \`FRAME_LOG_MAX\`)`), 'the document and src/ar/frame-epoch.ts disagree about how many discontinuities the sidecar keeps')
})

test('Procedure 6 holds the persistent-anchor cap at the build\'s own, and marks every anchor readout as arriving with WP-17b', () => {
  const body = section(PROC6)
  assert.ok(flat(body).includes(`\`MAX_PERSISTENT_ANCHORS\` (${MAX_PERSISTENT_ANCHORS}) stays`), 'the document and src/ar/anchors.ts disagree about the cap')
  const rows = body.split('\n').filter((line) => /^\| \d+ \|/.test(line))
  assert.equal(rows.length, 13, 'thirteen steps')
  assert.deepEqual(rows.map((row) => Number(/^\| (\d+) \|/.exec(row)![1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  for (const row of rows) {
    const step = Number(/^\| (\d+) \|/.exec(row)![1])
    const marked = /after WP-17b/.test(row)
    // Steps 7 to 13 are about an anchor, which the build does not make yet. Steps 2 and 5 are run today and also carry one anchor readout
    // each, marked where it is. The others read only what the build writes now.
    if (step >= 7) assert.ok(marked, `step ${step} reads an anchor, which the build does not make yet, and is not marked "after WP-17b"`)
    else if (step === 2 || step === 5) assert.ok(marked && /`enabledFeatures`|`anchors` entry/.test(row), `step ${step} carries an anchor readout, marked "after WP-17b" where it is`)
    else assert.equal(marked, false, `step ${step} is marked "after WP-17b" but reads what the build writes today`)
    // Every step says what to write down and what passes: a procedure that is not followed to a verdict is a story.
    assert.equal(row.split('|').length, 6, `step ${step} has an action, what to write down and a pass line`)
    assert.ok(/Pass|pass|fail|Record only|within|finding|Five kept|Restores|No line|Every loss|The phone answers|Nothing restores/.test(row.split('|')[4]!), `step ${step} has no pass line`)
  }
  for (const marked of ['`anchors` entry', '`driftM`', '`driftDeg`', '`enabledFeatures`', 'Remember this spot on this headset']) {
    for (const chunk of chunks(body).filter((c) => c.includes(marked))) assert.ok(/after WP-17b/.test(chunk), `${marked} is an anchor readout and is not marked "after WP-17b" where it appears`)
  }
})

/** The rows of a procedure's numbered steps, each split into its cells: [step, action, write down, pass when]. */
function stepCells(heading: string): string[][] {
  return section(heading).split('\n').filter((line) => /^\| \d+ \|/.test(line)).map((line) => line.split('|').slice(1, 5).map((cell) => cell.trim()))
}

test('Procedure 6 judges a loss by the change in Δ across it: the reference of Δ is never moved, so the document starts AR where Δ is read, takes two readings and closes the tab for a new reference', () => {
  const main = read('src/main.ts')
  // The reference is the page's first tracked pose: assigned in one place, once, and never re-based by a loss, a frame shift or a new AR session.
  assert.equal([...main.matchAll(/\bposeReference\s*=(?!=)/g)].length, 1, 'something else assigns the pose readout\'s reference')
  assert.ok(main.includes('if (!poseReference) poseReference = { position: { ...pose.position }, rotation: { ...pose.rotation } }'))
  // When it runs: the scanner's frame callback calls it (and writes the `[scan] tracking degraded` lines) from the moment the scanner starts, and the
  // scanner starts before the calibration flow does, so the first tracked pose is taken behind the open card, and the readout (in the HUD, at the top)
  // and the card (a bottom sheet) are on screen together.
  const scannerStart = main.indexOf('scanner.start(provider, (frame) => {')
  const readoutCall = main.indexOf('updatePoseReadout(frame.pose, provider.isTracking())')
  const degraded = main.indexOf('[scan] tracking degraded (')
  const calibrationCall = main.indexOf('await runProjectCalibration({')
  assert.ok(scannerStart > 0 && scannerStart < readoutCall && readoutCall < calibrationCall && scannerStart < degraded && degraded < calibrationCall, 'the scanner loop, and with it the readout and the tracking lines, runs before the calibration card opens')
  const page = read('index.html')
  assert.match(page, /\.project-calibration-card \{[^}]*\bbottom:/, 'the card is a bottom sheet')
  assert.ok(page.includes('<div id="pose-readout" aria-hidden="true"></div>') && !/#project-calibration \{[^}]*display:\s*none/.test(page))
  const upright = { x: 0, y: 0, z: 0, w: 1 }
  const turned = (deg: number) => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) })
  const first = { position: { x: 0, y: 1.3, z: 0 }, rotation: upright }
  // AR started 3.4 m from mark A: standing still on A, Δ reads 3.38 m. That is why "about zero" is true only where AR was started.
  assert.ok(poseDelta(first, { position: { x: 3.2, y: 1.3, z: 1.1 }, rotation: upright }).distanceM > 3.3)
  // The change worked out as the document says, from two readings, is the move between the two poses wherever AR started.
  const reading = (pose: { position: { x: number; y: number; z: number }; rotation: typeof upright }) => {
    const parts = /· (-?[\d.]+)° · x(-?[\d.]+) y(-?[\d.]+) z(-?[\d.]+)$/.exec(formatPoseDelta(poseDelta(first, pose)))!
    return { yaw: Number(parts[1]), x: Number(parts[2]), y: Number(parts[3]), z: Number(parts[4]) }
  }
  const before = reading({ position: { x: 3.2, y: 1.3, z: 1.1 }, rotation: turned(10) })
  const after = reading({ position: { x: 3.27, y: 1.31, z: 1.13 }, rotation: turned(14) })
  assert.ok(Math.abs(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) - Math.hypot(0.07, 0.01, 0.03)) < 0.02)
  assert.ok(Math.abs(after.yaw - before.yaw - 4) < 0.2)

  const text = flat(section(PROC6))
  assert.ok(text.includes('`Δ` in the `?debug=pose` readout is the distance and yaw from the first pose the page saw, and nothing moves that reference: not a loss, not a frame shift. So read `Δ` only where AR was started, and judge a loss by the change in `Δ` across it. A new reference needs a new page: close the tab.'))
  assert.ok(text.includes("The calibration card's `Tracking <status>` line is the same status live, while the card is open; the scanner and the pose readout run from the start of AR, behind the card."))
  assert.doesNotMatch(text, /should read about zero|you stood still/, 'Δ is not zero after a loss unless AR started on the mark')
  const steps = stepCells(PROC6)
  assert.ok(steps[1]![1]!.startsWith('Unplug. Stand on a taped mark A, facing the marked direction, tap **Start AR** (`#start-ar-btn`) there, grant the camera and choose a scratch Place if the app asks. Leave the calibration card open through step 5 (step 7 is where you calibrate): its `Tracking` line is on screen only while it is. Do not move until the pose readout shows a pose: that first pose is the one `Δ` is read from.'), 'AR is started on A, the card is left open, and the person waits for the pose Δ is read from')
  assert.ok(steps[0]![1]!.includes('Do not tap **Start AR** yet'), 'step 1 is the console at the desk')
  assert.ok(steps[2]![1]!.includes('for each loss read `Δ` (all of it) and write it down') && steps[2]![1]!.includes('and read `Δ` again'))
  assert.ok(steps[2]![2]!.includes('`Δ` before and after; and the change, which is the distance between the two readings\' x, y and z and the difference of their yaws. If the session ends instead of resuming, write that down as the result, close the tab and start AR on A again for the next loss'))
  assert.ok(steps[2]![3]!.includes('the change is within 10 cm and 5°. These are this step\'s own figures (adopted: Procedure 1\'s targets for a whole walk, used here for one loss)'))
  assert.ok(steps[3]![1]!.startsWith('Close the tab and open the page again, so that `Δ` starts again: stand on A facing the marked direction and tap **Start AR** there.'))
  assert.ok(steps[4]![1]!.includes('read `Δ`, long-press the Meta button to recenter, and read `Δ` again'))
})

test('Procedure 6 says that steps 7 to 13 need a DX6 kit, and the build has none of it: no anchor is made by the app, and a refusal by the browser is an answer of no with no name', async () => {
  const paragraph = chunks(section(PROC6)).find((chunk) => chunk.startsWith('**What steps 7 to 13 need.**'))
  assert.ok(paragraph, 'the procedure says what its anchor steps need')
  const kit = flat(paragraph)
  for (const need of [
    'they need a DX6 kit in the build. That is a line for each anchor event, with the time, the anchor\'s identity',
    'the anchor\'s drift from where it was made, readable while you walk',
    'a switch that makes 1, 5, 20 or 50 anchors in one scan',
    'the outcome of every persistence request (`store-full` or `runtime-refused` when it failed)',
    'the error name of every anchor or persistence request the browser refuses (the build treats a refusal as "no" and keeps no name)',
    'Until WP-17b adds it, steps 7 to 13 cannot be run',
    '(`plane-detection`, `depth-sensing`, `light-estimation`, `camera-access`) are not asked for by the build',
  ]) assert.ok(kit.includes(need), `the paragraph no longer says: ${need}`)
  // Step 10 is the one that cannot be run without the kit's switch, and says so in its own row.
  assert.ok(stepCells(PROC6)[9]![1]!.includes('Many anchors, made with the kit\'s switch: one short scan each with 1, 5, 20 and 50 anchors'))
  // The features the build asks for are the four step 2 names, and none of the four the paragraph leaves out.
  const webxr = read('src/ar/webxr.ts')
  for (const left of ['plane-detection', 'depth-sensing', 'light-estimation', 'camera-access']) assert.ok(!webxr.includes(`'${left}'`), `webxr.ts now asks for ${left}: the paragraph says it does not`)
  // Nothing in the app makes, keeps or restores an anchor today: only src/ar/anchors.ts defines those calls.
  for (const file of ['src/main.ts', 'src/ar/project-calibration.ts', 'src/ar/webxr.ts', 'src/ar/eighthwall.ts']) {
    assert.doesNotMatch(read(file), /\btryCreateAnchor\(|\bpersistAnchor\(|\brestoreAnchors\(|\.createAnchor\(/, `${file} makes or keeps an anchor: steps 7 to 13 no longer wait for WP-17b`)
  }
  // A refusal carries no name: both calls answer null, and the outcome of a refused persist is a reason and nothing else.
  const anchors = read('src/ar/anchors.ts')
  // In the capability's interface and in the class that implements it: a refusal is null, and no member can carry a name.
  assert.match(anchors, /^  createAnchor\(at: PoseLike\): Promise<AnchorHandle \| null>$/m)
  assert.match(anchors, /^  createAnchor\(at: PoseLike\): Promise<AnchorHandle \| null> \{$/m)
  assert.match(anchors, /^  requestPersistentHandle\(handle: AnchorHandle\): Promise<string \| null>$/m)
  assert.match(anchors, /^  async requestPersistentHandle\(handle: AnchorHandle\): Promise<string \| null> \{$/m)
  const refusing = { supportsPersistence: true, persistentIdOf: () => null, requestPersistentHandle: async () => null } as unknown as AnchorCapability
  const outcome = await persistAnchor(refusing, createPersistentAnchorStore(memoryStorage()), { id: 'a' }, { projectId: 'place-a', role: 'landmark' })
  assert.deepEqual(outcome, { ok: false, reason: 'runtime-refused' })
})

/** A localStorage stand-in. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  }
}

test('Procedure 6 step 12: the build answers store-full at the cap without asking the browser, so only a refusal by the browser before the cap is evidence for a lower one', async () => {
  const [, action, writeDown, pass] = stepCells(PROC6)[11]!
  const asked: string[] = []
  const browser = {
    supportsPersistence: true,
    persistentIdOf: () => null,
    requestPersistentHandle: async () => {
      asked.push('asked')
      return `00000000-0000-4000-8000-${String(asked.length).padStart(12, '0')}`
    },
  } as unknown as AnchorCapability
  const owner = { projectId: 'place-a', role: 'landmark' }
  const store = createPersistentAnchorStore(memoryStorage())
  for (let n = 1; n <= MAX_PERSISTENT_ANCHORS; n++) assert.equal((await persistAnchor(browser, store, { id: `anchor-${n}` }, owner)).ok, true, `spot ${n} is kept`)
  assert.equal(asked.length, MAX_PERSISTENT_ANCHORS)
  assert.deepEqual(await persistAnchor(browser, store, { id: 'anchor-6' }, owner), { ok: false, reason: 'store-full' })
  assert.equal(asked.length, MAX_PERSISTENT_ANCHORS, 'the browser is not asked for a sixth: 6 and 8 are not reached from one origin')
  // The list is the origin's own (one localStorage key), so a second origin starts empty and does ask the browser: that is how a shared cap is seen.
  assert.equal(createPersistentAnchorStore(memoryStorage()).list().length, 0)
  const refused = await persistAnchor({ supportsPersistence: true, persistentIdOf: () => null, requestPersistentHandle: async () => null } as unknown as AnchorCapability, createPersistentAnchorStore(memoryStorage()), { id: 'anchor-1' }, owner)
  assert.deepEqual(refused, { ok: false, reason: 'runtime-refused' }, 'a refusal by the browser is its own answer, before the cap')

  assert.ok(action!.startsWith('*(Quest only, after WP-17b)* Cap. Calibrate a new scratch Place and choose "Remember this spot on this headset" again, and again, until the build stops you or the browser refuses; repeat from the same page on a second origin'))
  assert.ok(writeDown!.includes('whether it was the build\'s (`store-full`, which it answers at 5 without asking the browser) or the browser\'s (`runtime-refused`, with its error name from the kit)'))
  assert.ok(pass!.includes(`Five kept from one origin and no refusal by the browser: \`MAX_PERSISTENT_ANCHORS\` (${MAX_PERSISTENT_ANCHORS}) stays. A refusal by the browser before 5 is the evidence for a lower cap, and is the only one`))
  assert.ok(pass!.includes('The build never asks the browser for a sixth from one origin, so 6 and 8 are not reached from this page'))
  assert.equal(MAX_PERSISTENT_ANCHORS, 5)
  // On a headset where the page's overlay cannot be seen, the readings that need it are the ones the document gives up.
  assert.ok(flat(section(PROC6)).includes('If the page\'s overlay cannot be seen inside the headset\'s session (that the Quest Browser draws it there is not confirmed), write that down: on the headset every `Δ` reading is then missing, steps 7 to 13 cannot be done (they need the page\'s buttons), and the lines of steps 2 to 5 are all there is.'))
})

test('Procedure 6 step 3 runs the losses the checklist asks for: covers of 3, 10 and 30 s twice each, a 10 s app switch, and on the Quest 10 s off and until it sleeps, with a row for each', () => {
  const action = stepCells(PROC6)[2]![1]!
  assert.ok(action.includes('cover the camera with a hand for 3 s, then 10 s, then 30 s, twice each with 20 s of normal tracking between; then switch to another app for 10 s and come back'))
  assert.ok(action.includes('Quest: the same with the headset off for 10 s, and again for as long as it takes to go to sleep, put back on at A facing the same way'))
  const losses = section(PROC6).split('\n').filter((line) => /^\| (?:Cover|Other app|Headset off)/.test(line)).map((line) => line.split('|')[1]!.trim())
  assert.deepEqual(losses, ['Cover 3 s', 'Cover 3 s', 'Cover 10 s', 'Cover 10 s', 'Cover 30 s', 'Cover 30 s', 'Other app 10 s', 'Headset off 10 s', 'Headset off until it sleeps'])
  assert.ok(section(PROC6).includes('| Loss | `Δ` before | `Δ` after | Change (cm, °) | Lines, in order | Pass or fail |'))
})

test('the drift and distance figures of Procedure 6 are stated as adopted, in the same words everywhere', () => {
  const body = section(PROC6)
  assert.ok(flat(body).includes('The figures below are **adopted, not measured** (ADR 0005 rule 5)'))
  const flats = body.split('\n').filter((line) => /^\| \d+ \|/.test(line)).join('\n')
  // 0.10 m and 2 degrees: the drift flag the spec adopts. No other pair appears as a pass line.
  assert.equal([...flats.matchAll(/within 0\.10 m(?: and 2°)?/g)].length >= 3, true)
  assert.equal(/within 0\.(?!10 m)\d+ m/.test(flats), false, 'a second distance appeared as a pass line')
  assert.match(flats, /`driftM` within 0\.10 m and `driftDeg` within 2° at 10 min/)
})

test('Procedure 6 steps that name a constant give the value the build has, and the features it asks for are the ones named', () => {
  const text = flat(section(PROC6))
  assert.ok(text.includes(`\`ANCHOR_REQUEST_TIMEOUT_MS\` (${ANCHOR_REQUEST_TIMEOUT_MS / 1000} s, adopted)`), 'the document and src/ar/anchors.ts disagree about the anchor request timeout')
  assert.ok(text.includes('over 2 s'), 'the 95th percentile line is judged against the same 2 s')
  // Step 1 says the build asks for four features: they are the ones webxr.ts asks for, hit-test required and the rest optional.
  const webxr = read('src/ar/webxr.ts')
  assert.match(webxr, /requiredFeatures: \['hit-test'\]/)
  assert.match(webxr, /optionalFeatures: \['dom-overlay', 'local-floor', ANCHORS_FEATURE\]/)
  assert.equal(ANCHORS_FEATURE, 'anchors')
  assert.ok(text.includes('the build asks for `hit-test`, `dom-overlay`, `local-floor` and `anchors`'))
  // "NOT_AVAILABLE means no viewer pose, LIMITED an emulated position": the one place the provider derives its status.
  assert.match(webxr, /!viewerPose \? 'NOT_AVAILABLE' : viewerPose\.emulatedPosition \? 'LIMITED' : 'NORMAL'/)
  assert.ok(text.includes('reading `NOT_AVAILABLE` means no viewer pose, and one reading `LIMITED` an emulated position'))
})

test('the steps a procedure refers to by number are steps it has', () => {
  for (const [heading, steps] of [[PROC6, 13]] as const) {
    const body = flat(section(heading))
    for (const match of body.matchAll(/\bsteps? (\d+)(?: (?:to|and) (\d+))?/g)) {
      for (const number of [match[1], match[2]]) {
        if (number !== undefined) assert.ok(Number(number) >= 1 && Number(number) <= steps, `${heading} refers to step ${number}, which it does not have (${match[0]})`)
      }
    }
  }
  // Procedure 6 borrows Procedure 1's figures, and says in the same words what it uses them for: a loop target there, a line for one loss here.
  assert.ok(flat(section('### Procedure 1 — within-session loop drift')).includes('< 10 cm translational and < 5° rotational'))
  assert.ok(flat(section(PROC6)).includes("These are this step's own figures (adopted: Procedure 1's targets for a whole walk, used here for one loss)") && flat(section(PROC6)).includes('(targets of 10 cm and 5°, not thresholds)'))
})

// ── DX8 ──────────────────────────────────────────────────────────────────────────────────────
// Procedure 8 came with the printed-marker reader it measures, and fiducial_device_doc.test.ts holds it to that code: its lines,
// its parameters, its commands and its arithmetic. What stays here is the run it leaves for the marker step, which is not built,
// with the construction this file held when that run was a step of the plan Procedure 8 replaced; and the debug-flag rule.

test('Procedure 8 leaves the tag-defined frame for later, and the probe run it keeps is laid with two tapes whose arithmetic, tolerance and tap are what the document says', () => {
  const later = flat(section('#### Not measured here'))
  assert.ok(section(PROC8).includes('#### Not measured here'), 'the run for later is part of Procedure 8')
  assert.ok(later.includes('which is a later package. Nothing here measures them'), 'it says that nothing measures it yet')
  // F is the floor point under the tag's centre, Q is 3 m along the foot of the wall, P is where a tape from F (5.000 m) crosses one from Q (sqrt(34) m).
  const crossing = (rF: number, rQ: number): { x: number; y: number } => {
    const along = 3
    const x = (rF * rF - rQ * rQ + along * along) / (2 * along)
    return { x, y: Math.sqrt(rF * rF - x * x) }
  }
  const exact = crossing(5, Math.sqrt(34))
  assert.ok(Math.abs(exact.x) < 1e-12 && Math.abs(exact.y - 5) < 1e-12, 'the two tapes cross 0 m across and 5 m out along the normal')
  assert.equal(Math.sqrt(34).toFixed(3), '5.831')
  assert.ok(later.includes('Q is 3.000 m from F along the foot of the wall, and P is where a tape from F reading 5.000 m crosses a tape from Q reading 5.831 m (the square root of 34)'))
  // Each tape read to 5 mm, in the worst combination: the mark is within 2 cm sideways and 0.5 cm (and a hair) out, as the document says.
  let sideways = 0
  let out = 0
  for (const eF of [-0.005, 0.005]) {
    for (const eQ of [-0.005, 0.005]) {
      const mark = crossing(5 + eF, 5.831 + eQ)
      sideways = Math.max(sideways, Math.abs(mark.x))
      out = Math.max(out, Math.abs(mark.y - 5))
    }
  }
  assert.ok(sideways <= 0.02, `the mark can be ${sideways} m off sideways`)
  assert.ok(sideways > 0.015, 'and the 2 cm the document states is not a figure far above what the tapes give')
  assert.ok(out <= 0.0055, `the mark can be ${out} m off along the normal`)
  assert.ok(later.includes('P is laid to within 2 cm sideways and 0.5 cm out with each tape read to 5 mm, and that comes out of the 10 cm'))
  // The 10 cm is the line, and a 1 degree aim error at 5 m would be most of it: that is why the mark is laid, not judged by eye.
  assert.ok(5 * Math.tan((1 * Math.PI) / 180) > 0.08)
  assert.ok(later.includes("Each is to be within 10 cm of P's true place, 0 m across and 5.000 m out along the normal (adopted:"))
  // The frame the probe reads: the tag's plan position is the origin and +Z its outward normal; the tap is Procedure 2's, and records the same fields.
  assert.ok(later.includes("its origin is F and its +Z the tag's outward normal"))
  assert.ok(later.includes('hold the phone looking steeply down about 2 m from P, and tap the middle of P once, as in Procedure 2'))
  // Procedure 8 names fields bare (fiducial_device_doc.test.ts keeps `line.` for the probe line's own procedures), so the probe test does not see these: they are held to the line here.
  assert.ok(later.includes("Write down the probe line's `px` and `pz` (the tap across and out in the frame), `rng` and `pitch` in each session, as Procedure 2 reads them (a `pitch` above −45 means the phone was not looking steeply down: say so)"))
  for (const field of ['px', 'pz', 'rng', 'pitch']) assert.ok((PROBE_KEYS as readonly string[]).includes(field), `the probe line has no ${field}`)
  assert.ok(flat(section(PROC2)).includes('A `line.pitch` above −45 means the phone was not looking steeply down'), 'the same rule, in the same words, as Procedure 2')
  assert.ok(flat(section(PROC2)).includes('from no more than 2 m away, the phone looking steeply down'))
})

test('Procedures 3, 6 and 8 name only debug flags the build knows, and Procedure 8 holds the adopted-not-measured line and states no lag as a fact', () => {
  const flagsSource = read('src/shared/debug-flags.ts')
  const known = new Set([...flagsSource.slice(flagsSource.indexOf('export type DebugFlag')).matchAll(/\| '(\w+)'/g)].map((m) => m[1]!))
  for (const flag of ['remote', 'probe', 'pose', 'verbose', 'tag', 'tagneg']) assert.ok(known.has(flag), `the parse of debug-flags.ts reads ${flag}`)
  for (const procedure of [PROC3, PROC6, PROC8]) {
    for (const chunk of chunks(section(procedure))) {
      for (const list of chunk.matchAll(/\?debug=([A-Za-z,]+)/g)) {
        for (const flag of list[1]!.split(',')) assert.ok(known.has(flag), `${flag} is not a debug flag the build knows: ${chunk.slice(0, 120)}`)
      }
    }
  }
  const body = section(PROC8)
  assert.ok(flat(body).includes('**adopted, not measured** (ADR 0005 rule 5)'))
  // Which pose goes with a frame's pixels is a hypothesis until Part D fits it: the document asks for the lag and claims none.
  assert.ok(flat(body).includes('is a hypothesis'))
  assert.doesNotMatch(body, /previous frame|one frame behind|frame behind|lags the pose/i)
})
