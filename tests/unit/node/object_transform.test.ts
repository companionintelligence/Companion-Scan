/**
 * Spatial Editor object editor: the XYZ fields round trip.
 *
 * The fields are typed by hand, stored on the object as a quaternion, and later saved as a
 * matrix. A value that goes in must come back out of each step, or the editor would show one
 * position and save another.
 *
 * Run: npm run test:object-transform
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  isValidTransformFields,
  parseFieldValue,
  readTransformFields,
  writeTransformFields,
  type TransformFields,
} from '../../../src/viewer/object-transform.ts'

const EPSILON = 1e-9

function assertFieldsClose(actual: TransformFields, expected: TransformFields): void {
  for (const group of ['position', 'rotation', 'scale'] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(
        Math.abs(actual[group][axis] - expected[group][axis]) < EPSILON,
        `${group}.${axis}: expected ${expected[group][axis]}, read ${actual[group][axis]}`,
      )
    }
  }
}

function fresh(): THREE.Object3D {
  return new THREE.Object3D()
}

const SAMPLES: TransformFields[] = [
  { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  { position: { x: 1.25, y: -0.5, z: 3 }, rotation: { x: 0, y: 0, z: 90 }, scale: { x: 1, y: 1, z: 1 } },
  { position: { x: -4.2, y: 0.75, z: 12.5 }, rotation: { x: 30, y: -45, z: 120 }, scale: { x: 0.5, y: 2, z: 1.25 } },
  { position: { x: 0.001, y: 2, z: -7 }, rotation: { x: -170, y: 60, z: -10 }, scale: { x: 3, y: 3, z: 3 } },
]

test('fields written to an object read back unchanged', () => {
  for (const sample of SAMPLES) {
    const object = fresh()
    writeTransformFields(object, sample)
    assertFieldsClose(readTransformFields(object), sample)
  }
})

test('fields survive the matrix the viewer saves: write, save the matrix, decompose, read', () => {
  for (const sample of SAMPLES) {
    const object = fresh()
    writeTransformFields(object, sample)
    const restored = fresh()
    restored.matrix.fromArray(object.matrix.toArray())
    restored.matrix.decompose(restored.position, restored.quaternion, restored.scale)
    assertFieldsClose(readTransformFields(restored), sample)
  }
})

test('reading and writing back an object is idempotent', () => {
  // A quaternion from an arbitrary axis-angle has no canonical Euler form until it is read.
  // Reading it, then writing the fields back, must keep the same orientation.
  const object = fresh()
  object.quaternion.setFromAxisAngle(new THREE.Vector3(1, 2, 3).normalize(), 1.1)
  object.position.set(2, -1, 0.5)
  const before = object.quaternion.clone()
  const fields = readTransformFields(object)
  writeTransformFields(object, fields)
  assert.ok(Math.abs(object.quaternion.angleTo(before)) < 1e-9, 'orientation must be preserved')
  assertFieldsClose(readTransformFields(object), fields)
})

test('a write changes only the transform, not the object identity or its children', () => {
  const object = fresh()
  const child = new THREE.Object3D()
  object.add(child)
  writeTransformFields(object, SAMPLES[2])
  assert.equal(object.children[0], child)
  assert.equal(child.parent, object)
})

test('parseFieldValue accepts finite numbers and rejects everything else', () => {
  assert.equal(parseFieldValue('1.5'), 1.5)
  assert.equal(parseFieldValue('  -2 '), -2)
  assert.equal(parseFieldValue('0'), 0)
  assert.equal(parseFieldValue(''), null)
  assert.equal(parseFieldValue('   '), null)
  assert.equal(parseFieldValue('abc'), null)
  assert.equal(parseFieldValue('Infinity'), null)
  assert.equal(parseFieldValue('NaN'), null)
})

test('a zero or non-finite value makes the fields invalid, so a bad edit is never saved', () => {
  const base = SAMPLES[1]
  assert.equal(isValidTransformFields(base), true)
  assert.equal(isValidTransformFields({ ...base, scale: { x: 0, y: 1, z: 1 } }), false)
  assert.equal(isValidTransformFields({ ...base, position: { x: Number.NaN, y: 0, z: 0 } }), false)
  assert.equal(isValidTransformFields({ ...base, rotation: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 } }), false)
  // A zero position or rotation is a real place and a real pose: it stays valid.
  assert.equal(isValidTransformFields({ ...base, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }), true)
})
