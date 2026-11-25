/**
 * The unit a floor plan is drawn in, for each AR runtime a capture can run on (server/floor_plan.ts).
 *
 * A calibration is what records a scan's `scaleKind`, so a scan with none was drawn in session units whatever its runtime.
 * The scanner now stamps every keyframe with its runtime's scale mode (src/capture/keyframes.ts), and the plan of a scan
 * with no calibration takes the weakest of its posed keyframes. It is in metres when a runtime that is metric by contract
 * posed every one: WebXR (`webxr-metric`), and ARCore or ARKit behind the native plugin (`native-metric`). It is in
 * approximate metres when the weakest is 8th Wall in absolute scale with its estimate in (`absolute-ready`). It is in
 * session units when any frame is in 8th Wall's own unit. A stamp that is missing or not a mode, and every calibrated
 * scan, are drawn as they were.
 *
 * `keyframesScaleKind` and `floorPlanScaleKind` on records, `isUncalibratedScan` on sidecars (the scanner's, an older one, and
 * one whose record splat-align replaced with a known-distance one), then `runFloorPlan` through its `_spawn` seam on a
 * synthetic captured room: the `--units` the worker is given and the manifest's `units`.
 */
import { assert, assertEquals } from './assert.ts'

import {
  floorPlanScaleKind,
  floorPlanUnitsFor,
  isUncalibratedScan,
  keyframesScaleKind,
  runFloorPlan,
} from '../../../server/floor_plan.ts'
import { calibrationFromMeta, withReplacedCalibration } from '../../../server/calibration_fields.ts'
import type { KeyframeRecord } from '../../../server/splat/splat_train_dataset.ts'
import type { ScaleKind, ScaleMode } from '../../../src/world/scale-mode.ts'
import { TINY_PLY, writeCapturedRoom } from './floor_plan_fixtures.ts'
import * as fs from 'node:fs/promises'
import { makeTempDir } from '../../../server/fs_util.ts'
import { test } from 'node:test'

/** Any file that exists and is executable, to stand in for an interpreter the `_spawn` seam never runs. */
const RUNNABLE = process.execPath

/** The runtimes whose unit is the metre by contract, as the scanner stamps them. */
const METRIC_RUNTIMES: Array<{ runtime: string; mode: ScaleMode }> = [
  { runtime: 'WebXR', mode: 'webxr-metric' },
  { runtime: 'ARCore or ARKit, behind the native plugin', mode: 'native-metric' },
]

/**
 * The modes the 8th Wall provider stamps when its unit is the engine's own (src/ar/engine-config.ts): responsive scale,
 * and absolute scale before the estimate is in or when the engine did not take it. The fifth, `absolute-ready`, is the
 * engine's estimate of metres.
 */
const EIGHTH_WALL_OWN_UNIT_MODES: ScaleMode[] = [
  'responsive-unconfigured',
  'responsive-originY:1.4',
  'absolute-notapplied',
  'absolute-notready',
]

