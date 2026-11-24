/**
 * runTake end to end with the tools faked at the spawn and the appliance faked
 * at fetch (FN-132, FN-187, FN-188): the clip and pose track are downloaded with
 * the token, frames are extracted, every view is placed from its pose and
 * intrinsics, Brush is run with the real flags, and the exports are named
 * frame-NNNNN.ply. The server test tests/unit/server/wp-runners-4d-e2e.test.ts
 * drives the same path with the real appliance side.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runTake } from '../server/pipeline.mjs'
import { fakeAppliance, fakeSpawn, placeholderBin, tinyJpeg } from './helpers.mjs'

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function poseTrack(durationMs, x0) {
  const frames = []
  for (let t = 0; t <= durationMs; t += 50) {
    frames.push({ timestamp: t, pose: { position: { x: x0 + t / 1000, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } })
  }
  return { version: 1, durationMs, intrinsics: { width: 1080, height: 1920, fovYDeg: 50, aspect: 0.5625 }, frames }
}

/** The tools, faked: ffmpeg writes a 270x480 JPEG, Brush exports a PLY, 4DAnyone writes its layout. */
function tools(cameras) {
  return fakeSpawn(async (bin, args) => {
    const name = path.basename(bin)
    if (name === 'ffmpeg') {
      await writeFile(args[args.length - 1], tinyJpeg(270, 480))
    } else if (name === 'brush-cli') {
      const out = args[args.indexOf('--export-path') + 1]
      await mkdir(out, { recursive: true })
      await writeFile(path.join(out, 'splat_3000.ply'), `ply for ${args[0]}`)
    } else if (name === 'python') {
      const video = args[args.indexOf('--video_path') + 1]
      const data = args[args.indexOf('--data_dir') + 1]
      const clipName = path.basename(video, path.extname(video))
      await mkdir(path.join(data, clipName, 'videos', 'dense'), { recursive: true })
      await writeFile(path.join(data, clipName, 'cameras.json'), JSON.stringify(cameras))
    }
    return { code: 0 }
  })
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), '4d-pipeline-'))
  const bin = path.join(root, 'bin')
  await mkdir(bin)
  const env = {
    PATH: '',
    FFMPEG_BIN: await placeholderBin(path.join(bin, 'ffmpeg')),
    BRUSH_BIN: await placeholderBin(path.join(bin, 'brush-cli')),
    FDANYONE_PYTHON: await placeholderBin(path.join(bin, 'python')),
    FDANYONE_DIR: root,
    BRUSH_TRAIN_ITERS: '3000',
  }
  return { root, env }
}

