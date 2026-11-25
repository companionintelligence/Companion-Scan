/**
 * The unit a floor plan is drawn in, for each AR runtime a capture can run on (server/floor_plan.ts).
 *
 * A calibration is what records a scan's `scaleKind`, so a scan with none was drawn in session units whatever its runtime.
 * The scanner now stamps every keyframe with its runtime's scale mode (src/capture/keyframes.ts), and the plan of a scan
 * with no calibration is in metres when every posed keyframe says a runtime that is metric by contract posed it: WebXR
 * (`webxr-metric`), and ARCore or ARKit behind the native plugin (`native-metric`). Every 8th Wall mode, a mix, a stamp
 * that is missing or not a mode, and every calibrated scan are drawn as they were.
 *
 * `keyframesScaleKind` and `floorPlanScaleKind` on records, `isUncalibratedScan` on the manifest field, then `runFloorPlan`
 * through its `_spawn` seam on a synthetic captured room: the `--units` the worker is given and the manifest's `units`.
 */
import { assert, assertEquals } from './assert.ts'

import {
  floorPlanScaleKind,
  floorPlanUnitsFor,
  isUncalibratedScan,
  keyframesScaleKind,
  runFloorPlan,
} from '../../../server/floor_plan.ts'
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

/** Every mode the 8th Wall provider can stamp (src/ar/engine-config.ts). None of them is metric by contract. */
const EIGHTH_WALL_MODES: ScaleMode[] = [
  'responsive-unconfigured',
  'responsive-originY:1.4',
  'absolute-notapplied',
  'absolute-notready',
  'absolute-ready',
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

test('keyframes stamped by 8th Wall say nothing, in every scale mode, absolute-ready included', () => {
  for (const mode of EIGHTH_WALL_MODES) {
    assertEquals(keyframesScaleKind(stamped(mode)), undefined, mode)
  }
})

test('one keyframe that is not from a metric runtime makes the whole capture say nothing', () => {
  // A native session handed over to 8th Wall partway: its later frames are in the engine's own unit.
  assertEquals(keyframesScaleKind([...stamped('native-metric'), posed(8, 'responsive-unconfigured')]), undefined)
  // A frame from before the stamp, or from a client that sends none.
  assertEquals(keyframesScaleKind([...stamped('webxr-metric'), posed(8)]), undefined)
  assertEquals(keyframesScaleKind([posed(0), ...stamped('webxr-metric')]), undefined, 'wherever the frame is')
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

test('a scan names no calibration only when its sidecar names no tier', () => {
  assertEquals(isUncalibratedScan({}), true)
  assertEquals(isUncalibratedScan({ calibrationMethod: undefined }), true)
  for (const method of ['two-point-ground', 'ground-tap-compass', 'known-distance'] as const) {
    assertEquals(isUncalibratedScan({ calibrationMethod: method }), false, method)
  }
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
  for (const mode of EIGHTH_WALL_MODES) {
    const kind = floorPlanScaleKind({ uncalibrated: true }, stamped(mode))
    assertEquals(kind, undefined, mode)
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

test('runFloorPlan keeps an uncalibrated 8th Wall capture, and one from before the stamp, in session units', async () => {
  for (const mode of [...EIGHTH_WALL_MODES, undefined]) {
    const run = await runWith(mode, { scaleKind: undefined, uncalibrated: true })
    assertEquals(run.status, 'ok', String(mode))
    assertEquals(run.argUnits, 'session', String(mode))
    assertEquals(run.manifestUnits, 'session', String(mode))
  }
})

test('runFloorPlan keeps a calibrated scan in its calibration\'s unit, whatever its keyframes say', async () => {
  const cases: Array<{ scan: { scaleKind?: ScaleKind; uncalibrated?: boolean }; frames: ScaleMode; units: string }> = [
    { scan: { scaleKind: 'arbitrary', uncalibrated: false }, frames: 'webxr-metric', units: 'session' },
    { scan: { scaleKind: 'estimated-metric', uncalibrated: false }, frames: 'webxr-metric', units: 'm-estimated' },
    { scan: { scaleKind: 'metric', uncalibrated: false }, frames: 'responsive-unconfigured', units: 'm' },
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
