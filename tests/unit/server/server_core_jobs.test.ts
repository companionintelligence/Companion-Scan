/**
 * The job plumbing fixes of wave 14 ticket 0001:
 *
 *   F-24   sensenova-vision, panoptic-scan and panoptic-lift need a scan, and fail by name without one.
 *   F-27   The pump's deadline signal reaches the runners that can stop on it.
 *   F-28   A panoptic-scan that found objects queues the lift; the request-only types are named.
 *   F-29   splat-train names the trainer that ran; memory-push says whether the GLB went, and is a skip with no
 *          Companion Memory.
 *   F-30   /process-scan files its job in the scan's own Place world, with no newest-GLB fallback; `.lingbot.glb` is
 *          not a scan; a frames `limit` that is not a number is the default.
 *   FN-148 Whole-world jobs dedupe per world, and a dry-run purge never stands in for a real one.
 */
import { assert, assertEquals, assertFalse, assertMatch } from './assert.ts'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { dedupeKeyFor, jobNeedsScan, panopticLiftFollowsScan, WORLD_JOB_RULES } from '../../../server/world/job_request.ts'
import { deleteSessionDirectories } from '../../../server/session_deletion.ts'
import { configFromEnv as memoryConfig, pushScanToMemory } from '../../../server/memory_push.ts'
import type { ScanManifest } from '../../../src/world/types.ts'
import { defaultWorldTokens, type JobRecord, type RunningServer, startServer, waitForJob } from './server_core_harness.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { makeTempDir } from '../../../server/fs_util.ts'
import { serveFetch } from './http_server.ts'

const read = (rel: string) => fs.readFile(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8')

// ── Units ────────────────────────────────────────────────────────────────────

test('F-24: the rules table says these three need a scan', () => {
  for (const type of ['sensenova-vision', 'panoptic-scan', 'panoptic-lift', 'splat-train', 'memory-push'] as const) {
    assert(jobNeedsScan(type), type)
  }
  for (const type of ['export-world', 'thing-correspondence', 'keyframe-purge', 'ingest', 'optimize-scan'] as const) {
    assertFalse(jobNeedsScan(type), type)
  }
})

test('F-24: the editor\'s scan-required list, once it exists, is the server\'s', async () => {
  // The editor's branch (wave 14 ticket 0005) adds SCAN_REQUIRED_JOB_TYPES to src/world/job-types.ts for its Advanced
  // queue. One list (ADR 0001): when both branches are in, the two must agree type for type. The module is imported by
  // a computed name, so this branch, which does not have it yet, still type-checks and skips the comparison.
  const path = ['..', '..', '..', 'src', 'world', 'job-types.ts'].join('/')
  let editorList: readonly string[] | null = null
  try {
    editorList = ((await import(path)) as { SCAN_REQUIRED_JOB_TYPES?: readonly string[] }).SCAN_REQUIRED_JOB_TYPES ?? null
  } catch { /* not merged yet */ }
  if (editorList === null) return
  const serverList = Object.keys(WORLD_JOB_RULES).filter((type) => jobNeedsScan(type as never)).sort()
  assertEquals([...editorList].sort(), serverList, 'src/world/job-types.ts and server/world/job_request.ts disagree')
})

test('F-28: a lift follows a panoptic-scan that found objects, and nothing else', () => {
  assert(panopticLiftFollowsScan({ status: 'ok', thingCount: 3 }))
  assertFalse(panopticLiftFollowsScan({ status: 'ok', thingCount: 0 }), 'only surfaces: nothing to lift')
  assertFalse(panopticLiftFollowsScan({ status: 'ok' }))
  assertFalse(panopticLiftFollowsScan({ status: 'skipped', thingCount: 3 }))
  assertFalse(panopticLiftFollowsScan({ status: 'error', thingCount: 3 }))
})

test('FN-148: whole-world jobs are one per world; a real purge and a dry run are two', () => {
  const key = (type: string, scanId?: string, payload?: Record<string, unknown>) =>
    dedupeKeyFor({ type: type as never, scanId, payload })
  assertEquals(key('thing-correspondence', 'scan-a'), key('thing-correspondence', 'scan-b'))
  assertEquals(key('export-world', 'scan-a'), key('export-world'))
  assert(key('keyframe-purge', undefined, { dryRun: false }) !== key('keyframe-purge', undefined, { dryRun: true }))
  assertEquals(key('keyframe-purge'), key('keyframe-purge', undefined, { dryRun: 'false' }), 'anything but false is a dry run')
  assert(key('splat-train', 'scan-a') !== key('splat-train', 'scan-b'), 'a scan job is one per scan')
  assertEquals(key('optimize-scan', undefined, { filename: 'a.glb' }), 'target:a.glb')
  assertEquals(key('ingest'), undefined, 'a job with no target is never deduped')
})

test('F-27: a session removal stops at the deadline, before the next session', async () => {
  const dir = await makeTempDir({ prefix: 'server-core-jobs-' })
  try {
    for (const id of ['sess-a', 'sess-b']) {
      await fs.mkdir(`${dir}/${id}`)
      await fs.writeFile(`${dir}/${id}/session.json`, '{}')
    }
    const stopped = new AbortController()
    stopped.abort()
    const report = await deleteSessionDirectories(dir, ['sess-a', 'sess-b'], { signal: stopped.signal })
    assertEquals(report.deleted, [])
    const kept: string[] = []
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) kept.push(entry.name)
    assertEquals(kept.sort(), ['sess-a', 'sess-b'])
    assertEquals((await deleteSessionDirectories(dir, ['sess-a', 'sess-b'])).deleted.sort(), ['sess-a', 'sess-b'])
  } finally {
    await fs.rm(dir, { recursive: true })
  }
})

