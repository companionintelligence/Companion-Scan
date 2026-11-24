/**
 * F-08: uploaded session summaries are kept with their session, and go with it.
 *
 * A summary carries a session's detections and, with a fix, its street address and a map link. It used to be written
 * loose into SUMMARIES_DIR and never deleted. Now it is kept under its session (server/scan_summaries.ts) and removed
 * with the session, with the scan that names the session, and by clear-all. One that names no server session (a plain
 * export) is still accepted, as it always was, and kept apart in `unlinked/`, which clear-all removes.
 *
 * Needs `deno task test`'s permissions.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  removeAllSummaries,
  removeSessionSummaries,
  storeSummary,
  summaryFileName,
  summaryFolderFor,
  UNLINKED_SUMMARIES,
} from '../../../server/scan_summaries.ts'
import { filesUnder, type RunningServer, startServer } from './server_core_harness.ts'

Deno.test('summaries: one is kept in its session\'s folder, and only a server session names a folder', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'server-core-summaries-' })
  try {
    assertEquals(summaryFolderFor(dir, 'sess-abc-123'), `${dir}/sess-abc-123`)
    for (const bad of ['local-abc', '../sess-abc', 'sess-ABC', '', null, 42]) assertEquals(summaryFolderFor(dir, bad), null, String(bad))
    assertEquals(summaryFileName('../evil/path.md', 7), '7_evil_path.md', 'the same sanitising the route always had')
    assertEquals(summaryFileName('notes', 7), '7_notes.md')

    const stored = await storeSummary({ summariesDir: dir, sessionId: 'sess-abc-123', originalName: 'scan-summary.md', text: '# x', now: 1 })
    assertEquals(stored, { filename: '1_scan-summary.md', sessionId: 'sess-abc-123' })
    assertEquals(await Deno.readTextFile(`${dir}/sess-abc-123/${stored.filename}`), '# x')
    const unlinked = await storeSummary({ summariesDir: dir, sessionId: 'local-1', originalName: 'a.md', text: 'u', now: 2 })
    assertEquals(unlinked, { filename: '2_a.md', sessionId: null })
    assertEquals(await Deno.readTextFile(`${dir}/${UNLINKED_SUMMARIES}/2_a.md`), 'u', 'kept apart, for clear-all')
    assertEquals(await removeSessionSummaries(dir, UNLINKED_SUMMARIES), 0, 'no session removal reaches it')

    assertEquals(await removeSessionSummaries(dir, 'sess-abc-123'), 1)
    assertEquals(await removeSessionSummaries(dir, 'sess-abc-123'), 0, 'a second removal finds nothing and succeeds')
    assertEquals(await removeSessionSummaries(dir, 'sess-never'), 0)

    await storeSummary({ summariesDir: dir, sessionId: 'sess-a', originalName: 'a.md', text: 'a' })
    await Deno.writeTextFile(`${dir}/1700000000000_loose.md`, 'an earlier build wrote this one loose')
    assertEquals(await removeAllSummaries(dir), { removed: 3, failed: 0 }, 'sess-a/, unlinked/ and the loose file')
    assertEquals(await filesUnder(dir), [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

/** A GLB the server accepts as a scan. What is in it does not matter to deletion. */
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

async function openSession(server: RunningServer): Promise<string> {
  const reply = await server.post('/sessions', {})
  assertEquals(reply.status, 201, reply.text)
  return reply.json<{ sessionId: string }>().sessionId
}

async function uploadSummary(server: RunningServer, sessionId: string | null, name = 'scan-summary.md'): Promise<{ status: number; filename?: string; sessionId?: string | null }> {
  const form = new FormData()
  form.append('file', new Blob(['# Summary\n\nAddress: (a test address)\n'], { type: 'text/markdown' }), name)
  if (sessionId !== null) form.append('sessionId', sessionId)
  const reply = await server.request('POST', '/upload-summary', { body: form })
  const body = reply.status === 200 ? reply.json<{ filename: string; sessionId: string | null }>() : null
  return { status: reply.status, filename: body?.filename, sessionId: body?.sessionId }
}

Deno.test('summaries over HTTP: kept by session, and gone with the session, the scan, and clear-all', async (t) => {
  const server = await startServer()
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    await t.step('an upload that names no server session is kept apart, as it was always accepted', async () => {
      for (const id of [null, 'local-abc', '../../etc']) {
        const stored = await uploadSummary(server, id)
        assertEquals(stored.status, 200, why(`sessionId ${id}`))
        assertEquals(stored.sessionId, null)
      }
      const files = await filesUnder(server.summariesDir)
      assertEquals(files.length, 3)
      assert(files.every((name) => name.startsWith(`${UNLINKED_SUMMARIES}/`)), `all in unlinked/: ${files}`)
    })

    await t.step('DELETE /sessions/:id takes the session\'s summaries with its frames', async () => {
      const sessionId = await openSession(server)
      const stored = await uploadSummary(server, sessionId)
      assertEquals(stored.status, 200, why('upload'))
      assertEquals(stored.sessionId, sessionId)
      const mine = async () => (await filesUnder(server.summariesDir)).filter((name) => name.startsWith(`${sessionId}/`))
      assertEquals(await mine(), [`${sessionId}/${stored.filename}`])
      assertEquals((await server.request('DELETE', `/sessions/${sessionId}`)).status, 200, why('DELETE /sessions/:id'))
      assertEquals(await mine(), [], 'the summary went with the session')
    })

    await t.step('deleting a scan takes the summaries of the sessions it takes', async () => {
      const sessionId = await openSession(server)
      const form = new FormData()
      form.append('file', new Blob([glb()], { type: 'model/gltf-binary' }), 'room.glb')
      form.append('metadata', JSON.stringify({ sessionId }))
      const uploaded = await server.request('POST', '/upload-scan', { body: form })
      assertEquals(uploaded.status, 200, why('upload-scan'))
      const filename = uploaded.json<{ filename: string }>().filename
      assertEquals((await uploadSummary(server, sessionId)).status, 200)
      // A summary of another session stays.
      const other = await openSession(server)
      assertEquals((await uploadSummary(server, other)).status, 200)

      const deleted = await server.request('DELETE', `/scans/${encodeURIComponent(filename)}`)
      assertEquals(deleted.status, 200, why('DELETE /scans/:filename'))
      const left = await filesUnder(server.summariesDir)
      assert(!left.some((name) => name.startsWith(`${sessionId}/`)), `the scan's session's summary went: ${left}`)
      assert(left.some((name) => name.startsWith(`${other}/`)), 'another session\'s summary stayed')
    })

    await t.step('clear-all removes every summary, those of sessions with no folder and loose ones too', async () => {
      assertEquals((await uploadSummary(server, 'sess-no-folder-0001')).status, 200, 'a well-formed id whose frames are gone')
      await Deno.writeTextFile(`${server.summariesDir}/1700000000000_loose.md`, 'written loose by an earlier build')
      const cleared = await server.request('DELETE', '/scans?confirm=delete-all')
      assertEquals(cleared.status, 200, why('clear-all'))
      assert((cleared.json<{ summaries: number }>().summaries ?? 0) >= 2, cleared.text)
      assertEquals(await filesUnder(server.summariesDir), [])
    })
  } finally {
    await server.stop()
  }
})
