/**
 * Splat-detect worker driver.
 *
 * Mirrors splat_train.ts: the TS side stays thin — it locates a trained
 * Gaussian-splat PLY, spawns the already-built splat_analyzer pipeline
 * (run_local.py: render → OWLv2 open-vocab detection → 3D boxes) as a
 * subprocess, then copies the resulting `interactions.json` next to the scan
 * and writes a `splat-detect.manifest.json` the world-job coordinator persists.
 *
 * The driver never hard-crashes the server:
 *   - a missing python venv or analyzer dir yields a `skipped` result with a
 *     remediation hint (exactly like splat_train handles a missing Brush binary),
 *   - a crash or a run that produced no interactions.json yields an `error`.
 *
 * splat_analyzer facts baked in (from run_local.py --help on the host this was
 * written on):
 *   run_local.py --ply <x> --prompt <p> --quality <low|medium|high>
 *     --renderer point --job_dir <tmp>
 *   An upstream checkout measured since (wave 14, 2026-11-23) lists no
 *   `--renderer` option and has no pointcloud_to_gs.py, so against it this
 *   driver's run exits 2 on the unknown flag and the point-cloud fallback
 *   cannot start (docs/splat-detect.md). The flag is still passed: dropping it
 *   would hand a ROCm host the gsplat rasterizer it has no build of. Which
 *   analyzer is the supported one is an owner decision (wave 14 report).
 *   The quality preset is the camera coverage: low renders 24 views, medium 90,
 *   high 192. This driver passes SPLAT_DETECT_QUALITY, default `medium`.
 *   Writes <job_dir>/interactions.json (+ frames/ transforms.json we discard).
 *   WMD_DEVICE=cuda selects the torch cuda/HIP path; POINT_SPLAT_SIZE=6 sizes
 *   the point renderer. A GPU pin is passed only when HIP_VISIBLE_DEVICES is
 *   set: unset means no pin, so torch takes its first device, the way
 *   BRUSH_DEVICE works for Brush. (It used to default to "1", the second GPU of
 *   the one multi-GPU host this was written on, which names a device that does
 *   not exist on a single-GPU box.)
 *   run_local.py does not emit a manifest — this driver writes it.
 *
 * Input selection:
 *   - prefer the scan's <base>.splat.ply (Brush-trained 3DGS),
 *   - else convert the session's lingbot-map.point-cloud.ply into a 3DGS-attribute
 *     PLY via $SPLAT_DETECT_DIR/pointcloud_to_gs.py first, then detect on that —
 *     unless the LingBot run judged that cloud degenerate (quality.degenerate in
 *     lingbot-map.manifest.json), in which case detection is skipped.
 */

// The manifest type lives in src/world/manifests.ts, not here — see that
// file's header (it's the canonical, Node-API-free home so the browser
// viewer can type-import it without dragging this file's `node:*` imports into
// its DOM-lib type-check program). Re-exported below so
// `import type { SplatDetectManifest } from './splat_detect.ts'` still works.
import type { SplatDetectManifest } from '../../src/world/types.ts'
import { locateTool, runnerToolLookup } from '../exec_probe.ts'
import {
  budgetFromEnv,
  finishRun,
  isValidSessionDir,
  KILL_GRACE_MS,
  runWithDeadline,
  writeRunnerManifest,
} from '../run_with_deadline.ts'
import { lingBotCloudCollapsed } from './splat_train_dataset.ts'
import * as fs from 'node:fs/promises'
import { makeTempDir } from '../fs_util.ts'
export type { SplatDetectManifest }

/** The documented venv and checkout: the shared table's fallbacks (runnerToolLookups, server/exec_probe.ts). */
const DEFAULT_DETECT_PYTHON = runnerToolLookup('splat-detect-python').fallbacks[0]
const DEFAULT_DETECT_DIR = runnerToolLookup('splat-detect-dir').fallbacks[0]
const DEFAULT_DETECT_PROMPT = 'sofa, chair, table, tv, lamp, plant, bed, desk, shelf, door, window'

