/**
 * The spawned server the server-core tests talk to (wave 14 ticket 0001).
 *
 * server/main.ts serves at import and exports nothing, so a route cannot be called in-process. Each test spawns the
 * real server/main.ts on a free port, with every folder it writes in a temp directory, the mock inference engine, a
 * fixed host name and no GPU tool, and talks to it over HTTP: the middleware, the guards and the handler together, as
 * tests/unit/server/export_route_guard.test.ts does.
 */
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { signSession } from '../../../server/portal_auth.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { type SpawnedCommand, spawnCommand } from '../../../server/subprocess.ts'
import { makeTempDir } from '../../../server/fs_util.ts'

const SERVER_ENTRY = fileURLToPath(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000

/** What the spawned server may inherit: the search path, temp folders, proxies and certificates, and nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

/** The session secret and the one allowlisted account the sign-in modes below use. */
export const TEST_SESSION_SECRET = 'server-core-test-secret'
export const TEST_EMAIL = 'owner@example.com'

/** Sign-in on, with an issuer on a port fetch refuses (port 9, on the Fetch standard's bad-port list), so discovery fails at once and nothing leaves the machine. */
export const SIGN_IN_ON: Record<string, string> = {
  PORTAL_OIDC_ENABLED: '1',
  OIDC_ISSUER_URL: 'http://127.0.0.1:9',
  PORTAL_OIDC_ALLOWED_EMAILS: TEST_EMAIL,
  SESSION_SECRET: TEST_SESSION_SECRET,
}

/** A Companion session token for `email`, signed with the test secret, valid for an hour. */
export function companionSession(email = TEST_EMAIL): Promise<string> {
  return signSession({ sub: `sub-${email}`, email, name: 'Test', exp: Math.floor(Date.now() / 1000) + 3600 }, TEST_SESSION_SECRET)
}

export interface Reply {
  status: number
  headers: Headers
  body: Uint8Array
  text: string
  json<T = unknown>(): T
}

export interface RequestOptions {
  /** A world member token or a session, sent as `?token=`. */
  token?: string
  /** Sent as `Authorization: Bearer`. */
  bearer?: string
  /** A Cookie header. */
  cookie?: string
  /** Sent as JSON. */
  json?: unknown
  /** Sent as is (a string or form data). */
  body?: BodyInit
  headers?: Record<string, string>
}

export interface RunningServer {
  root: string
  scansDir: string
  sessionsDir: string
  worldsDir: string
  summariesDir: string
  projectsFile: string
  request(method: string, path: string, opts?: RequestOptions): Promise<Reply>
  get(path: string, opts?: RequestOptions): Promise<Reply>
  post(path: string, json: unknown, opts?: RequestOptions): Promise<Reply>
  /** The port the server listens on. */
  port: number
  /** What the server printed so far, for a failure message. */
  log(): string
  stop(): Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

function withToken(path: string, token: string | undefined): string {
  if (!token) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

async function send(base: string, method: string, path: string, opts: RequestOptions): Promise<Reply> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`
  if (opts.cookie) headers['Cookie'] = opts.cookie
  let body: BodyInit | undefined = opts.body
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.json)
  }
  try {
    const res = await fetch(`${base}${withToken(path, opts.token)}`, { method, headers, body, signal: controller.signal, redirect: 'manual' })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    return { status: res.status, headers: res.headers, body: bytes, text, json: <T>() => JSON.parse(text) as T }
  } finally {
    clearTimeout(timer)
  }
}

function baseEnv(root: string): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && INHERITED_ENV.test(name)) inherited[name] = value
  }
  return {
    ...inherited,
    PORT: '0',
    SCANS_DIR: `${root}/scans`,
    WORLDS_DIR: `${root}/worlds`,
    SUMMARIES_DIR: `${root}/summaries`,
    PROJECTS_FILE: `${root}/projects.json`,
    STATIC_DIR: `${root}/no-static-bundle`,
    PHYSAG3D_RUNS_DIR: `${root}/physag3d-runs`,
    INFERENCE_MODE: 'mock',
    TAILSCALE_HOSTNAME: 'scan.test',
    // No GPU or reconstruction tool is ever found: a job that reaches one skips.
    PANOPTIC_PYTHON: `${root}/no-tool/python`,
    PANOPTIC_DIR: `${root}/no-tool`,
    SENSENOVA_DIR: `${root}/no-tool`,
    BRUSH_BIN: `${root}/no-tool/brush`,
    COLMAP_BIN: `${root}/no-tool/colmap`,
  }
}

function spawnServer(root: string, env: Record<string, string>): Promise<SpawnedCommand> {
  return spawnCommand(process.execPath, {
    args: [SERVER_ENTRY],
    cwd: fileURLToPath(REPO_ROOT),
    clearEnv: true,
    env: { ...baseEnv(root), ...env },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  })
}

/**
 * Spawns server/main.ts with `env` on top of the test environment, and resolves once it says where it listens.
 * `prepare` runs first, with the temp folders, so a test can leave files the server finds at boot.
 */
export async function startServer(
  env: Record<string, string> = {},
  prepare?: (dirs: { root: string; scansDir: string; sessionsDir: string; worldsDir: string; projectsFile: string }) => Promise<void>,
): Promise<RunningServer> {
  const root = await makeTempDir({ prefix: 'server-core-' })
  const dirs = {
    root,
    scansDir: `${root}/scans`,
    sessionsDir: `${root}/scans/sessions`,
    worldsDir: `${root}/worlds`,
    summariesDir: `${root}/summaries`,
    projectsFile: `${root}/projects.json`,
  }
  let child: SpawnedCommand | null = null
  let output = ''
  const pumps: Promise<void>[] = []
  const stop = async (): Promise<void> => {
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch { /* already gone */ }
      await child.status
      await Promise.all(pumps)
    }
    await fs.rm(root, { recursive: true }).catch(() => undefined)
  }
  try {
    await fs.mkdir(dirs.sessionsDir, { recursive: true })
    await fs.mkdir(dirs.worldsDir, { recursive: true })
    if (prepare) await prepare(dirs)
    child = await spawnServer(root, env)
    let announce!: (port: number) => void
    const listening = new Promise<number>((resolve) => {
      announce = resolve
    })
    const onText = (text: string) => {
      output += text
      const match = /Listening on https?:\/\/[^:\s/]+:(\d+)/.exec(output)
      if (match) announce(Number(match[1]))
    }
    pumps.push(pump(child.stdout, onText), pump(child.stderr, onText))
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      listening.then((port) => ({ port })),
      child.status.then((status) => ({ exitCode: status.code })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), BOOT_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    if (!('port' in outcome)) {
      throw new Error(`the server did not start (${JSON.stringify(outcome)}). Its output:\n${output.slice(-4000)}`)
    }
    const base = `http://127.0.0.1:${outcome.port}`
    const request = (method: string, path: string, opts: RequestOptions = {}) => send(base, method, path, opts)
    return {
      ...dirs,
      port: outcome.port,
      request,
      get: (path, opts = {}) => request('GET', path, opts),
      post: (path, json, opts = {}) => request('POST', path, { ...opts, json }),
      log: () => output.slice(-6000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/** Boots the server with `env` and waits for it to exit or listen. For a configuration that must not start. */
export async function bootOutcome(env: Record<string, string>): Promise<{ exitCode: number | null; output: string }> {
  const root = await makeTempDir({ prefix: 'server-core-boot-' })
  let output = ''
  const child = await spawnServer(root, env)
  const pumps = [pump(child.stdout, (t) => (output += t)), pump(child.stderr, (t) => (output += t))]
  let timer: ReturnType<typeof setTimeout> | undefined
  let check: ReturnType<typeof setInterval> | undefined
  const outcome = await Promise.race([
    child.status.then((status) => status.code),
    new Promise<null>((resolve) => {
      check = setInterval(() => {
        if (/Listening on/.test(output)) resolve(null)
      }, 50)
      timer = setTimeout(() => resolve(null), BOOT_TIMEOUT_MS)
    }),
  ])
  // Both are cleared whichever side won: a server that exits at boot never prints the line, and an interval left
  // running would hold the test file open.
  if (timer !== undefined) clearTimeout(timer)
  if (check !== undefined) clearInterval(check)
  if (outcome === null) {
    try {
      child.kill('SIGTERM')
    } catch { /* gone */ }
    await child.status
  }
  await Promise.all(pumps)
  await fs.rm(root, { recursive: true }).catch(() => undefined)
  return { exitCode: outcome, output }
}

/** The member tokens of a world, from its file. */
export async function worldTokens(server: RunningServer, slug: string): Promise<Record<string, string>> {
  const world = JSON.parse(await fs.readFile(`${server.worldsDir}/${slug}.json`, 'utf8')) as {
    members: Array<{ role: string; token: string }>
  }
  return Object.fromEntries(world.members.map((member) => [member.role, member.token]))
}

/**
 * Makes the default world exist: an anonymous read builds it, on every install. Returns its tokens. On an install
 * whose session guard covers nothing world-shaped, this is the one world a test can get without signing in.
 */
export async function defaultWorldTokens(server: RunningServer): Promise<Record<string, string>> {
  const read = await server.get('/worlds/default')
  if (read.status !== 200) throw new Error(`GET /worlds/default answered ${read.status}: ${read.text}`)
  return await worldTokens(server, 'default')
}

/**
 * Writes a world file for `slug` the way POST /worlds would leave it, by copying the default world with fresh tokens.
 * For the modes where POST /worlds cannot be reached (SCAN_REQUIRE_AUTH=1 with sign-in off lets no request through).
 */
export async function writeWorldLike(server: RunningServer, slug: string): Promise<Record<string, string>> {
  await defaultWorldTokens(server)
  const world = JSON.parse(await fs.readFile(`${server.worldsDir}/default.json`, 'utf8')) as Record<string, unknown> & {
    members: Array<{ role: string; token: string; memberId: string }>
  }
  world.worldId = `world-${slug}`
  world.shareSlug = slug
  world.name = slug
  world.members = world.members.map((member) => ({
    ...member,
    memberId: `${member.role}-${crypto.randomUUID()}`,
    token: `${member.role}-${crypto.randomUUID()}`,
  }))
  await fs.writeFile(`${server.worldsDir}/${slug}.json`, JSON.stringify(world, null, 2))
  return Object.fromEntries(world.members.map((member) => [member.role, member.token]))
}

export interface JobRecord {
  jobId: string
  type: string
  status: string
  scanId?: string
  workerId?: string
  result?: string
  error?: string
  payload?: Record<string, unknown>
  artifacts?: Array<{ type: string; url?: string; metadata?: Record<string, unknown> }>
}

/** Polls a world's jobs until `jobId` settles, and returns it. */
export async function waitForJob(
  server: RunningServer,
  slug: string,
  jobId: string,
  opts: { token?: string; timeoutMs?: number } = {},
): Promise<JobRecord> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  let job: JobRecord | undefined
  while (Date.now() < deadline) {
    const jobs = await server.get(`/worlds/${slug}/jobs`, { token: opts.token })
    if (jobs.status === 200) {
      job = jobs.json<JobRecord[]>().find((item) => item.jobId === jobId)
      if (job && (job.status === 'completed' || job.status === 'failed')) return job
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} did not settle: ${JSON.stringify(job)}\n${server.log()}`)
}

/** Every file name under `dir`, recursively, relative to it. */
export async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (path: string, prefix: string) => {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(`${path}/${entry.name}`, rel)
      else out.push(rel)
    }
  }
  await walk(dir, '').catch(() => undefined)
  return out.sort()
}
