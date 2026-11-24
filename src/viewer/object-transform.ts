/**
 * The XYZ fields of the object editor, and their conversion to and from an object's
 * local transform.
 *
 * Position is in metres, rotation is Euler XYZ in degrees, and scale is a unitless
 * multiplier. The object keeps its quaternion; the fields are a view of it. Writing the
 * fields and reading them back returns the same numbers, within floating-point noise,
 * for any rotation whose Y angle is inside ±90°. Outside that range the same orientation
 * has more than one XYZ decomposition, and reading back gives the canonical one. The
 * editor never produces such a value from a gizmo drag, and a typed one is normalised to
 * the same orientation, so nothing is lost.
 *
 * Pure apart from three.js maths, so tests/unit/node/object_transform.test.ts can run it.
 */
import * as THREE from 'three'

export interface Xyz {
  x: number
  y: number
  z: number
}

export interface TransformFields {
  /** Metres, in the object's parent frame (the same frame as `obj.position`). */
  position: Xyz
  /** Euler XYZ, degrees. */
  rotation: Xyz
  /** Unitless multiplier. A zero component is rejected by {@link isValidTransformFields}. */
  scale: Xyz
}

export type TransformGroup = keyof TransformFields
export type TransformAxis = keyof Xyz

/** The three.js members the fields read and write. An Object3D satisfies this. */
export interface TransformTarget {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
  updateMatrix(): void
}

const DEG_PER_RAD = 180 / Math.PI

export function readTransformFields(target: Pick<TransformTarget, 'position' | 'quaternion' | 'scale'>): TransformFields {
  const euler = new THREE.Euler().setFromQuaternion(target.quaternion, 'XYZ')
  return {
    position: { x: target.position.x, y: target.position.y, z: target.position.z },
    rotation: { x: euler.x * DEG_PER_RAD, y: euler.y * DEG_PER_RAD, z: euler.z * DEG_PER_RAD },
    scale: { x: target.scale.x, y: target.scale.y, z: target.scale.z },
  }
}

/** Writes the fields to the object and refreshes its matrix, so a save reads the new values. */
export function writeTransformFields(target: TransformTarget, fields: TransformFields): void {
  target.position.set(fields.position.x, fields.position.y, fields.position.z)
  const euler = new THREE.Euler(
    fields.rotation.x / DEG_PER_RAD,
    fields.rotation.y / DEG_PER_RAD,
    fields.rotation.z / DEG_PER_RAD,
    'XYZ',
  )
  target.quaternion.setFromEuler(euler)
  target.scale.set(fields.scale.x, fields.scale.y, fields.scale.z)
  target.updateMatrix()
}

/** Parses one typed value. Null for blank text or anything that is not a finite number. */
export function parseFieldValue(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** Every value finite, and no scale component zero (a zero scale has no inverse, so the matrix cannot be saved). */
export function isValidTransformFields(fields: TransformFields): boolean {
  const groups: TransformGroup[] = ['position', 'rotation', 'scale']
  for (const group of groups) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = fields[group][axis]
      if (!Number.isFinite(value)) return false
      if (group === 'scale' && value === 0) return false
    }
  }
  return true
}
