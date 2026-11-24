/**
 * Wave 14, ticket 0004 (F-40: FN-034, FN-037): the calibration's interface plumbing, each piece in one home.
 *
 *  - src/ar/canvas-taps.ts: one tap on the AR canvas, as the calibration card and the re-anchor banner both read it.
 *  - src/ar/drift-tap.ts, built on the calibration's own sampler (src/ar/calibration-taps.ts), with `?tap=` only when the
 *    host passes its query string.
 *  - src/ar/reference-photo-view.ts: loading a stored photo into a panel and placing its crosshair, for the card's photo
 *    and the return visit's two.
 *  - src/scene/dispose.ts: the three.js dispose traversal the modal and the ghosts share.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-ui-plumbing.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { fractionOfBox, listenForCanvasTaps } from '../../../src/ar/canvas-taps.ts'
import { loadReferencePhotoInto, placeReferenceCrosshair } from '../../../src/ar/reference-photo-view.ts'
import { referenceCrosshairPixels } from '../../../src/ar/reference-photo.ts'
import { disposeObject3D } from '../../../src/scene/dispose.ts'
import { driftTapReader } from '../../../src/ar/drift-tap.ts'
import type { HitBurstFrame, HitResult, Pose } from '../../../src/ar/provider.ts'
import type { TapProvider } from '../../../src/ar/tap-sampling.ts'
import type { CalibrationReferencePhoto } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

// ── Canvas taps ──────────────────────────────────────────────────────────────

class FakeCanvas extends EventTarget {
  added: Array<{ type: string; options: unknown }> = []
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    this.added.push({ type, options })
    super.addEventListener(type, listener, options)
  }
  getBoundingClientRect() {
    return { left: 100, top: 50, width: 400, height: 200 }
  }
}

const touch = (touches: Array<{ clientX: number; clientY: number }>): Event => Object.assign(new Event('touchstart'), { touches })
const pointer = (pointerType: string, clientX: number, clientY: number): Event =>
  Object.assign(new Event('pointerdown'), { pointerType, clientX, clientY })

test('one finger is one tap: the touchstart counts and the pointerdown the same tap fires does not', () => {
  const canvas = new FakeCanvas()
  const taps: Array<[number, number]> = []
  listenForCanvasTaps(canvas, (x, y) => taps.push([x, y]))
  canvas.dispatchEvent(touch([{ clientX: 300, clientY: 150 }]))
  canvas.dispatchEvent(pointer('touch', 300, 150))
  assert.deepEqual(taps, [[300, 150]])
  assert.deepEqual(canvas.added.find((a) => a.type === 'touchstart')?.options, { passive: true }, 'never blocks a scroll or a pinch')
})

test('two fingers are a gesture, not a tap; a mouse or a controller ray is a tap', () => {
  const canvas = new FakeCanvas()
  const taps: Array<[number, number]> = []
  listenForCanvasTaps(canvas, (x, y) => taps.push([x, y]))
  canvas.dispatchEvent(touch([{ clientX: 1, clientY: 1 }, { clientX: 2, clientY: 2 }]))
  canvas.dispatchEvent(touch([]))
  canvas.dispatchEvent(pointer('mouse', 120, 60))
  canvas.dispatchEvent(pointer('pen', 130, 70))
  assert.deepEqual(taps, [[120, 60], [130, 70]])
})

test('the remover takes both listeners off', () => {
  const canvas = new FakeCanvas()
  let taps = 0
  const stop = listenForCanvasTaps(canvas, () => { taps += 1 })
  stop()
  canvas.dispatchEvent(touch([{ clientX: 1, clientY: 1 }]))
  canvas.dispatchEvent(pointer('mouse', 1, 1))
  assert.equal(taps, 0)
})

test('a tap is read as a fraction of the canvas box', () => {
  assert.deepEqual(fractionOfBox(new FakeCanvas(), 300, 150), { x: 0.5, y: 0.5 })
  assert.deepEqual(fractionOfBox(new FakeCanvas(), 100, 250), { x: 0, y: 1 })
})

test('the card and the banner read a tap through it, and the card keeps its own guards and removes its listeners', () => {
  const card = read('src/ar/project-calibration.ts')
  const banner = read('src/ar/reanchor-banner.ts')
  for (const [path, src] of [['project-calibration', card], ['reanchor-banner', banner]] as const) {
    assert.doesNotMatch(src, /addEventListener\('touchstart'/, path)
    assert.doesNotMatch(src, /addEventListener\('pointerdown'/, path)
    assert.match(src, /listenForCanvasTaps\(/, path)
  }
  assert.match(card, /if \(tapInFlight \|\| !options\.provider\.isTracking\(\)\) return/)
  assert.match(card, /stopCanvasTaps\(\)/)
})

// ── The drift reader ─────────────────────────────────────────────────────────

const CAMERA: Pose = { position: { x: 0, y: 0.6, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
const hitAt = (z: number): HitResult => ({ position: { x: 0, y: 0, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: Math.hypot(0.6, z) })

function burstProvider(calls: { burst: number; single: number }): TapProvider {
  return {
    hitTest: () => null,
    getPose: () => CAMERA,
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.5625,
    trackingStatus: () => 'NORMAL',
    hitTestBurstAsync: async () => {
      calls.burst += 1
      const frames: HitBurstFrame[] = Array.from({ length: 10 }, () => ({ hit: hitAt(-1.8), status: 'NORMAL' as const, pose: CAMERA }))
      return { frames }
    },
  }
}

test('the drift reader is the calibration\'s sampler: a burst by default, whatever the address says', async () => {
  const calls = { burst: 0, single: 0 }
  const read1 = driftTapReader({ provider: burstProvider(calls), hitTest: async () => { calls.single += 1; return hitAt(-1.8) }, ground: () => null })
  const result = await read1(0.5, 0.7)
  assert.equal(result.ok, true)
  assert.deepEqual(calls, { burst: 1, single: 0 })
})

test('given the page\'s query string, `?tap=single` reaches the drift check as it reaches the calibration', async () => {
  const calls = { burst: 0, single: 0 }
  const reader = driftTapReader({
    provider: burstProvider(calls),
    hitTest: async () => { calls.single += 1; return hitAt(-1.8) },
    ground: () => null,
    search: '?tap=single',
  })
  await reader(0.5, 0.7)
  assert.equal(calls.burst, 0, 'one hit, no burst: DX2\'s single arm')
  assert.equal(calls.single, 1)
})

test('the drift reader reads the floor at each tap, as the sampler does', async () => {
  let reads = 0
  const reader = driftTapReader({ provider: burstProvider({ burst: 0, single: 0 }), hitTest: async () => null, ground: () => { reads += 1; return null } })
  await reader(0.5, 0.7)
  await reader(0.5, 0.7)
  assert.equal(reads, 2)
  assert.match(read('src/ar/drift-tap.ts'), /calibrationTapSampler\(\{/)
  assert.doesNotMatch(read('src/ar/drift-tap.ts'), /sampleTap\(/, 'no second construction of the reader')
})

// ── The reference photo ──────────────────────────────────────────────────────

const PHOTO = { localKey: 'k', url: '/media/p.jpg', tapPoint: { x: 0.25, y: 0.5 } } as unknown as CalibrationReferencePhoto

function panel() {
  const events: string[] = []
  const img = { src: '', onload: null as ((this: GlobalEventHandlers, ev: Event) => unknown) | null, clientWidth: 200, clientHeight: 100 }
  const kept: string[] = []
  return {
    events,
    img,
    kept,
    options: (load: (photo: CalibrationReferencePhoto) => Promise<string | null>, current = () => true) => ({
      photo: PHOTO,
      load,
      img,
      isCurrent: current,
      keepObjectUrl: (url: string) => { kept.push(url); events.push('kept') },
      reveal: () => events.push(`reveal:${img.src}`),
      placeCrosshair: () => events.push('cross'),
    }),
  }
}

function withRevokes(): { revoked: string[]; restore: () => void } {
  const revoked: string[] = []
  const original = URL.revokeObjectURL
  URL.revokeObjectURL = (url: string) => { revoked.push(url) }
  return { revoked, restore: () => { URL.revokeObjectURL = original } }
}

test('a photo that arrives in time is put in the element, shown, and then crosshaired, and again when it loads', async () => {
  const p = panel()
  assert.equal(await loadReferencePhotoInto(p.options(async () => 'blob:abc')), 'shown')
  assert.equal(p.img.src, 'blob:abc')
  assert.deepEqual(p.events, ['kept', 'reveal:blob:abc', 'cross'], 'shown before the crosshair: a hidden picture has no size')
  p.img.onload?.call({} as GlobalEventHandlers, new Event('load'))
  assert.deepEqual(p.events.slice(-1), ['cross'])
  assert.deepEqual(p.kept, ['blob:abc'])

  const q = panel()
  await loadReferencePhotoInto(q.options(async () => '/media/p.jpg'))
  assert.deepEqual(q.kept, [], 'a plain path is not ours to release')
})

test('a loader that throws, rejects or answers nothing is a failure, and shows nothing', async () => {
  for (const load of [
    () => { throw new Error('sync') },
    async () => { throw new Error('async') },
    async () => null,
  ]) {
    const p = panel()
    assert.equal(await loadReferencePhotoInto(p.options(load as (photo: CalibrationReferencePhoto) => Promise<string | null>)), 'failed')
    assert.equal(p.img.src, '')
    assert.deepEqual(p.events, [])
  }
})

test('a photo nobody wants any more is not shown, and its blob is released; so is one with no element to go in', async () => {
  const r = withRevokes()
  try {
    const p = panel()
    assert.equal(await loadReferencePhotoInto(p.options(async () => 'blob:late', () => false)), 'stale')
    assert.equal(p.img.src, '')
    assert.deepEqual(r.revoked, ['blob:late'])
    assert.equal(await loadReferencePhotoInto(p.options(async () => '/media/late.jpg', () => false)), 'stale')
    assert.deepEqual(r.revoked, ['blob:late'], 'a path is not revoked')

    const q = panel()
    assert.equal(await loadReferencePhotoInto({ ...q.options(async () => 'blob:nowhere'), img: null }), 'failed')
    assert.deepEqual(r.revoked, ['blob:late', 'blob:nowhere'])
    assert.equal(await loadReferencePhotoInto({ ...q.options(async () => 'blob:gone', () => false), img: null }), 'stale', 'stale before failed')
  } finally {
    r.restore()
  }
})

test('the crosshair is placed from where the picture sits in its figure', () => {
  const cross = { style: { left: '', top: '' } }
  const expected = referenceCrosshairPixels({ x: 0.25, y: 0.5 }, { width: 200, height: 100 })
  placeReferenceCrosshair(cross, { clientWidth: 200, clientHeight: 100 }, { x: 0.25, y: 0.5 })
  assert.deepEqual(cross.style, { left: `${expected.left}px`, top: `${expected.top}px` }, 'a picture that fills its figure')
  placeReferenceCrosshair(cross, { clientWidth: 200, clientHeight: 100, offsetLeft: 30, offsetTop: 4 }, { x: 0.25, y: 0.5 })
  assert.deepEqual(cross.style, { left: `${expected.left + 30}px`, top: `${expected.top + 4}px` }, 'a picture centred in a wider figure')
})

test('both panels load through it and keep their own words', () => {
  for (const path of ['src/ar/project-calibration.ts', 'src/ar/return-visit-aids.ts']) {
    const src = read(path)
    assert.match(src, /loadReferencePhotoInto\(\{/, path)
    assert.match(src, /placeReferenceCrosshair\(/, path)
    assert.doesNotMatch(src, /referenceCrosshairPixels\(/, path)
    assert.doesNotMatch(src, /\.onload = \(\) => positionCrosshair/, path)
  }
  assert.match(read('src/ar/project-calibration.ts'), /'The saved photo could not be loaded\. Place this marker from memory\.'/)
})

// ── Dispose ──────────────────────────────────────────────────────────────────

test('disposeObject3D frees every geometry and material under the root, arrays of materials included', () => {
  const disposed: string[] = []
  const geometry = (name: string) => Object.assign(new THREE.BufferGeometry(), { dispose: () => disposed.push(name) })
  const material = (name: string) => Object.assign(new THREE.MeshBasicMaterial(), { dispose: () => disposed.push(name) })
  const root = new THREE.Mesh(geometry('root-g'), material('root-m'))
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry('child-g'), [material('child-m1'), material('child-m2')]))
  root.add(group)
  disposeObject3D(root)
  assert.deepEqual(disposed.sort(), ['child-g', 'child-m1', 'child-m2', 'root-g', 'root-m'])
  assert.equal(root.children.length, 1, 'it frees, it does not detach')
})

test('the modal and the ghosts share it', () => {
  for (const path of ['src/ar/project-calibration.ts', 'src/ar/constellation-ghosts.ts']) {
    const src = read(path)
    assert.match(src, /import \{ disposeObject3D \} from '\.\.\/scene\/dispose\.ts'/, path)
    assert.doesNotMatch(src, /drawable\.geometry\?\.dispose\(\)/, path)
  }
})

// ── FN-039 ───────────────────────────────────────────────────────────────────

test('ReferencePhotoRole is declared once, by the store, and the calibration side takes it from there as a type', () => {
  const store = read('src/project/project-store.ts')
  const photo = read('src/ar/reference-photo.ts')
  assert.match(store, /export type ReferencePhotoRole = 'landmark' \| 'headingMarker' \| 'check1' \| 'check2' \| 'check3'/)
  assert.doesNotMatch(photo, /export type ReferencePhotoRole =/)
  assert.match(photo, /import type \{ ReferencePhotoRole \} from '\.\.\/project\/project-store\.ts'/)
  assert.match(photo, /export type \{ ReferencePhotoRole \}/)
})
