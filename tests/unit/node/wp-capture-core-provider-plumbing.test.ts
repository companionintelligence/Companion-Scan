/**
 * Wave 14, ticket 0004 (F-40: FN-031; FN-046): the frame plumbing both web providers share, src/ar/provider-plumbing.ts,
 * and the bounded wait for the 8th Wall engine.
 *
 * The helpers are tested on their own, then through the real provider classes, so the strings a caller matches on
 * ("Capture already pending", "Timed out waiting for camera frame", "No AR session. Start the scan first.") are held where
 * they are produced.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-provider-plumbing.test.ts
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPTURE_PENDING_MESSAGE,
  CAPTURE_TIMEOUT_MESSAGE,
  HiddenSpell,
  capturePoseTooOld,
  failCaptures,
  queueCapture,
  settleCaptures,
  withPoseAge,
  type PendingCapture,
} from '../../../src/ar/provider-plumbing.ts'
import { MAX_CAPTURE_POSE_AGE_MS } from '../../../src/ar/frame-epoch.ts'
import { EighthWallProvider, createEighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import type { RawFrame } from '../../../src/ar/provider.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

const FRAME: RawFrame = {
  pixels: new Uint8ClampedArray(4),
  width: 1,
  height: 1,
  pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  timestamp: 0,
}

/**
 * Runs `body` with a stand-in `window`: an EventTarget, for `xrloaded`, with the `location` the 8th Wall provider's
 * constructor reads its camera fit from.
 */
async function withWindow(body: (win: EventTarget) => Promise<void>): Promise<void> {
  const g = globalThis as unknown as { window?: unknown }
  const had = 'window' in g
  const saved = g.window
  const win = Object.assign(new EventTarget(), { location: { search: '' } })
  g.window = win
  try {
    await body(win)
  } finally {
    if (had) g.window = saved
    else delete g.window
  }
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (e) {
    return (e as Error).message
  }
  assert.fail('expected a rejection')
}

// ── The queue ────────────────────────────────────────────────────────────────

test('one capture at a time: a second is refused while the first waits, and the first is not disturbed', async () => {
  const queue: PendingCapture[] = []
  const first = queueCapture(queue, 1000)
  assert.equal(await rejection(queueCapture(queue, 1000)), CAPTURE_PENDING_MESSAGE)
  assert.equal(queue.length, 1)
  settleCaptures(queue, FRAME)
  assert.equal(await first, FRAME)
  assert.equal(queue.length, 0)
})

test('a capture nobody answers fails with the timeout message and leaves the queue', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const queue: PendingCapture[] = []
  const waiting = queueCapture(queue, 4000)
  t.mock.timers.tick(3999)
  assert.equal(queue.length, 1)
  t.mock.timers.tick(1)
  assert.equal(await rejection(waiting), CAPTURE_TIMEOUT_MESSAGE)
  assert.equal(queue.length, 0, 'a later capture is not refused as pending')
})

test('failCaptures refuses every waiting capture with the caller\'s words and clears their timers', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const queue: PendingCapture[] = []
  const a = queueCapture(queue, 4000)
  // A second waiting call, as the providers' own tests put one there.
  const b = new Promise<RawFrame>((resolve, reject) => queue.push({ resolve, reject, timeout: setTimeout(() => reject(new Error('timer')), 4000) }))
  failCaptures(queue, 'Tracking lost — hold still, then tap again')
  assert.equal(queue.length, 0)
  assert.equal(await rejection(a), 'Tracking lost — hold still, then tap again')
  assert.equal(await rejection(b), 'Tracking lost — hold still, then tap again')
  t.mock.timers.tick(10_000) // no timer is left to fire a second rejection
})

// ── The stale pose, the pose age, a hidden spell ─────────────────────────────

test('a pose is too old to stamp once it is past the bound, and never before the first', () => {
  assert.equal(capturePoseTooOld(null, 1e9), false)
  assert.equal(capturePoseTooOld(1000, 1000 + MAX_CAPTURE_POSE_AGE_MS), false, 'exactly the bound is not past it')
  assert.equal(capturePoseTooOld(1000, 1000 + MAX_CAPTURE_POSE_AGE_MS + 1), true)
  assert.equal(MAX_CAPTURE_POSE_AGE_MS, 200)
})

test('poseAgeMs is added from the last frame, never negative, and left out before there is a pose or a frame', () => {
  const diag = { status: 'NORMAL', poseJumps: 0 }
  assert.deepEqual(withPoseAge(diag, 1000, 1250), { status: 'NORMAL', poseJumps: 0, poseAgeMs: 250 })
  assert.deepEqual(withPoseAge(diag, 1300, 1250), { status: 'NORMAL', poseJumps: 0, poseAgeMs: 0 })
  assert.deepEqual(withPoseAge(diag, null, 1250), diag)
  assert.deepEqual(withPoseAge(diag, 1000, null), diag)
  assert.equal('poseAgeMs' in withPoseAge(diag, null, null), false)
})

