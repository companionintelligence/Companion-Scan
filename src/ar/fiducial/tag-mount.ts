/**
 * How a printed marker is mounted, and which of its own axes gives the Place frame its heading.
 *
 * Shared by the fusion (`tag-pose.ts`), which measures how much the per-frame headings scatter, and the frame builder
 * (`tag-frame.ts`), which builds the Place frame from the same axis: the two cannot disagree about what "heading" means, and a gate on
 * the scatter of the angle the frame keeps is a gate on the angle the frame keeps.
 *
 * Pure (ADR 0002): nothing imported but a type, and the shared angle wrap of src/shared/pose-math.ts, which has no imports.
 */
import type { FiducialMount } from '../../world/fiducial-evidence.ts'

/**
 * A tag whose outward normal has a vertical component below this (in absolute value) is mounted on a wall: its normal is
 * within about 17 degrees of horizontal. Adopted, not measured (ADR 0005 rule 5): it bounds how far from plumb a wall
 * mount may lean before the horizontal projection of the normal (the frame's +Z) stops being a good heading.
 */
export const WALL_MAX_NORMAL_Y = 0.3

/**
 * A tag whose outward normal has a vertical component above this (in absolute value) lies flat: floor, table, shelf or
 * ceiling. Its normal is within about 26 degrees of vertical. Adopted, not measured (ADR 0005 rule 5).
 */
export const HORIZONTAL_MIN_NORMAL_Y = 0.9

/**
 * What mounting a tag's normal says it has: `'wall'` below {@link WALL_MAX_NORMAL_Y}, `'horizontal'` above
 * {@link HORIZONTAL_MIN_NORMAL_Y}, `'tilted'` for the band between (limits included in the band).
 */
export function classifyMount(normalY: number): FiducialMount | 'tilted' {
  const a = Math.abs(normalY)
  if (a < WALL_MAX_NORMAL_Y) return 'wall'
  if (a > HORIZONTAL_MIN_NORMAL_Y) return 'horizontal'
  return 'tilted'
}

/**
 * The axis of a tag whose horizontal bearing is the frame's heading, in the session: the tag's outward normal (its +z) for a wall
 * tag, its printed up axis (its +y) for a horizontal one. `rotation` is the tag's row-major rotation, tag frame to session, so the
 * axes are its columns.
 */
export function tagHeadingAxis(rotation: readonly number[], mount: FiducialMount): [number, number, number] {
  return mount === 'wall' ? [rotation[2]!, rotation[5]!, rotation[8]!] : [rotation[1]!, rotation[4]!, rotation[7]!]
}

/** The bearing of an axis's horizontal part, degrees: `atan2(x, z)`, as `twoPointHeadingDeg` writes the two-point frame's heading. */
export function axisBearingDeg(axis: readonly [number, number, number]): number {
  return (Math.atan2(axis[0], axis[2]) * 180) / Math.PI
}

/** An angle difference in degrees brought into (-180, 180]: the shared one (src/shared/pose-math.ts), not a second copy (ADR 0001). */
export { wrapDeg } from '../../shared/pose-math.ts'
