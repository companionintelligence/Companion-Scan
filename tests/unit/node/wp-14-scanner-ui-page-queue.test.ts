/**
 * Wave 14, ticket 0003 (scanner-ui), F-15 and FN-003: the offline upload queue a native shell runs in its page,
 * because the apps have no service worker (src/page-upload-queue.ts).
 *
 * It is the worker's queue run by the page: the same SM-056 answer, the same records, ids, kinds and bounds. The
 * queue is driven here against an in-memory store and a fake network, and its constants are held equal to the
 * literals public/sw.js keeps (the worker is a classic script and cannot import them), read from the script the
 * way tests/unit/node/sw_offline_queue.test.ts reads it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-scanner-ui-page-queue.test.ts
 * Also run by npm run test:wave.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { NO_QUEUE_HEADER, QUEUED_OFFLINE_HEADER, isQueuedOffline } from '../../../src/shared/offline-queue.ts'
import { OFFLINE_QUEUE_DB_NAME } from '../../../src/shared/storage-keys.ts'
import {
  MAX_FLUSH_ATTEMPTS,
  MAX_QUEUE_AGE_MS,
  MAX_QUEUE_ITEMS,
  QUEUE_KIND_NAMES,
  QUEUE_KIND_PREFIXES,
  QUEUE_STORE,
  RETRIABLE_FLUSH_STATUSES,
  createPageUploadQueue,
  describeQueueKinds,
  pageQueues,
  queueKindOfId,
  type QueueNotice,
  type QueueStore,
  type QueuedRequest,
} from '../../../src/page-upload-queue.ts'

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
const SERVER = 'https://scan.example.test'

// ── The worker's literals ────────────────────────────────────────────────────────────────────────

const sw = vm.createContext({ self: { addEventListener() {} }, Request, Response, URL, Headers })
vm.runInContext(read('public/sw.js'), sw, { filename: 'public/sw.js' })
const fromWorker = <T>(expression: string) => JSON.parse(JSON.stringify(vm.runInContext(expression, sw))) as T

test('the page queue keeps the worker\'s bounds', () => {
  assert.equal(MAX_QUEUE_ITEMS, fromWorker<number>('MAX_QUEUE_ITEMS'))
  assert.equal(MAX_QUEUE_AGE_MS, fromWorker<number>('MAX_QUEUE_AGE_MS'))
  assert.equal(MAX_FLUSH_ATTEMPTS, fromWorker<number>('MAX_FLUSH_ATTEMPTS'))
  assert.deepEqual([...RETRIABLE_FLUSH_STATUSES], fromWorker<number[]>('RETRIABLE_FLUSH_STATUSES'))
})

test('the page queue names kinds as the worker does', () => {
  assert.deepEqual(QUEUE_KIND_PREFIXES.map((pair) => [...pair]), fromWorker<string[][]>('QUEUE_KIND_PREFIXES'))
  assert.deepEqual(JSON.parse(JSON.stringify(QUEUE_KIND_NAMES)), fromWorker<Record<string, string[]>>('QUEUE_KIND_NAMES'))
})

test('the page queue writes the worker\'s database and store', () => {
  assert.equal(fromWorker<string>('QUEUE_DB'), OFFLINE_QUEUE_DB_NAME)
  assert.equal(fromWorker<string>('QUEUE_STORE'), QUEUE_STORE)
})

test('the worker says what kind of write it queued (FN-011)', () => {
  assert.match(read('public/sw.js'), /type: 'offline-queued',\n\s+queueId,\n\s+url: request\.url,\n\s+method: request\.method,\n\s+kind: queueKindOfPath\(new URL\(request\.url\)\.pathname\),/)
})

// ── What is queued ───────────────────────────────────────────────────────────────────────────────

test('only the three writes whose callers read a queued answer are queued', () => {
  const none = new Headers()
  assert.equal(pageQueues('POST', '/upload-scan', none), true)
  assert.equal(pageQueues('POST', '/upload-summary', none), true)
  assert.equal(pageQueues('POST', '/sessions/s-1/finalize', none), true)
  assert.equal(pageQueues('post', '/upload-scan', none), true, 'method case does not matter')
  for (const [method, path, why] of [
    ['POST', '/projects', 'a Place create must be refused offline, and a shell cannot send the no-queue header'],
    ['PUT', '/projects/p-1', 'a Place change or frame'],
    ['POST', '/sessions', 'opening a keyframe session'],
    ['POST', '/sessions/s-1/keyframes', 'a camera frame: consent withdrawal reaches only the worker\'s queue'],
    ['POST', '/process-scan', 'its answer is waited for'],
    ['POST', '/ingest-video', 'too large for a count-bounded queue'],
    ['GET', '/upload-scan', 'a read'],
    ['POST', '/upload-scanner', 'another route'],
  ] as const) assert.equal(pageQueues(method, path, none), false, `${method} ${path}: ${why}`)
  assert.equal(pageQueues('POST', '/upload-scan', new Headers({ [NO_QUEUE_HEADER]: '1' })), false, 'the no-queue header is honoured')
})

// ── The queue, against a fake network and store ──────────────────────────────────────────────────

function memoryStore(): QueueStore & { rows: Map<string, QueuedRequest> } {
  const rows = new Map<string, QueuedRequest>()
  return {
    rows,
    keys: async () => [...rows.keys()],
    getAll: async () => [...rows.values()],
    put: async (record) => { rows.set(record.id, structuredClone(record)) },
    delete: async (id) => { rows.delete(id) },
  }
}

interface Rig {
  store: ReturnType<typeof memoryStore>
  notices: QueueNotice[]
  sent: Array<{ url: string, method: string, headers: Headers, body: string }>
  /** What the network does with the next request: answer a status, or fail to connect. */
  network: { mode: 'down' | number }
  clock: { now: number }
  queue: ReturnType<typeof createPageUploadQueue>
}