export interface SplatDetectRunOptions {
  /** Absolute path to the scan's trained splat, when present (<base>.splat.ply). */
  splatPlyPath?: string
  /** Absolute path to the session dir (holds lingbot-map.point-cloud.ply fallback). */
  sessionDir?: string
  /** Where interactions.json should land (e.g. <SCANS>/<base>.interactions.json). */
  outputInteractionsPath: string
  /** Path where the splat-detect manifest is written (defaults next to outputInteractionsPath). */
  manifestPath?: string
  /** Open-vocab prompt. Falls back to env SPLAT_DETECT_PROMPT, then a house default. */
  prompt?: string
  /** Python interpreter. Falls back to env SPLAT_DETECT_PYTHON, then the venv default. */
  python?: string
  /** splat_analyzer checkout dir. Falls back to env SPLAT_DETECT_DIR, then ~/splat_analyzer. */
  detectDir?: string
  /** GPU pin for torch/HIP. Falls back to env HIP_VISIBLE_DEVICES, then '' — no pin. */
  hipVisibleDevices?: string
  /** Point-renderer splat size. Falls back to env POINT_SPLAT_SIZE, then "6". */
  pointSplatSize?: string
  /** Camera coverage preset: low (24 views) | medium (90) | high (192). Env SPLAT_DETECT_QUALITY, then "medium". */
  quality?: string
  /** Per-frame OWLv2 confidence cutoff. Env SPLAT_DETECT_SCORE_THRESHOLD; unset = run_local.py default (0.12). */
  scoreThreshold?: string
  /** Frames an object must appear in to be kept. Env SPLAT_DETECT_MIN_VOTES; unset = run_local.py default (8). */
  minVotes?: string
  /** Best single-frame confidence required. Env SPLAT_DETECT_MIN_PEAK_SCORE; unset = run_local.py default (0.40). */
  minPeakScore?: string
  /** For testing: skip the real spawn and treat these results as the analyzer run. */
  _spawn?: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; stderr: string; timeoutReason?: string | null }>
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId?: string; scanId?: string }
  /**
   * Stops the run when it fires: the job pump passes its job's signal, so a job
   * it has given up on does not leave its child running (F-27).
   */
  signal?: AbortSignal
}

export type SplatDetectStatus = 'ok' | 'skipped' | 'error'

export interface SplatDetectResult {
  status: SplatDetectStatus
  manifest: SplatDetectManifest
  /** Absolute path of the landed interactions.json when status is 'ok'. */
  interactionsPath?: string
  objectCount?: number
  /** stderr tail from the analyzer — surfaced in the UI on failure. */
  log: string
  /** Subprocess exit code (or a synthetic code on skip/pre-spawn failure). */
  exitCode: number
}

export function resolveParams(opts: SplatDetectRunOptions) {
  const python = opts.python ?? process.env.SPLAT_DETECT_PYTHON ?? DEFAULT_DETECT_PYTHON
  const detectDir = opts.detectDir ?? process.env.SPLAT_DETECT_DIR ?? DEFAULT_DETECT_DIR
  const prompt = opts.prompt ?? process.env.SPLAT_DETECT_PROMPT ?? DEFAULT_DETECT_PROMPT
  // '' is "no pin": the child is then not given HIP_VISIBLE_DEVICES at all.
  const hipVisibleDevices = opts.hipVisibleDevices ?? process.env.HIP_VISIBLE_DEVICES ?? ''
  const pointSplatSize = opts.pointSplatSize ?? process.env.POINT_SPLAT_SIZE ?? '6'
  const quality = opts.quality ?? process.env.SPLAT_DETECT_QUALITY ?? 'medium'
  // Clustering knobs: undefined means "let run_local.py use its own default"
  // (score 0.12 / votes 8 / peak 0.40) so we never fight the analyzer when
  // untuned — override only once calibrated on a real room splat.
  const scoreThreshold = opts.scoreThreshold ?? process.env.SPLAT_DETECT_SCORE_THRESHOLD ?? undefined
  const minVotes = opts.minVotes ?? process.env.SPLAT_DETECT_MIN_VOTES ?? undefined
  const minPeakScore = opts.minPeakScore ?? process.env.SPLAT_DETECT_MIN_PEAK_SCORE ?? undefined
  return {
    python,
    detectDir,
    prompt,
    hipVisibleDevices,
    pointSplatSize,
    quality,
    scoreThreshold,
    minVotes,
    minPeakScore,
    renderer: 'point',
  }
}

/**
 * Assemble the run_local.py CLI arguments. `--renderer point` avoids the gsplat
 * rasterizer that has no ROCm build on this box. `--quality` is the coverage
 * preset from SPLAT_DETECT_QUALITY (default medium, 90 views; low is 24, the
 * cheap one).
 */
export function buildDetectArgs(
  runLocalPath: string,
  plyPath: string,
  jobDir: string,
  params: ReturnType<typeof resolveParams>,
): string[] {
  const args = [
    runLocalPath,
    '--ply', plyPath,
    '--prompt', params.prompt,
    '--quality', params.quality,
    '--renderer', params.renderer,
    '--job_dir', jobDir,
  ]
  // Only pass clustering knobs when explicitly set — otherwise run_local.py
  // applies its own tuned defaults.
  if (params.scoreThreshold != null) args.push('--score_threshold', params.scoreThreshold)
  if (params.minVotes != null) args.push('--min_votes', params.minVotes)
  if (params.minPeakScore != null) args.push('--min_peak_score', params.minPeakScore)
  return args
}

