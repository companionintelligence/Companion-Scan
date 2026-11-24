/**
 * Wave 14-0002 (F-26, FN-132, FN-187, FN-188): the 4D path end to end.
 *
 * Before this, only stub mode could produce a sequence: the appliance sent clip
 * URLs and the 4d-capture service read `localPath` and `durationMs`, which
 * nothing set, and downloaded nothing. Here every piece is the real one except
 * the GPU tools:
 *
 *   runPerson4D (server/person4d/person_4d.ts)
 *     → the real service (subsystems/4d-capture/server/service.mjs) on an
 *       ephemeral port, checking the token
 *       → downloads from a clip route built on the appliance's own
 *         `rangedResponse` (server/http_range.ts), which demands the token and
 *         sends at most 8 MiB per 206
 *       → ffmpeg, 4DAnyone and Brush as shell-script stand-ins that write what
 *         the real tools write, spawned the real way
 *     ← the appliance pulls the frames back and writes its manifest.
 *
 * The subsystem's own `npm test` covers the stages piece by piece; this is the
 * run that ties both sides of the contract together, inside `deno task test`.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-runners-4d-e2e.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { runPerson4D } from '../../../server/person4d/person_4d.ts'
import { MAX_RANGE_BYTES, rangedResponse, readFileRange } from '../../../server/http_range.ts'
import { poseToMatrix as serverPoseToMatrix } from '../../../server/splat/splat_train_dataset.ts'
// @ts-ignore — a plain .mjs module outside both builds
import { createService } from '../../../subsystems/4d-capture/server/service.mjs'
// @ts-ignore — a plain .mjs module outside both builds
import { poseToMatrix as subsystemPoseToMatrix } from '../../../subsystems/4d-capture/stages/pose.mjs'

const isWindows = Deno.build.os === 'windows'
const TOKEN = 'e2e-shared-token'

/** A JPEG with just a SOF0 of `w` x `h`: what the SOF reader needs. */
function tinyJpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
}