function rig(): Rig {
  const store = memoryStore()
  const notices: QueueNotice[] = []
  const sent: Rig['sent'] = []
  const network: Rig['network'] = { mode: 'down' }
  const clock = { now: 1_700_000_000_000 }
  let n = 0
  const queue = createPageUploadQueue({
    store,
    notify: (notice) => notices.push(notice),
    now: () => clock.now,
    random: () => `r${++n}`,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() })
      if (network.mode === 'down') throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ filename: 'scan.glb' }), { status: network.mode })
    },
  })
  return { store, notices, sent, network, clock, queue }
}

const upload = (r: Rig, body = 'glb-bytes', extra: Record<string, string> = {}) => r.queue.fetch(`${SERVER}/upload-scan`, {
  method: 'POST',
  body,
  headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer secret-token', ...extra },
})

test('offline, a queueable write is stored and answered with the worker\'s 202', async () => {
  const r = rig()
  const response = await upload(r)
  assert.equal(response.status, 202)
  assert.equal(response.headers.get(QUEUED_OFFLINE_HEADER), '1')
  assert.equal(isQueuedOffline(response), true, 'a caller reads it as not delivered, as it reads the worker\'s')
  const body = await response.json() as { ok: boolean, queuedOffline: boolean, queueId: string }
  assert.equal(body.ok, false)
  assert.equal(body.queuedOffline, true)
  const row = r.store.rows.get(body.queueId)
  assert.ok(row, 'stored under the id it answered with')
  assert.match(row.id, /^\d+-scan-r1$/, 'the worker\'s id format, with the kind')
  assert.equal(row.url, `${SERVER}/upload-scan`)
  assert.equal(new TextDecoder().decode(row.body), 'glb-bytes')
  assert.equal(row.attempts, 0)
  assert.deepEqual(r.notices, [{ type: 'offline-queued', queueId: row.id, url: `${SERVER}/upload-scan`, method: 'POST', kind: 'scan' }])
})

