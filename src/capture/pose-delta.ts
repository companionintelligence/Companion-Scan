/**
 * Pose delta — how far the device has moved and turned since a reference pose.
 *
 * Exists for the room-loop drift benchmark (wave 09 ticket 0006): walk a
 * perimeter, return to a taped floor marker, and read the accumulated SLAM
 * drift straight off the HUD. Sits alongside quality-monitor.ts's metrics
 * rather than inside them — `driftEvents` there counts how often camera
 * *speed* exceeded a threshold, a proxy for drift *risk*; this measures the
 * positional error that actually accumulated.
 *
 * Pure and side-effect free so it is unit-testable without a DOM or an AR
 * runtime (see pose_delta.test.ts).
 *
 * Types come from world/types.ts rather than ar/provider.ts even though
 * `ARProvider.Pose` is the structurally identical shape this is fed at runtime:
 * provider.ts references `HTMLCanvasElement`, so importing from it drags DOM
 * lib types into the Deno test run and fails type-checking (ADR 0002).
 * `PoseLike` is structurally compatible with `Pose`, so callers pass one
 * without a cast.
 */
import type { Quat, Vec3 } from '../world/types'
import { cameraHeadingDeg, wrapDeg } from '../shared/pose-math.ts'

/**
 * `wrapDeg` and the heading (`yawDegFromQuat`, which src/shared/pose-math.ts names `cameraHeadingDeg` to tell it from
 * the twist between two orientations) live in src/shared/pose-math.ts with the rest of the pose maths (wave 14, F-40).
 * They are exported from here too, under the names they always had: src/world/frame-fit.ts, src/ar/closure.ts and the
 * tests import them from this path.
 */
export { wrapDeg }
export const yawDegFromQuat = cameraHeadingDeg

/** The pose shape this module needs — structurally `ARProvider`'s `Pose`. */
export interface PoseLike {
  position: Vec3
  rotation: Quat
}

export interface PoseDelta {
  /** Straight-line distance from the reference position, in metres. */
  distanceM: number
  /** Per-axis offset, in metres — useful for telling vertical drift from horizontal. */
  offsetM: { x: number; y: number; z: number }
  /** Signed yaw difference, wrapped to (-180, 180]. Positive is counter-clockwise about +Y. */
  yawDeg: number
}

/**
 * Displacement and turn of `current` relative to `reference`.
 *
 * Returns zeros when the two are the same pose, which is what the readout
 * shows immediately after a session starts.
 */
export function poseDelta(reference: PoseLike, current: PoseLike): PoseDelta {
  const dx = current.position.x - reference.position.x
  const dy = current.position.y - reference.position.y
  const dz = current.position.z - reference.position.z
  return {
    distanceM: Math.hypot(dx, dy, dz),
    offsetM: { x: dx, y: dy, z: dz },
    yawDeg: wrapDeg(yawDegFromQuat(current.rotation) - yawDegFromQuat(reference.rotation)),
  }
}

/**
 * One-line HUD rendering of a delta, e.g. `Δ 6cm · 2.4° · x0.03 y-0.01 z0.05`.
 *
 * Sub-metre distances render in centimetres because the benchmark's whole
 * range of interest is a few centimetres to a few tens of centimetres, where
 * "0.06 m" is harder to read at a glance than "6cm".
 */
export function formatPoseDelta(delta: PoseDelta): string {
  const dist = delta.distanceM < 1
    ? `${Math.round(delta.distanceM * 100)}cm`
    : `${delta.distanceM.toFixed(2)}m`
  const axes = `x${delta.offsetM.x.toFixed(2)} y${delta.offsetM.y.toFixed(2)} z${delta.offsetM.z.toFixed(2)}`
  return `Δ ${dist} · ${delta.yawDeg.toFixed(1)}° · ${axes}`
}
