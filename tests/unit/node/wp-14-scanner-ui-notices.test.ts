/**
 * Wave 14, ticket 0003 (scanner-ui), FN-010 and FN-011: what the page says about the offline queue
 * (src/ui/queue-notice.ts), for the service worker's messages and the page queue's alike.
 *
 *  - FN-011: a queued write is named by its kind. A keyframe, a Place change or a processing request is not
 *    "a scan queued for sync", and only a scan upload writes the scan's autosave line.
 *  - FN-010: the status line is written through writeStatus(), so a loss holds the line and a queued notice
 *    does not stomp a capture result that holds it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-scanner-ui-notices.test.ts
 * Also run by npm run test:wave.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QUEUE_KIND_NAMES } from '../../../src/page-upload-queue.ts'
import { noticeKind, queueNoticeLines, showQueueNotice } from '../../../src/ui/queue-notice.ts'
import { statusIsHeld, writeStatus } from '../../../src/ui/status-line.ts'

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

test('a queued write is named by its kind, and only a scan upload touches the autosave line', () => {
  const scan = queueNoticeLines({ type: 'offline-queued', kind: 'scan' })!
  assert.match(scan.status!, /^Offline — scan saved/)
  assert.equal(scan.autosave, 'Saved offline - sync pending')
  for (const [kind, words] of [
    ['session', /camera frames/],
    ['place', /Place change/],
    ['process', /processing request held/],
    ['summary', /summary saved/],
    ['world', /editor change/],
  ] as const) {
    const lines = queueNoticeLines({ type: 'offline-queued', kind })!
    assert.match(lines.status!, words, kind)
    assert.doesNotMatch(lines.status!, /scan saved|scan queued/, `${kind} is not called a scan`)
    assert.equal(lines.autosave, undefined, `${kind} leaves the scan's autosave line alone`)
  }
})

test('every kind the queues know has its own words', () => {
  const said = new Set<string>()
  for (const kind of Object.keys(QUEUE_KIND_NAMES)) said.add(queueNoticeLines({ type: 'offline-queued', kind })!.status!)
  assert.equal(said.size, Object.keys(QUEUE_KIND_NAMES).length)
})

test('a message from an older worker has no kind field: the kind comes from its queue id', () => {
  assert.equal(noticeKind({ type: 'offline-queued', queueId: '1700000000000-session-ab12' }), 'session')
  assert.equal(noticeKind({ type: 'offline-queued', queueId: '1700000000000-ab12' }), 'other')
  assert.equal(noticeKind({ type: 'offline-queued', kind: 'bogus', queueId: '1-scan-x' }), 'scan', 'an unknown kind field falls back to the id')
})

test('a loss holds the status line; a queued or synced write does not', () => {
  for (const type of ['offline-queue-failed', 'offline-dropped', 'offline-gave-up', 'offline-rejected']) {
    assert.equal(queueNoticeLines({ type, message: 'm' })!.priority, 'sticky', type)
  }
  assert.equal(queueNoticeLines({ type: 'offline-queued', kind: 'scan' })!.priority, 'normal')
  assert.equal(queueNoticeLines({ type: 'offline-flushed', kind: 'scan', status: 200 })!.priority, 'normal')
  assert.equal(queueNoticeLines({ type: 'offline-flushed', status: 403 })!.priority, 'sticky', 'an old worker\'s rejection through offline-flushed')
  assert.equal(queueNoticeLines({ type: 'something-else' }), null)
})

test('showQueueNotice writes through the status line\'s hold (FN-010)', () => {
  const status = { textContent: '' as string | null }
  const autosave = { textContent: '' as string | null }
  const g = globalThis as unknown as Record<string, unknown>
  const before = g['document']
  g['document'] = { getElementById: (id: string) => (id === 'status-text' ? status : id === 'autosave-status' ? autosave : null) }
  try {
    // A capture result holds the line: a queued autosave does not replace it, but its own line is written.
    writeStatus(status, '✓ 3 objects detected', 'sticky')
    showQueueNotice({ type: 'offline-queued', kind: 'scan', queueId: '1-scan-a' })
    assert.equal(status.textContent, '✓ 3 objects detected')
    assert.equal(autosave.textContent, 'Saved offline - sync pending')
    // A loss is an event worth reading: it takes the line, and holds it.
    showQueueNotice({ type: 'offline-gave-up', message: 'Gave up on a queued upload after 5 attempts.' })
    assert.equal(status.textContent, 'Gave up on a queued upload after 5 attempts.')
    assert.equal(statusIsHeld(status), true)
  } finally {
    g['document'] = before
  }
})

test('source shape: src/pwa.ts shows the worker\'s messages through showQueueNotice, and writes #status-text nowhere itself', () => {
  const pwa = read('src/pwa.ts')
  assert.match(pwa, /import \{ showQueueNotice, type QueueMessage \} from '\.\/ui\/queue-notice\.ts'/)
  assert.match(pwa, /showQueueNotice\(data\)/)
  assert.doesNotMatch(pwa, /textContent|getElementById\('status-text'\)/, 'no direct write')
})

test('source shape: no scanner writer sets #status-text.textContent directly (FN-010)', () => {
  const main = read('src/main.ts')
  assert.doesNotMatch(main, /statusEl\.textContent =|el\.textContent = `Error:/, 'the insecure line and main().catch go through the writer')
  assert.match(main, /setupStatusOverlay\(\)\.setStatus\(`Error: \$\{e instanceof Error \? e\.message : String\(e\)\}`, 'sticky'\)/)
  assert.match(main, /setupStatusOverlay\(\)\.setStatus\(`✕ Needs a secure link\\n• Ask for the https:\/\/ link`, 'sticky'\)/)
})

test('source shape: a queued /process-scan says it is held, and is not read as a result (FN-011)', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('async function requestServerProcessing(')
  const body = main.slice(start, main.indexOf('\n}\n', start))
  const queued = body.indexOf('if (isQueuedOffline(resp)) {')
  const parsed = body.indexOf('await resp.json()')
  assert.ok(queued > 0 && parsed > queued, 'the queued answer is checked before the body is read as a result')
  assert.match(body.slice(queued, parsed), /processing request held/)
})