test('the token is never stored: the shell\'s fetch wrapper adds the current one to the replay', async () => {
  const r = rig()
  await upload(r)
  const [row] = [...r.store.rows.values()]
  assert.ok(row)
  assert.ok(!row.headers.some(([name]) => name.toLowerCase() === 'authorization'), 'no Authorization header in IndexedDB')
  assert.ok(row.headers.some(([name, value]) => name === 'content-type' && value === 'application/octet-stream'), 'other headers are kept')
})

test('a write that is not queued passes through untouched, and fails as it would have', async () => {
  const r = rig()
  await assert.rejects(r.queue.fetch(`${SERVER}/projects`, { method: 'POST', body: '{}' }), TypeError)
  await assert.rejects(r.queue.fetch(`${SERVER}/upload-scan`, { method: 'POST', body: 'x', headers: { [NO_QUEUE_HEADER]: '1' } }), TypeError)
  assert.equal(r.store.rows.size, 0)
  assert.deepEqual(r.notices, [])
})

test('online, a queueable write is simply sent', async () => {
  const r = rig()
  r.network.mode = 200
  const response = await upload(r)
  assert.equal(response.status, 200)
  assert.equal(isQueuedOffline(response), false)
  assert.equal(r.store.rows.size, 0)
})

test('a cancel is not a failure to send: an aborted write is not queued', async () => {
  const store = memoryStore()
  const queue = createPageUploadQueue({
    store,
    notify: () => {},
    fetch: async () => { throw new DOMException('The operation was aborted.', 'AbortError') },
  })
  await assert.rejects(queue.fetch(`${SERVER}/upload-summary`, { method: 'POST', body: 'x' }), { name: 'AbortError' })
  assert.equal(store.rows.size, 0)
})

test('a caller\'s timeout is a failure to send, and is queued', async () => {
  const store = memoryStore()
  const queue = createPageUploadQueue({
    store,
    notify: () => {},
    fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') },
  })
  const response = await queue.fetch(`${SERVER}/sessions/s-1/finalize`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 202)
  assert.equal([...store.rows.keys()][0]?.split('-')[1], 'session')
})

test('a write the store refuses answers 507 with no queued header, and says so', async () => {
  const notices: QueueNotice[] = []
  const queue = createPageUploadQueue({
    store: { keys: async () => [], getAll: async () => [], put: async () => { throw new Error('QuotaExceededError') }, delete: async () => {} },
    notify: (notice) => notices.push(notice),
    fetch: async () => { throw new TypeError('Failed to fetch') },
  })
  const response = await queue.fetch(`${SERVER}/upload-scan`, { method: 'POST', body: 'x' })
  assert.equal(response.status, 507)
  assert.equal(isQueuedOffline(response), false, 'the caller reads the failure it is')
  assert.equal(notices[0]?.type, 'offline-queue-failed')
})

// ── The replay ───────────────────────────────────────────────────────────────────────────────────

test('a flush sends what is queued, oldest first, and deletes what the server took', async () => {
  const r = rig()
  await upload(r, 'first')
  r.clock.now += 1
  await r.queue.fetch(`${SERVER}/upload-summary`, { method: 'POST', body: 'second' })
  r.sent.length = 0
  r.notices.length = 0
  r.network.mode = 200
  await r.queue.flush()
  assert.deepEqual(r.sent.map((s) => s.body), ['first', 'second'])
  assert.equal(r.store.rows.size, 0)
  assert.deepEqual(r.notices.map((n) => n.type), ['offline-flushed', 'offline-flushed'])
  assert.ok(!r.sent[0]!.headers.has('authorization'), 'the replay carries no stored token')
})

test('a network failure during a flush ends the pass and counts nothing', async () => {
  const r = rig()
  await upload(r, 'a')
  r.clock.now += 1
  await upload(r, 'b')
  r.sent.length = 0
  await r.queue.flush()
  assert.equal(r.sent.length, 1, 'the pass stops at the first one that cannot be sent')
  assert.deepEqual([...r.store.rows.values()].map((row) => row.attempts), [0, 0])
})

