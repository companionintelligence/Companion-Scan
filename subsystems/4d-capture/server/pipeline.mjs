/**
 * Take orchestration: download → densify (or not) → frame sets → per-timestep train.
 *
 * Every stage returns `ok` / `skipped` / `error` and the whole run always ends
 * with a result object, because the appliance maps those straight through:
 * `skipped` becomes a *green* job with a remediation hint, never a red one.
 * That contract is what lets a Companion Scan install work with no GPU host
 * attached at all. A missing tool (ffmpeg, Brush, 4DAnyone or its python) is
 * `skipped`; a take that cannot be reconstructed from what arrived is `error`.
 *
 * What the appliance sends for each clip (`buildSubmitRequest` in
 * server/person4d/person_4d.ts): `url`, `mimeType`, `poseTrackUrl`, `sync`,
 * `clientId`, and, when it has them, `durationMs` and `localToWorld`. This
 * module fetches the clip and pose track with the shared token, so nothing here
 * depends on a path on the appliance's disk.
 */
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { densify } from '../stages/densify.mjs'
import { extractFrame, jpegFileDimensions, probeDurationMs } from '../stages/extract.mjs'
import { downloadToFile, fetchJson } from '../stages/fetch.mjs'
import { bestClip, choosePath, commonWindow, planFrameSets } from '../stages/frameset.mjs'
import {
  cameraToMatrix,
  columnMajorToRows,
  frameIntrinsics,
  mul4,
  poseToMatrix,
  readIntrinsics,
  samplePoseTrack,
  trackIntrinsics,
} from '../stages/pose.mjs'
import { runStub } from '../stages/stub.mjs'
import { missingTool, resolveTool, toolTable } from '../stages/tools.mjs'
import { trainTimestep, writeDataset } from '../stages/train.mjs'

const pad = (n, width) => String(n).padStart(width, '0')
const message = (err) => (err instanceof Error ? err.message : String(err))
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

/**
 * Run one take. Never throws for an expected failure; the service still guards
 * against a throw.
 *
 * `opts`: `workDir`, `env`, `stub`, `onProgress(fraction, stage)`, and the
 * injection seams `fetchFn` and `spawnFn`. `token` defaults to FDANYONE_TOKEN.
 */
