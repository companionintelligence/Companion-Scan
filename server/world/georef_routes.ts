/**
 * The Place georeference routes, registered onto the server's app: `PUT /projects/:id/georeference` and
 * `GET /projects/:id/georeference-seed` (ADR 0015).
 *
 * Deno-API-free like the rest of server/world/ (ADR 0004): the one thing here that is not a plain function, the Hono app, is a
 * type, and everything server/main.ts owns (the Places registry and its mutation queue, the size-capped body reader, the stored
 * scans and the sidecar readers) is handed in. It is `registerMemoryPush`'s shape (server/memory_push.ts), and the routes are
 * behind the guard every `/projects` path is behind: server/main.ts registers that guard before it calls this.
 *
 *  - `PUT`: the body is `{ georeference, expectedVersion }`, accepted only when `expectedVersion` is the version the Place holds
 *    (200 `{ georefVersion, georeference }`), else 409 `{ current }` and nothing changes, and 400 carries the validator's reasons
 *    (`applyGeoreferenceWrite`, ./georef_write.ts). The scans of the Place's world are placed again the next time it is read.
 *  - `GET .../georeference-seed`: what the Place's scans say together about where it is and which way it faces, the compass
 *    estimate the Place location panel offers. Read-only and approximate (./georef_seed.ts): it writes nothing, and a record made
 *    from it is not confirmed.
 */
import type { Hono } from 'hono'
import type { Project } from '../../src/world/types.ts'
import { applyGeoreferenceWrite } from './georef_write.ts'
import { georeferenceSeedFromScans, type SeedHost, type SeedScan } from './georef_seed.ts'

export interface GeoreferenceRouteDeps {
  /** Reads a request body as text, or null when it is longer than `maxBytes`. */
  readTextCapped: (request: Request, maxBytes: number) => Promise<string | null>
  /** The longest body the write accepts, bytes: a Place's, as the whole-record PUT's. */
  maxBodyBytes: number
  /** The Places registry's mutation queue: the read and the write are one step. */
  mutateProjects: <T>(mutator: (projects: Project[]) => { result: T; save: boolean } | Promise<{ result: T; save: boolean }>) => Promise<T>
  loadProjects: () => Promise<Project[]>
  /** The stored scans whose sidecar names this Place. */
  scansOfPlace: (projectId: string) => Promise<SeedScan[]>
  seedHost: SeedHost
}

export function registerGeoreferenceRoutes(app: Hono, deps: GeoreferenceRouteDeps): void {
  app.put('/projects/:id/georeference', async (c) => {
    const raw = await deps.readTextCapped(c.req.raw, deps.maxBodyBytes)
    if (raw === null) return c.json({ error: 'Place is too large' }, 413)
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch { /* handled below */ }
    if (!parsed) return c.json({ error: 'Invalid JSON' }, 400)
    const reply = await deps.mutateProjects((projects) => applyGeoreferenceWrite(projects, c.req.param('id'), parsed, Date.now()))
    return c.json(reply.body, reply.status)
  })

  app.get('/projects/:id/georeference-seed', async (c) => {
    const projectId = c.req.param('id')
    const project = (await deps.loadProjects()).find((item) => item.projectId === projectId)
    if (!project) return c.json({ error: 'Not found' }, 404)
    return c.json(georeferenceSeedFromScans(project, await deps.scansOfPlace(projectId), deps.seedHost))
  })
}