test('a retriable status keeps the body and counts an attempt; the fifth gives up and says so', async () => {
  const r = rig()
  await upload(r)
  r.network.mode = 503
  for (let i = 1; i < MAX_FLUSH_ATTEMPTS; i++) {
    await r.queue.flush()
    assert.equal([...r.store.rows.values()][0]?.attempts, i)
    assert.equal([...r.store.rows.values()][0]?.lastError, '503')
  }
  r.notices.length = 0
  await r.queue.flush()
  assert.equal(r.store.rows.size, 0)
  assert.equal(r.notices[0]?.type, 'offline-gave-up')
  for (const status of [401, 403, 408, 429]) {
    const again = rig()
    await upload(again)
    again.network.mode = status
    await again.queue.flush()
    assert.equal(again.store.rows.size, 1, `${status} keeps the body`)
  }
})

test('a permanent refusal drops the body under its own notice, not as a delivery', async () => {
  const r = rig()
  await upload(r)
  r.notices.length = 0
  r.network.mode = 413
  await r.queue.flush()
  assert.equal(r.store.rows.size, 0)
  assert.equal(r.notices[0]?.type, 'offline-rejected')
  assert.match((r.notices[0] as { message: string }).message, /too large/)
})

test('one flush at a time: a flush asked for during a pass waits for it', async () => {
  const r = rig()
  await upload(r)
  r.sent.length = 0
  r.network.mode = 200
  await Promise.all([r.queue.flush(), r.queue.flush()])
  assert.equal(r.sent.length, 1, 'the request is replayed once')
})

// ── The bounds ───────────────────────────────────────────────────────────────────────────────────

test('over the item cap, the oldest are dropped first, and the notice names them by kind', async () => {
  const r = rig()
  for (let i = 0; i <= MAX_QUEUE_ITEMS; i++) {
    r.clock.now += 1
    await upload(r, `scan-${i}`)
  }
  assert.equal(r.store.rows.size, MAX_QUEUE_ITEMS, 'one write past the cap made room for itself')
  const dropped = r.notices.filter((n) => n.type === 'offline-dropped')
  assert.equal(dropped.length, 1)
  assert.equal((dropped[0] as { message: string }).message, 'Dropped 1 scan upload — the offline queue is full.')
  const bodies = [...r.store.rows.values()].map((row) => new TextDecoder().decode(row.body))
  assert.ok(!bodies.includes('scan-0'), 'the oldest went')
})

test('a write older than a day is dropped when the next one is queued', async () => {
  const r = rig()
  await upload(r, 'old')
  r.clock.now += MAX_QUEUE_AGE_MS + 1
  await upload(r, 'new')
  assert.deepEqual([...r.store.rows.values()].map((row) => new TextDecoder().decode(row.body)), ['new'])
  assert.equal((r.notices.find((n) => n.type === 'offline-dropped') as { expired: number }).expired, 1)
})

test('kinds read from ids and named in a notice as the worker names them', () => {
  assert.equal(queueKindOfId('1700000000000-scan-abc'), 'scan')
  assert.equal(queueKindOfId('1700000000000-abc'), 'other', 'an id from before kinds were recorded')
  assert.equal(queueKindOfId('1700000000000-nonsense-abc'), 'other')
  assert.equal(describeQueueKinds(['1-scan-a', '2-scan-b', '3-summary-c']), '2 scan uploads and 1 scan summary')
})

// ── The install ──────────────────────────────────────────────────────────────────────────────────

test('source shape: the scanner installs it in a native shell only, after registerPWA, and flushes only as the writer', () => {
  const main = read('src/main.ts')
  const pwa = main.indexOf('registerPWA({ flushQueue: !readOnlyScanner })')
  const install = main.indexOf('if (isNativeShell()) installPageUploadQueue({ flush: !readOnlyScanner, notify: showQueueNotice })')
  assert.ok(pwa > 0 && install > pwa)
  assert.equal(main.split('installPageUploadQueue(').length, 2, 'installed once')
})