function poseTrack(durationMs: number) {
  const frames = []
  for (let t = 0; t <= durationMs; t += 50) {
    frames.push({ timestamp: t, pose: { position: { x: t / 1000, y: 1.4, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } })
  }
  return { version: 1, clientId: 'client-a', takeId: null, mimeType: 'video/mp4', recordedAt: '2026-11-23T00:00:00Z', durationMs, nominalFps: 30, hasArSession: true, intrinsics: { width: 1080, height: 1920, fovYDeg: 52, aspect: 0.5625 }, frames }
}

async function script(path: string, body: string): Promise<string> {
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`)
  await Deno.chmod(path, 0o755)
  return path
}

/** Stand-ins that write what the real tools write, so the service's real spawns have something to run. */
async function fakeTools(root: string) {
  const fixtures = `${root}/fixtures`
  await Deno.mkdir(fixtures, { recursive: true })
  await Deno.writeFile(`${fixtures}/frame.jpg`, tinyJpeg(270, 480))
  await Deno.writeTextFile(`${fixtures}/splat.ply`, 'ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n')
  await Deno.writeTextFile(`${fixtures}/cameras.json`, JSON.stringify({
    cameras: Array.from({ length: 6 }, (_, i) => ({
      transform_matrix: [[1, 0, 0, Math.cos(i)], [0, 1, 0, 1.2], [0, 0, 1, Math.sin(i)], [0, 0, 0, 1]],
      fx: 700, fy: 700, cx: 540, cy: 960, width: 1080, height: 1920,
    })),
  }))
  const bin = `${root}/bin`
  await Deno.mkdir(bin)
  return {
    // ffmpeg: the output is the last argument.
    FFMPEG_BIN: await script(`${bin}/ffmpeg`, `for last; do :; done\ncp "${fixtures}/frame.jpg" "$last"`),
    FFPROBE_BIN: await script(`${bin}/ffprobe`, 'echo 4.000'),
    // Brush: exports splat_<iter>.ply into --export-path.
    BRUSH_BIN: await script(
      `${bin}/brush-cli`,
      'out=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--export-path" ]; then out="$2"; fi; shift; done\n' +
        `mkdir -p "$out" && cp "${fixtures}/splat.ply" "$out/splat_3000.ply"`,
    ),
    // 4DAnyone: cameras.json and videos/dense/ under <data_dir>/<clip name>/.
    FDANYONE_PYTHON: await script(
      `${bin}/python`,
      'video=""; data=""\nwhile [ $# -gt 0 ]; do case "$1" in --video_path) video="$2";; --data_dir) data="$2";; esac; shift; done\n' +
        'name=$(basename "$video"); name="${name%.*}"\n' +
        'mkdir -p "$data/$name/videos/dense"\n' +
        `cp "${fixtures}/cameras.json" "$data/$name/cameras.json"`,
    ),
    FDANYONE_DIR: root,
  }
}

interface Seen {
  path: string
  auth: string | null
  range: string | null
}

/** The appliance's two clip-side routes, on the real range helper, admitting only the shared token. */
function fakeAppliance(clipPath: string, track: unknown, seen: Seen[]) {
  return Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    const url = new URL(req.url)
    seen.push({ path: url.pathname, auth: req.headers.get('authorization'), range: req.headers.get('range') })
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('unauthorized', { status: 401 })
    if (url.pathname === '/sessions/sess-e2e-0001/pose-track.json') return Response.json(track)
    if (url.pathname === '/sessions/sess-e2e-0001/clip/clip.mp4') {
      const size = (await Deno.stat(clipPath)).size
      return await rangedResponse({
        rangeHeader: req.headers.get('range'),
        size,
        contentType: 'video/mp4',
        readRange: (start, length) => readFileRange(clipPath, start, length),
        readAll: () => Deno.readFile(clipPath),
      })
    }
    return new Response('not found', { status: 404 })
  })
}

Deno.test({
  name: '4D e2e: a single clip goes appliance → service → back as a playable frame-NNNNN sequence',
  ignore: isWindows,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-runners-4d-' })
    const seen: Seen[] = []
    // Larger than one 206, so the downloader has to follow Content-Range.
    const clipPath = `${root}/clip.mp4`
    await Deno.writeFile(clipPath, new Uint8Array(MAX_RANGE_BYTES + 4096).fill(3))
    const appliance = fakeAppliance(clipPath, poseTrack(4000), seen)
    const tools = await fakeTools(root)
    const service = createService({
      port: 0,
      host: '127.0.0.1',
      workDir: `${root}/work`,
      token: TOKEN,
      stub: false,
      env: { ...Deno.env.toObject(), ...tools },
    })
    const { port } = await service.listen()
    try {
      const base = `http://127.0.0.1:${appliance.addr.port}`
      const result = await runPerson4D({
        takeId: 'take-e2e-solo',
        clips: [{
          clientId: 'client-a',
          url: `${base}/sessions/sess-e2e-0001/clip/clip.mp4`,
          mimeType: 'video/mp4',
          poseTrackUrl: `${base}/sessions/sess-e2e-0001/pose-track.json`,
          sync: null,
        }],
        sequenceDir: `${root}/scans/x.4d`,
        manifestPath: `${root}/scans/x.4d-capture.manifest.json`,
        host: `http://127.0.0.1:${port}`,
        token: TOKEN,
        timestepFps: 2,
        pollIntervalMs: 25,
        maxWaitMs: 60_000,
      })

      assertEquals(result.status, 'ok', `${result.log} ${JSON.stringify(result.manifest)}`)
      // 4 s at 2 fps: eight timesteps, eight frames, named the way /scans/:base.4d/:frame and the viewer expect.
      assertEquals(result.manifest.frameCount, 8)
      assertEquals(result.manifest.viewSource, 'densified')
      assertEquals(result.manifest.viewCount, 6)
      const landed = [...Deno.readDirSync(`${root}/scans/x.4d`)].map((e) => e.name).sort()
      assertEquals(landed, Array.from({ length: 8 }, (_, i) => `frame-${String(i).padStart(5, '0')}.ply`))
      const manifest = JSON.parse(await Deno.readTextFile(`${root}/scans/x.4d-capture.manifest.json`))
      assertEquals(manifest.status, 'ok')

      // The service fetched the clip in ranges, following Content-Range, with the token every time.
      const clipRequests = seen.filter((s) => s.path.endsWith('/clip/clip.mp4'))
      assertEquals(clipRequests.map((s) => s.range), ['bytes=0-', `bytes=${MAX_RANGE_BYTES}-`])
      assert(seen.every((s) => s.auth === `Bearer ${TOKEN}`), JSON.stringify(seen))

      // Every view was placed from cameras.json with its own lens, at the pixels that landed.
      const t0 = JSON.parse(await Deno.readTextFile(`${root}/work/take-e2e-solo/t-00000/transforms.json`))
      assertEquals(t0.frames.length, 6)
      assert(t0.frames.every((f: { transform_matrix: number[][] }) => f.transform_matrix[1][3] === 1.2), 'a view kept the identity')
      assertEquals([t0.frames[0].w, t0.frames[0].h, t0.frames[0].fl_y], [270, 480, 175])
    } finally {
      await service.close()
      await appliance.shutdown()
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: '4D e2e: a service whose token the appliance refuses fails the take and says which variable to fix',
  ignore: isWindows,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-runners-4d-' })
    const clipPath = `${root}/clip.mp4`
    await Deno.writeFile(clipPath, new Uint8Array(64))
    const appliance = fakeAppliance(clipPath, poseTrack(2000), [])
    const service = createService({
      port: 0,
      host: '127.0.0.1',
      workDir: `${root}/work`,
      token: 'not-the-shared-token',
      stub: false,
      env: { ...Deno.env.toObject(), ...(await fakeTools(root)) },
    })
    const { port } = await service.listen()
    try {
      const base = `http://127.0.0.1:${appliance.addr.port}`
      const result = await runPerson4D({
        takeId: 'take-e2e-badtoken',
        clips: [{ clientId: null, url: `${base}/sessions/sess-e2e-0001/clip/clip.mp4`, mimeType: 'video/mp4', poseTrackUrl: null, sync: null }],
        sequenceDir: `${root}/scans/y.4d`,
        manifestPath: `${root}/scans/y.4d-capture.manifest.json`,
        host: `http://127.0.0.1:${port}`,
        token: 'not-the-shared-token',
        pollIntervalMs: 25,
        maxWaitMs: 30_000,
      })
      assertEquals(result.status, 'error')
      assertStringIncludes(result.manifest.error ?? '', 'FDANYONE_TOKEN')
    } finally {
      await service.close()
      await appliance.shutdown()
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: '4D e2e: the appliance without the service\'s token is refused at submit',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-runners-4d-' })
    const service = createService({ port: 0, host: '127.0.0.1', workDir: `${root}/work`, token: TOKEN, stub: true, env: {} })
    const { port } = await service.listen()
    try {
      const result = await runPerson4D({
        takeId: 'take-e2e-noauth',
        clips: [{ clientId: null, url: 'http://127.0.0.1:1/clip.mp4', mimeType: 'video/mp4', poseTrackUrl: null, sync: null }],
        sequenceDir: `${root}/scans/z.4d`,
        manifestPath: `${root}/scans/z.4d-capture.manifest.json`,
        host: `http://127.0.0.1:${port}`,
        token: null,
        _sleep: () => Promise.resolve(),
      })
      assertEquals(result.status, 'error')
      assertStringIncludes(result.manifest.error ?? '', 'HTTP 401')
      // With the token, the same stub take goes through.
      const ok = await runPerson4D({
        takeId: 'take-e2e-stub',
        clips: [{ clientId: null, url: 'http://127.0.0.1:1/clip.mp4', mimeType: 'video/mp4', poseTrackUrl: null, sync: null }],
        sequenceDir: `${root}/scans/w.4d`,
        manifestPath: `${root}/scans/w.4d-capture.manifest.json`,
        host: `http://127.0.0.1:${port}`,
        token: TOKEN,
        pollIntervalMs: 10,
      })
      assertEquals(ok.status, 'ok', ok.log)
    } finally {
      await service.close()
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test('4D: the subsystem places a pose exactly as the appliance\'s dataset builder does', () => {
  // The two copies of poseToMatrix exist because the subsystem is outside both builds; this holds them equal.
  const poses = [
    { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    { position: { x: 1.5, y: -2, z: 0.25 }, rotation: { x: 0.1, y: 0.7, z: -0.2, w: 0.65 } },
    { position: { x: -3, y: 4, z: 5 }, rotation: { x: 2, y: 0, z: 0, w: 2 } }, // not unit: both normalise
    { position: {}, rotation: {} },
  ]
  for (const pose of poses) {
    const a = serverPoseToMatrix(pose)
    const b = subsystemPoseToMatrix(pose) as number[][]
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) assert(Math.abs(a[r][c] - b[r][c]) < 1e-12, `${JSON.stringify(pose)} [${r}][${c}]`)
  }
})

Deno.test('4D: the submit payload carries duration and session-to-Place when known, and null, never a guess, when not', async () => {
  const { buildSubmitRequest, resolveParams } = await import('../../../server/person4d/person_4d.ts')
  const l2w = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, -1, 1]
  const opts = {
    takeId: 'take-abc',
    sequenceDir: '/x',
    manifestPath: '/x.json',
    host: 'http://gpu.invalid:9040',
    clips: [
      { clientId: 'a', url: 'http://h/a.mp4', mimeType: 'video/mp4', poseTrackUrl: 'http://h/a.json', sync: null, durationMs: 4800, localToWorld: l2w },
      { clientId: 'b', url: 'http://h/b.mp4', mimeType: 'video/mp4', poseTrackUrl: null, sync: null },
      { clientId: 'c', url: 'http://h/c.mp4', mimeType: 'video/mp4', poseTrackUrl: null, sync: null, durationMs: 0, localToWorld: [1, 2, 3] },
    ],
  }
  const req = buildSubmitRequest(opts, resolveParams(opts))
  assertEquals([req.clips[0].durationMs, req.clips[0].localToWorld], [4800, l2w])
  assertEquals([req.clips[1].durationMs, req.clips[1].localToWorld], [null, null])
  assertEquals([req.clips[2].durationMs, req.clips[2].localToWorld], [null, null])
  assertEquals(req.clips[0].poseTrackUrl, 'http://h/a.json')
})