export async function runSplatDetect(opts: SplatDetectRunOptions): Promise<SplatDetectResult> {
  const params = resolveParams(opts)
  const manifestPath = opts.manifestPath
    ?? opts.outputInteractionsPath.replace(/\.interactions\.json$/, '') + '.splat-detect.manifest.json'
  const started = Date.now()

  const baseManifest: SplatDetectManifest = {
    schemaVersion: 1,
    tool: 'splat-analyzer',
    status: 'error',
    createdAt: new Date().toISOString(),
    prompt: params.prompt,
    params,
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  const runLocalPath = `${params.detectDir}/run_local.py`
  const converterPath = `${params.detectDir}/pointcloud_to_gs.py`

  // 1. Guard: python + the analyzer checkout must exist before we do any work.
  //    A missing venv/dir is a *skip*, not an error — the server keeps running
  //    and the UI shows a remediation, the same one GET /capabilities prints.
  const pythonLookup = runnerToolLookup('splat-detect-python')
  const pythonLocation = await locateTool(pythonLookup, { explicit: params.python })
  if (!pythonLocation.found) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `splat-analyzer python not found or not executable: ${params.python}`,
      remediation: pythonLookup.remediation,
    }, 0, `splat-detect python missing: ${params.python}`)
  }
  const python = pythonLocation.path ?? params.python
  if (!(await exists(runLocalPath))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `splat-analyzer run_local.py not found: ${runLocalPath}`,
      remediation: runnerToolLookup('splat-detect-dir').remediation,
    }, 0, `splat-detect dir missing: ${params.detectDir}`)
  }

  // 2. Resolve the input PLY: the trained splat wins; else convert the session's
  //    plain point cloud into a 3DGS-attribute PLY the analyzer loader ingests.
  let detectPly: string
  let convertedPly: string | undefined
  const jobDir = await makeTempDir({ prefix: 'splat-detect-' })
  try {
    if (opts.splatPlyPath && (await exists(opts.splatPlyPath))) {
      detectPly = opts.splatPlyPath
    } else {
      // A LingBot cloud its own run judged collapsed is not detection input. This
      // is the same verdict splat_train_dataset.ts applies before it seeds a splat.
      if (opts.sessionDir && (await lingBotCloudCollapsed(opts.sessionDir))) {
        await removeQuietly(jobDir)
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'skipped',
          skippedReason:
            'lingbot-map verdict: its point cloud was judged degenerate, so there is no input to detect on',
          remediation: 'Run a splat-train job on this scan, or re-scan the room and run lingbot-map-reconstruct again.',
        }, 0, 'splat-detect skipped: lingbot-map verdict is degenerate')
      }
      const srcCloud = opts.sessionDir ? `${opts.sessionDir}/lingbot-map.point-cloud.ply` : undefined
      if (!srcCloud || !(await exists(srcCloud))) {
        await removeQuietly(jobDir)
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'skipped',
          skippedReason: 'no splat: scan has no <base>.splat.ply and the session has no lingbot-map.point-cloud.ply',
          remediation: 'Run a splat-train job on this scan first, or a lingbot-map-reconstruct job whose cloud is not judged degenerate.',
        }, 0, 'splat-detect has no input ply')
      }
      // Convert the plain xyz+rgb cloud into a 3DGS-attribute PLY.
      convertedPly = `${jobDir}/from-pointcloud.gs.ply`
      const convEnv: Record<string, string> = gpuPinEnv(params.hipVisibleDevices)
      let convResult: { code: number; stderr: string; timeoutReason?: string | null }
      try {
        convResult = opts._spawn
          ? await opts._spawn(python, [converterPath, srcCloud, convertedPly], convEnv)
          : await defaultSpawn(python, [converterPath, srcCloud, convertedPly], convEnv, opts.signal)
      } catch (e) {
        await removeQuietly(jobDir)
        const msg = e instanceof Error ? e.message : String(e)
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'error',
          error: `pointcloud_to_gs spawn failed: ${msg}`,
        }, 3, msg)
      }
      if (convResult.code !== 0 || !(await exists(convertedPly))) {
        await removeQuietly(jobDir)
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'error',
          error: convResult.timeoutReason
            ? `pointcloud_to_gs ${convResult.timeoutReason} and was stopped`
            : `pointcloud_to_gs exited ${convResult.code}`,
          timing: { elapsedMs: Date.now() - started },
        }, convResult.code || 3, convResult.stderr)
      }
      detectPly = convertedPly
    }

    // 3. Spawn the analyzer headless with the GPU pin + point renderer.
    const args = buildDetectArgs(runLocalPath, detectPly, jobDir, params)
    const env: Record<string, string> = {
      ...gpuPinEnv(params.hipVisibleDevices),
      WMD_DEVICE: 'cuda',
      POINT_SPLAT_SIZE: params.pointSplatSize,
    }

    let spawnResult: { code: number; stderr: string; timeoutReason?: string | null }
    try {
      spawnResult = opts._spawn
        ? await opts._spawn(python, args, env)
        : await defaultSpawn(python, args, env, opts.signal)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: `splat-analyzer spawn failed: ${msg}`,
      }, 3, msg)
    }

    if (spawnResult.code !== 0) {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: spawnResult.timeoutReason
          ? `splat-analyzer ${spawnResult.timeoutReason} and was stopped`
          : `splat-analyzer exited ${spawnResult.code}`,
        timing: { elapsedMs: Date.now() - started },
      }, spawnResult.code, spawnResult.stderr)
    }

    // 4. Locate + read interactions.json.
    const producedInteractions = `${jobDir}/interactions.json`
    let interactionsText: string
    try {
      interactionsText = await fs.readFile(producedInteractions, 'utf8')
    } catch {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: 'splat-analyzer finished but produced no interactions.json',
        timing: { elapsedMs: Date.now() - started },
      }, spawnResult.code, spawnResult.stderr)
    }
    const objectCount = countInteractions(interactionsText) ?? 0

    // 5. Land interactions.json next to the scan.
    await fs.writeFile(opts.outputInteractionsPath, interactionsText)

    const manifest: SplatDetectManifest = {
      ...baseManifest,
      status: 'ok',
      interactionsPath: opts.outputInteractionsPath.split('/').pop(),
      objectCount,
      timing: { elapsedMs: Date.now() - started },
    }
    await writeManifest(manifestPath, manifest)

    return {
      status: 'ok',
      manifest,
      interactionsPath: opts.outputInteractionsPath,
      objectCount,
      log: spawnResult.stderr,
      exitCode: spawnResult.code,
    }
  } finally {
    await removeQuietly(jobDir)
  }
}

