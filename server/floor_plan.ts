/**
 * Floor-plan worker driver: a 2D plan (walls, a room outline, area) from a scan's LingBot-Map point cloud.
 *
 * Ported from PR #273, which wrote it against the old root layout. Shaped like splat_detect.ts and splat_finish.ts:
 * the TS side stays thin. It finds the session's `lingbot-map.point-cloud.ply`, spawns scripts/floor_plan_worker.py
 * (stdlib + numpy: height histogram → wall-band occupancy grid → seeded-RANSAC wall segments → room polygon) into a
 * temp dir, lands the plan JSON and SVG next to the scan, and writes the `<base>.floor-plan.manifest.json` the
 * world-job coordinator reports from.
 *
 * The driver never hard-crashes the server:
 *   - no point cloud, a cloud its own LingBot run judged degenerate, an interpreter that is not found, a missing
 *     worker script, or an interpreter without numpy (the worker's exit 3) is a `skipped` result with a remediation,
 *   - a worker crash, a run its deadline or its job stopped, or a run that wrote no readable plan is an `error`.
 *
 * The interpreter is LingBot-Map's, `LINGBOT_MAP_PYTHON`, resolved through the table GET /capabilities reports
 * (server/exec_probe.ts). The cloud this reads exists only where that interpreter ran, and it has numpy, so a second
 * variable naming an interpreter would be a second name for the same thing (ADR 0001). The PR's own default was the
 * LingBot-Map venv.
 *
 * Frame and units: a LingBot-Map cloud is in LingBot's own frame, neither metric (lingbot_map.ts measures it "in the
 * worker's own units") nor gravity-aligned (docs/pipelines/lingbot-map.md, Limitations). The worker's thresholds are in
 * metres and its height histogram needs the up axis, so the driver first fits the cloud to the capture's own AR camera
 * poses (`fitCloudToSession`): the same keyframes, posed once by LingBot-Map and once by the AR runtime, paired by
 * file name as splat-align pairs them. The rotation comes from the cameras' orientations, which a capture walked in a
 * straight line (a hallway) still fixes; the scale and offset come from their centres. The worker gets that similarity
 * as `--transform`, with `--up-axis y` (an AR session's frame is Y-up) and `--units`, from the scan's `scaleKind`:
 * metres for a metric runtime, approximate metres for an estimated one, the session's own units otherwise. A calibration
 * is what stamps `scaleKind` on a scan, so a scan with no calibration has none; its plan is in metres when every keyframe
 * with an AR pose says it was posed by a runtime that is metric by contract (`keyframesScaleKind`), and in the session's
 * own units otherwise (`floorPlanScaleKind`). A scan with no AR poses (a photo or video ingest), or poses the cloud does
 * not fit, is a skip that says so: nothing else sets the plan's scale or which way is up, and a plan drawn on a guess is
 * wrong without saying so.
 *
 * Worker contract (scripts/floor_plan_worker.py):
 *   floor_plan_worker.py --ply <cloud> --out-json <p> --out-svg <p> [--min-wall-m 0.5]
 *                        [--transform <16 numbers> --up-axis y --units m|m-estimated|session]
 *   exit 0 plan written · 2 bad input · 3 numpy missing. Deterministic, CPU only. It writes no manifest.
 */
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { FloorPlanAlignment, FloorPlanManifest, FloorPlanUnits, ScanManifest } from '../src/world/types.ts'
import { asScaleMode, type ScaleKind, scaleKindOfMode } from '../src/world/scale-mode.ts'
import { displayPathOf, locateTool, runnerToolLookup, toolSkip } from './exec_probe.ts'
import { makeTempDir } from './fs_util.ts'
import { REPO_ROOT } from './repo-root.ts'
import {
  budgetFromEnv,
  finishRun,
  isValidSessionDir,
  KILL_GRACE_MS,
  numFromEnv,
  runWithDeadline,
  writeRunnerManifest,
} from './run_with_deadline.ts'
import {
  type KeyframeRecord,
  lingBotCloudCollapsed,
  poseToMatrix,
  readKeyframes,
  readLingbotPoses,
  recordHasPose,
} from './splat/splat_train_dataset.ts'
import {
  DEFAULT_MAX_RESIDUAL_M,
  DEFAULT_MIN_CORRESPONDENCES,
  det3,
  matMul3,
  similarityToRowMajor,
  svd3,
  transpose3,
} from './splat/splat_align.ts'
export type { FloorPlanAlignment, FloorPlanManifest, FloorPlanUnits }