test('F-27: every request a memory push makes ends with the deadline', async () => {
  const cfg = memoryConfig((name) => ({ CI_SERVER_URL: 'http://memory.invalid', CI_SERVER_TOKEN: 'token' } as Record<string, string>)[name])
  const stopped = new AbortController()
  stopped.abort()
  const seen: boolean[] = []
  const fetchStub = ((_input: unknown, init?: RequestInit) => {
    seen.push(init?.signal?.aborted === true)
    return Promise.reject(new DOMException('aborted', 'AbortError'))
  }) as typeof fetch
  const scan = { scanId: 'scan-a', filename: 'a.glb', name: 'A' } as unknown as ScanManifest
  const outcome = await pushScanToMemory(cfg, scan, {
    scansDir: '/nonexistent',
    readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    readTextFile: () => Promise.reject(Object.assign(new Error('none'), { code: 'ENOENT' })),
    statFile: () => Promise.reject(Object.assign(new Error('none'), { code: 'ENOENT' })),
    fetch: fetchStub,
    signal: stopped.signal,
  }).then(() => 'resolved', () => 'rejected')
  assert(seen.length > 0, 'it made a request')
  assert(seen.every(Boolean), 'each request carried the aborted signal')
  assertEquals(outcome, 'rejected', 'the push does not report success')
})

test('F-27 / F-28: main.ts forwards the signal and chains the lift, in the source', async () => {
  const main = await read('server/main.ts')
  assert(main.includes('(slug, jobId, signal) => _dispatchWorldJob(slug, jobId, signal)'), 'the pump forwards it')
  for (const call of ['_runKeyframePurgeJob(slug, jobId, signal)', '_runMemoryPushJob(slug, jobId, signal)', '_runThingCorrespondenceJob(slug, jobId, signal)', '_runExportWorldJob(slug, jobId, signal)', '_runOptimizeScanJob(slug, jobId, signal)']) {
    assert(main.includes(call), call)
  }
  assert(main.includes('const RUNNERS_WITHOUT_SIGNAL'), 'the runners that cannot take it are named')
  const scanJob = main.slice(main.indexOf('async function _runPanopticScanJob'), main.indexOf('async function _runPanopticLiftJob'))
  assert(scanJob.includes('panopticLiftFollowsScan(result)'))
  assert(scanJob.includes("createWorldJob(current, 'panoptic-lift'"))
  assert(scanJob.includes('completeJobSoon(slug, chainedLiftJobId)'))
})

// ── Over HTTP ───────────────────────────────────────────────────────────────

const FRAMES_SESSION = 'sess-frames-0001'
const FRAMES_SCAN = '1700000000001_frames.glb'
const LINGBOT_GLB = '1700000000001_frames.lingbot.glb'

function glb(padTo = 0): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, extras: { pad: 'x'.repeat(padTo) } }))
  const padded = new Uint8Array(json.length + ((4 - (json.length % 4)) % 4)).fill(0x20)
  padded.set(json)
  const bytes = new Uint8Array(20 + padded.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546C67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.length, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, 0x4E4F534A, true)
  bytes.set(padded, 20)
  return bytes
}

