/**
 * /events and /rtc-signal on Node (ADR 0016): the upgrade runs through the routes' own checks first, as it did on Deno.
 *
 *   - A page from an origin the server does not admit is refused with 403, and no socket opens.
 *   - A client that sends no Origin (not a browser) and a page from an admitted origin are upgraded (101).
 *   - The preview roles of /rtc-signal (phone, viewer) answer 404 while VITE_ENABLE_WEBRTC_LIVE is off; capture is
 *     not gated.
 *
 * A raw HTTP upgrade request, so the test sets the Origin header itself, against the spawned server
 * (server_core_harness.ts).
 */
import { assertEquals } from './assert.ts'
import { startServer } from './server_core_harness.ts'
import { request } from 'node:http'
import { test } from 'node:test'

/** The status the server answers a WebSocket upgrade of `path` with: 101 when it upgrades. */
function upgradeStatus(port: number, path: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(origin ? { Origin: origin } : {}),
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

test('the WebSocket routes refuse a foreign origin with 403, gate the preview roles, and upgrade the rest', async () => {
  const server = await startServer()
  try {
    const foreign = 'https://elsewhere.example'
    const admitted = 'https://scan.test:5173' // the harness's TAILSCALE_HOSTNAME, on the Vite port
    assertEquals(await upgradeStatus(server.port, '/events', foreign), 403, '/events from a foreign page')
    assertEquals(await upgradeStatus(server.port, '/events'), 101, '/events from a client that sends no Origin')
    assertEquals(await upgradeStatus(server.port, '/events', admitted), 101, '/events from an admitted page')
    assertEquals(await upgradeStatus(server.port, '/rtc-signal?role=capture&room=r1&clientId=c1', foreign), 403, '/rtc-signal from a foreign page')
    assertEquals(await upgradeStatus(server.port, '/rtc-signal?role=viewer&room=r1'), 404, 'the preview pair is off')
    assertEquals(await upgradeStatus(server.port, '/rtc-signal?role=phone&room=r1'), 404, 'the preview pair is off')
    assertEquals(await upgradeStatus(server.port, '/rtc-signal?role=capture&room=r1&clientId=c1', admitted), 101, 'capture is not gated')
  } finally {
    await server.stop()
  }
})
