/**
 * The floor-plan job on the real server: the wiring tests/unit/deno/floor_plan.test.ts cannot reach.
 *
 *   - POST /worlds/:slug/jobs takes the type, the pump dispatches it, and a job queued with no scan fails by name.
 *   - A scan whose session has no LingBot-Map cloud completes as skipped, with the fix in the job's own words.
 *   - With an interpreter that has numpy (the one the job would use here), a session holding a synthetic captured room
 *     (its cloud in a tilted LingBot frame, its keyframes' AR poses) gets its plan: the job's artifact, the three files
 *     served with their types, the drawing under a policy that runs nothing, the manifest with no server path in it,
 *     and all three taken when the scan is deleted. The scan records no scale kind, so the plan is in session units.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'

import { scanIdFor } from '../../../server/scan_id.ts'
import type { WorldJob } from '../../../src/world/types.ts'
import { floorPlanPython, ROOM, writeCapturedRoom } from './floor_plan_fixtures.ts'
import { filesUnder, type RunningServer, startServer } from './server_core_harness.ts'

const PYTHON = await floorPlanPython()
const JOB_TIMEOUT_MS = 45_000

const ROOM_SESSION = 'sess-floorplan-room'
const ROOM_BASE = '1700000000000_room'
const BARE_SESSION = 'sess-floorplan-bare'
const BARE_BASE = '1700000000001_bare'

/** The smallest valid GLB: a header and an asset-only JSON chunk. The scan is filed by its session, not its size. */
function glb(): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }))
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

async function storeScan(scansDir: string, sessionsDir: string, base: string, session: string): Promise<string> {
  await Deno.mkdir(`${sessionsDir}/${session}`, { recursive: true })
  await Deno.writeTextFile(`${sessionsDir}/${session}/session.json`, JSON.stringify({ sessionId: session, glbFilename: `${base}.glb` }))
  await Deno.writeFile(`${scansDir}/${base}.glb`, glb())
  await Deno.writeTextFile(`${scansDir}/${base}.json`, JSON.stringify({ sessionId: session }))
  return `${sessionsDir}/${session}`
}

async function queue(server: RunningServer, body: Record<string, unknown>): Promise<WorldJob> {
  const reply = await server.post('/worlds/default/jobs', body)
  assertEquals(reply.status, 202, `POST /worlds/default/jobs ${JSON.stringify(body)}\n${server.log()}`)
  const job = reply.json<WorldJob>()
  assertEquals(job.type, body.type)
  return job
}

