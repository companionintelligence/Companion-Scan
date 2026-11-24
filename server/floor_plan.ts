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
 * Units: the plan is in the cloud's own units. A LingBot-Map cloud is not known to be metric (lingbot_map.ts measures
 * it "in the worker's own units"; docs/pipelines/splat-toolbox.md: a reconstruction is unitless until splat-align says
 * otherwise), so `areaM2`, `lengthM` and `ceilingHeightM` are metres only when the cloud was. The plan file says so in
 * its `disclaimer`, which the manifest carries too.
 *
 * Worker contract (scripts/floor_plan_worker.py):
 *   floor_plan_worker.py --ply <cloud> --out-json <p> --out-svg <p> [--min-wall-m 0.5]
 *   exit 0 plan written · 2 bad input · 3 numpy missing. Deterministic, CPU only. It writes no manifest.
 */
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { FloorPlanManifest } from '../src/world/types.ts'
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
import { lingBotCloudCollapsed } from './splat/splat_train_dataset.ts'
export type { FloorPlanManifest }

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

/** The floor_plan_worker.py arguments, in a stable order. */
export function buildFloorPlanArgs(
  workerPath: string,
  plyPath: string,
  outJsonPath: string,
  outSvgPath: string,
  params: { minWallM: number },
): string[] {
  return [
    workerPath,
    '--ply', plyPath,
    '--out-json', outJsonPath,
    '--out-svg', outSvgPath,
    '--min-wall-m', String(params.minWallM),
  ]
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
    const args = buildFloorPlanArgs(params.workerPath, cloudPath, jobJson, jobSvg, params)

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
