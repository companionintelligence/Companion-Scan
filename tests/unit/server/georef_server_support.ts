/**
 * What the georeference tests that run the real server share: starting server/main.ts on a free port with every
 * directory it writes in a temp folder, talking to it over HTTP, and putting scans on disk the way the upload route
 * leaves them (a `.glb` and its sidecar `.json`). Not a test file: `npm run test:server` runs only what is named `*.test.ts`.
 *
 * server/main.ts starts listening at import and exports nothing, so a route cannot be called from a test in-process
 * (tests/unit/server/place_frame_route.test.ts says the same). Each test that needs the route as wired spawns the
 * real file, so the middleware, the guard, the handler, the serialised mutation queue and the temp-file-and-rename
 * save are all in the loop.
 */
import { REPO_ROOT } from '../../../server/repo-root.ts'
import type { Project, WorldProject } from '../../../src/world/types.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { makeTempDir } from '../../../server/fs_util.ts'
import { type SpawnedCommand, spawnCommand } from '../../../server/subprocess.ts'

const SERVER_ENTRY = fileURLToPath(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000

/** What the spawned server may inherit: the search path, temp folders, proxies and certificates, and nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

export interface Reply {
  status: number
  text: string
  json: unknown
}

export interface Credential {
  /** A world member token, sent in the query as the editor's share links do. */
  token?: string
  /** A Companion session, sent as a Bearer token as the app does. */
  bearer?: string
}

export interface RunningServer {
  root: string
  registryFile: string
  worldsDir: string
  scansDir: string
  /** One request with a JSON body (or `raw` text), as `who` if a credential is given. */
  send(method: string, path: string, body?: unknown, who?: Credential, raw?: string): Promise<Reply>
  /** The registry file as it is on disk right now, not as the server answers. */
  registry(): Promise<Project[]>
  /** A world file as it is on disk right now. */
  worldFile(slug: string): Promise<WorldProject>
  log(): string
  /** Stops the server and removes its folder, or keeps the folder for a restart on it. */
  stop(keepRoot?: boolean): Promise<void>
}

export interface StartOptions {
  /** Written as the Places registry before the server starts. */
  seed?: unknown[]
  /** Reuse a folder, for a restart. */
  root?: string
  /** World files (slug to JSON text) written before the server starts: how a test starts from a world an older build wrote. */
  worlds?: Record<string, string>
  /** Called with the scans directory before the server starts, to put scans there. */
  scans?: (scansDir: string) => Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

/** Spawns server/main.ts with `env` on top of a bare environment and resolves once it says where it listens. */
export async function startServer(env: Record<string, string> = {}, options: StartOptions = {}): Promise<RunningServer> {
  const root = options.root ?? await makeTempDir({ prefix: 'georef-server-' })
  const registryFile = `${root}/projects.json`
  const worldsDir = `${root}/worlds`
  const scansDir = `${root}/scans`
  await fs.mkdir(worldsDir, { recursive: true })
  await fs.mkdir(scansDir, { recursive: true })
  if (options.seed) await fs.writeFile(registryFile, JSON.stringify(options.seed, null, 2))
  for (const [slug, text] of Object.entries(options.worlds ?? {})) await fs.writeFile(`${worldsDir}/${slug}.json`, text)
  if (options.scans) await options.scans(scansDir)

  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && INHERITED_ENV.test(name)) inherited[name] = value
  }
  let child: SpawnedCommand | null = null
  let output = ''
  const pumps: Promise<void>[] = []
  const stop = async (keepRoot = false): Promise<void> => {
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch { /* already gone */ }
      await child.status
      await Promise.all(pumps)
      child = null
    }
    if (!keepRoot) await fs.rm(root, { recursive: true }).catch(() => undefined)
  }
  try {
    child = await spawnCommand(process.execPath, {
      args: [SERVER_ENTRY],
      cwd: fileURLToPath(REPO_ROOT),
      clearEnv: true,
      env: {
        ...inherited,
        PORT: '0',
        SCANS_DIR: scansDir,
        WORLDS_DIR: worldsDir,
        SUMMARIES_DIR: `${root}/summaries`,
        PROJECTS_FILE: registryFile,
        STATIC_DIR: `${root}/no-static-bundle`,
        INFERENCE_MODE: 'mock',
        TAILSCALE_HOSTNAME: 'scan.test',
        ...env,
      },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    })

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
    return {
      root,
      registryFile,
      worldsDir,
      scansDir,
      send: async (method, path, body, who = {}, raw) => {
        const url = `${base}${path}${who.token ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(who.token)}` : ''}`
        const headers: Record<string, string> = {}
        const hasBody = body !== undefined || raw !== undefined
        if (hasBody) headers['Content-Type'] = 'application/json'
        if (who.bearer) headers['Authorization'] = `Bearer ${who.bearer}`
        const controller = new AbortController()
        const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const res = await fetch(url, {
            method,
            headers,
            body: hasBody ? (raw ?? JSON.stringify(body)) : undefined,
            signal: controller.signal,
          })
          const text = await res.text()
          let json: unknown = null
          try {
            json = JSON.parse(text)
          } catch { /* not JSON */ }
          return { status: res.status, text, json }
        } finally {
          clearTimeout(abort)
        }
      },
      registry: async () => JSON.parse(await fs.readFile(registryFile, 'utf8')) as Project[],
      worldFile: async (slug) => JSON.parse(await fs.readFile(`${worldsDir}/${slug}.json`, 'utf8')) as WorldProject,
      log: () => output.slice(-4000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/** A valid binary glTF whose scene has no nodes: enough for the server to hold a scan of. */
export function emptyGlb(): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }))
  const padded = new Uint8Array(new ArrayBuffer(Math.ceil(json.length / 4) * 4)).fill(0x20)
  padded.set(json)
  const out = new Uint8Array(new ArrayBuffer(12 + 8 + padded.length))
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(padded, 20)
  return out
}

/**
 * Puts one scan where the upload route leaves it: `<name>.glb` and its sidecar `<name>.json`, with the file's
 * modification time set, which is what the server lists a scan's upload time from (newest first), so a test decides
 * the order. The sidecar is the object `uploadToServer` in src/export/gltf.ts posts as `metadata`.
 */
export async function writeScan(scansDir: string, name: string, meta: Record<string, unknown>, mtimeMs: number): Promise<void> {
  await fs.mkdir(scansDir, { recursive: true })
  await fs.writeFile(`${scansDir}/${name}.glb`, emptyGlb())
  await fs.writeFile(`${scansDir}/${name}.json`, JSON.stringify(meta))
  const at = new Date(mtimeMs)
  await fs.utimes(`${scansDir}/${name}.glb`, at, at)
  await fs.utimes(`${scansDir}/${name}.json`, at, at)
}

/** A world as the server answers it, by slug (the legacy default world, or `project-<id>` for a Place's). */
export async function readWorld(server: RunningServer, path = '/worlds/default'): Promise<WorldProject> {
  const reply = await server.send('GET', path)
  if (reply.status !== 200) throw new Error(`GET ${path}: ${reply.status} ${reply.text}\n${server.log()}`)
  return reply.json as WorldProject
}