/** The worker this checkout ships. FLOORPLAN_WORKER overrides it, as LINGBOT_MAP_SCRIPT does LingBot-Map's. */
export const DEFAULT_FLOORPLAN_WORKER = fileURLToPath(new URL('scripts/floor_plan_worker.py', REPO_ROOT))

/** The input the worker reads: the session's LingBot-Map reconstruction. */
export const FLOOR_PLAN_INPUT = 'lingbot-map.point-cloud.ply'

/** The worker's exit code for "numpy is not installed for this interpreter". A skip, not a failure. */
export const WORKER_EXIT_NO_NUMPY = 3

/** What fixes a worker that ran without numpy. */
export const NO_NUMPY_REMEDIATION =
  'Install numpy for the interpreter LINGBOT_MAP_PYTHON names (`python3 -m pip install numpy`), ' +
  'or point LINGBOT_MAP_PYTHON at the LingBot-Map venv, which has it.'

/** One worker run. A room-sized cloud takes seconds; the budget only stops a wedged run. Untuned. */
const DEFAULT_FLOORPLAN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * RMS angle, in degrees, above which the LingBot-Map cameras are taken not to be the AR cameras turned as one. A
 * sanity line between "the same cameras" and "something upstream is wrong" (a mis-paired frame set, a reconstruction
 * that failed quietly), like splat-align's residual line; not a measured quality bar (ADR 0005 rule 5).
 */
export const MAX_ORIENTATION_RESIDUAL_DEG = 10

/** What fixes a capture the floor plan cannot be fitted to. */
export const NO_AR_POSES_REMEDIATION =
  'Capture the room with the AR scanner: the floor plan takes its scale and which way is up from the AR poses its ' +
  'keyframes carry, and a photo or video ingest has none.'
const REFIT_REMEDIATION =
  'Run lingbot-map-reconstruct on this scan again. If it repeats, the AR tracking or the reconstruction is off for ' +
  'this capture: re-scan the room.'

/**
 * What one unit of a scan's AR session is worth, as its calibration recorded it: its `scaleKind`, else the kind of its
 * `scaleMode`. Both are stamped by a calibration (`stampScale`, src/ar/engine-config.ts), so a scan with none has neither.
 */
export function scaleKindOfScan(scan: Pick<ScanManifest, 'scaleKind' | 'scaleMode'>): ScaleKind | undefined {
  return scan.scaleKind ?? (scan.scaleMode !== undefined ? scaleKindOfMode(scan.scaleMode) : undefined)
}

/**
 * Whether a scan carries no calibration: its sidecar names no calibration tier (`calibrationMethod`). The scanner writes
 * the tier beside the calibration's status and unit, so a scan that has one is never read as one that has none.
 */
export function isUncalibratedScan(scan: Pick<ScanManifest, 'calibrationMethod'>): boolean {
  return scan.calibrationMethod === undefined
}

/**
 * What one unit of a capture's AR session is worth, from the runtime that posed its keyframes: `'metric'` when every
 * keyframe with an AR pose carries a scale mode (`scaleMode`, stamped per frame by src/capture/keyframes.ts) whose kind is
 * `'metric'`, which is WebXR's (`'webxr-metric'`) and ARCore's or ARKit's behind the native plugin (`'native-metric'`).
 * Undefined otherwise.
 *
 * Anything less is undefined, and so is the whole capture:
 *   - a posed frame with no mode: a capture from before the stamp, or from a client that sends none (the Quest app);
 *   - a stored value that is not a mode;
 *   - any 8th Wall mode. In responsive scale the unit is the engine's own, which is not metric. In absolute scale it is the
 *     engine's estimate (`'absolute-ready'`, kind `'estimated-metric'`). A calibrated scan in that mode is drawn in
 *     approximate metres; whether an uncalibrated one should be too is not decided here, so it stays in session units.
 *     That includes a session whose frames are partly metric: a native session handed over to 8th Wall partway.
 *   - no posed frame at all.
 *
 * Only the posed frames are read: a record with no AR pose gives the plan nothing to fit, so its unit says nothing of it.
 */
