/**
 * A headset's camera, as distinct from its eyes (wave 19, 0002).
 *
 * On a phone, WebXR's one view is the camera the scanner photographs through, so the viewer pose and that view's
 * projection describe every keyframe. On a headset (a viewer pose with two views) they describe the eyes. The camera
 * that `getUserMedia` opens sits apart from them and sees a different field, and WebXR says nothing about where it is.
 * So the page is given a measured model, and keeps it on the device:
 *
 *   ?camoffset=x,y,z   the camera's position in the viewer's frame, in metres (+x right, +y up, -z forward)
 *   ?campitch=deg      the camera's pitch relative to the viewer, in degrees (negative looks down)
 *   ?camfov=deg        the camera image's vertical field of view, in degrees
 *   ?camera=clear      forgets the stored model
 *
 * A model given in the address is stored (localStorage `scan-xr-camera-model`), so a headset keeps it across reloads.
 * None is built in for any device: none has been measured. Without one, a head-mounted session goes on reporting the
 * eyes' pose and projection, and the provider says so.
 *
 * Pure, so its maths is tested without a browser.
 */
import type { Pose } from './provider.ts'

/** The localStorage key the model is kept under. */
export const CAMERA_MODEL_STORAGE_KEY = 'scan-xr-camera-model'

export interface XrCameraModel {
  /** The camera's position in the viewer's frame, in metres, or null to leave the position as the viewer's. */
  offset: { x: number; y: number; z: number } | null
  /** The camera's pitch about the viewer's x axis, in degrees: negative looks down. */
  pitchDeg: number
  /** The camera image's vertical field of view, in degrees, or null to keep the view's. */
  fovYDeg: number | null
  /** Where the model came from: this page's address, or what an earlier address stored. */
  source: 'address' | 'stored'
}

type ModelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The largest offset accepted, in metres on any axis: a camera on a headset is centimetres from the eyes. */
const MAX_OFFSET_M = 0.5

function parseOffset(raw: string): { x: number; y: number; z: number } | null {
  const parts = raw.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 3 || !parts.every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_OFFSET_M)) return null
  const [x, y, z] = parts as [number, number, number]
  return { x, y, z }
}

function parseAngle(raw: string | null, min: number, max: number): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= min && value <= max ? value : null
}

/**
 * The model the address gives, `'clear'` for `?camera=clear`, or null when it gives none. A value out of range is
 * ignored, not clamped: a wrong camera model misplaces every keyframe.
 */
export function parseCameraModel(search: string): XrCameraModel | 'clear' | null {
  const params = new URLSearchParams(search)
  if (params.get('camera') === 'clear') return 'clear'
  const offsetRaw = params.get('camoffset')
  const offset = offsetRaw === null ? null : parseOffset(offsetRaw)
  const pitchDeg = parseAngle(params.get('campitch'), -90, 90)
  const fovYDeg = parseAngle(params.get('camfov'), 10, 170)
  if (offset === null && pitchDeg === null && fovYDeg === null) return null
  return { offset, pitchDeg: pitchDeg ?? 0, fovYDeg, source: 'address' }
}

function fromStored(raw: string | null): XrCameraModel | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<XrCameraModel> | null
    if (!value || typeof value !== 'object') return null
    const offset = value.offset && typeof value.offset === 'object'
      ? parseOffset(`${value.offset.x},${value.offset.y},${value.offset.z}`)
      : null
    const pitchDeg = typeof value.pitchDeg === 'number' ? parseAngle(String(value.pitchDeg), -90, 90) : null
    const fovYDeg = typeof value.fovYDeg === 'number' ? parseAngle(String(value.fovYDeg), 10, 170) : null
    if (offset === null && pitchDeg === null && fovYDeg === null) return null
    return { offset, pitchDeg: pitchDeg ?? 0, fovYDeg, source: 'stored' }
  } catch {
    return null
  }
}

/**
 * The model for this page: the address's, which is then stored; or the stored one; or none. `?camera=clear` forgets the
 * stored one. A storage that throws (a private window, a WebView without it) leaves only the address.
 */
export function readCameraModel(search: string, storage: ModelStorage | null): XrCameraModel | null {
  const given = parseCameraModel(search)
  try {
    if (given === 'clear') {
      storage?.removeItem(CAMERA_MODEL_STORAGE_KEY)
      return null
    }
    if (given) {
      const { offset, pitchDeg, fovYDeg } = given
      storage?.setItem(CAMERA_MODEL_STORAGE_KEY, JSON.stringify({ offset, pitchDeg, fovYDeg }))
      return given
    }
    return fromStored(storage?.getItem(CAMERA_MODEL_STORAGE_KEY) ?? null)
  } catch {
    return given === 'clear' ? null : given
  }
}

type Quat = { x: number; y: number; z: number; w: number }
type Vec3 = { x: number; y: number; z: number }

function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** `v` rotated by the unit quaternion `q`. */
export function rotateVector(q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q.xyz × v); v' = v + q.w * t + q.xyz × t
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/** The camera's pose, from the viewer's and the model: the offset turned into the world by the viewer's orientation. */
export function cameraPoseFromViewer(viewer: Pose, model: XrCameraModel): Pose {
  const shift = model.offset ? rotateVector(viewer.rotation, model.offset) : { x: 0, y: 0, z: 0 }
  const half = (model.pitchDeg * Math.PI) / 360
  const pitch: Quat = { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) }
  return {
    position: { x: viewer.position.x + shift.x, y: viewer.position.y + shift.y, z: viewer.position.z + shift.z },
    rotation: model.pitchDeg === 0 ? { ...viewer.rotation } : multiply(viewer.rotation, pitch),
  }
}

/** One line for the log and the in-session panel: what a keyframe's pose and field of view are. */
export function describeCameraModel(model: XrCameraModel | null, headMounted: boolean): string {
  if (!headMounted) return 'pose: the camera (one view)'
  if (!model) return 'pose: the eyes, no camera model set'
  const parts: string[] = []
  if (model.offset) parts.push(`offset ${model.offset.x}, ${model.offset.y}, ${model.offset.z} m`)
  if (model.pitchDeg !== 0) parts.push(`pitch ${model.pitchDeg}°`)
  if (model.fovYDeg !== null) parts.push(`fov ${model.fovYDeg}°`)
  return `pose: the camera (${parts.join(', ')}; ${model.source === 'address' ? 'from the address' : 'stored'})`
}
