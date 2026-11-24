/**
 * The WebSocket keepalive (server/ws_heartbeat.ts): Deno's idleTimeout rule, which `ws` does not have. A socket that
 * answers each ping stays; one that misses one is closed at the next tick; the keepalive stops when told.
 *
 * Run: node --test tests/unit/server/ws_heartbeat.test.ts
 */
import { assert, assertEquals } from './assert.ts'
import { test } from 'node:test'
import { startWsHeartbeat, WS_IDLE_TIMEOUT_MS } from '../../../server/ws_heartbeat.ts'

class FakeSocket {
  pings = 0
  terminated = false
  private pong: (() => void) | null = null
  readonly answers: boolean
  constructor(answers: boolean) {
    this.answers = answers
  }
  ping(): void {
    this.pings += 1
    if (this.answers) queueMicrotask(() => this.pong?.())
  }
  terminate(): void {
    this.terminated = true
  }
  on(_event: 'pong', listener: () => void): void {
    this.pong = listener
  }
}

class FakeServer {
  clients = new Set<FakeSocket>()
  private connected: ((socket: FakeSocket) => void) | null = null
  on(_event: 'connection', listener: (socket: FakeSocket) => void): void {
    this.connected = listener
  }
  connect(socket: FakeSocket): void {
    this.clients.add(socket)
    this.connected?.(socket)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('ws heartbeat: the interval is the 30 s idleTimeout the server ran with under Deno', () => {
  assertEquals(WS_IDLE_TIMEOUT_MS, 30_000)
})

test('ws heartbeat: a socket that answers stays open; one that misses a ping is closed at the next tick', async () => {
  const server = new FakeServer()
  const alive = new FakeSocket(true)
  const asleep = new FakeSocket(false)
  server.connect(alive)
  server.connect(asleep)
  const stop = startWsHeartbeat(server, 20)
  try {
    await sleep(110)
    assertEquals(alive.terminated, false, 'a socket that answers every ping is kept')
    assert(alive.pings >= 3, `pinged each tick, ${alive.pings} times`)
    assertEquals(asleep.terminated, true, 'a socket that did not answer is closed')
  } finally {
    stop()
  }
})

test('ws heartbeat: a socket that was open before it started is watched from the first tick, not closed', async () => {
  const server = new FakeServer()
  const stop = startWsHeartbeat(server, 20)
  const late = new FakeSocket(true)
  server.clients.add(late) // no connection event: it was there first
  try {
    await sleep(110)
    assertEquals(late.terminated, false)
  } finally {
    stop()
  }
})

test('ws heartbeat: stopping it stops the pings', async () => {
  const server = new FakeServer()
  const socket = new FakeSocket(true)
  server.connect(socket)
  const stop = startWsHeartbeat(server, 10)
  await sleep(35)
  stop()
  const pings = socket.pings
  await sleep(40)
  assertEquals(socket.pings, pings, 'no ping after stop')
})