async function seedFrames(dirs: { scansDir: string; sessionsDir: string }): Promise<void> {
  await fs.mkdir(`${dirs.sessionsDir}/${FRAMES_SESSION}`, { recursive: true })
  await fs.writeFile(`${dirs.sessionsDir}/${FRAMES_SESSION}/session.json`, JSON.stringify({ sessionId: FRAMES_SESSION }))
  const lines = Array.from({ length: 600 }, (_, i) => JSON.stringify({ index: i, file: `kf-${String(i).padStart(5, '0')}.jpg`, timestamp: i }))
  await fs.writeFile(`${dirs.sessionsDir}/${FRAMES_SESSION}/keyframes.jsonl`, lines.join('\n') + '\n')
  await fs.writeFile(`${dirs.scansDir}/${FRAMES_SCAN}`, glb())
  await fs.writeFile(`${dirs.scansDir}/${FRAMES_SCAN.replace(/\.glb$/, '.json')}`, JSON.stringify({ sessionId: FRAMES_SESSION, name: 'Frames' }))
  // LingBot-Map's point cloud for that scan: large enough that the world's size rule would take it for a scan.
  await fs.writeFile(`${dirs.scansDir}/${LINGBOT_GLB}`, glb(4096))
}

async function queue(server: RunningServer, slug: string, body: unknown, token?: string): Promise<JobRecord> {
  const reply = await server.post(`/worlds/${slug}/jobs`, body, { token })
  assertEquals(reply.status, 202, `${JSON.stringify(body)}: ${reply.text}\n${server.log()}`)
  return reply.json<JobRecord>()
}

type Row = { scanId: string; filename: string; sessionId: string | null }

test('jobs over HTTP, an install open by design', async (t) => {
  const server = await startServer({}, seedFrames)
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    const tokens = await defaultWorldTokens(server)
    const rows = (await server.get('/worlds/default')).json<{ scans: Row[] }>().scans
    const frames = rows.find((row) => row.filename === FRAMES_SCAN)
    assert(frames, why(`the seeded scan is a row: ${JSON.stringify(rows)}`))

    await t.test('F-30: .lingbot.glb is not a scan, in GET /scans or in a world', async () => {
      const listed = (await server.get('/scans')).json<Array<{ filename: string }>>().map((entry) => entry.filename)
      assert(listed.includes(FRAMES_SCAN), why('the scan is listed'))
      assertFalse(listed.includes(LINGBOT_GLB), 'its LingBot-Map cloud is not')
      assertFalse(rows.some((row) => row.filename === LINGBOT_GLB), 'and no world takes it for a scan')
    })

    await t.test('FN-123: a frames limit that is not a number is the default, not every line', async () => {
      const count = async (limit: string) =>
        (await server.get(`/worlds/default/frames/${frames.scanId}${limit}`)).json<{ count: number }>().count
      assertEquals(await count(''), 500)
      assertEquals(await count('?limit=abc'), 500)
      assertEquals(await count('?limit='), 500)
      assertEquals(await count('?limit=10'), 10)
      assertEquals(await count('?limit=0'), 1)
      assertEquals(await count('?limit=99999'), 600, 'capped at 2000, and this session has 600')
    })

    await t.test('F-24: the three types fail by name without a scan', async () => {
      for (const type of ['sensenova-vision', 'panoptic-scan', 'panoptic-lift']) {
        const job = await waitForJob(server, 'default', (await queue(server, 'default', { type })).jobId)
        assertEquals(job.status, 'failed', type)
        assertEquals(job.error, `${type} requires a selected scan.`, why(type))
      }
    })

    await t.test('F-29: memory-push with no Companion Memory is a skip with the fix', async () => {
      const job = await waitForJob(server, 'default', (await queue(server, 'default', { type: 'memory-push', scanId: frames.scanId }, tokens.editor)).jobId)
      assertEquals(job.status, 'completed', why('memory-push'))
      assertMatch(job.result ?? '', /^Memory push skipped: Companion Memory is not connected/)
      assertEquals(job.artifacts?.map((artifact) => artifact.type), ['memory-push-skip'])
      assertEquals(job.workerId, 'companion-memory')
    })

    await t.test('F-29: splat-train\'s worker is the backend SPLAT_BACKEND names (Brush by default)', async () => {
      const job = await waitForJob(server, 'default', (await queue(server, 'default', { type: 'splat-train', scanId: frames.scanId })).jobId)
      assertEquals(job.workerId, 'brush')
    })

    await t.test('FN-148: whole-world jobs dedupe per world, and a dry-run purge is not the real one', async () => {
      // Two placeholders hold the single-flight pump, so the jobs below stay queued while they are asked for again.
      await queue(server, 'default', { type: 'ingest' })
      await queue(server, 'default', { type: 'ingest' })
      const first = await queue(server, 'default', { type: 'thing-correspondence', scanId: frames.scanId })
      const again = await queue(server, 'default', { type: 'thing-correspondence', scanId: 'scan-some-other' })
      assertEquals(again.jobId, first.jobId, 'the same whole-world job, whatever scan the editor had selected')
      const dry = await queue(server, 'default', { type: 'keyframe-purge', payload: { dryRun: true } })
      const real = await queue(server, 'default', { type: 'keyframe-purge', payload: { dryRun: false } }, tokens.editor)
      assert(real.jobId !== dry.jobId, 'a dry run does not stand in for the purge that deletes')
      const realAgain = await queue(server, 'default', { type: 'keyframe-purge', payload: { dryRun: false } }, tokens.editor)
      assertEquals(realAgain.jobId, real.jobId)
      for (const job of [first, dry, real]) await waitForJob(server, 'default', job.jobId)
    })

    await t.test('F-30: /process-scan files its job in the scan\'s Place world, and names its scan', async () => {
      const place = (await server.post('/projects', { name: 'A Place' })).json<{ projectId: string }>().projectId
      const form = new FormData()
      form.append('file', new Blob([glb()], { type: 'model/gltf-binary' }), 'placed.glb')
      // A point count, so the world's membership rule takes this tiny test GLB for a scan (shouldIncludeInWorld).
      form.append('metadata', JSON.stringify({ projectId: place, name: 'Placed', pointCount: 10 }))
      const uploaded = await server.request('POST', '/upload-scan', { body: form })
      assertEquals(uploaded.status, 200, why('upload'))
      const filename = uploaded.json<{ filename: string }>().filename
      const processed = await server.post('/process-scan', { filename, action: 'object-count' })
      assertEquals(processed.status, 200, why('process-scan'))
      const jobId = processed.json<{ jobId: string }>().jobId
      const job = await waitForJob(server, `project-${place}`, jobId)
      assertEquals(job.status, 'completed', why(`the job is the Place's, and found its scan: ${JSON.stringify(job)}`))
      assertFalse((await server.get('/worlds/default/jobs')).json<JobRecord[]>().some((item) => item.jobId === jobId), 'not in the default world')

      const nameless = await server.post('/process-scan', { action: 'object-count' })
      assertEquals(nameless.status, 400, 'no newest-scan fallback')
      assertEquals((await server.post('/process-scan', { action: 'object-count', sessionId: 'sess-no-scan' })).status, 400)
    })
  } finally {
    await server.stop()
  }
})