export function keyframesScaleKind(records: KeyframeRecord[]): 'metric' | undefined {
  let posed = 0
  for (const rec of records) {
    if (!recordHasPose(rec)) continue
    const mode = asScaleMode(rec.scaleMode)
    if (mode === undefined || scaleKindOfMode(mode) !== 'metric') return undefined
    posed++
  }
  return posed > 0 ? 'metric' : undefined
}

/**
 * The unit a scan's plan is drawn in, as a `ScaleKind`. The calibration's (`scaleKind`, from `scaleKindOfScan`) whenever the
 * scan has one: a calibration is never overridden, and a calibration that recorded no unit (the `'known-distance'` tier, a
 * record from before units were recorded) leaves the plan in session units, as it always has. Only for a scan with no
 * calibration (`uncalibrated`, from `isUncalibratedScan`) is the unit taken from the runtime that posed the keyframes
 * (`keyframesScaleKind`).
 */
export function floorPlanScaleKind(
  scan: { scaleKind?: ScaleKind; uncalibrated?: boolean },
  records: KeyframeRecord[],
): ScaleKind | undefined {
  if (scan.scaleKind !== undefined || scan.uncalibrated !== true) return scan.scaleKind
  return keyframesScaleKind(records)
}

/** The units the plan is drawn in, from what one unit of the scan's AR session is worth. */
export function floorPlanUnitsFor(scaleKind: ScaleKind | undefined): Exclude<FloorPlanUnits, 'cloud'> {
  if (scaleKind === 'metric') return 'm'
  if (scaleKind === 'estimated-metric') return 'm-estimated'
  return 'session'
}

export type CloudFit =
  | { ok: true; alignment: FloorPlanAlignment & { transform: number[] } }
  | { ok: false; reason: string; remediation: string }

/**
 * The similarity that carries the LingBot-Map cloud into the capture's AR session frame, from the keyframes both
 * posed: `lingbot` (file → camera-to-world, OpenGL axes, as `readLingbotPoses` returns it) against the AR poses in
 * `records` (keyframes.jsonl; `poseToMatrix` gives the same axes, so no flip is needed between the two).
 *
 *   - rotation R: the rotation nearest Σ R_ar·R_lbᵀ (an SVD projection). From orientations, not centres, so a capture
 *     walked in a straight line, which leaves a centres-only fit free to roll about that line, still fixes it.
 *   - scale s and offset t: least squares on the camera centres with R held: s = Σ d_ar·R·d_lb / Σ |R·d_lb|²,
 *     t = μ_ar − s·R·μ_lb.
 *
 * Refused, with the reason: fewer than four keyframes posed by both (four is splat-align's minimum), cameras that did
 * not move (no scale), orientations that disagree by more than MAX_ORIENTATION_RESIDUAL_DEG RMS, or centres that miss
 * by more than splat-align's DEFAULT_MAX_RESIDUAL_M RMS after the fit, in the session's units.
 */