test('a hidden spell: a return says how long it was away, a second hide keeps the first time, a first look is no return', () => {
  const spell = new HiddenSpell()
  spell.begin(false, 0)
  assert.equal(spell.note(false, 10), null, 'in view and still in view')
  assert.equal(spell.note(true, 100), null)
  assert.equal(spell.note(true, 400), null, 'hidden again while hidden')
  assert.deepEqual(spell.note(false, 1100), { awayMs: 1000 }, 'counted from the first hide')
  assert.equal(spell.note(false, 1200), null)

  spell.begin(true, 5000)
  assert.deepEqual(spell.note(false, 5300), { awayMs: 300 }, 'a spell already hidden at the start counts from the start')
  spell.note(true, 6000)
  spell.reset()
  assert.equal(spell.hidden, false)
  assert.equal(spell.hiddenAtMs, null)
  assert.equal(spell.note(false, 7000), null, 'nothing to return from after a reset')
})

// ── Through the providers ────────────────────────────────────────────────────

test('8th Wall: the same refusals, worded as before', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withWindow(async () => {
    const provider = new EighthWallProvider()
    const waiting = provider.captureFrame(4000)
    assert.equal(await rejection(provider.captureFrame()), 'Capture already pending')
    t.mock.timers.tick(4000)
    assert.equal(await rejection(waiting), 'Timed out waiting for camera frame')
  })
})

test('WebXR: no session is refused at once, but a capture already waiting is what a second call is told about first', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const provider = new WebXRProvider()
  assert.equal(await rejection(provider.captureFrame()), 'No AR session. Start the scan first.')
  const internals = provider as unknown as { session: unknown; captureQueue: PendingCapture[] }
  internals.session = {}
  const waiting = provider.captureFrame(4000)
  internals.session = null
  assert.equal(await rejection(provider.captureFrame()), 'Capture already pending', 'the order the two checks always had')
  t.mock.timers.tick(4000)
  assert.equal(await rejection(waiting), 'Timed out waiting for camera frame')
  assert.equal(internals.captureQueue.length, 0)
})

test('the queue and its words are declared once in the web providers\' files, and both use the shared helpers', () => {
  // src/ar/native.ts (the native-apps session's file) keeps its own copy of the two refusals: listed for that session.
  const declarations = readdirSync(resolve(ROOT, 'src/ar'))
    .filter((name) => name.endsWith('.ts') && !name.startsWith('native'))
    .filter((name) => /'Capture already pending'/.test(read(`src/ar/${name}`)))
  assert.deepEqual(declarations, ['provider-plumbing.ts'])
  for (const path of ['src/ar/eighthwall.ts', 'src/ar/webxr.ts']) {
    const src = read(path)
    assert.doesNotMatch(src, /'Timed out waiting for camera frame'/, path)
    assert.match(src, /queueCapture\(this\.captureQueue, timeoutMs\)/, path)
    assert.match(src, /withPoseAge\(this\._epochs\.diagnostics\(\), this\._poseAtMs, this\._frameMs\)/, path)
    assert.match(src, /capturePoseTooOld\(this\._poseAtMs/, path)
    assert.match(src, /new HiddenSpell\(\)/, path)
    assert.doesNotMatch(src, /_hiddenAtMs|_pageHidden|_sessionHidden/, path)
  }
  // What still differs stays with its provider: 8th Wall calls a pose old only while it is being held over.
  assert.match(read('src/ar/eighthwall.ts'), /return this\._poseHeld && capturePoseTooOld\(this\._poseAtMs, nowMs\)/)
})

// ── FN-046: the engine wait is bounded ──────────────────────────────────────

test('createEighthWallProvider waits for xrloaded, and gives up with start()\'s message when it never comes', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withWindow(async (win) => {
    assert.equal(typeof (globalThis as { XR8?: unknown }).XR8, 'undefined')
    const gaveUp = createEighthWallProvider(1500)
    t.mock.timers.tick(1500)
    assert.equal(await rejection(gaveUp), '8th Wall engine (/xr.js) did not load within 1500 ms — the AR camera cannot start')

    const defaults = createEighthWallProvider()
    t.mock.timers.tick(10_000)
    assert.match(await rejection(defaults), /did not load within 10000 ms/, 'the same 10 s start() allows')

    const arrives = createEighthWallProvider(1500)
    win.dispatchEvent(new Event('xrloaded'))
    assert.ok((await arrives) instanceof EighthWallProvider)
    t.mock.timers.tick(5000) // the timer was cleared: nothing fires late
  })
})

test('start() and createEighthWallProvider() wait through one bounded helper', () => {
  const src = read('src/ar/eighthwall.ts')
  assert.equal(src.match(/addEventListener\('xrloaded'/g)?.length, 1)
  assert.match(src, /typeof XR8 === 'undefined' && !\(await engineLoaded\(XR_LOAD_TIMEOUT_MS\)\)\) throw engineDidNotLoad\(XR_LOAD_TIMEOUT_MS\)/)
  assert.match(src, /export async function createEighthWallProvider\(timeoutMs: number = XR_LOAD_TIMEOUT_MS\)/)
})