async function settled(server: RunningServer, jobId: string): Promise<WorldJob> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const jobs = (await server.get('/worlds/default/jobs')).json<WorldJob[]>()
    const seen = jobs.find((job) => job.jobId === jobId)
    if (seen && (seen.status === 'completed' || seen.status === 'failed')) return seen
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} did not settle in ${JOB_TIMEOUT_MS} ms\n${server.log()}`)
}

Deno.test('the floor-plan job on the server: queued, run, skipped or drawn, served, and deleted with its scan', async (t) => {
  let root = ''
  const server = await startServer(
    PYTHON ? { LINGBOT_MAP_PYTHON: PYTHON.path } : {},
    async ({ root: r, scansDir, sessionsDir }) => {
      root = r
      const roomSession = await storeScan(scansDir, sessionsDir, ROOM_BASE, ROOM_SESSION)
      await writeCapturedRoom(roomSession)
      await storeScan(scansDir, sessionsDir, BARE_BASE, BARE_SESSION)
    },
  )
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    await t.step('a job queued with no scan fails, and says it needs one', async () => {
      const job = await queue(server, { type: 'floor-plan' })
      const done = await settled(server, job.jobId)
      assertEquals(done.status, 'failed', why('no scan'))
      assertEquals(done.error, 'floor-plan requires a selected scan.')
    })

    await t.step('a scan whose session has no LingBot-Map cloud completes as skipped, with the fix', async () => {
      const job = await queue(server, { type: 'floor-plan', scanId: scanIdFor(`${BARE_BASE}.glb`) })
      const done = await settled(server, job.jobId)
      assertEquals(done.status, 'completed', why('bare scan'))
      assert(done.result?.startsWith('Floor plan skipped: no point cloud'), done.result)
      assertStringIncludes(done.result ?? '', 'lingbot-map-reconstruct')
      assertEquals(done.artifacts?.[0]?.type, 'floor-plan-skip')
      const manifest = await server.get(`/scans/${BARE_BASE}.floor-plan.manifest.json`)
      assertEquals(manifest.status, 200, why('skip manifest'))
      assertEquals(manifest.json<{ status: string }>().status, 'skipped')
      assertEquals((await server.get(`/scans/${BARE_BASE}.floor-plan.svg`)).status, 404, 'a skip writes no drawing')
    })

    await t.step({
      name: 'with numpy, the room is drawn, and its three files are served the way the editor reads them',
      ignore: !PYTHON?.numpy,
      fn: async () => {
        const job = await queue(server, { type: 'floor-plan', scanId: scanIdFor(`${ROOM_BASE}.glb`), payload: { minWallM: 0.5 } })
        const done = await settled(server, job.jobId)
        assertEquals(done.status, 'completed', why(`room: ${done.error ?? done.result}`))
        assertStringIncludes(done.result ?? '', 'fitted to the capture\'s AR poses')
        const artifact = done.artifacts?.find((a) => a.type === 'floor-plan')
        assert(artifact, `no floor-plan artifact: ${JSON.stringify(done.artifacts)}`)
        assertEquals(artifact.url, `/scans/${ROOM_BASE}.floor-plan.json`)
        const metadata = artifact.metadata as { areaM2: number; units: string }
        assert(Math.abs(metadata.areaM2 - ROOM.width * ROOM.depth) <= 1.2, `area ${metadata.areaM2}`)
        assertEquals(metadata.units, 'session', 'a scan that recorded no scale kind is not taken to be in metres')

        const manifest = await server.get(`/scans/${ROOM_BASE}.floor-plan.manifest.json`)
        assertEquals(manifest.status, 200, why('manifest'))
        assertEquals(manifest.headers.get('content-type'), 'application/json')
        const body = manifest.json<{ status: string; params: { python: string; workerPath: string } }>()
        assertEquals(body.status, 'ok')
        assertEquals(body.params.workerPath, 'floor_plan_worker.py', 'the server path is cut to the file name')
        assertFalse(manifest.text.includes(root), 'no server path')
        assertFalse(body.params.python.includes('/'), 'the interpreter is named, not located')

        const plan = await server.get(`/scans/${ROOM_BASE}.floor-plan.json`)
        assertEquals(plan.status, 200, why('plan'))
        assertEquals(plan.headers.get('content-type'), 'application/json')
        assert(plan.json<{ walls: unknown[] }>().walls.length >= 4)

        const svg = await server.get(`/scans/${ROOM_BASE}.floor-plan.svg`)
        assertEquals(svg.status, 200, why('svg'))
        assertEquals(svg.headers.get('content-type'), 'image/svg+xml')
        assertStringIncludes(svg.headers.get('content-security-policy') ?? '', "default-src 'none'")
        assertStringIncludes(svg.headers.get('content-security-policy') ?? '', 'sandbox')
        assertEquals(svg.headers.get('x-content-type-options'), 'nosniff')
        assertStringIncludes(svg.text, '<svg xmlns="http://www.w3.org/2000/svg"')
        // The JSON sidecars are not sandboxed: the policy is the drawing's.
        assertEquals(plan.headers.get('content-security-policy'), null)
      },
    })

    await t.step('the artifact route turns away other suffixes and a path out of the scans dir', async () => {
      assert((await server.get(`/scans/${ROOM_BASE}.floor-plan.exe`)).status >= 400)
      assert((await server.get(`/scans/${ROOM_BASE}.floor-plan.svg/../../main.ts`)).status >= 400)
      assert((await server.get(`/scans/..%2F${ROOM_BASE}.floor-plan.svg`)).status >= 400)
    })

    await t.step('deleting a scan takes its floor-plan files', async () => {
      const deleted = await server.request('DELETE', `/scans/${BARE_BASE}.glb`)
      assertEquals(deleted.status, 200, why('DELETE bare'))
      let left = await filesUnder(server.scansDir)
      assertFalse(left.some((name) => name.startsWith(`${BARE_BASE}.floor-plan`)), `left: ${left}`)
      if (PYTHON?.numpy) {
        assertEquals((await server.request('DELETE', `/scans/${ROOM_BASE}.glb`)).status, 200, why('DELETE room'))
        left = await filesUnder(server.scansDir)
        assertFalse(left.some((name) => name.startsWith(`${ROOM_BASE}.floor-plan`)), `left: ${left}`)
      }
    })
  } finally {
    await server.stop()
  }
})

/**
 * Stands in for LINGBOT_MAP_PYTHON, as the stand-in in wp-runners-signal-pump.test.ts does. Run as LingBot-Map's worker
 * it leaves a prepared reconstruction in the session (a captured room: its cloud and its cameras, which match the
 * session's AR keyframes, so the run's quality verdict and the floor plan's fit both pass); run as the floor-plan worker
 * it writes a small plan where it is told to. Anything else is refused.
 */
function interpreterStub(fixtureDir: string): string {
  return `#!/bin/sh