export function fitCloudToSession(lingbot: Map<string, number[][]> | null, records: KeyframeRecord[]): CloudFit {
  const ar = new Map<string, number[][]>()
  for (const rec of records) {
    if (typeof rec.file !== 'string' || !rec.file || !recordHasPose(rec)) continue
    const m = poseToMatrix(rec.pose ?? {})
    if (m.every((row) => row.every(Number.isFinite))) ar.set(rec.file, m)
  }
  if (ar.size === 0) {
    return { ok: false, reason: 'no AR poses: the capture\'s keyframes carry none', remediation: NO_AR_POSES_REMEDIATION }
  }
  const files = [...(lingbot?.keys() ?? [])].filter((f) => ar.has(f)).sort()
  if (files.length < DEFAULT_MIN_CORRESPONDENCES) {
    return {
      ok: false,
      reason: `only ${files.length} keyframes have both an AR pose and a LingBot-Map pose (${DEFAULT_MIN_CORRESPONDENCES} needed)`,
      remediation: REFIT_REMEDIATION,
    }
  }
  const rot = (m: number[][]) => [m[0]!.slice(0, 3), m[1]!.slice(0, 3), m[2]!.slice(0, 3)]
  const centre = (m: number[][]): number[] => [m[0]![3]!, m[1]![3]!, m[2]![3]!]

  // Rotation: the nearest proper rotation to Σ R_ar·R_lbᵀ.
  const sum = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const f of files) {
    const p = matMul3(rot(ar.get(f)!), transpose3(rot(lingbot!.get(f)!)))
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sum[i]![j]! += p[i]![j]!
  }
  const { u, v } = svd3(sum)
  const flip = det3(u) * det3(v) < 0 ? -1 : 1
  const r = matMul3(matMul3(u, [[1, 0, 0], [0, 1, 0], [0, 0, flip]]), transpose3(v))

  let angleSq = 0
  for (const f of files) {
    const e = matMul3(transpose3(matMul3(r, rot(lingbot!.get(f)!))), rot(ar.get(f)!))
    const cos = Math.min(1, Math.max(-1, (e[0]![0]! + e[1]![1]! + e[2]![2]! - 1) / 2))
    angleSq += Math.acos(cos) ** 2
  }
  const orientationResidualDeg = Math.sqrt(angleSq / files.length) * 180 / Math.PI
  if (!(orientationResidualDeg <= MAX_ORIENTATION_RESIDUAL_DEG)) {
    return {
      ok: false,
      reason: `the LingBot-Map cameras do not turn with the AR ones: ${orientationResidualDeg.toFixed(1)}° RMS apart ` +
        `(limit ${MAX_ORIENTATION_RESIDUAL_DEG}°)`,
      remediation: REFIT_REMEDIATION,
    }
  }

  // Scale and offset, from the centres with R held.
  const mean = (pts: number[][]) => [0, 1, 2].map((k) => pts.reduce((acc, p) => acc + p[k]!, 0) / pts.length)
  const cAr = files.map((f) => centre(ar.get(f)!))
  const cLb = files.map((f) => centre(lingbot!.get(f)!))
  const muAr = mean(cAr)
  const muLb = mean(cLb)
  let cross = 0
  let lbSq = 0
  let arSq = 0
  for (let k = 0; k < files.length; k++) {
    const dAr = [0, 1, 2].map((i) => cAr[k]![i]! - muAr[i]!)
    const dLbRaw = [0, 1, 2].map((i) => cLb[k]![i]! - muLb[i]!)
    const dLb = [0, 1, 2].map((i) => r[i]![0]! * dLbRaw[0]! + r[i]![1]! * dLbRaw[1]! + r[i]![2]! * dLbRaw[2]!)
    cross += dAr[0]! * dLb[0]! + dAr[1]! * dLb[1]! + dAr[2]! * dLb[2]!
    lbSq += dLb[0]! ** 2 + dLb[1]! ** 2 + dLb[2]! ** 2
    arSq += dAr[0]! ** 2 + dAr[1]! ** 2 + dAr[2]! ** 2
  }
  // A path with no extent on either side leaves the scale 0/0: the camera turned on the spot.
  const scale = lbSq > 1e-18 && arSq > 1e-18 ? cross / lbSq : Number.NaN
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return {
      ok: false,
      reason: 'the camera did not move between keyframes, so the reconstruction\'s scale cannot be read from them',
      remediation: 'Walk the room while scanning, rather than turning on the spot, then reconstruct it again.',
    }
  }
  const rMuLb = [0, 1, 2].map((i) => r[i]![0]! * muLb[0]! + r[i]![1]! * muLb[1]! + r[i]![2]! * muLb[2]!)
  const translation = [0, 1, 2].map((i) => muAr[i]! - scale * rMuLb[i]!) as [number, number, number]

  let missSq = 0
  for (let k = 0; k < files.length; k++) {
    for (let i = 0; i < 3; i++) {
      const fitted = scale * (r[i]![0]! * cLb[k]![0]! + r[i]![1]! * cLb[k]![1]! + r[i]![2]! * cLb[k]![2]!) + translation[i]!
      missSq += (cAr[k]![i]! - fitted) ** 2
    }
  }
  const residual = Math.sqrt(missSq / files.length)
  if (!(residual <= DEFAULT_MAX_RESIDUAL_M)) {
    return {
      ok: false,
      reason: `the LingBot-Map camera path does not match the AR one: ${residual.toFixed(3)} RMS apart after the fit ` +
        `(limit ${DEFAULT_MAX_RESIDUAL_M}, in the session's units)`,
      remediation: REFIT_REMEDIATION,
    }
  }
  return {
    ok: true,
    alignment: {
      transform: similarityToRowMajor({ rotation: r, translation, scale }),
      scale,
      pairedFrames: files.length,
      residual,
      orientationResidualDeg,
    },
  }
}

