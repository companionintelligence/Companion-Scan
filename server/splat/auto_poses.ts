/**
 * Session → Nerfstudio dataset, solving the poses with COLMAP first when the
 * session has none.
 *
 * Shared by both trainers (splat_train.ts for Brush, spirula_train.ts for
 * Spirula), which carried this block twice, identical but for the dataset
 * options (ADR 0001).
 *
 * A pose-less session is recoverable, not terminal: COLMAP can solve the poses
 * on CPU. Chaining it here is what makes `splat-train` a pipeline rather than a
 * stage that needs a human to notice the dependency and queue it by hand, which
 * is how every photo-ingest session once ended up stuck at "no camera poses".
 * Opt out with SPLAT_TRAIN_AUTO_POSES=0 (or `autoSolvePoses: false`) when a
 * caller wants the failure surfaced instead of repaired.
 */
import { type BuildDatasetOptions, buildBrushDataset } from './splat_train_dataset.ts'
import { runColmapPoses } from '../colmap/colmap_poses.ts'

type Dataset = Awaited<ReturnType<typeof buildBrushDataset>>

/** The manifest fields a failed build adds, and the exit code and log the runner reports with them. */
export interface DatasetFailure {
  manifest: { status: 'skipped' | 'error'; skippedReason?: string; error?: string; remediation?: string }
  exitCode: number
  log: string
}

export type DatasetOutcome = { ok: true; dataset: Dataset } | { ok: false; failure: DatasetFailure }

/** Injection seams, so the policy is testable without a session or COLMAP on disk. */
export interface AutoPosesDeps {
  build?: (opts: BuildDatasetOptions) => Promise<Dataset>
  solve?: (opts: { sessionDir: string; signal?: AbortSignal }) => ReturnType<typeof runColmapPoses>
  /** The trainer job's signal, handed to the COLMAP solve so it stops with the job. */
  signal?: AbortSignal
}

export async function buildDatasetWithAutoPoses(
  datasetOpts: BuildDatasetOptions,
  autoSolvePoses?: boolean,
  deps: AutoPosesDeps = {},
): Promise<DatasetOutcome> {
  const build = deps.build ?? buildBrushDataset
  const solve = deps.solve ?? runColmapPoses
  const autoSolve = autoSolvePoses ?? process.env.SPLAT_TRAIN_AUTO_POSES !== '0'

  try {
    return { ok: true, dataset: await build(datasetOpts) }
  } catch (first) {
    if (!(autoSolve && /no camera poses/.test(messageOf(first)))) return { ok: false, failure: classify(first) }
  }

  const solved = await solve({ sessionDir: datasetOpts.sessionDir, ...(deps.signal ? { signal: deps.signal } : {}) })
  if (solved.status !== 'ok') {
    // Surface COLMAP's own diagnosis: it tells "not installed" from "this
    // capture has no parallax", and those need different fixes.
    const reason = solved.manifest.skippedReason ?? solved.manifest.error ?? 'pose solve failed'
    const skipped = solved.status === 'skipped'
    return {
      ok: false,
      failure: {
        manifest: {
          status: skipped ? 'skipped' : 'error',
          ...(skipped ? { skippedReason: reason } : { error: reason }),
          remediation: solved.manifest.remediation,
        },
        exitCode: skipped ? 0 : 2,
        log: solved.log,
      },
    }
  }

  try {
    return { ok: true, dataset: await build(datasetOpts) }
  } catch (second) {
    return { ok: false, failure: classify(second) }
  }
}

/** "No keyframes" is a graceful skip; any other conversion failure is an error. */
function classify(err: unknown): DatasetFailure {
  const msg = messageOf(err)
  if (/no keyframes|no usable keyframes/.test(msg)) {
    return {
      manifest: { status: 'skipped', skippedReason: msg, remediation: 'Stream keyframes for this scan before training a splat.' },
      exitCode: 0,
      log: msg,
    }
  }
  return { manifest: { status: 'error', error: `dataset build failed: ${msg}` }, exitCode: 2, log: msg }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
