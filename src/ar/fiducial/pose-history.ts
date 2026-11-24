/**
 * A short memory of camera poses, so a camera image can be paired with the pose it was taken at
 * rather than the pose the runtime reports now.
 *
 * Why it exists: a tag's pose in the session is the tag's pose in the camera (from the image)
 * carried through the camera's pose in the session. If the pose is not the one the image was exposed
 * at, the tag lands where the camera was, not where the tag is. A phone walked at 0.3 m/s moves 1 cm
 * in 33 ms and turns a few tenths of a degree, which is the size of the error this package is trying
 * to measure.
 *
 * ## The pairing is a hypothesis, and `lagFrames` is how it is stated
 *
 * What a runtime documents about the camera image it hands over is its size, its format and where it
 * is delivered; the 8th Wall `CameraPixelArray` page (https://8thwall.org/docs/api/engine/camerapixelarray/pipelinemodule)
 * says nothing about which frame the pixels show, relative to the pose delivered in the same tick. So how far the
 * pixels trail the pose is a number to be FITTED on a phone, not a fact to be read: `lagFrames` is how many frames
 * the pixels are assumed to be older than the newest pose, 0 meaning the pose of the same frame, and
 * {@link DEFAULT_PIXEL_LAG_FRAMES} is only the starting guess. Device experiment DX8 swings a phone past a fixed tag
 * and back and fits 0, 1 and 2 by how well the tag's session pose explains the frames (`fitPixelLag` in `tag-debug.ts`, shown
 * by `?debug=tag`; it needs the camera's speed to change, since a steady sweep fits every lag alike); what it finds
 * replaces the default. Push every frame's pose here with its timestamp, and ask
 * {@link PoseHistory.pairedSample} for the pose to go with the pixels delivered with the newest.
 *
 * The WebXR companion `getUserMedia` stream has no frame timestamp that is comparable with the XR clock at all, so
 * it cannot be synchronised this way; see the WP-14a report.
 *
 * Interpolation (`at`) is linear for position and spherical for rotation (shortest arc). It never
 * extrapolates, and it refuses to interpolate across a hole in the data. `pairedSample` does not interpolate:
 * it names a whole frame.
 *
 * Browser-safe (ADR 0002), no dependency.
 */
import type { Pose } from '../provider.ts'

/**
 * How many frames the pixels are assumed to be older than the newest pose, to begin with. A hypothesis, adopted, not
 * measured (ADR 0005 rule 5), and the one thing in this folder that a real frame can contradict without any test
 * here noticing: DX8 fits 0, 1 and 2 and replaces it. The header says why it is a hypothesis.
 */
export const DEFAULT_PIXEL_LAG_FRAMES = 1
/** Largest gap between two samples that may be interpolated across, milliseconds. Adopted, not measured: a few frames at 30 fps. */
export const DEFAULT_MAX_GAP_MS = 100
/** How far outside the stored range a request is answered with the nearest sample, milliseconds. Adopted, not measured: under one frame at 30 fps. */
export const DEFAULT_EDGE_TOLERANCE_MS = 20

interface Sample {
  t: number
  pose: Pose
}

export interface PoseHistoryOptions {
  /** See {@link DEFAULT_PIXEL_LAG_FRAMES}. A whole number from 0 to one less than the capacity. */
  lagFrames?: number
}

/** A recorded pose and the time it was recorded for. */
export interface PoseSample {
  pose: Pose
  timestampMs: number
}