type SpawnResult = { code: number; stderr: string; timeoutReason?: string | null }

export interface FloorPlanRunOptions {
  /** Absolute path to the session dir (holds lingbot-map.point-cloud.ply). Absent for a scan with no session. */
  sessionDir?: string
  /** Where the plan JSON should land (<SCANS>/<base>.floor-plan.json). */
  outputJsonPath: string
  /** Where the plan SVG should land (<SCANS>/<base>.floor-plan.svg). */
  outputSvgPath: string
  /** Path where the floor-plan manifest is written (defaults next to outputJsonPath). */
  manifestPath?: string
  /** Interpreter. Falls back to LINGBOT_MAP_PYTHON, then python3 on PATH (the shared table's row). */
  python?: string
  /** Worker script. Falls back to env FLOORPLAN_WORKER, then scripts/floor_plan_worker.py. */
  workerPath?: string
  /** Shortest wall segment kept, in the cloud's units. Env FLOORPLAN_MIN_WALL_M, then 0.5. */
  minWallM?: number
  /**
   * What one unit of the scan's AR session is worth, as its calibration recorded it (`scaleKindOfScan`): the scan's
   * `scaleKind`, or `scaleKindOfMode` of its `scaleMode`. Absent for a scan with no calibration, and for one whose
   * calibration recorded no unit; either reads as the session's own units unless `uncalibrated` says otherwise.
   */
  scaleKind?: ScaleKind
  /**
   * True for a scan that carries no calibration (`isUncalibratedScan`). Then, and only then, the unit comes from the
   * runtime that posed the keyframes when `scaleKind` is absent (`floorPlanScaleKind`). Absent or false: `scaleKind` alone.
   */
  uncalibrated?: boolean
  /** For testing: skip the real spawn and treat this as the worker run. */
  _spawn?: (bin: string, args: string[], env: Record<string, string>) => Promise<SpawnResult>
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId?: string; scanId?: string }
  /**
   * Stops the run when it fires: the job pump passes its job's signal, so a job it has given up on does not leave its
   * child running (F-27).
   */
  signal?: AbortSignal
}

export type FloorPlanStatus = FloorPlanManifest['status']

export interface FloorPlanResult {
  status: FloorPlanStatus
  manifest: FloorPlanManifest
  /** Absolute path of the landed plan JSON when status is 'ok'. */
  planJsonPath?: string
  /** Absolute path of the landed plan SVG when status is 'ok'. */
  planSvgPath?: string
  areaM2?: number
  wallCount?: number
  /** stderr from the worker, surfaced on failure. */
  log: string
  /** Subprocess exit code (or a synthetic code on skip/pre-spawn failure). */
  exitCode: number
}

/** The headline numbers of a plan file. */
export interface FloorPlanSummary {
  areaM2: number
  wallCount: number
  roomCount: number
  ceilingHeightM: number
  disclaimer?: string
}

/** The worker script and the shortest wall kept: an explicit option, else the environment, else the default. */
export function resolveParams(opts: Pick<FloorPlanRunOptions, 'workerPath' | 'minWallM'>) {
  const workerPath = opts.workerPath ?? process.env.FLOORPLAN_WORKER ?? DEFAULT_FLOORPLAN_WORKER
  const minWallM = opts.minWallM !== undefined && Number.isFinite(opts.minWallM) && opts.minWallM >= 0
    ? opts.minWallM
    : numFromEnv('FLOORPLAN_MIN_WALL_M', 0.5)
  return { workerPath, minWallM }
}

/**
 * The floor_plan_worker.py arguments, in a stable order. With a `transform` (the row-major 4x4 `fitCloudToSession`
 * found), the worker moves the cloud into the AR session's frame, takes Y as up, and labels in `units`.
 */
export function buildFloorPlanArgs(
  workerPath: string,
  plyPath: string,
  outJsonPath: string,
  outSvgPath: string,
  params: { minWallM: number; transform?: number[]; units?: FloorPlanUnits },
): string[] {
  const args = [
    workerPath,
    '--ply', plyPath,
    '--out-json', outJsonPath,
    '--out-svg', outSvgPath,
    '--min-wall-m', String(params.minWallM),
  ]
  if (params.transform) args.push('--transform', params.transform.map(String).join(','), '--up-axis', 'y')
  if (params.units) args.push('--units', params.units)
  return args
}