/** Count detected objects from an interactions.json payload. */
export function countInteractions(text: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed.length
  if (parsed && typeof parsed === 'object') {
    const objs = (parsed as Record<string, unknown>)['objects']
    if (Array.isArray(objs)) return objs.length
    const interactions = (parsed as Record<string, unknown>)['interactions']
    if (Array.isArray(interactions)) return interactions.length
  }
  return null
}

/**
 * The shared session-dir check (server/run_with_deadline.ts), re-exported under
 * the name this module always exported. `runSplatDetect` itself has no caller
 * of it: its input is a splat path, not a session dir.
 */
export { isValidSessionDir }

/**
 * The child's GPU pin. An empty pin is no pin: the variable is left out, so the
 * child sees every device (or whatever the server's own environment says).
 */
export function gpuPinEnv(hipVisibleDevices: string): Record<string, string> {
  return hipVisibleDevices ? { HIP_VISIBLE_DEVICES: hipVisibleDevices } : {}
}

// isRunnable now lives in ./exec_probe.ts — it was duplicated here and in
// splat_train.ts, and both copies mis-detected every binary as non-runnable
// on Windows (see that file's header for the mode-bit reason).

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
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

/** Covers the converter and the analyzer; each call gets this budget, not one shared across both. Untuned. */
const DEFAULT_DETECT_TIMEOUT_MS = 60 * 60 * 1000

async function defaultSpawn(
  bin: string,
  args: string[],
  extraEnv: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string; timeoutReason: string | null }> {
  const output = await runWithDeadline(
    bin,
    { args, env: extraEnv, stdout: 'piped', stderr: 'piped' },
    budgetFromEnv('SPLAT_DETECT_TIMEOUT_MS', DEFAULT_DETECT_TIMEOUT_MS),
    KILL_GRACE_MS,
    signal,
  )
  const stderr = new TextDecoder().decode(output.stderr).trim()
  return { code: output.code, stderr, timeoutReason: output.timeoutReason }
}

async function writeManifest(path: string, manifest: SplatDetectManifest): Promise<void> {
  await writeRunnerManifest(path, manifest, 'splat-detect')
}

function _finish(
  manifestPath: string,
  manifest: SplatDetectManifest,
  exitCode: number,
  log: string,
): Promise<SplatDetectResult> {
  return finishRun(manifestPath, manifest, exitCode, log, 'splat-detect')
}
