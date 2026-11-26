/**
 * Wave 19, 0002: a headset's camera model (src/ar/xr-camera-model.ts). The address gives it, the device keeps it, and
 * the keyframe pose moves from the eyes to the camera by it.
 *
 *   node --experimental-strip-types --no-warnings --test tests/unit/node/wp-19-xr-camera-model.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA_MODEL_STORAGE_KEY,
  cameraPoseFromViewer,
  describeCameraModel,
  parseCameraModel,
  readCameraModel,
  rotateVector,
} from '../../../src/ar/xr-camera-model.ts'
import type { XrCameraModel } from '../../../src/ar/xr-camera-model.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

test('the address: offset, pitch and field of view, each optional, each refused out of range', () => {
  assert.deepEqual(parseCameraModel('?camoffset=0.03,-0.02,-0.05&campitch=-12&camfov=62'),
    { offset: { x: 0.03, y: -0.02, z: -0.05 }, pitchDeg: -12, fovYDeg: 62, source: 'address' })
  assert.deepEqual(parseCameraModel('?camfov=70'), { offset: null, pitchDeg: 0, fovYDeg: 70, source: 'address' })
  assert.equal(parseCameraModel(''), null)
  assert.equal(parseCameraModel('?camera=clear'), 'clear')
  // Out of range or malformed: ignored, never clamped.
  assert.equal(parseCameraModel('?camoffset=3,0,0'), null)
  assert.equal(parseCameraModel('?camoffset=0.1,0.2'), null)
  assert.equal(parseCameraModel('?camfov=5'), null)
  assert.equal(parseCameraModel('?campitch=120'), null)
})

test('the device keeps an address\'s model, gives it back on a plain reload, and forgets it on ?camera=clear', () => {
  const storage = memoryStorage()
  const given = readCameraModel('?camoffset=0,0.01,-0.04&camfov=64', storage)
  assert.equal(given?.source, 'address')
  assert.ok(storage.data.has(CAMERA_MODEL_STORAGE_KEY))
  const later = readCameraModel('', storage)
  assert.deepEqual(later, { offset: { x: 0, y: 0.01, z: -0.04 }, pitchDeg: 0, fovYDeg: 64, source: 'stored' })
  assert.equal(readCameraModel('?camera=clear', storage), null)
  assert.equal(storage.data.has(CAMERA_MODEL_STORAGE_KEY), false)
  assert.equal(readCameraModel('', storage), null)
})

test('a stored model that is not one is ignored, and a storage that throws leaves only the address', () => {
  assert.equal(readCameraModel('', memoryStorage({ [CAMERA_MODEL_STORAGE_KEY]: '{not json' })), null)
  assert.equal(readCameraModel('', memoryStorage({ [CAMERA_MODEL_STORAGE_KEY]: '{"offset":{"x":9,"y":0,"z":0}}' })), null)
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => {} }
  assert.equal(readCameraModel('?camfov=60', throwing)?.fovYDeg, 60)
  assert.equal(readCameraModel('', throwing), null)
  assert.equal(readCameraModel('?camfov=60', null)?.fovYDeg, 60)
})

test('the camera pose: the offset turns with the head, and the pitch is the camera\'s own', () => {
  const model: XrCameraModel = { offset: { x: 0, y: -0.02, z: -0.05 }, pitchDeg: 0, fovYDeg: null, source: 'address' }
  // Facing -Z: the offset goes straight on.
  const ahead = cameraPoseFromViewer({ position: { x: 1, y: 1.6, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, model)
  assert.ok(close(ahead.position.x, 1) && close(ahead.position.y, 1.58) && close(ahead.position.z, 1.95))
  // Turned 90° to the left (about +Y): "ahead" is now -X, so the camera is 5 cm along -X.
  const s = Math.SQRT1_2
  const left = cameraPoseFromViewer({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: s, z: 0, w: s } }, model)
  assert.ok(close(left.position.x, -0.05) && close(left.position.y, -0.02) && close(left.position.z, 0))
  // A pitch of -90° turns the camera's forward from -Z to -Y: it looks at the floor.
  const down = cameraPoseFromViewer({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { ...model, pitchDeg: -90 })
  const forward = rotateVector(down.rotation, { x: 0, y: 0, z: -1 })
  assert.ok(close(forward.x, 0) && close(forward.y, -1) && close(forward.z, 0), JSON.stringify(forward))
})

test('the one line the log and the panel give', () => {
  assert.equal(describeCameraModel(null, false), 'pose: the camera (one view)')
  assert.equal(describeCameraModel(null, true), 'pose: the eyes, no camera model set')
  assert.equal(
    describeCameraModel({ offset: { x: 0, y: -0.02, z: -0.05 }, pitchDeg: -10, fovYDeg: 62, source: 'stored' }, true),
    'pose: the camera (offset 0, -0.02, -0.05 m, pitch -10°, fov 62°; stored)',
  )
})
