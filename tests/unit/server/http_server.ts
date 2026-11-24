/**
 * A fetch-style HTTP server for a test's fake upstream (ADR 0016, wave 18 ticket 0002): an OIDC
 * issuer, CI-Server, a PhysAg3D controller, the 4D appliance. It stands where Deno's `serve` stood.
 *
 * It listens on 127.0.0.1 on a free port, and `close()` drops every connection, including the idle
 * keep-alive ones `fetch` holds, so a test does not wait out Node's keep-alive timeout.
 */
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'

export interface TestServer {
  /** The port it listens on. */
  port: number
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string
  /** Stop listening and close every connection. */
  close(): Promise<void>
}

export function serveFetch(
  handler: (request: Request) => Response | Promise<Response>,
  opts: { hostname?: string } = {},
): Promise<TestServer> {
  const hostname = opts.hostname ?? '127.0.0.1'
  return new Promise((resolve) => {
    const server = serve({ fetch: handler, port: 0, hostname, overrideGlobalObjects: false }, (info) => {
      resolve({
        port: info.port,
        url: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done) => {
            const http = server as Server
            http.close(() => done())
            http.closeAllConnections()
          }),
      })
    })
  })
}
