/**
 * The keepalive every WebSocket the server holds gets: /events and /rtc-signal (ADR 0016).
 *
 * Deno's `upgradeWebSocket` pinged an idle socket and closed one that had not answered with a pong within its
 * `idleTimeout`, 30 s by default, which is what the server used. The `ws` library that `@hono/node-ws` upgrades through
 * does no such thing. So without this, a phone that went to sleep, or lost its network, would keep its slot in a take
 * room (`MAX_TAKE_MEMBERS`, server/world/rtc_rooms.ts) and its place in the /events fan-out until TCP noticed, which
 * can take hours.
 *
 * The rule is Deno's: every `intervalMs` each open socket is pinged, and a socket that has not answered the previous
 * ping by then is closed. A browser answers a ping by itself. Closing a socket runs its close handlers, which leave the
 * room and the fan-out as a socket the client closed does.
 */

/** Deno's default `idleTimeout`, which the server ran with. */
export const WS_IDLE_TIMEOUT_MS = 30_000

/** What the keepalive needs of a socket: `ws`'s `ping`, `terminate` and `pong` event. */
export interface PingableSocket {
  ping(): void
  terminate(): void
  on(event: 'pong', listener: () => void): unknown
}

/** What the keepalive needs of the server: the open sockets, and word of each new one. */
export interface PingableServer<S extends PingableSocket> {
  clients: Iterable<S>
  on(event: 'connection', listener: (socket: S) => void): unknown
}

/**
 * Starts the keepalive on `server`'s sockets, and returns the function that stops it. Its timer does not hold the
 * process open.
 */
export function startWsHeartbeat<S extends PingableSocket>(
  server: PingableServer<S>,
  intervalMs: number = WS_IDLE_TIMEOUT_MS,
): () => void {
  const answered = new WeakMap<S, boolean>()
  // A socket is watched from its connection, or, if it was open before the keepalive started, from the first tick.
  const watch = (socket: S) => {
    answered.set(socket, true)
    socket.on('pong', () => answered.set(socket, true))
  }
  server.on('connection', watch)
  const timer = setInterval(() => {
    for (const socket of server.clients) {
      if (!answered.has(socket)) watch(socket)
      if (answered.get(socket) === false) {
        socket.terminate()
        continue
      }
      answered.set(socket, false)
      try {
        socket.ping()
      } catch {
        // Closing already: the close handlers do the rest.
      }
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