test('F-29: with SPLAT_BACKEND=spirula the splat-train worker is spirula', async () => {
  const server = await startServer({ SPLAT_BACKEND: 'spirula' }, seedFrames)
  try {
    await defaultWorldTokens(server)
    const frames = (await server.get('/worlds/default')).json<{ scans: Row[] }>().scans.find((row) => row.filename === FRAMES_SCAN)!
    const job = await waitForJob(server, 'default', (await queue(server, 'default', { type: 'splat-train', scanId: frames.scanId })).jobId)
    assertEquals(job.workerId, 'spirula')
    // The source's own result line names the trainer its run's manifest names.
    assert((await read('server/main.ts')).includes('currentJob.result = splatTrainResult(result.manifest.tool)'))
  } finally {
    await server.stop()
  }
})

test('F-27: past the pump\'s deadline a job that can stop does, and says why', async () => {
  const server = await startServer({ WORLD_JOB_DEADLINE_MS: '50' })
  try {
    await defaultWorldTokens(server)
    // A placeholder sleeps 650 ms. With the signal forwarded it is cut short at the 50 ms deadline and fails by name;
    // without it, it would have completed with its No-op result.
    const job = await waitForJob(server, 'default', (await queue(server, 'default', { type: 'ingest' })).jobId)
    assertEquals(job.status, 'failed', server.log())
    assertEquals(job.error, 'Stopped after it ran past its time limit.')
  } finally {
    await server.stop()
  }
})

