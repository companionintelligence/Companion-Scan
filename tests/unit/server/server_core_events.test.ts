/**
 * F-09 / FN-122: what /events sends, and to whom.
 *
 *   - Phone console records (POST /client-logs) are fanned out on /events only with CLIENT_LOGS_BROADCAST=1. They used
 *     to reach every connected socket. The hello says which it is.
 *   - World and Place events carry a `scope` ({ worldId, slug, projectId }), so a client can keep the ones of the world
 *     it shows; `/events?world=<slug>` keeps a socket to that world's events and the ones with no scope.
 *
 * Over a real socket against the spawned server (server_core_harness.ts).
 */
import { assert, assertEquals } from './assert.ts'
import { type RunningServer, startServer } from './server_core_harness.ts'
import { test } from 'node:test'

type Message = Record<string, unknown> & { type: string; scope?: { worldId: string; slug: string; projectId: string | null } }

interface Listener {
  messages: Message[]
  until(predicate: (message: Message) => boolean, timeoutMs?: number): Promise<Message | null>
  close(): Promise<void>
}

async function listen(server: RunningServer, query = ''): Promise<Listener> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events${query}`)
  const messages: Message[] = []
  ws.onmessage = (event) => {
    try {
      messages.push(JSON.parse(String(event.data)) as Message)
    } catch { /* not JSON */ }
  }
  const closed = new Promise<void>((resolve) => {
    ws.onclose = () => resolve()
  })
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('the socket did not open'))
  })
  const until = async (predicate: (message: Message) => boolean, timeoutMs = 5_000): Promise<Message | null> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = messages.find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return null
  }
  // The hello is the first thing the server sends, once it has read the default world.
  await until((message) => message.type === 'hello')
  return {
    messages,
    until,
    close: async () => {
      ws.close()
      await closed
    },
  }
}

async function postLog(server: RunningServer, msg: string): Promise<void> {
  const reply = await server.post('/client-logs', { entries: [{ ts: Date.now(), level: 'log', msg }] })
  assertEquals(reply.status, 204, reply.text)
}

test('events: console records stay off the stream by default; world events are scoped and filterable', async () => {
  const server = await startServer()
  const sockets: Listener[] = []
  try {
    const all = await listen(server)
    const elsewhere = await listen(server, '?world=some-other-world')
    sockets.push(all, elsewhere)
    assertEquals(all.messages.find((m) => m.type === 'hello')?.clientLogs, false, 'the hello says console records are not sent')

    await postLog(server, 'a phone console line')
    // The record still reaches the server's own log; the stream is what no longer carries it.
    assertEquals(await all.until((m) => m.type === 'client-log', 600), null, 'no socket gets a console record')
    assert(server.log().includes('a phone console line'), 'the server log keeps it')

    const queued = await server.post('/worlds/default/jobs', { type: 'export-world' })
    assertEquals(queued.status, 202, queued.text)
    const jobId = queued.json<{ jobId: string }>().jobId
    const update = await all.until((m) => m.type === 'world-job-update' && (m.job as { jobId: string }).jobId === jobId)
    assert(update, `a world-job-update for ${jobId}\n${server.log()}`)
    assertEquals(update.scope, { worldId: 'world-default', slug: 'default', projectId: null })
    assertEquals(update.worldId, 'world-default', 'the payload fields are unchanged')

    // An event about no one world reaches every socket, the filtered one too.
    assertEquals((await server.post('/sessions', {})).status, 201)
    assert(await elsewhere.until((m) => m.type === 'session-started'), 'unscoped events reach a filtered socket')
    assertEquals(elsewhere.messages.filter((m) => m.scope?.slug === 'default'), [], 'a socket that asked for another world gets none of default\'s')
  } finally {
    for (const socket of sockets) await socket.close()
    await server.stop()
  }
})

test('events: with CLIENT_LOGS_BROADCAST=1 the console records are on the stream, as logs:watch reads them', async () => {
  const server = await startServer({ CLIENT_LOGS_BROADCAST: '1' })
  let socket: Listener | null = null
  try {
    socket = await listen(server)
    assertEquals(socket.messages.find((m) => m.type === 'hello')?.clientLogs, true)
    await postLog(server, 'a line to watch')
    const record = await socket.until((m) => m.type === 'client-log')
    assert(record, `the record is sent\n${server.log()}`)
    assertEquals(record.msg, 'a line to watch')
  } finally {
    await socket?.close()
    await server.stop()
  }
})