function slerp(a: Pose['rotation'], b: Pose['rotation'], u: number): Pose['rotation'] {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  if (dot < 0) {
    dot = -dot
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let ka: number
  let kb: number
  if (dot > 0.9995) {
    ka = 1 - u
    kb = u
  } else {
    const theta = Math.acos(dot)
    const s = Math.sin(theta)
    ka = Math.sin((1 - u) * theta) / s
    kb = Math.sin(u * theta) / s
  }
  const x = ka * a.x + kb * bx
  const y = ka * a.y + kb * by
  const z = ka * a.z + kb * bz
  const w = ka * a.w + kb * bw
  const n = Math.hypot(x, y, z, w) || 1
  return { x: x / n, y: y / n, z: z / n, w: w / n }
}

export class PoseHistory {
  private readonly samples: Sample[] = []
  private readonly capacity: number
  /** Frames the pixels are assumed to trail the newest pose. See {@link DEFAULT_PIXEL_LAG_FRAMES}. */
  readonly lagFrames: number

  constructor(capacity = 64, options: PoseHistoryOptions = {}) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError('a pose history needs room for at least two samples')
    const lag = options.lagFrames ?? DEFAULT_PIXEL_LAG_FRAMES
    if (!Number.isInteger(lag) || lag < 0 || lag >= capacity) throw new RangeError(`lagFrames ${lag} is not a whole number from 0 to ${capacity - 1}`)
    this.capacity = capacity
    this.lagFrames = lag
  }

  get size(): number {
    return this.samples.length
  }

  clear(): void {
    this.samples.length = 0
  }

  /**
   * Record the pose at `timestampMs`. A sample that is not newer than the newest one is ignored
   * (a runtime callback can fire twice for one frame), and a non-finite timestamp or pose is ignored.
   */
  push(pose: Pose, timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) return
    const p = pose.position
    const q = pose.rotation
    if (![p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(Number.isFinite)) return
    const last = this.samples[this.samples.length - 1]
    if (last && timestampMs <= last.t) return
    this.samples.push({ t: timestampMs, pose: { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } } })
    if (this.samples.length > this.capacity) this.samples.shift()
  }

  /**
   * The pose at `timestampMs`, interpolated between the two samples around it. Null when there is
   * no sample near enough: the time lies outside the stored range by more than `edgeToleranceMs`
   * (within it the nearest sample is returned, not extrapolated), or the two samples around it are
   * more than `maxGapMs` apart.
   */
  at(timestampMs: number, maxGapMs = DEFAULT_MAX_GAP_MS, edgeToleranceMs = DEFAULT_EDGE_TOLERANCE_MS): Pose | null {
    const s = this.samples
    if (s.length === 0 || !Number.isFinite(timestampMs)) return null
    const first = s[0]!
    const last = s[s.length - 1]!
    if (timestampMs < first.t) return first.t - timestampMs <= edgeToleranceMs ? this.copy(first.pose) : null
    if (timestampMs > last.t) return timestampMs - last.t <= edgeToleranceMs ? this.copy(last.pose) : null
    let lo = 0
    let hi = s.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (s[mid]!.t <= timestampMs) lo = mid
      else hi = mid
    }
    const a = s[lo]!
    const b = s[hi]!
    if (timestampMs === a.t) return this.copy(a.pose)
    if (timestampMs === b.t) return this.copy(b.pose)
    if (b.t - a.t > maxGapMs) return null
    const u = (timestampMs - a.t) / (b.t - a.t)
    return {
      position: {
        x: a.pose.position.x + (b.pose.position.x - a.pose.position.x) * u,
        y: a.pose.position.y + (b.pose.position.y - a.pose.position.y) * u,
        z: a.pose.position.z + (b.pose.position.z - a.pose.position.z) * u,
      },
      rotation: slerp(a.pose.rotation, b.pose.rotation, u),
    }
  }

  /**
   * The pose to pair with the pixels delivered with the NEWEST sample: the one recorded `lagFrames` frames before it
   * (0 is the newest itself). `lagFrames` defaults to the history's own. Null while the history is not that deep, so a
   * pairing is never made from a pose that is not the one asked for. A whole frame, never an interpolation.
   */
  pairedSample(lagFrames: number = this.lagFrames): PoseSample | null {
    if (!Number.isInteger(lagFrames) || lagFrames < 0) return null
    const sample = this.samples[this.samples.length - 1 - lagFrames]
    return sample ? { pose: this.copy(sample.pose), timestampMs: sample.t } : null
  }

  /** The newest `count` samples, newest first (fewer when the history is shorter). */
  newest(count: number): PoseSample[] {
    const out: PoseSample[] = []
    for (let i = this.samples.length - 1; i >= 0 && out.length < count; i--) out.push({ pose: this.copy(this.samples[i]!.pose), timestampMs: this.samples[i]!.t })
    return out
  }

  /**
   * How fast the camera turned between the newest two samples, degrees per second: what bounds motion blur, and so
   * a pose-grade frame. Null with fewer than two samples. A rate over one frame, not over an exposure.
   */
  angularSpeedDegPerS(): number | null {
    const n = this.samples.length
    if (n < 2) return null
    const a = this.samples[n - 2]!
    const b = this.samples[n - 1]!
    const dot = Math.abs(a.pose.rotation.x * b.pose.rotation.x + a.pose.rotation.y * b.pose.rotation.y + a.pose.rotation.z * b.pose.rotation.z + a.pose.rotation.w * b.pose.rotation.w)
    const angleDeg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
    return angleDeg / ((b.t - a.t) / 1000)
  }

  private copy(p: Pose): Pose {
    return { position: { ...p.position }, rotation: { ...p.rotation } }
  }
}
