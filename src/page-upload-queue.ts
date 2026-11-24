/**
 * The offline upload queue for a page that has no service worker: the phone and desktop apps (F-15).
 *
 * The apps are built with VITE_DISABLE_PWA (scripts/native/build-web.mjs), and could not use a worker
 * anyway: their page is on the app's own origin and the Scan server is on another, and a worker sees
 * only its own origin's requests. So in an app, an export made offline used to fail outright, and the
 * scanner said "server rejected it". On a phone, the GLB of a failed upload exists only in memory.
 *
 * This is the worker's queue, run by the page. It answers in the worker's contract (SM-056,
 * src/shared/offline-queue.ts): a queued write gets `202` with `X-Companion-Queued-Offline: 1` and
 * `{ ok: false, queuedOffline: true, queueId, message }`, and `X-Companion-No-Queue: 1` keeps a write
 * out. So the callers that already read that contract work unchanged: exportToGLB reports
 * 'queued-offline' and the scanner says the scan is saved on the phone. The records are the worker's
 * too (public/sw.js `queueRequest`), in the same database and store, with the same id format, kinds,
 * bounds and notices. tests/unit/node/wp-14-scanner-ui-page-queue.test.ts holds the shared constants
 * equal to sw.js's literals.
 *
 * It queues less than the worker does, on purpose (docs/factory/14-inventory-fixes/0003-scanner-ui.md):
 *  - POST /upload-scan, POST /upload-summary and POST /sessions/<id>/finalize: writes whose callers
 *    already read a queued answer, and whose bodies are a scan, a summary or a few counts;
 *  - not /projects. A shell cannot send the no-queue header (noQueueHeaders() needs a worker), a Place
 *    that is created must be refused while offline, and a Place's frame has its own pending store;
 *  - not keyframe images or POST /sessions. Withdrawing consent drops queued frames only from the
 *    worker's queue, and the streamer already backs off and drops frames while offline;
 *  - not /process-scan, whose answer the person is waiting for.
 *
 * One difference in replay: a network error while replaying ends the pass and counts nothing, because
 * the network is still down and that says nothing about the request. The age bound still ends a request
 * that never gets through. A status is counted exactly as the worker counts it.
 *
 * `Authorization` is never stored. The shell's fetch wrapper (src/shared/shell-sign-in.ts) adds the
 * current token to the replay, so a token is not left in IndexedDB.
 *
 * Imports only the contract and the key, so plain node tests the queue against fakes.
 */
import { NO_QUEUE_HEADER, QUEUED_OFFLINE_HEADER, isQueuedOffline } from './shared/offline-queue.ts'
import { OFFLINE_QUEUE_DB_NAME } from './shared/storage-keys.ts'

// ── The worker's constants. public/sw.js keeps its own literals; the test holds them equal. ──────

/** The object store inside OFFLINE_QUEUE_DB_NAME, at version 1 (public/sw.js QUEUE_STORE). */
export const QUEUE_STORE = 'requests'
export const MAX_QUEUE_ITEMS = 24
export const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000
export const MAX_FLUSH_ATTEMPTS = 5
/** Statuses below 500 that a later replay could answer differently, so the body is kept. */
export const RETRIABLE_FLUSH_STATUSES: readonly number[] = [401, 403, 408, 429]

export type QueueKind = 'place' | 'scan' | 'summary' | 'session' | 'world' | 'process' | 'other'

/** The kind of a queued write, by the path it went to (public/sw.js QUEUE_KIND_PREFIXES). */
export const QUEUE_KIND_PREFIXES: ReadonlyArray<readonly [string, QueueKind]> = [
  ['/projects', 'place'],
  ['/upload-scan', 'scan'],
  ['/upload-summary', 'summary'],
  ['/sessions', 'session'],
  ['/worlds', 'world'],
  ['/process-scan', 'process'],
]

