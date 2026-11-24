/**
 * F-27 end to end, on the merge of server-core (0001) and server-runners (0002): the pump's deadline signal reaches
 * the runners whose drivers spawn a child or call a service, and the child is stopped rather than left running beside
 * the next job.
 *
 * The real server (server-core's harness), a real job, and a stand-in interpreter that would sleep for 30 s: with the
 * pump's deadline at 300 ms the job must fail inside a few seconds, with the driver's own reason, and the child must
 * be gone. Before the call sites passed the signal, the job ran its full 30 s.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi tests/unit/deno/wp-runners-signal-pump.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { defaultWorldTokens, startServer, waitForJob } from './server_core_harness.ts'

const SESSION = 'sess-signal-0001'
const SCAN = '1700000000003_signal.glb'

/** The smallest GLB the server takes for a scan: a header and an empty-ish JSON chunk. */
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

function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 'SIGCONT')
    return true
  } catch {
    return false
  }
}

Deno.test({
  name: 'F-27: past the pump\'s deadline a LingBot-Map job\'s child is killed, and the job fails with the driver\'s reason',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const tools = await Deno.makeTempDir({ prefix: 'wp-runners-pump-' })
    const pidFile = `${tools}/child.pid`
    // `exec` keeps the PID: the process the driver spawned is the one that sleeps.
    const python = `${tools}/python`
    await Deno.writeTextFile(python, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`)
    await Deno.chmod(python, 0o755)

    const server = await startServer({ WORLD_JOB_DEADLINE_MS: '300', LINGBOT_MAP_PYTHON: python }, async (dirs) => {
      await Deno.mkdir(`${dirs.sessionsDir}/${SESSION}`, { recursive: true })
      await Deno.writeTextFile(`${dirs.sessionsDir}/${SESSION}/session.json`, JSON.stringify({ sessionId: SESSION }))
      await Deno.writeTextFile(`${dirs.sessionsDir}/${SESSION}/keyframes.jsonl`, JSON.stringify({ index: 0, file: 'kf-00000.jpg' }) + '\n')
      await Deno.writeFile(`${dirs.scansDir}/${SCAN}`, glb())
      await Deno.writeTextFile(`${dirs.scansDir}/${SCAN.replace(/\.glb$/, '.json')}`, JSON.stringify({ sessionId: SESSION, name: 'Signal' }))
    })
    try {
      await defaultWorldTokens(server)
      const rows = (await server.get('/worlds/default')).json<{ scans: Array<{ scanId: string; filename: string }> }>().scans
      const scan = rows.find((row) => row.filename === SCAN)
      assert(scan, `the seeded scan is a row\n${server.log()}`)

      const queued = await server.post('/worlds/default/jobs', { type: 'lingbot-map-reconstruct', scanId: scan.scanId })
      assertEquals(queued.status, 202, `${queued.text}\n${server.log()}`)
      const started = performance.now()
      const job = await waitForJob(server, 'default', queued.json<{ jobId: string }>().jobId, { timeoutMs: 20_000 })
      const took = performance.now() - started

      assertEquals(job.status, 'failed', server.log())
      assertStringIncludes(job.error ?? '', 'aborted by its job', server.log())
      assert(took < 15_000, `took ${Math.round(took)} ms: the child ran on past the deadline`)

      const pid = Number((await Deno.readTextFile(pidFile)).trim())
      assert(Number.isInteger(pid) && pid > 0, 'the stand-in interpreter ran')
      // SIGKILL is delivered at once; give the kernel a moment to reap it.
      for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
      assert(!alive(pid), `the child ${pid} is still running`)
    } finally {
      await server.stop()
      await Deno.remove(tools, { recursive: true })
    }
  },
})