export async function runFloorPlan(opts: FloorPlanRunOptions): Promise<FloorPlanResult> {
  const params = resolveParams(opts)
  const manifestPath = opts.manifestPath
    ?? opts.outputJsonPath.replace(/\.floor-plan\.json$/, '') + '.floor-plan.manifest.json'
  const started = Date.now()
  const pythonLookup = runnerToolLookup('lingbot-map-python')
  const pythonLocation = await locateTool(pythonLookup, { explicit: opts.python })
  const python = pythonLocation.path ?? displayPathOf(pythonLookup, pythonLocation)

  const baseManifest: FloorPlanManifest = {
    schemaVersion: 1,
    tool: 'floor-plan-worker',
    status: 'error',
    createdAt: new Date().toISOString(),
    params: { python, workerPath: params.workerPath, minWallM: params.minWallM },
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  // 1. The input: the session's LingBot-Map reconstruction. None is a skip that names the step that makes one.
  const cloudPath = opts.sessionDir && isValidSessionDir(opts.sessionDir)
    ? `${opts.sessionDir}/${FLOOR_PLAN_INPUT}`
    : undefined
  if (!cloudPath || !(await isFile(cloudPath))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `no point cloud: the scan's session has no ${FLOOR_PLAN_INPUT}`,
      remediation: 'Run lingbot-map-reconstruct on this scan first.',
    }, 0, 'floor-plan has no input point cloud')
  }
  // The verdict splat-detect and splat-train already apply to this cloud (splat_train_dataset.ts).
  if (await lingBotCloudCollapsed(opts.sessionDir!)) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: 'lingbot-map verdict: its point cloud was judged degenerate, so there is no room to draw',
      remediation: 'Re-scan the room and run lingbot-map-reconstruct again.',
    }, 0, 'floor-plan skipped: lingbot-map verdict is degenerate')
  }
  // The capture's AR poses set the plan's scale and its up axis. None that fit is a skip, not a plan on a guess.
  const records = await readKeyframes(opts.sessionDir!)
  const fit = fitCloudToSession(await readLingbotPoses(opts.sessionDir!), records)
  if (!fit.ok) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `cannot fit the point cloud to the capture: ${fit.reason}`,
      remediation: fit.remediation,
    }, 0, `floor-plan skipped: ${fit.reason}`)
  }
  // The unit of those same poses: the calibration's, or for a scan with none, the runtime's that posed them.
  const units = floorPlanUnitsFor(floorPlanScaleKind(opts, records))
  const { transform, ...alignment } = fit.alignment

  // 2. The interpreter and the worker. One that is not found is a skip with the remediation GET /capabilities prints.
  if (!pythonLocation.found) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      ...toolSkip(pythonLookup, pythonLocation, 'floor-plan interpreter (LINGBOT_MAP_PYTHON)'),
    }, 0, `floor-plan python missing: ${python}`)
  }
  if (!(await isFile(params.workerPath))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `floor_plan_worker.py not found: ${params.workerPath}`,
      remediation: 'Restore scripts/floor_plan_worker.py, or set FLOORPLAN_WORKER to a copy of it.',
    }, 0, `floor-plan worker missing: ${params.workerPath}`)
  }

  // 3. Run the worker into a temp dir, so a failed run never overwrites the plan files already there. The manifest
  //    still records this run, as splat-detect's does, so the editor then shows the failure, not the older plan.
  const jobDir = await makeTempDir({ prefix: 'floor-plan-' })
  try {
    const jobJson = `${jobDir}/floor-plan.json`
    const jobSvg = `${jobDir}/floor-plan.svg`
    const args = buildFloorPlanArgs(params.workerPath, cloudPath, jobJson, jobSvg, { ...params, transform, units })

    let run: SpawnResult
    try {
      run = opts._spawn ? await opts._spawn(python, args, {}) : await defaultSpawn(python, args, {}, opts.signal)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: `floor-plan worker spawn failed: ${msg}`,
      }, 3, msg)
    }

    if (run.code === WORKER_EXIT_NO_NUMPY && !run.timeoutReason) {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'skipped',
        skippedReason: `numpy is not installed for the floor-plan interpreter: ${python}`,
        remediation: NO_NUMPY_REMEDIATION,
        timing: { elapsedMs: Date.now() - started },
      }, 0, run.stderr)
    }
    if (run.code !== 0) {
      const tail = run.stderr.trim().split('\n').slice(-4).join('\n')
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: run.timeoutReason
          ? `floor-plan worker ${run.timeoutReason} and was stopped`
          : `floor-plan worker exited ${run.code}${tail ? `: ${tail}` : ''}`,
        timing: { elapsedMs: Date.now() - started },
      }, run.code || 3, run.stderr)
    }

    // 4. Read back what it wrote. A clean exit with no readable plan is an error, not an empty plan.
    let planText: string
    let svgText: string
    try {
      planText = await fs.readFile(jobJson, 'utf8')
      svgText = await fs.readFile(jobSvg, 'utf8')
    } catch {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: 'floor-plan worker finished but produced no plan JSON/SVG',
        timing: { elapsedMs: Date.now() - started },
      }, run.code, run.stderr)
    }
    const summary = summarizePlan(planText)
    if (!summary) {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: 'floor-plan worker produced unparseable plan JSON',
        timing: { elapsedMs: Date.now() - started },
      }, run.code, run.stderr)
    }

    // 5. Land the plan next to the scan.
    await fs.writeFile(opts.outputJsonPath, planText)
    await fs.writeFile(opts.outputSvgPath, svgText)

    const manifest: FloorPlanManifest = {
      ...baseManifest,
      status: 'ok',
      planPath: baseName(opts.outputJsonPath),
      svgPath: baseName(opts.outputSvgPath),
      areaM2: summary.areaM2,
      wallCount: summary.wallCount,
      roomCount: summary.roomCount,
      ceilingHeightM: summary.ceilingHeightM,
      ...(summary.disclaimer ? { disclaimer: summary.disclaimer } : {}),
      units,
      frame: 'scan',
      alignment,
      timing: { elapsedMs: Date.now() - started },
    }
    await writeRunnerManifest(manifestPath, manifest, 'floor-plan')
    return {
      status: 'ok',
      manifest,
      planJsonPath: opts.outputJsonPath,
      planSvgPath: opts.outputSvgPath,
      areaM2: summary.areaM2,
      wallCount: summary.wallCount,
      log: run.stderr,
      exitCode: run.code,
    }
  } finally {
    await removeQuietly(jobDir)
  }
}

