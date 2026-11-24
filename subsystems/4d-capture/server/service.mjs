/**
 * The 4d-capture HTTP service.
 *
 * Five routes, and one property that matters more than any of them:
 * **submission is idempotent on `takeId`.**
 *
 *   GET  /health                        liveness, and whether this is stub mode
 *   POST /takes                         submit a take (idempotent on takeId)
 *   GET  /takes/:takeId                 status: running | ok | skipped | error
 *   GET  /takes/:takeId/sequence        the finished frame list
 *   GET  /takes/:takeId/frames/:frame   one trained timestep, frame-NNNNN.(sog|ply)
 *
 * Companion Scan's job pump requeues every in-flight job unconditionally on
 * boot (requeue-always is type-agnostic by design, ADR 0003). For a local job
 * that costs time; for a job that occupies a rented GPU for 25 minutes it costs
 * money, twice. The appliance re-attaches rather than resubmitting, and this
 * side refuses to start a second run for a take it is running or has finished.
 * A take that ended `error` or `skipped` may be submitted again: that is how a
 * fixed install gets a second try.
 *
 * **Access.** With FDANYONE_TOKEN set, every route needs
 * `Authorization: Bearer <FDANYONE_TOKEN>`, compared in constant time; the
 * appliance sends that header, and this service sends it back when it fetches
 * the clips. Unset, the routes are open, as they always were, and a warning
 * says so at start. LISTEN_HOST picks the interface (unset: every interface,
 * as before). Both defaults are kept so stub mode works out of the box; see the
 * README.
 *
 * No framework: the surface is five routes and adding a dependency tree to a
 * subsystem that must run on someone else's GPU box is not worth it.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTake as defaultRunTake } from './pipeline.mjs'

/** What a take id may be before it becomes a directory name: no separators, no dots, bounded. */
export const TAKE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const FRAME_RE = /^frame-\d{5}\.(sog|ply)$/

/** Largest submit body accepted. A take is a few clips' URLs; this is generous. */
const MAX_BODY_BYTES = 1024 * 1024

/** The service's settings from its environment and argv. */
export function configFromEnv(env = process.env, argv = process.argv) {
  return {
    port: Number(env.PORT || 9040),
    host: env.LISTEN_HOST || undefined,
    workDir: env.WORK_DIR || path.join(process.cwd(), 'work'),
    stub: argv.includes('--stub') || env.STUB_MODE === '1',
    token: env.FDANYONE_TOKEN || null,
    env,
  }
}

/** Constant-time check of an `Authorization` header against the token. Hashing first fixes the lengths. */
export function bearerMatches(header, token) {
  if (!token) return true
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? '').trim())
  if (!m) return false
  const given = createHash('sha256').update(m[1]).digest()
  const want = createHash('sha256').update(token).digest()
  return timingSafeEqual(given, want)
}

function json(res, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...extra })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

/**
 * One service instance. Nothing listens until `listen()` is called, so a test
 * can make one, pick its own port and work directory, and inject the pipeline.
 */