test('a single clip is downloaded with the token, densified, placed, trained and named frame-NNNNN', async () => {
  const { root, env } = await setup()
  try {
    const cameras = {
      cameras: Array.from({ length: 6 }, (_, i) => ({
        transform_matrix: [[1, 0, 0, i], [0, 1, 0, 0], [0, 0, 1, 2], [0, 0, 0, 1]],
        fovYDeg: 40,
      })),
    }
    const { spawnFn, calls } = tools(cameras)
    const { fetchFn, seen } = fakeAppliance({
      'http://appliance/sessions/s1/clip/clip.mp4': Buffer.alloc(2500, 7),
      'http://appliance/sessions/s1/pose-track.json': poseTrack(1000, 0),
    }, { token: 'tok', chunk: 1000 })

    const result = await runTake({
      takeId: 'take-solo',
      clips: [{ url: 'http://appliance/sessions/s1/clip/clip.mp4', mimeType: 'video/mp4', poseTrackUrl: 'http://appliance/sessions/s1/pose-track.json', sync: null }],
      params: { timestepFps: 2, viewsPerLayer: 6 },
    }, { workDir: root, env, token: 'tok', fetchFn, spawnFn })

    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.viewSource, 'densified')
    assert.equal(result.frameCount, 2)
    assert.equal(result.viewCount, 6)
    assert.ok(seen.every((s) => s.auth === 'Bearer tok'), 'every download carries the token')
    assert.deepEqual((await readdir(result.sequenceDir)).sort(), ['frame-00000.ply', 'frame-00001.ply'])

    const transforms = JSON.parse(await readFile(path.join(root, 'take-solo', 't-00000', 'transforms.json'), 'utf8'))
    assert.equal(transforms.frames.length, 6)
    // The view's own matrix, not the identity, and its own 40° lens at the extracted 270x480, not 60° at 1080x1920.
    assert.equal(transforms.frames[3].transform_matrix[0][3], 3)
    assert.equal(transforms.frames[0].w, 270)
    assert.ok(Math.abs(transforms.frames[0].fl_y - 480 / (2 * Math.tan((40 * Math.PI) / 360))) < 1e-9)

    const brush = calls.find((c) => path.basename(c.bin) === 'brush-cli')
    assert.ok(brush.args.includes('--total-train-iters'))
    assert.ok(path.isAbsolute(brush.args[brush.args.indexOf('--export-path') + 1]))
    assert.equal(brush.opts.env.CUBECL_WGPU_DEFAULT_DEVICE, undefined, 'no GPU pin unless BRUSH_DEVICE is set')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two synchronised, placed clips are a multi-camera take, each view posed from its own track at the timestep', async () => {
  const { root, env } = await setup()
  try {
    const { spawnFn, calls } = tools(null)
    const sync = { method: 'measured', offsetMs: 0, residualMs: 5, toleranceMs: 50 }
    // Member b's session sits 10 m along x in the Place frame.
    const shifted = [...IDENTITY16]
    shifted[12] = 10
    const { fetchFn } = fakeAppliance({
      'http://a/sessions/a/clip/clip.mp4': Buffer.alloc(100),
      'http://a/sessions/a/pose-track.json': poseTrack(1000, 0),
      'http://a/sessions/b/clip/clip.webm': Buffer.alloc(100),
      'http://a/sessions/b/pose-track.json': poseTrack(1000, 0),
    })
    const result = await runTake({
      takeId: 'take-pair',
      clips: [
        { url: 'http://a/sessions/a/clip/clip.mp4', mimeType: 'video/mp4', poseTrackUrl: 'http://a/sessions/a/pose-track.json', sync, localToWorld: IDENTITY16 },
        { url: 'http://a/sessions/b/clip/clip.webm', mimeType: 'video/webm', poseTrackUrl: 'http://a/sessions/b/pose-track.json', sync, localToWorld: shifted },
      ],
      params: { timestepFps: 2 },
    }, { workDir: root, env, fetchFn, spawnFn })

    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.viewSource, 'multi-camera')
    assert.equal(calls.filter((c) => path.basename(c.bin) === 'python').length, 0, '4DAnyone is not run')
    const t0 = JSON.parse(await readFile(path.join(root, 'take-pair', 't-00000', 'transforms.json'), 'utf8'))
    // Timestep 0 is sampled at 250 ms, where each track has moved 0.25 m; b is 10 m further in the Place frame.
    assert.ok(Math.abs(t0.frames[0].transform_matrix[0][3] - 0.25) < 1e-9)
    assert.ok(Math.abs(t0.frames[1].transform_matrix[0][3] - 10.25) < 1e-9)
    // The lens is the pose track's 50°, scaled to the extracted frame.
    assert.ok(Math.abs(t0.frames[0].fl_y - 480 / (2 * Math.tan((50 * Math.PI) / 360))) < 1e-9)
    const extract = calls.find((c) => path.basename(c.bin) === 'ffmpeg')
    assert.equal(extract.args[extract.args.indexOf('-ss') + 1], '0.250')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing ffmpeg or Brush is a skip with a remediation, decided before anything is downloaded', async () => {
  const { root, env } = await setup()
  try {
    const { fetchFn, seen } = fakeAppliance({})
    for (const [missing, word] of [['FFMPEG_BIN', 'ffmpeg'], ['BRUSH_BIN', 'Brush']]) {
      const result = await runTake(
        { takeId: 'take-x', clips: [{ url: 'http://a/c.mp4' }] },
        { workDir: root, env: { ...env, [missing]: path.join(root, 'nope') }, fetchFn, spawnFn: tools(null).spawnFn },
      )
      assert.equal(result.status, 'skipped', missing)
      assert.match(result.remediation, new RegExp(missing))
      assert.match(result.skippedReason, new RegExp(word))
    }
    assert.equal(seen.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a clip the appliance refuses is an error that names the token', async () => {
  const { root, env } = await setup()
  try {
    const { fetchFn } = fakeAppliance({ 'http://a/c.mp4': Buffer.alloc(10) }, { token: 'right' })
    const result = await runTake(
      { takeId: 'take-x', clips: [{ url: 'http://a/c.mp4' }] },
      { workDir: root, env, token: 'wrong', fetchFn, spawnFn: tools(null).spawnFn },
    )
    assert.equal(result.status, 'error')
    assert.match(result.error, /FDANYONE_TOKEN/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cameras.json in a shape this cannot place is an error, never an identity pose', async () => {
  const { root, env } = await setup()
  try {
    const { spawnFn } = tools({ cameras: [{ yaw: 30 }, { yaw: 60 }] })
    const { fetchFn } = fakeAppliance({ 'http://a/c.mp4': Buffer.alloc(10), 'http://a/p.json': poseTrack(1000, 0) })
    const result = await runTake(
      { takeId: 'take-x', clips: [{ url: 'http://a/c.mp4', poseTrackUrl: 'http://a/p.json' }] },
      { workDir: root, env, fetchFn, spawnFn },
    )
    assert.equal(result.status, 'error')
    assert.match(result.error, /cameras\.json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stub mode still needs no tools and no network', async () => {
  const root = await mkdtemp(path.join(tmpdir(), '4d-pipeline-'))
  try {
    const result = await runTake({ takeId: 'take-stub', clips: [{ url: 'http://nowhere/c.mp4' }] }, {
      workDir: root, env: {}, stub: true, fetchFn: () => { throw new Error('no network in stub mode') },
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.stub, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a resubmitted take starts clean: an earlier run\'s frames are not listed as this run\'s', async () => {
  const root = await mkdtemp(path.join(tmpdir(), '4d-pipeline-'))
  try {
    const take = { takeId: 'take-again', clips: [{ url: 'http://nowhere/c.mp4' }] }
    const first = await runTake(take, { workDir: root, env: {}, stub: true })
    await writeFile(path.join(first.sequenceDir, 'frame-00030.ply'), 'left over from a longer run')
    const second = await runTake(take, { workDir: root, env: {}, stub: true })
    const frames = (await readdir(second.sequenceDir)).sort()
    assert.equal(frames.length, second.frameCount)
    assert.ok(!frames.includes('frame-00030.ply'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a take id that would leave workDir is refused before anything is removed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), '4d-pipeline-'))
  try {
    for (const takeId of ['..', '../x', 'a/b', '']) {
      const result = await runTake({ takeId, clips: [{ url: 'http://x/c.mp4' }] }, { workDir: path.join(root, 'work'), env: {}, stub: true })
      assert.equal(result.status, 'error', JSON.stringify(takeId))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
