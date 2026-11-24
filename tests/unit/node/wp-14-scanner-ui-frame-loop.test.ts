/**
 * Wave 14, ticket 0003 (scanner-ui), F-13: the detection pins are drawn on every AR runtime.
 *
 * The pins used to be positioned only by an 8th Wall camera pipeline module. src/main.ts now runs a frame loop
 * (src/ui/frame-loop.ts) once AR is running, on every runtime, and AROverlay.frame() draws the pins from the
 * provider's pose unless the 8th Wall pipeline drew them within PIPELINE_GRACE_MS.
 *
 * AROverlay declares parameter properties, which Node's strip-only loader cannot run, so a load hook transforms
 * src/ui/overlay.ts (as tests/unit/node/wp-ar-run-views.test.ts does) and a small stand-in document is installed.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-scanner-ui-frame-loop.test.ts
 * Also run by npm run test:wave.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { PIPELINE_GRACE_MS, pipelineDrewRecently, startFrameLoop } from '../../../src/ui/frame-loop.ts'

/** How the load hook compiles a file Node cannot strip: Node 26's stripTypeScriptTypes has no transform mode. */
const TRANSPILE = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }

// src/ui/overlay.ts uses parameter properties, which Node's type stripping cannot run, so the hook compiles it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const missing = (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
      if (missing && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
  load(url, context, nextLoad) {
    if (/\/src\/ui\/overlay\.ts$/.test(url)) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      return { format: 'module', source: ts.transpileModule(source, { fileName: url, compilerOptions: TRANSPILE }).outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

// ── The loop ─────────────────────────────────────────────────────────────────────────────────────

/** A scheduler that runs a frame only when the test says so. */
function manualFrames() {
  let pending: ((timeMs: number) => void) | null = null
  let cancelled = 0
  return {
    schedule: (callback: (timeMs: number) => void) => { pending = callback; return 1 },
    cancel: () => { cancelled++; pending = null },
    step(timeMs: number) {
      const run = pending
      pending = null
      run?.(timeMs)
    },
    get waiting() { return pending !== null },
    get cancelled() { return cancelled },
  }
}

test('the loop ticks once per frame, with the frame time, until it is stopped', () => {
  const frames = manualFrames()
  const ticks: number[] = []
  const stop = startFrameLoop((t) => ticks.push(t), frames.schedule, frames.cancel)
  frames.step(16)
  frames.step(33)
  assert.deepEqual(ticks, [16, 33])
  stop()
  assert.equal(frames.cancelled, 1, 'the pending frame is cancelled')
  frames.step(50)
  assert.deepEqual(ticks, [16, 33], 'nothing runs after a stop')
  stop()
  assert.equal(frames.cancelled, 1, 'a second stop does nothing')
})

test('a tick that throws is logged and the loop goes on', () => {
  const frames = manualFrames()
  let calls = 0
  const warn = console.warn
  console.warn = () => {}
  try {
    startFrameLoop(() => { calls++; throw new Error('bad frame') }, frames.schedule, frames.cancel)
    frames.step(16)
    frames.step(33)
  } finally {
    console.warn = warn
  }
  assert.equal(calls, 2)
  assert.ok(frames.waiting, 'the next frame is still asked for')
})

test('the pipeline grace: a pipeline draw in the last PIPELINE_GRACE_MS keeps the frame', () => {
  assert.equal(pipelineDrewRecently(null, 1_000), false, 'no pipeline: the loop draws')
  assert.equal(pipelineDrewRecently(1_000, 1_000), true)
  assert.equal(pipelineDrewRecently(1_000, 1_000 + PIPELINE_GRACE_MS - 1), true)
  assert.equal(pipelineDrewRecently(1_000, 1_000 + PIPELINE_GRACE_MS), false, 'a stopped pipeline hands over')
  assert.equal(pipelineDrewRecently(2_000, 1_000), false, 'a clock that went backwards hands over')
})

// ── The overlay, on a runtime with no pipeline module ────────────────────────────────────────────

const registry = new Map<string, El>()

class El {
  readonly tag: string
  className = ''
  textContent = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  children: El[] = []
  parent: El | null = null
  private _id = ''
  readonly classList = {
    add: (name: string) => { this.className = `${this.className} ${name}`.trim() },
    remove: (name: string) => { this.className = this.className.split(' ').filter((n) => n !== name).join(' ') },
    contains: (name: string) => this.className.split(' ').includes(name),
  }
  constructor(tag: string) { this.tag = tag }
  get id(): string { return this._id }
  set id(value: string) { this._id = value; registry.set(value, this) }
  append(...nodes: El[]): void { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  appendChild(node: El): El { this.append(node); return node }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this) }
  addEventListener(): void {}
  querySelector(selector: string): El | null {
    const want = selector.startsWith('.') ? selector.slice(1) : selector
    const walk = (node: El): El | null => {
      for (const child of node.children) {
        if (child.className.split(' ').includes(want)) return child
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this)
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 800 } }
}

function installDocument(): void {
  registry.clear()
  for (const id of ['ar-overlay', 'capture-btn', 'camerafeed']) new El('div').id = id
  const g = globalThis as unknown as Record<string, unknown>
  g['document'] = { getElementById: (id: string) => registry.get(id) ?? null, createElement: (tag: string) => new El(tag) }
  g['window'] = { innerWidth: 400, innerHeight: 800 }
}

const { DetectionStore } = await import('../../../src/scene/store.ts')
const { AROverlay } = await import('../../../src/ui/overlay.ts')

/** A WebXR or native provider: tracking, at the origin, looking down -z. */
const provider = {
  isTracking: () => true,
  getPose: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  getCameraFovY: () => 60,
  getCameraAspect: () => 0.5,
}

function lampAhead() {
  return {
    label: 'lamp',
    confidence: 0.9,
    description: 'a lamp',
    bbox: [0.1, 0.1, 0.4, 0.4],
    worldPos: { x: 0, y: 0, z: -2 },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1_000,
  }
}

const pins = () => registry.get('ar-overlay')!.children.filter((child) => child.className.includes('ar-pin-wrap'))

test('frame(): on a runtime with no pipeline module, the overlay places a pin from the provider\'s pose', async () => {
  installDocument()
  const store = new DetectionStore()
  const overlay = new AROverlay(store, false, provider as never)
  store.startArRun('run-A')
  await store.upsert(new Map([['lamp:0.0,0.0,-2.0', lampAhead() as never]]), new Map())
  assert.match(pins()[0]?.style['cssText'] ?? '', /display:none/, 'a pin is built hidden')
  assert.equal(pins()[0]?.style['display'], undefined, 'and nothing has placed it yet')
  overlay.frame(10_000)
  assert.equal(pins()[0]?.style['display'], 'block', 'the frame loop placed it')
  assert.match(pins()[0]?.querySelector('.ar-pin-dist')?.textContent ?? '', /2\.0 m/, 'with its live distance')
})

test('frame(): an empty scan costs nothing per frame', async () => {
  installDocument()
  const store = new DetectionStore()
  let poses = 0
  const counting = { ...provider, getPose: () => { poses++; return provider.getPose() } }
  const overlay = new AROverlay(store, false, counting as never)
  overlay.frame(10_000)
  assert.equal(poses, 0, 'no pin, so no camera is built')
})

test('source shape: main.ts runs the loop once AR is running, for every runtime', () => {
  const main = read('src/main.ts')
  const started = main.indexOf("document.getElementById('start-screen')?.remove()")
  const loop = main.indexOf('startFrameLoop(() => arOverlay.frame())')
  assert.ok(started > 0 && loop > started, 'after the start screen is gone, which is after provider.start() resolved')
  assert.equal(main.split('startFrameLoop(').length, 2, 'started once')
  assert.doesNotMatch(main.slice(loop - 200, loop), /use8thWall/, 'not behind a runtime check')
})

test('source shape: the 8th Wall pipeline still draws on 8th Wall, and notes when it did', () => {
  const overlay = read('src/ui/overlay.ts')
  assert.match(overlay, /onRender: \(\) => \{\n\s+self\._lastPipelineMs = performance\.now\(\)/)
  assert.match(overlay, /if \(this\.pinMap\.size === 0 \|\| pipelineDrewRecently\(this\._lastPipelineMs, nowMs\)\) return/)
  assert.doesNotMatch(overlay, /setStatus\(|setProgress\(/, 'the overlay writes no status line (FN-010)')
  assert.match(overlay, /more than 20 m away/, 'FN-018: the comment says the distance the code uses')
  assert.match(overlay, /const MAX_PIN_DISTANCE_M = 20/)
})