/** How a kind reads in a notice: [one, many] (public/sw.js QUEUE_KIND_NAMES). */
export const QUEUE_KIND_NAMES: Readonly<Record<QueueKind, readonly [string, string]>> = {
  place: ['Place change', 'Place changes'],
  scan: ['scan upload', 'scan uploads'],
  summary: ['scan summary', 'scan summaries'],
  session: ['keyframe upload', 'keyframe uploads'],
  world: ['editor change', 'editor changes'],
  process: ['processing request', 'processing requests'],
  other: ['queued upload', 'queued uploads'],
}

export function queueKindOfPath(pathname: string): QueueKind {
  for (const [prefix, kind] of QUEUE_KIND_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return kind
  }
  return 'other'
}

/** The kind written into a queue id, `<ms>-<kind>-<random>`. An id from before kinds were recorded is 'other'. */
export function queueKindOfId(id: string): QueueKind {
  const parts = String(id).split('-')
  const kind = parts.length === 3 ? parts[1]! : 'other'
  return Object.prototype.hasOwnProperty.call(QUEUE_KIND_NAMES, kind) ? kind as QueueKind : 'other'
}

/** "2 scan uploads and 1 scan summary", for the notice that names what was dropped. */
export function describeQueueKinds(ids: readonly string[]): string {
  const counts = new Map<QueueKind, number>()
  for (const id of ids) counts.set(queueKindOfId(id), (counts.get(queueKindOfId(id)) ?? 0) + 1)
  const parts = [...counts].map(([kind, count]) => `${count} ${QUEUE_KIND_NAMES[kind][count === 1 ? 0 : 1]}`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? ''
}

// ── What this page queues ─────────────────────────────────────────────────────────────────────────

/** Whether a page with no worker queues this write when it cannot be sent. See the file header for why so few. */
export function pageQueues(method: string, pathname: string, headers: Headers): boolean {
  if (method.toUpperCase() !== 'POST') return false
  if (headers.get(NO_QUEUE_HEADER) === '1') return false
  return pathname === '/upload-scan' || pathname === '/upload-summary' || /^\/sessions\/[^/]+\/finalize$/.test(pathname)
}

// ── The record and its store ──────────────────────────────────────────────────────────────────────

/** A queued request, as public/sw.js `queueRequest` writes it. */
export interface QueuedRequest {
  id: string
  url: string
  method: string
  headers: Array<[string, string]>
  body: ArrayBuffer
  createdAt: number
  attempts: number
  lastError?: string
}

/** The calls the queue makes on its IndexedDB store. A test passes an in-memory one. */
export interface QueueStore {
  keys(): Promise<string[]>
  getAll(): Promise<QueuedRequest[]>
  put(record: QueuedRequest): Promise<void>
  delete(id: string): Promise<void>
}

/** The messages public/sw.js posts to its pages, which src/pwa.ts shows. This queue says the same things. */
export type QueueNotice =
  | { type: 'offline-queued', queueId: string, url: string, method: string, kind: QueueKind }
  | { type: 'offline-flushed', queueId: string, ok: true, status: number }
  | { type: 'offline-queue-failed', url: string, message: string }
  | { type: 'offline-dropped', count: number, expired: number, evicted: number, message: string }
  | { type: 'offline-gave-up', queueId: string, url: string, attempts: number, lastError: string, message: string }
  | { type: 'offline-rejected', queueId: string, url: string, status: number, message: string }

export interface PageUploadQueueOptions {
  store: QueueStore
  /** The fetch the page had: a request is sent, and replayed, through this. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  notify: (notice: QueueNotice) => void
  now?: () => number
  /** The random part of a queue id. */
  random?: () => string
}

export interface PageUploadQueue {
  /** A fetch that queues a write it may queue when that write cannot be sent, and passes everything else through. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Send what is queued, oldest first. One pass at a time; a call during a pass waits for it. */
  flush: () => Promise<void>
}

const QUEUED_MESSAGE = 'Saved offline and will retry when the network returns.'
const STORAGE_FULL_MESSAGE = 'Could not save this upload for later — device storage is full.'

/** The path of a request URL, resolved against the page when it is relative. Null when it is not a URL. */
function pathOf(url: string): string | null {
  try {
    return new URL(url, globalThis.location?.href).pathname
  } catch {
    return null
  }
}

/** A rejection that means the request could not be sent: a network failure, or the caller's timeout. Not a cancel. */
function couldNotSend(error: unknown): boolean {
  if (error instanceof TypeError) return true
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError'
}

export function createPageUploadQueue(options: PageUploadQueueOptions): PageUploadQueue {
  const { store, notify } = options
  const send = options.fetch
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? (() => Math.random().toString(36).slice(2))

  async function prune(): Promise<void> {
    const keys = [...await store.keys()].sort()
    const at = now()
    const expired: string[] = []
    const live: string[] = []
    for (const key of keys) {
      const createdAt = Number(String(key).split('-')[0])
      if (Number.isFinite(createdAt) && at - createdAt > MAX_QUEUE_AGE_MS) expired.push(key)
      else live.push(key)
    }
    // Room for the request about to be written. Oldest first: a newer autosave of a scan supersedes an older one.
    const overflow = live.length - (MAX_QUEUE_ITEMS - 1)
    const evicted = overflow > 0 ? live.slice(0, overflow) : []
    const dropped = [...expired, ...evicted]
    for (const key of dropped) await store.delete(key)
    if (dropped.length > 0) {
      notify({
        type: 'offline-dropped',
        count: dropped.length,
        expired: expired.length,
        evicted: evicted.length,
        message: `Dropped ${describeQueueKinds(dropped)} — the offline queue is full.`,
      })
    }
  }

  async function enqueue(request: Request, pathname: string): Promise<string> {
    const id = `${now()}-${queueKindOfPath(pathname)}-${random()}`
    const body = await request.arrayBuffer()
    const headers = [...request.headers.entries()]
      .filter(([name]) => !['content-length', 'host', 'authorization'].includes(name.toLowerCase()))
    await prune()
    await store.put({ id, url: request.url, method: request.method, headers, body, createdAt: now(), attempts: 0 })
    return id
  }

  async function queueingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Decided from the arguments, without building a Request: every other request passes through as it came,
    // and a body is never read for one that is not queued.
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const pathname = pathOf(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (pathname === null || !pageQueues(method, pathname, headers)) return send(input, init)
    const request = new Request(input, init)
    // The copy is taken before the request is sent, because sending consumes its body.
    const copy = request.clone()
    try {
      return await send(request)
    } catch (error) {
      if (!couldNotSend(error)) throw error
      let queueId: string
      try {
        queueId = await enqueue(copy, pathname)
      } catch (storeError) {
        // Not stored: say so, and answer as the worker does (507, no queued header), so the caller reads a failure.
        notify({ type: 'offline-queue-failed', url: request.url, message: STORAGE_FULL_MESSAGE })
        return new Response(JSON.stringify({
          ok: false,
          queuedOffline: false,
          error: 'queue-write-failed',
          message: STORAGE_FULL_MESSAGE,
          detail: storeError instanceof Error ? storeError.message : String(storeError),
        }), { status: 507, headers: { 'Content-Type': 'application/json' } })
      }
      notify({ type: 'offline-queued', queueId, url: request.url, method: request.method, kind: queueKindOfPath(pathname) })
      return new Response(JSON.stringify({ ok: false, queuedOffline: true, queueId, message: QUEUED_MESSAGE }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', [QUEUED_OFFLINE_HEADER]: '1' },
      })
    }
  }

  async function recordFailedAttempt(item: QueuedRequest, lastError: string): Promise<void> {
    const attempts = (item.attempts ?? 0) + 1
    if (attempts >= MAX_FLUSH_ATTEMPTS) {
      await store.delete(item.id)
      notify({
        type: 'offline-gave-up',
        queueId: item.id,
        url: item.url,
        attempts,
        lastError,
        message: `Gave up on a queued upload after ${attempts} attempts.`,
      })
      return
    }
    await store.put({ ...item, attempts, lastError })
  }

  async function runFlush(): Promise<void> {
    const items = [...await store.getAll()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const item of items) {
      let response: Response
      try {
        response = await send(item.url, { method: item.method, headers: new Headers(item.headers), body: item.body })
      } catch {
        // Still offline, or the server is not answering: this pass ends, and nothing is counted against the rest.
        return
      }
      if (response.ok && !isQueuedOffline(response)) {
        await store.delete(item.id)
        notify({ type: 'offline-flushed', queueId: item.id, ok: true, status: response.status })
      } else if (response.status >= 500 || RETRIABLE_FLUSH_STATUSES.includes(response.status)) {
        await recordFailedAttempt(item, `${response.status}`)
      } else {
        // Permanent: the same bytes get the same answer. The body goes, under its own notice.
        await store.delete(item.id)
        notify({
          type: 'offline-rejected',
          queueId: item.id,
          url: item.url,
          status: response.status,
          message: response.status === 413
            ? 'A queued upload was too large for the server and could not be saved.'
            : `The server rejected a queued upload (${response.status}) — it could not be saved.`,
        })
      }
    }
  }

  let flushing: Promise<void> | null = null
  function flush(): Promise<void> {
    flushing ??= runFlush().catch((error: unknown) => {
      console.warn('[page-queue] flush failed:', error)
    }).finally(() => { flushing = null })
    return flushing
  }

  return { fetch: queueingFetch, flush }
}

// ── The browser's store and the install ───────────────────────────────────────────────────────────

/** The worker's database, opened as public/sw.js `openQueueDb` opens it. */
export function indexedDbQueueStore(factory: IDBFactory = indexedDB): QueueStore {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = factory.open(OFFLINE_QUEUE_DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(QUEUE_STORE)) req.result.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const run = async <T>(mode: IDBTransactionMode, call: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, mode)
        const req = call(tx.objectStore(QUEUE_STORE))
        tx.oncomplete = () => resolve(req.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }
  return {
    keys: async () => (await run('readonly', (s) => s.getAllKeys())).map(String),
    getAll: () => run('readonly', (s) => s.getAll() as IDBRequest<QueuedRequest[]>),
    put: async (record) => { await run('readwrite', (s) => s.put(record)) },
    delete: async (id) => { await run('readwrite', (s) => s.delete(id)) },
  }
}

/** How often a page with something queued tries again, besides the `online` event and the page load. */
export const PAGE_QUEUE_RETRY_MS = 60_000

let installed = false

/**
 * Put the queue in front of the page's fetch. Called by the scanner in a native shell only. With
 * `flush`, this page also sends what is queued: at once, on every `online` event, and every
 * PAGE_QUEUE_RETRY_MS while it is not known to be offline. A read-only scanner tab passes false, as it
 * does to registerPWA(), so it cannot resend the writer's uploads.
 */
export function installPageUploadQueue(options: { flush: boolean, notify: (notice: QueueNotice) => void }): void {
  if (installed || typeof globalThis.fetch !== 'function' || typeof indexedDB === 'undefined') return
  installed = true
  const queue = createPageUploadQueue({
    store: indexedDbQueueStore(),
    fetch: globalThis.fetch.bind(globalThis),
    notify: options.notify,
  })
  globalThis.fetch = queue.fetch as typeof fetch
  if (!options.flush) return
  const flushIfOnline = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    void queue.flush()
  }
  globalThis.addEventListener?.('online', () => { void queue.flush() })
  setInterval(flushIfOnline, PAGE_QUEUE_RETRY_MS)
  flushIfOnline()
}
