/**
 * Stage 3 — one Gaussian splat per timestep.
 *
 * Reuses the conventions `server/splat/splat_train.ts` and
 * `splat_train_dataset.ts` already pin, because getting them wrong produces a
 * plausible-looking but wrong splat:
 *
 *  - Nerfstudio `transforms.json` + `images/`, with per-frame intrinsics in
 *    the pixels that actually landed (read from each JPEG, never assumed).
 *  - **No axis flip.** Companion-Scan / WebXR / three.js poses are already in
 *    the OpenGL/Blender camera-to-world convention Nerfstudio expects. This is
 *    the single easiest thing to get wrong here.
 *  - Brush's flags as `brush-cli --help` lists them and as the appliance passes
 *    them (`--total-train-iters`, not the `--total-steps` this file once used),
 *    with an absolute `--export-path`: Brush resolves a relative one against
 *    the dataset's parent directory.
 *  - GPU selection is an env var, not a flag: `CUBECL_WGPU_DEFAULT_DEVICE`,
 *    set only when BRUSH_DEVICE is. Unset means no pin, which is the
 *    appliance's default too: a hard-coded `DiscreteGpu(1)` matches exactly one
 *    machine and selects nothing everywhere else.
 *  - The export is renamed to `frame-NNNNN.ply`, the only names /sequence lists
 *    and /frames serves, rather than trusting Brush's name template.
 *
 * The one deliberate divergence is iteration count. A static scan trains at
 * 15000; here that is multiplied by the timestep count, so it defaults far
 * lower. Sequence length × iterations is the pipeline's whole cost budget.
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './extract.mjs'

/** Lower than a static scan's 15000 — this is paid once per timestep. */
export const DEFAULT_TRAIN_ITERS = 3000

/** The name a trained timestep is served under. */
export function frameName(index, ext = 'ply') {
  return `frame-${String(index).padStart(5, '0')}.${ext}`
}

/**
 * Nerfstudio transforms for one frame set. Each view brings its own
 * camera-to-world `matrix` (from its pose, unflipped) and its intrinsics in the
 * pixels that landed. Pure.
 */
export function buildTransforms(views) {
  return {
    camera_model: 'OPENCV',
    frames: views.map((v) => ({
      file_path: v.file,
      transform_matrix: v.matrix,
      fl_x: v.fl_x,
      fl_y: v.fl_y,
      cx: v.cx,
      cy: v.cy,
      w: v.w,
      h: v.h,
    })),
  }
}

/**
 * Brush CLI args, in the order and spelling `buildBrushArgs` in the appliance's
 * server/splat/splat_train.ts uses. Pure, so the assembly is testable without
 * the binary. Exports once, at the last iteration.
 */
export function buildBrushArgs({ datasetDir, exportDir, trainIters, shDegree = 2, maxResolution = 1280 }) {
  return [
    datasetDir,
    '--total-train-iters', String(trainIters),
    '--sh-degree', String(shDegree),
    '--max-resolution', String(maxResolution),
    '--export-every', String(trainIters),
    '--export-path', exportDir,
    '--export-name', 'splat_{iter}.ply',
    '--eval-every', String(trainIters),
  ]
}

/** Write a Nerfstudio dataset directory's transforms.json; the images are already under it. */
export async function writeDataset(dir, views) {
  await mkdir(path.join(dir, 'images'), { recursive: true })
  await writeFile(path.join(dir, 'transforms.json'), JSON.stringify(buildTransforms(views), null, 2))
  return dir
}

/** The highest-iteration `.ply` Brush exported, or null. */
export async function findExportedPly(exportDir) {
  let best = null
  let names = []
  try {
    names = await readdir(exportDir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.ply') || name.endsWith('.compressed.ply')) continue
    const iter = Number(/(\d+)/.exec(name)?.[1] ?? 0)
    if (!best || iter >= best.iter) best = { file: path.join(exportDir, name), iter }
  }
  return best?.file ?? null
}

/** Whole-number knob, at least 1, else the default: the appliance's intFromEnv rule. */
function wholeFromEnv(raw, fallback) {
  const whole = Math.floor(Number(String(raw ?? '').trim() || Number.NaN))
  return Number.isFinite(whole) && whole >= 1 ? whole : fallback
}

/**
 * Train one timestep and land it as `<sequenceDir>/frame-NNNNN.ply`.
 *
 * `brushBin` is the binary the pipeline resolved (BRUSH_BIN, then PATH, then
 * the documented path); a missing one never gets here. A Brush that cannot be
 * started is still `skipped`, the contract every optional GPU tool keeps.
 */
export async function trainTimestep({ datasetDir, frameIndex, sequenceDir, brushBin, env = process.env, spawnFn = spawn }) {
  const trainIters = wholeFromEnv(env.BRUSH_TRAIN_ITERS, DEFAULT_TRAIN_ITERS)
  const exportDir = path.resolve(datasetDir, 'exports')
  await mkdir(exportDir, { recursive: true })
  const args = buildBrushArgs({ datasetDir: path.resolve(datasetDir), exportDir, trainIters })
  const childEnv = env.BRUSH_DEVICE ? { ...env, CUBECL_WGPU_DEFAULT_DEVICE: env.BRUSH_DEVICE } : { ...env }
  const result = await runProcess(brushBin, args, { spawnFn, env: childEnv })

  if (result.spawnError) {
    return { status: 'skipped', remediation: `Build Brush and set BRUSH_BIN (could not start ${brushBin}: ${result.spawnError.message ?? result.spawnError})` }
  }
  if (result.code !== 0) {
    return { status: 'error', error: `brush exited ${result.code}: ${String(result.stderr).slice(-300)}` }
  }
  const exported = await findExportedPly(exportDir)
  if (!exported) {
    return { status: 'error', error: `brush exited 0 but exported no .ply in ${exportDir}` }
  }
  await mkdir(sequenceDir, { recursive: true })
  const landed = path.join(sequenceDir, frameName(frameIndex))
  await copyFile(exported, landed)
  return { status: 'ok', frame: path.basename(landed) }
}