export async function runTake(take, opts = {}) {
  const { workDir, env = process.env, stub = false, onProgress = () => {}, fetchFn = fetch, spawnFn } = opts
  const token = opts.token ?? (env.FDANYONE_TOKEN || null)
  const takeDir = path.join(workDir, take.takeId)
  const sequenceDir = path.join(takeDir, 'sequence')
  const clips = take.clips ?? []
  const fps = positive(take.params?.timestepFps) ?? 5
  const done = (result) => ({ ...result, takeId: take.takeId, clipCount: clips.length })

  if (clips.length === 0) {
    return { status: 'error', error: 'take has no clips' }
  }
  // The take directory is cleared below, so it must be one under workDir. The
  // service validates take ids too; this holds for any other caller.
  const relative = path.relative(path.resolve(workDir), path.resolve(takeDir))
  if (!take.takeId || relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    return { status: 'error', error: 'invalid takeId' }
  }
  // A resubmitted take starts clean. An earlier run's frames would be listed
  // by /sequence and pulled back as this run's, and an earlier export in a
  // timestep's exports/ would be taken for a Brush run that exported nothing.
  await rm(takeDir, { recursive: true, force: true })

  if (stub) {
    onProgress(0.5, 'stub')
    const result = await runStub({ takeId: take.takeId, sequenceDir, fps, clipCount: clips.length })
    onProgress(1, 'done')
    return result
  }

  // 1. Tools, before a byte is downloaded: a take needs ffmpeg to slice frames
  //    and Brush to train them. ffprobe is optional (the pose track usually
  //    carries the duration). 4DAnyone is checked by densify() itself.
  const tools = toolTable(env)
  const ffmpeg = await resolveTool(tools.ffmpeg, env)
  if (!ffmpeg.found) return done(missingTool(tools.ffmpeg, ffmpeg))
  const brush = await resolveTool(tools.brush, env)
  if (!brush.found) return done(missingTool(tools.brush, brush))
  const ffprobe = await resolveTool(tools.ffprobe, env)

  // 2. Download every clip and its pose track, with the shared token.
  const local = []
  for (const [i, clip] of clips.entries()) {
    if (typeof clip?.url !== 'string' || !clip.url) return done({ status: 'error', error: `clip ${i + 1} has no url` })
    const ext = /webm/i.test(clip.mimeType ?? '') ? 'webm' : 'mp4'
    const localPath = path.join(takeDir, 'clips', `clip-${pad(i, 2)}.${ext}`)
    onProgress(0.02 + (0.08 * i) / clips.length, `download ${i + 1}/${clips.length}`)
    try {
      await downloadToFile(clip.url, localPath, { token, fetchFn, what: `clip ${i + 1}` })
    } catch (err) {
      return done({ status: 'error', error: `could not download clip ${i + 1}: ${message(err)}` })
    }
    let poseTrack = null
    if (clip.poseTrackUrl) {
      try {
        poseTrack = await fetchJson(clip.poseTrackUrl, { token, fetchFn, what: `the pose track of clip ${i + 1}` })
      } catch (err) {
        // A clip without its track can still be densified; the path decision below sees it as unposed.
        console.warn(`[4d-capture] clip ${i + 1}: ${message(err)}`)
      }
    }
    // The recorder's own measurement first, then the file itself, then what the appliance sent.
    const durationMs = positive(poseTrack?.durationMs) ??
      (ffprobe.found ? await probeDurationMs(localPath, { ffprobe: ffprobe.path, spawnFn }) : null) ??
      positive(clip.durationMs)
    local.push({ ...clip, index: i, localPath, poseTrack, durationMs })
  }

  // 3. Which path, and why, decided on what actually arrived. Recorded rather
  //    than decided silently — a take that *could* have been multi-camera and
  //    was densified instead is a fact the operator should be able to see.
  const decision = choosePath(local)
  onProgress(0.1, `path: ${decision.viewSource}`)

  let views
  let window
  if (decision.viewSource === 'densified') {
    const clip = bestClip(local)
    if (!clip.durationMs) {
      return done({ status: 'error', error: `clip ${clip.index + 1} has no known duration: no pose track, no ffprobe, and none was sent` })
    }
    let densifyEnv = env
    if (env.FDANYONE_DIR) {
      const python = await resolveTool(tools.python, env)
      if (!python.found) return done(missingTool(tools.python, python))
      densifyEnv = { ...env, FDANYONE_PYTHON: python.path }
    }
    onProgress(0.12, 'densify')
    const out = await densify({
      clipPath: clip.localPath,
      viewsPerLayer: take.params?.viewsPerLayer ?? 6,
      env: densifyEnv,
      workDir: takeDir,
      ...(spawnFn ? { spawnFn } : {}),
    })
    if (out.status !== 'ok') {
      // Skip and error both propagate verbatim — the appliance distinguishes them.
      return done(out)
    }
    const cameras = Array.isArray(out.cameras?.cameras) ? out.cameras.cameras : Array.isArray(out.cameras) ? out.cameras : []
    // A synthesized view's lens is 4DAnyone's, not the phone's: its own record, then the run's metadata.
    const shared = readIntrinsics(out.cameras?.intrinsics) ?? readIntrinsics(out.metadata?.intrinsics) ?? readIntrinsics(out.metadata)
    views = cameras.map((cam, i) => ({
      label: `densified view ${i}`,
      source: path.join(out.denseDir, `${pad(i, 2)}.mp4`),
      matrix: cameraToMatrix(cam),
      intrinsics: readIntrinsics(cam) ?? readIntrinsics(cam?.intrinsics) ?? shared,
    }))
    const usable = views.filter((v) => v.matrix && v.intrinsics)
    if (usable.length === 0) {
      return done({
        status: 'error',
        error: `4DAnyone's cameras.json has no camera this pipeline can place (${cameras.length} entries; ` +
          'it reads a 4x4 or flat-16 camera-to-world, or position + rotation, with fx/fy or a vertical fov ' +
          'on the camera or in metadata.json)',
      })
    }
    views = usable
    window = { startMs: 0, durationMs: clip.durationMs }
  } else {
    views = decision.members.map((c) => ({
      label: `clip ${c.index + 1}`,
      source: c.localPath,
      poseTrack: c.poseTrack,
      localToWorld: columnMajorToRows(c.localToWorld),
      // A measured offset is applied at slice time, never by mutating a device clock.
      offsetMs: -(c.sync?.offsetMs ?? 0),
      durationMs: c.durationMs,
    }))
    const unknown = views.find((v) => !v.durationMs)
    if (unknown) return done({ status: 'error', error: `${unknown.label} has no known duration` })
    window = commonWindow(views)
    if (!(window.durationMs > 0)) {
      return done({ status: 'error', error: 'the synchronised clips do not overlap in time once their offsets are applied' })
    }
  }

  const frameSets = planFrameSets({ views, durationMs: window.durationMs, timestepFps: fps, startMs: window.startMs })
  if (frameSets.length === 0) {
    return done({ status: 'error', error: `no timesteps to train: ${window.durationMs} ms at ${fps} fps` })
  }
  onProgress(0.25, `${frameSets.length} timesteps`)
  await mkdir(sequenceDir, { recursive: true })

  // 4. Per timestep: slice each view, place it, train, and land the export.
  //    Frames are numbered by what trained, contiguously: the viewer asks for
  //    frame-00000 to frame-(N-1). A timestep with no usable view is left out
  //    and counted, so a shortfall is visible rather than a gap that 404s.
  let trained = 0
  const droppedViews = []
  const emptyTimesteps = []
  for (const frameSet of frameSets) {
    const datasetDir = path.join(takeDir, `t-${pad(frameSet.index, 5)}`)
    await mkdir(path.join(datasetDir, 'images'), { recursive: true })
    const placed = []
    for (const v of frameSet.views) {
      const view = views[v.viewIndex]
      const file = `images/view-${pad(v.viewIndex, 3)}.jpg`
      const why = await placeView(view, v.timeMs, path.join(datasetDir, file), { ffmpeg: ffmpeg.path, spawnFn })
      if (typeof why === 'string') {
        droppedViews.push(`t${frameSet.index} ${view.label}: ${why}`)
        continue
      }
      placed.push({ file, ...why })
    }
    if (placed.length === 0) {
      emptyTimesteps.push(frameSet.index)
      continue
    }
    await writeDataset(datasetDir, placed)
    const out = await trainTimestep({ datasetDir, frameIndex: trained, sequenceDir, brushBin: brush.path, env, ...(spawnFn ? { spawnFn } : {}) })
    if (out.status !== 'ok') return done(out)
    trained++
    onProgress(0.25 + (trained / frameSets.length) * 0.7, `trained ${trained}/${frameSets.length}`)
  }

  if (trained === 0) {
    return done({
      status: 'error',
      error: `no timestep had a usable view (${droppedViews.slice(0, 3).join('; ')}${droppedViews.length > 3 ? '; …' : ''})`,
    })
  }

  onProgress(1, 'done')
  return done({
    status: 'ok',
    viewSource: decision.viewSource,
    pathReason: decision.reason,
    degraded: decision.degraded ?? false,
    viewCount: views.length,
    frameCount: trained,
    fps,
    durationMs: window.durationMs,
    sequenceDir,
    ...(emptyTimesteps.length > 0 ? { emptyTimesteps } : {}),
    ...(droppedViews.length > 0 ? { droppedViewCount: droppedViews.length } : {}),
  })
}

/**
 * Slice one view at `timeMs` into `outPath` and say where its camera was.
 * Returns the Nerfstudio frame fields, or a reason the view cannot be used.
 */
async function placeView(view, timeMs, outPath, { ffmpeg, spawnFn }) {
  const extracted = await extractFrame(view.source, timeMs, outPath, { ffmpeg, spawnFn })
  if (!extracted.ok) return extracted.error
  const dims = await jpegFileDimensions(outPath)
  if (!dims) return 'the extracted frame is not a readable JPEG'

  let matrix
  let intrinsics
  if (view.poseTrack) {
    const pose = samplePoseTrack(view.poseTrack, timeMs)
    if (!pose) return `the pose track has no sample near ${timeMs} ms`
    matrix = poseToMatrix(pose)
    // Session frame → Place frame, so every member's camera is in one frame.
    if (view.localToWorld) matrix = mul4(view.localToWorld, matrix)
    intrinsics = trackIntrinsics(view.poseTrack, timeMs)
    if (!intrinsics) return 'the pose track carries no intrinsics'
  } else {
    matrix = view.matrix
    intrinsics = view.intrinsics
  }
  return { matrix, ...frameIntrinsics(intrinsics, dims.w, dims.h) }
}