export function createService(config = {}) {
  const cfg = { ...configFromEnv(), ...config }
  const runTake = config.runTake ?? defaultRunTake
  /** takeId → job record. In-memory: a restart loses progress, and the appliance re-submits. */
  const takes = new Map()

  function startTake(take) {
    const record = {
      takeId: take.takeId,
      status: 'running',
      stage: 'queued',
      progress: 0,
      startedAt: new Date().toISOString(),
    }
    takes.set(take.takeId, record)

    // Deliberately not awaited: submit returns immediately and the appliance polls.
    Promise.resolve().then(() =>
      runTake(take, {
        workDir: cfg.workDir,
        env: cfg.env,
        stub: cfg.stub,
        token: cfg.token,
        ...(cfg.deps ?? {}),
        onProgress: (progress, stage) => {
          record.progress = progress
          record.stage = stage
        },
      })
    ).then((result) => {
      Object.assign(record, result, { finishedAt: new Date().toISOString() })
      if (!record.status || record.status === 'running') record.status = 'error'
    }).catch((err) => {
      // A throw here must still land as a reportable state, never a silent hang.
      Object.assign(record, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      })
    })

    return record
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://4d-capture.invalid')

    if (!bearerMatches(req.headers.authorization, cfg.token)) {
      return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, stub: cfg.stub, takes: takes.size })
    }

    if (req.method === 'POST' && url.pathname === '/takes') {
      const body = await readBody(req)
      if (body === null) return json(res, 413, { error: 'take too large' })
      if (typeof body.takeId !== 'string' || !Array.isArray(body.clips)) {
        return json(res, 400, { error: 'takeId and clips[] are required' })
      }
      // Validated before it names a directory under WORK_DIR.
      if (!TAKE_ID_RE.test(body.takeId)) return json(res, 400, { error: 'invalid takeId' })
      const existing = takes.get(body.takeId)
      if (existing && existing.status !== 'error' && existing.status !== 'skipped') {
        // Idempotent: re-attach rather than start a second GPU run.
        return json(res, 202, { takeId: body.takeId, jobId: body.takeId, attached: true })
      }
      startTake(body)
      return json(res, 202, { takeId: body.takeId, jobId: body.takeId, attached: false, ...(existing ? { retried: true } : {}) })
    }

    const statusMatch = /^\/takes\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && statusMatch) {
      const record = takes.get(decodeURIComponent(statusMatch[1]))
      if (!record) return json(res, 404, { error: 'unknown take' })
      return json(res, 200, record)
    }

    const seqMatch = /^\/takes\/([^/]+)\/sequence$/.exec(url.pathname)
    if (req.method === 'GET' && seqMatch) {
      const record = takes.get(decodeURIComponent(seqMatch[1]))
      if (!record || record.status !== 'ok') return json(res, 404, { error: 'no finished sequence' })
      let frames = []
      try {
        frames = (await readdir(record.sequenceDir)).filter((f) => FRAME_RE.test(f)).sort()
      } catch { /* directory vanished */ }
      return json(res, 200, { ...record, frames })
    }

    // GET /takes/:takeId/frames/:frame — one trained timestep.
    //
    // The appliance pulls these back to where it serves from; the subsystem's
    // work directory is not reachable by a browser.
    const frameMatch = /^\/takes\/([^/]+)\/frames\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && frameMatch) {
      const record = takes.get(decodeURIComponent(frameMatch[1]))
      const frame = decodeURIComponent(frameMatch[2])
      // Allowlist, not a sanitiser — these names are fully determined by the
      // trainer, so anything else is not a frame.
      if (!record || record.status !== 'ok' || !FRAME_RE.test(frame)) {
        return json(res, 404, { error: 'not found' })
      }
      try {
        const bytes = await readFile(path.join(record.sequenceDir, frame))
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length })
        return res.end(bytes)
      } catch {
        return json(res, 404, { error: 'frame not found' })
      }
    }

    json(res, 404, { error: 'not found' })
  })

  function listen() {
    return new Promise((resolve) => {
      server.listen(cfg.port, cfg.host, () => resolve(server.address()))
    })
  }

  function close() {
    return new Promise((resolve) => server.close(() => resolve()))
  }

  return { server, takes, startTake, listen, close, config: cfg }
}

// The module-level instance, kept for anything that imported `server`, `startTake` or `takes`.
const defaultService = createService()
export const { server, startTake, takes } = defaultService

/**
 * Whether this file is the program being run (`node server/service.mjs`), as
 * opposed to a module someone imported. Compared as real paths: a checkout
 * reached through a symlink gives argv[1] one spelling and import.meta.url
 * another, and the service would then exit without listening.
 */
export function isMainModule(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isMainModule() && process.env.NODE_ENV !== 'test') {
  defaultService.listen().then(() => {
    const cfg = defaultService.config
    const where = `${cfg.host ?? '*'}:${cfg.port}`
    console.log(`[4d-capture] listening on ${where}${cfg.stub ? ' (STUB MODE — no GPU, synthetic sequence)' : ''}`)
    if (!cfg.token) {
      console.warn('[4d-capture] FDANYONE_TOKEN is not set — every route is open to anyone who can reach this port')
    }
    if (!cfg.stub && !cfg.env.FDANYONE_DIR) {
      console.warn('[4d-capture] FDANYONE_DIR is not set — single-clip takes will report "skipped"')
    }
  })
}