/** A posed keyframe record, as keyframes.jsonl holds it, with `scaleMode` as given (left off when undefined). */
function posed(index: number, scaleMode?: unknown): KeyframeRecord {
  return {
    index,
    file: `kf-${String(index).padStart(5, '0')}.jpg`,
    pose: { position: { x: index * 0.4, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ...(scaleMode === undefined ? {} : { scaleMode }),
  }
}

/** Eight posed records, every one stamped with `scaleMode`. */
const stamped = (scaleMode: unknown): KeyframeRecord[] => Array.from({ length: 8 }, (_, k) => posed(k, scaleMode))

// ── The runtime, from the keyframes ─────────────────────────────────────────

test('keyframes stamped by WebXR, or by ARCore or ARKit behind the native plugin, say metric', () => {
  for (const { runtime, mode } of METRIC_RUNTIMES) {
    assertEquals(keyframesScaleKind(stamped(mode)), 'metric', runtime)
  }
  // Two runtimes whose unit is the metre agree, whatever their modes are called: a native session that fell back to WebXR.
  assertEquals(keyframesScaleKind([...stamped('native-metric'), posed(8, 'webxr-metric')]), 'metric')
})

test('keyframes stamped by 8th Wall say estimated metres in absolute scale with its estimate in, and its own unit otherwise', () => {
  assertEquals(keyframesScaleKind(stamped('absolute-ready')), 'estimated-metric')
  for (const mode of EIGHTH_WALL_OWN_UNIT_MODES) {
    assertEquals(keyframesScaleKind(stamped(mode)), 'arbitrary', mode)
  }
})

test('the weakest keyframe decides the whole capture', () => {
  // A native session handed over to 8th Wall partway: its later frames are in the engine's own unit.
  assertEquals(keyframesScaleKind([...stamped('native-metric'), posed(8, 'responsive-unconfigured')]), 'arbitrary')
  // An absolute-scale session whose estimate came in partway: the frames before it were in another unit.
  assertEquals(keyframesScaleKind([posed(0, 'absolute-notready'), ...stamped('absolute-ready')]), 'arbitrary')
  // Metres from one runtime and the engine's estimate from another: estimated, not metric.
  assertEquals(keyframesScaleKind([...stamped('webxr-metric'), posed(8, 'absolute-ready')]), 'estimated-metric')
})

test('one keyframe with no stamp makes the whole capture say nothing', () => {
  // A frame from before the stamp, or from a client that sends none.
  assertEquals(keyframesScaleKind([...stamped('webxr-metric'), posed(8)]), undefined)
  assertEquals(keyframesScaleKind([posed(0), ...stamped('webxr-metric')]), undefined, 'wherever the frame is')
  assertEquals(keyframesScaleKind([...stamped('absolute-ready'), posed(8, 'not-a-mode')]), undefined, 'or a stamp that is not a mode')
})

test('a stamp that is not a mode is no stamp', () => {
  for (const junk of ['metric', 'webxr', 'WEBXR-METRIC', 'webxr-metric ', 'native', 'constructor', '__proto__', '', 42, true, null, {}, ['webxr-metric']]) {
    assertEquals(keyframesScaleKind(stamped(junk)), undefined, JSON.stringify(junk))
  }
})

test('only posed keyframes are read, and a capture with none says nothing', () => {
  // A record with no AR pose gives the fit nothing, so its missing stamp says nothing of the plan's unit.
  const unposed: KeyframeRecord = { index: 9, file: 'kf-00009.jpg' }
  assertEquals(keyframesScaleKind([...stamped('webxr-metric'), unposed, { ...unposed, pose: null }]), 'metric')
  assertEquals(keyframesScaleKind([]), undefined, 'no keyframes')
  assertEquals(keyframesScaleKind([unposed, { ...unposed, index: 10, scaleMode: 'webxr-metric' }]), undefined, 'no posed keyframe')
})

// ── The calibration first ───────────────────────────────────────────────────

/** The flat keys the scanner writes for a scan it never calibrated (src/export/gltf.ts). */
const UNCALIBRATED_SIDECAR = { sessionId: 'sess-a', calibrationMethod: null, calibrationStatus: 'uncalibrated', scaleMode: null, scaleKind: null, calibration: null }

/** A `'known-distance'` record, the shape server/capture/known_distance.ts derives and splat-align persists. */
const KNOWN_DISTANCE_RECORD = {
  method: 'known-distance',
  sessionToProject: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
  calibratedAt: '2026-11-24T00:00:00.000Z',
  status: 'provisional',
  separationM: 3,
  residualM: 0,
  toleranceM: 0.05,
  gravityAligned: false,
}

test('a scan has no calibration only when its sidecar names no tier and holds no record', () => {
  assertEquals(isUncalibratedScan(UNCALIBRATED_SIDECAR), true, 'what the scanner writes for a scan it never calibrated')
  assertEquals(isUncalibratedScan({ sessionId: 'sess-a' }), true, 'an older sidecar, with neither key')
  for (const method of ['two-point-ground', 'ground-tap-compass', 'known-distance']) {
    assertEquals(isUncalibratedScan({ ...UNCALIBRATED_SIDECAR, calibrationMethod: method, calibration: { method } }), false, method)
    assertEquals(isUncalibratedScan({ ...UNCALIBRATED_SIDECAR, calibrationMethod: method }), false, `${method}, summary only`)
  }
  assertEquals(isUncalibratedScan({ ...UNCALIBRATED_SIDECAR, calibrationMethod: 'a-tier-from-later' }), false, 'a tier this does not know')
})

test('an uncalibrated scan that splat-align sized from measured distances counts as calibrated', () => {
  // The job replaces the record and leaves the flat summary saying "none" (withReplacedCalibration).
  const sized = withReplacedCalibration(UNCALIBRATED_SIDECAR, KNOWN_DISTANCE_RECORD)
  assertEquals(sized['calibrationMethod'], null, 'the summary still names no tier')
  assertEquals(calibrationFromMeta(sized).calibrationMethod, undefined, 'and the manifest shows none')
  assertEquals(isUncalibratedScan(sized), false, 'the record is what says it has one')
  // So its plan is not taken from the keyframes, WebXR's included: it stays in session units, as it was.
  assertEquals(floorPlanScaleKind({ scaleKind: undefined, uncalibrated: isUncalibratedScan(sized) }, stamped('webxr-metric')), undefined)
})

test('a calibration is never overridden: its unit, or none when it recorded none', () => {
  const webxr = stamped('webxr-metric')
  const eighthWall = stamped('responsive-unconfigured')
  for (const kind of ['metric', 'estimated-metric', 'arbitrary'] as ScaleKind[]) {
    assertEquals(floorPlanScaleKind({ scaleKind: kind, uncalibrated: false }, webxr), kind, `${kind} over WebXR frames`)
    assertEquals(floorPlanScaleKind({ scaleKind: kind, uncalibrated: false }, eighthWall), kind, `${kind} over 8th Wall frames`)
    // A kind is a calibration's, so it wins even beside a flag that says there is none.
    assertEquals(floorPlanScaleKind({ scaleKind: kind, uncalibrated: true }, webxr), kind, `${kind}, flagged uncalibrated`)
  }
  // The known-distance tier, or a record from before units were recorded: calibrated, with no unit. Not taken from the frames.
  assertEquals(floorPlanScaleKind({ uncalibrated: false }, webxr), undefined)
  // A caller that does not say the scan is uncalibrated gets the unit it passed and nothing else.
  assertEquals(floorPlanScaleKind({}, webxr), undefined)
})

test('a scan with no calibration takes its unit from the runtime that posed its keyframes', () => {
  for (const { runtime, mode } of METRIC_RUNTIMES) {
    const kind = floorPlanScaleKind({ uncalibrated: true }, stamped(mode))
    assertEquals(kind, 'metric', runtime)
    assertEquals(floorPlanUnitsFor(kind), 'm', runtime)
  }
  const estimated = floorPlanScaleKind({ uncalibrated: true }, stamped('absolute-ready'))
  assertEquals(estimated, 'estimated-metric', '8th Wall in absolute scale, its estimate in')
  assertEquals(floorPlanUnitsFor(estimated), 'm-estimated')
  for (const mode of EIGHTH_WALL_OWN_UNIT_MODES) {
    const kind = floorPlanScaleKind({ uncalibrated: true }, stamped(mode))
    assertEquals(kind, 'arbitrary', mode)
    assertEquals(floorPlanUnitsFor(kind), 'session', mode)
  }
  assertEquals(floorPlanUnitsFor(floorPlanScaleKind({ uncalibrated: true }, stamped(undefined))), 'session', 'a capture from before the stamp')
})

// ── Through the run ─────────────────────────────────────────────────────────

/**
 * Runs the driver over a synthetic captured room whose keyframes carry `scaleMode`, with `scan` as the job passes it,
 * through the `_spawn` seam. Returns the `--units` the worker was given and the manifest's `units`.
 */
async function runWith(
  scaleMode: unknown,
  scan: { scaleKind?: ScaleKind; uncalibrated?: boolean },
): Promise<{ argUnits: string | undefined; manifestUnits: unknown; status: string }> {
  const tmp = await makeTempDir({ prefix: 'floor-plan-units-' })
  try {
    const session = `${tmp}/sess-floorplan-units`
    await fs.mkdir(session, { recursive: true })
    await fs.writeFile(`${session}/lingbot-map.point-cloud.ply`, TINY_PLY)
    await writeCapturedRoom(session, { write: { cloud: false }, scaleMode })
    let argUnits: string | undefined
    const result = await runFloorPlan({
      sessionDir: session,
      outputJsonPath: `${tmp}/scan.floor-plan.json`,
      outputSvgPath: `${tmp}/scan.floor-plan.svg`,
      python: RUNNABLE,
      ...scan,
      _spawn: async (_bin, args) => {
        argUnits = args[args.indexOf('--units') + 1]
        await fs.writeFile(args[args.indexOf('--out-json') + 1]!, JSON.stringify({ areaM2: 12, walls: [{}], rooms: [{}] }))
        await fs.writeFile(args[args.indexOf('--out-svg') + 1]!, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        return { code: 0, stderr: '' }
      },
    })
    const manifest = JSON.parse(await fs.readFile(`${tmp}/scan.floor-plan.manifest.json`, 'utf8')) as { units?: unknown }
    return { argUnits, manifestUnits: manifest.units, status: result.status }
  } finally {
    await fs.rm(tmp, { recursive: true })
  }
}

test('runFloorPlan draws an uncalibrated WebXR, ARCore or ARKit capture in metres', async () => {
  for (const { runtime, mode } of METRIC_RUNTIMES) {
    const run = await runWith(mode, { scaleKind: undefined, uncalibrated: true })
    assertEquals(run.status, 'ok', runtime)
    assertEquals(run.argUnits, 'm', `${runtime}: the worker labels in metres`)
    assertEquals(run.manifestUnits, 'm', `${runtime}: the manifest the editor reads says metres`)
  }
})

test('runFloorPlan draws an uncalibrated 8th Wall capture in absolute scale, its estimate in, in approximate metres', async () => {
  const run = await runWith('absolute-ready', { scaleKind: undefined, uncalibrated: true })
  assertEquals(run.status, 'ok')
  assertEquals(run.argUnits, 'm-estimated', 'the worker labels in approximate metres')
  assertEquals(run.manifestUnits, 'm-estimated', 'the manifest the editor reads says approximate metres')
})

test('runFloorPlan keeps an uncalibrated 8th Wall capture in the engine\'s own unit, and one from before the stamp, in session units', async () => {
  for (const mode of [...EIGHTH_WALL_OWN_UNIT_MODES, undefined]) {
    const run = await runWith(mode, { scaleKind: undefined, uncalibrated: true })
    assertEquals(run.status, 'ok', String(mode))
    assertEquals(run.argUnits, 'session', String(mode))
    assertEquals(run.manifestUnits, 'session', String(mode))
  }
  // A session whose absolute-scale estimate came in partway.
  const settling = await runWith((k: number) => (k === 0 ? 'absolute-notready' : 'absolute-ready'), { uncalibrated: true })
  assertEquals(settling.manifestUnits, 'session', 'one frame from before the estimate')
})

test('runFloorPlan keeps a calibrated scan in its calibration\'s unit, whatever its keyframes say', async () => {
  const cases: Array<{ scan: { scaleKind?: ScaleKind; uncalibrated?: boolean }; frames: ScaleMode; units: string }> = [
    { scan: { scaleKind: 'arbitrary', uncalibrated: false }, frames: 'webxr-metric', units: 'session' },
    { scan: { scaleKind: 'estimated-metric', uncalibrated: false }, frames: 'webxr-metric', units: 'm-estimated' },
    { scan: { scaleKind: 'metric', uncalibrated: false }, frames: 'responsive-unconfigured', units: 'm' },
    { scan: { scaleKind: 'arbitrary', uncalibrated: false }, frames: 'absolute-ready', units: 'session' },
    // Calibrated, with no unit recorded (the known-distance tier, or a record from before units were).
    { scan: { uncalibrated: false }, frames: 'webxr-metric', units: 'session' },
    { scan: {}, frames: 'native-metric', units: 'session' },
  ]
  for (const { scan, frames, units } of cases) {
    const run = await runWith(frames, scan)
    const what = `${JSON.stringify(scan)} over ${frames} frames`
    assertEquals(run.status, 'ok', what)
    assertEquals(run.argUnits, units, what)
    assertEquals(run.manifestUnits, units, what)
  }
})

test('the stamp decides nothing about whether the plan is drawn: a capture the cloud does not fit is still a skip', async () => {
  const tmp = await makeTempDir({ prefix: 'floor-plan-units-' })
  try {
    const session = `${tmp}/sess-floorplan-units`
    await fs.mkdir(session, { recursive: true })
    await fs.writeFile(`${session}/lingbot-map.point-cloud.ply`, TINY_PLY)
    // Stamped by WebXR, but with only three keyframes: too few to fit.
    await writeCapturedRoom(session, { write: { cloud: false }, scaleMode: 'webxr-metric', frames: 3 })
    const result = await runFloorPlan({
      sessionDir: session,
      outputJsonPath: `${tmp}/scan.floor-plan.json`,
      outputSvgPath: `${tmp}/scan.floor-plan.svg`,
      python: RUNNABLE,
      uncalibrated: true,
      _spawn: () => {
        throw new Error('spawn must not be reached')
      },
    })
    assertEquals(result.status, 'skipped')
    assert(result.manifest.units === undefined, 'a skip names no units')
  } finally {
    await fs.rm(tmp, { recursive: true })
  }
})