test('F-29: memory-push says whether the GLB went with the event', async () => {
  // A stand-in Companion Memory on loopback: it takes any file and any event.
  const seen: string[] = []
  const memory = await serveFetch(async (req) => {
    const path = new URL(req.url).pathname
    seen.push(`${req.method} ${path}`)
    await req.body?.cancel()
    if (req.method === 'POST' && path === '/files/upload') return Response.json([{ id: `file-${seen.length}` }])
    if (req.method === 'POST' && path === '/v1/events') return Response.json({ ingested: 1, duplicate: 0 })
    return new Response('not found', { status: 404 })
  })
  const base = memory.url
  const server = await startServer({ CI_SERVER_URL: base, CI_SERVER_TOKEN: 'memory-test-token' }, seedFrames)
  try {
    const tokens = await defaultWorldTokens(server)
    const frames = (await server.get('/worlds/default')).json<{ scans: Row[] }>().scans.find((row) => row.filename === FRAMES_SCAN)!
    const push = async () =>
      await waitForJob(server, 'default', (await queue(server, 'default', { type: 'memory-push', scanId: frames.scanId }, tokens.editor)).jobId)

    const attached = await push()
    assertEquals(attached.status, 'completed', server.log())
    assertEquals(attached.result, 'Scan pushed to Companion Memory as a capture.scan event with the GLB attached.')
    assert(seen.includes('POST /files/upload') && seen.includes('POST /v1/events'), `the stand-in saw both: ${seen}`)

    // The GLB gone from disk: the event still goes, and the result says the GLB did not.
    await fs.rm(`${server.scansDir}/${FRAMES_SCAN}`)
    const without = await push()
    assertEquals(without.status, 'completed', server.log())
    assertMatch(without.result ?? '', /^Scan pushed to Companion Memory as a capture\.scan event, without the GLB: glb not found on disk\.$/)
    assertFalse((without.result ?? '').includes(server.root), 'no server path in it')
  } finally {
    await server.stop()
    await memory.close()
  }
})

test('F-30: a world that already lists a .lingbot.glb row drops it, and prunes as it would without it', async () => {
  const server = await startServer({}, seedFrames)
  try {
    await defaultWorldTokens(server)
    const path = `${server.worldsDir}/default.json`
    const world = JSON.parse(await fs.readFile(path, 'utf8')) as { scans: Array<Record<string, unknown>> }
    const real = world.scans.find((row) => row.filename === FRAMES_SCAN)!
    // What an earlier build left: a row for the LingBot-Map cloud, and a row for a scan whose file has since gone.
    world.scans.push({ ...real, scanId: 'scan-phantom-lingbot', filename: LINGBOT_GLB, name: 'phantom' })
    world.scans.push({ ...real, scanId: 'scan-gone', filename: '1700000000002_gone.glb', name: 'gone', sessionId: null })
    await fs.writeFile(path, JSON.stringify(world, null, 2))
    // A new scan on disk, so the listing is as long as the manifest once the phantom is gone.
    await fs.writeFile(`${server.scansDir}/1700000000003_new.glb`, glb())
    await fs.writeFile(`${server.scansDir}/1700000000003_new.json`, JSON.stringify({ name: 'New', pointCount: 10 }))

    const rows = (await server.get('/worlds/default')).json<{ scans: Row[] }>().scans.map((row) => row.filename).sort()
    assertEquals(rows, [FRAMES_SCAN, '1700000000003_new.glb'].sort(), server.log())
  } finally {
    await server.stop()
  }
})

test('FN-148: the retention timer queues its real pass even when a dry run is already waiting', async () => {
  const at = new Date().toISOString()
  const server = await startServer({ KEYFRAME_RETENTION_DAYS: '30' }, async ({ worldsDir }) => {
    // The default world as a previous run left it: a dry-run purge still queued, which boot recovery requeues.
    await fs.writeFile(`${worldsDir}/default.json`, JSON.stringify({
      worldId: 'world-default',
      name: 'Default World Scan',
      shareSlug: 'default',
      projectId: null,
      originGeoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
      localFrame: { type: 'ENU_Y_UP', origin: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
      scans: [],
      things: [],
      thingObservations: [],
      members: ['owner', 'editor', 'commenter', 'viewer', 'scanner'].map((role) => ({ memberId: `${role}-m`, role, token: `${role}-t`, createdAt: at, expiresAt: null })),
      comments: [],
      editPatches: [],
      jobs: [{ jobId: 'job-dry-waiting', worldId: 'world-default', type: 'keyframe-purge', status: 'queued', payload: { dryRun: true }, capabilities: [], progress: 0, createdAt: at, updatedAt: at }],
      createdAt: at,
      updatedAt: at,
    }, null, 2))
  })
  try {
    let purges: JobRecord[] = []
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      purges = (await server.get('/worlds/default/jobs')).json<JobRecord[]>().filter((job) => job.type === 'keyframe-purge')
      if (purges.some((job) => job.payload?.['dryRun'] === false)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(purges.some((job) => job.jobId === 'job-dry-waiting'), 'the dry run is still there')
    assert(purges.some((job) => job.payload?.['dryRun'] === false), `the timer queued its real pass: ${JSON.stringify(purges)}\n${server.log()}`)
  } finally {
    await server.stop()
  }
})
