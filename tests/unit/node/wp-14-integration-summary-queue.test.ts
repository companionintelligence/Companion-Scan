/**
 * Wave 14 integration: the session summary's upload log tells a queued upload from a delivered one.
 *
 * With the offline queue (public/sw.js, or src/page-upload-queue.ts in the apps), a POST /upload-summary made
 * offline is answered 202 by the queue, with X-Companion-Queued-Offline: 1 and no server body. uploadSummary read
 * it as delivered and logged "Uploaded to server: undefined". It now says the summary is queued.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-integration-summary-queue.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { exportSessionSummary } from '../../../src/export/summary.ts'
import { DetectionStore } from '../../../src/scene/store.ts'
import { QUEUED_OFFLINE_HEADER } from '../../../src/shared/offline-queue.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'

/** Runs the summary export against stand-ins for the document and fetch, and returns what it logged. */
async function logsFor(response: () => Response): Promise<string[]> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { document: g['document'], fetch: g['fetch'], create: URL.createObjectURL, revoke: URL.revokeObjectURL, log: console.log }
  const lines: string[] = []
  g['document'] = { createElement: () => ({ click() {}, set href(_v: string) {}, set download(_v: string) {} }) }
  g['fetch'] = async () => response()
  URL.createObjectURL = () => 'blob:summary'
  URL.revokeObjectURL = () => {}
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    const pointCloud = {
      count: 10,
      boundingBox: () => ({ min: { x: -2, y: 0, z: -4 }, max: { x: 2, y: 2, z: 0 } }),
    } as unknown as PointCloud
    await exportSessionSummary({ store: new DetectionStore(), pointCloud, poseHistory: [], captureCount: 0 })
    // uploadSummary runs after the download; give its promise a turn to settle.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    g['document'] = saved.document
    g['fetch'] = saved.fetch
    URL.createObjectURL = saved.create
    URL.revokeObjectURL = saved.revoke
    console.log = saved.log
  }
  return lines.filter((line) => line.startsWith('[summary]'))
}

test('a summary the offline queue stored is logged as queued, not as uploaded', async () => {
  // The body both queues answer with (public/sw.js, src/page-upload-queue.ts): JSON, and no filename in it.
  const queued = { ok: false, queuedOffline: true, queueId: 'q-1', message: 'Saved offline' }
  const lines = await logsFor(() => new Response(JSON.stringify(queued), {
    status: 202,
    headers: { 'Content-Type': 'application/json', [QUEUED_OFFLINE_HEADER]: '1' },
  }))
  assert.ok(lines.some((line) => /queued/.test(line)), lines.join('\n'))
  assert.ok(!lines.some((line) => /Uploaded to server/.test(line)), lines.join('\n'))
})

test('a summary the server saved is logged with the filename it saved', async () => {
  const lines = await logsFor(() => Response.json({ filename: 'summary-1.md' }))
  assert.ok(lines.some((line) => line.includes('Uploaded to server: summary-1.md')), lines.join('\n'))
})