case "$1" in
  *lingbot_map_worker.py)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--session-dir" ]; then dir="$2"; fi
      shift
    done
    cp "${fixtureDir}/lingbot-map.point-cloud.ply" "${fixtureDir}/lingbot-map.poses.json" "$dir/"
    printf '{"schemaVersion":1,"tool":"lingbot-map","status":"ok","frameCount":2}' > "$dir/lingbot-map.manifest.json"
    ;;
  *floor_plan_worker.py)
    while [ $# -gt 0 ]; do
      case "$1" in
        --out-json) json="$2" ;;
        --out-svg) svg="$2" ;;
      esac
      shift
    done
    printf '{"areaM2":12,"ceilingHeightM":2.5,"walls":[{},{},{},{}],"rooms":[{}],"disclaimer":"stand-in"}' > "$json"
    printf '<svg xmlns="http://www.w3.org/2000/svg"></svg>' > "$svg"
    ;;
  *) exit 64 ;;
esac
`
}

Deno.test({
  name: 'a LingBot-Map run that succeeds queues a floor plan on the same interpreter, and FLOORPLAN_AUTO=0 stops that',
  ignore: Deno.build.os === 'windows',
  fn: async (t) => {
    const tools = await Deno.makeTempDir({ prefix: 'floor-plan-chain-' })
    try {
      // The reconstruction the stand-in leaves (cloud and poses), and the keyframes the session holds (AR poses).
      await writeCapturedRoom(tools)
      const keyframes = await Deno.readTextFile(`${tools}/keyframes.jsonl`)
      const stub = `${tools}/python`
      await Deno.writeTextFile(stub, interpreterStub(tools))
      await Deno.chmod(stub, 0o755)

      for (const auto of ['1', '0']) {
        await t.step(`FLOORPLAN_AUTO=${auto}`, async () => {
          const server = await startServer({ LINGBOT_MAP_PYTHON: stub, FLOORPLAN_AUTO: auto }, async ({ scansDir, sessionsDir }) => {
            const session = await storeScan(scansDir, sessionsDir, ROOM_BASE, ROOM_SESSION)
            await Deno.writeTextFile(`${session}/keyframes.jsonl`, keyframes)
          })
          const why = (what: string) => `${what}\n${server.log()}`
          try {
            const reconstruct = await queue(server, { type: 'lingbot-map-reconstruct', scanId: scanIdFor(`${ROOM_BASE}.glb`) })
            const done = await settled(server, reconstruct.jobId)
            assertEquals(done.status, 'completed', why(`reconstruct: ${done.error ?? done.result}`))
            // The chain is written in the same commit as that completion, so it is in the list now or never.
            const chained = (await server.get('/worlds/default/jobs')).json<WorldJob[]>().filter((job) => job.type === 'floor-plan')
            if (auto === '0') {
              assertEquals(chained.length, 0, 'FLOORPLAN_AUTO=0 queues no floor plan')
              return
            }
            assertEquals(chained.length, 1, why('one floor plan follows the reconstruction'))
            const job = chained[0]!
            assertEquals(job.scanId, scanIdFor(`${ROOM_BASE}.glb`))
            assertEquals(job.payload?.['source'], 'auto-chain')
            assertEquals(job.payload?.['reconstructJobId'], reconstruct.jobId)
            const plan = await settled(server, job.jobId)
            assertEquals(plan.status, 'completed', why(`floor plan: ${plan.error ?? plan.result}`))
            assert(plan.artifacts?.some((a) => a.type === 'floor-plan'), 'it ran on the same interpreter and drew a plan')
            const manifest = (await server.get(`/scans/${ROOM_BASE}.floor-plan.manifest.json`)).json<{ status: string; disclaimer?: string }>()
            assertEquals(manifest.status, 'ok')
            assertEquals(manifest.disclaimer, 'stand-in', 'the plan is the one the stand-in wrote')
          } finally {
            await server.stop()
          }
        })
      }
    } finally {
      await Deno.remove(tools, { recursive: true })
    }
  },
})