/** The headline numbers of a floor-plan.json, or null when it is not a plan (no `walls` and `rooms` arrays). */
export function summarizePlan(text: string): FloorPlanSummary | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const plan = parsed as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const walls = plan['walls']
  const rooms = plan['rooms']
  if (!Array.isArray(walls) || !Array.isArray(rooms)) return null
  const disclaimer = plan['disclaimer']
  return {
    areaM2: num(plan['areaM2']),
    wallCount: walls.length,
    roomCount: rooms.length,
    ceilingHeightM: num(plan['ceilingHeightM']),
    ...(typeof disclaimer === 'string' && disclaimer ? { disclaimer } : {}),
  }
}

/**
 * The shared session-dir check (server/run_with_deadline.ts), re-exported under the name the PR's driver exported.
 * `runFloorPlan` reads no cloud from a directory that is not a server session.
 */
export { isValidSessionDir }

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true })
  } catch {
    // already gone
  }
}

async function defaultSpawn(
  bin: string,
  args: string[],
  extraEnv: Record<string, string>,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  const output = await runWithDeadline(
    bin,
    { args, env: extraEnv, stdout: 'piped', stderr: 'piped' },
    budgetFromEnv('FLOORPLAN_TIMEOUT_MS', DEFAULT_FLOORPLAN_TIMEOUT_MS),
    KILL_GRACE_MS,
    signal,
  )
  const stderr = new TextDecoder().decode(output.stderr).trim()
  return { code: output.code, stderr, timeoutReason: output.timeoutReason }
}

function _finish(
  manifestPath: string,
  manifest: FloorPlanManifest,
  exitCode: number,
  log: string,
): Promise<FloorPlanResult> {
  return finishRun(manifestPath, manifest, exitCode, log, 'floor-plan')
}
