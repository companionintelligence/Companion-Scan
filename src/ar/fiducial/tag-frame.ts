/**
 * The Place frame a printed marker defines: `sessionToProject` from the tag's fused pose.
 *
 * Pure maths over numbers, browser-safe (ADR 0002), nothing imported but types and the quaternion helper.
 *
 * ## The frame is defined by the tag's POSE, not by its corners
 *
 * The constellation fit (`src/world/frame-fit.ts`) refuses to take a tag's four corners as four points: they are
 * closer together than `DUPLICATE_POINT_GAP_M`, a wall tag's corners have only two distinct plan positions, and the
 * four corners of one pose are one observation, not four. So the frame is built from the fused pose (`fuseTagObservations`),
 * and only the part of it a gravity-aligned session can trust:
 *
 * - **Origin:** the tag centre's plan position, at the floor. Project `y = 0` is the floor datum, as it is on the two-point
 *   tier (`twoPointToProjectTransform`), so a frame from a marker and a frame from two taps put the floor in the same place.
 * - **Up:** the session's own +y. Roll and pitch come from gravity, which the runtime knows far better than a tag's tilt
 *   estimate can say it; only a rotation about the vertical is taken from the tag. That rotation is the frame's "heading",
 *   and it is the part of the pose a tag fixes worst (an out-of-plane rotation for a wall tag, which is why the flow coaches
 *   a view from the side and a sweep).
 * - **+Z:** the horizontal projection of the tag's outward normal for a WALL tag (so +Z points from the wall into the room);
 *   the tag's printed up axis for a HORIZONTAL tag (so +Z points up the page as it is read from the side it is read from).
 * - **+X:** up crossed with +Z, which makes the frame right-handed and a proper rotation about the vertical, the
 *   same as the two-point frame's. For a wall tag +X is the tag's printed right.
 *
 * ## Matrix convention
 *
 * `sessionToProject` is COLUMN-MAJOR 16 numbers, the layout of `scan.localToWorld`, `THREE.Matrix4.elements`, and the
 * arguments of `transformPoint` in `src/world/geo.ts`: it takes a point in session coordinates (session units) to the
 * Place frame in METRES. It is a rotation about Y, a translation and a uniform scale `1 / sessionUnitsPerMetre` (the
 * scale `invertAffine` in `src/world/anchor-placement.ts` is documented to invert). For a metric runtime the scale is 1.
 * `tests/unit/node/fiducial_tag_frame.test.ts` checks it against `transformPoint`, against `twoPointToProjectTransform`
 * (the same rotation and the same sign of it), and against `invertAffine`.
 *
 * ## Which tags it takes
 *
 * The mount is read from the vertical component of the fused normal: a wall tag, `|n_y| < 0.3`; a horizontal one,
 * `|n_y| > 0.9`; anything between is a tag leaning at an angle nobody mounts one at, refused as `'tilted'` and not
 * guessed at. Both limits are adopted, not measured (ADR 0005 rule 5): they bound how far from vertical or flat a real
 * mounting may be, and the heading of a tag tilted between the two is the worst-conditioned of all.
 */
import type { Vec3 } from '../../world/types.ts'
import type { FiducialMount } from '../../world/fiducial-evidence.ts'
import type { FusedTagPose } from './types.ts'
import { quatToMatrix } from './tag-pose.ts'
import { axisBearingDeg, classifyMount, tagHeadingAxis } from './tag-mount.ts'

// The mount limits and the classifier live in `tag-mount.ts`, which the fusion also reads (its heading spread is the scatter of the angle
// this frame is built from); they are part of this module's interface still.
export { HORIZONTAL_MIN_NORMAL_Y, WALL_MAX_NORMAL_Y, classifyMount } from './tag-mount.ts'

/**
 * The floor datum and the floor the sheet's mount height implies may differ by this much, metres, before the frame says
 * so. It is the figure `FLOOR_DATUM_AGREE_M` (`ground-gate.ts`) uses for a tap against a fitted floor, three times over,
 * because a mount height is a person's measurement and a fitted floor is a few centimetres out. Adopted, not measured
 * (ADR 0005 rule 5): DX8 records both.
 */
export const FLOOR_MOUNT_DISAGREE_M = 0.15

/** Lowest and highest a tag's centre may sit above the floor, metres, for the frame to be built: below it the floor is above the tag, above it the "floor" is not one. Adopted, not measured. */
export const TAG_HEIGHT_MIN_M = -0.1
export const TAG_HEIGHT_MAX_M = 4

export interface TagFrameOptions {
  /**
   * Height of the floor in SESSION coordinates (session units), from a fitted floor the caller trusts
   * (`landmarkDatum().y`, `src/ar/ground-gate.ts`). Null when there is none.
   */
  floorY: number | null
  /**
   * The height of the tag's centre above the floor as it was mounted, metres: what the sheet and the Place record say.
   * Used for the floor only when `floorY` is null; compared with it when both exist. Null when not known.
   */
  mountHeightM: number | null
  /** The mount the sheet or the Place states, if any. A measured normal that contradicts it is refused, not overruled. */
  mount?: FiducialMount | null
  /** Session units per metre: 1 for a metric runtime, the unit worked out from the printed size otherwise. */
  sessionUnitsPerMetre: number
}

export type TagFrameRefusal =
  /** The fusion produced no pose. */
  | 'not-fused'
  /** `sessionUnitsPerMetre` is not a positive finite number. */
  | 'bad-scale'
  /** The normal is neither near horizontal nor near vertical (see {@link classifyMount}). */
  | 'tilted'
  /** The sheet or the Place says wall (or horizontal) and the measured normal says the other. */
  | 'mount-mismatch'
  /** No floor datum and no mount height: nothing says where project `y = 0` is. */
  | 'no-floor'
  /** The mount height is not a number from 0 up, or the tag centre would sit below or far above the floor. */
  | 'bad-height'

/** What was noted about the frame without refusing it. */
export type TagFrameFlag =
  /** The floor is the tag's height less the mount height on the sheet: a person's number, not a measured floor. */
  | 'floor-from-mount-height'
  /** A fitted floor and the sheet's mount height disagree by more than `FLOOR_MOUNT_DISAGREE_M`; the fitted floor is used. */
  | 'floor-disagrees-with-mount-height'

export interface TagFrame {
  status: 'ok'
  mount: FiducialMount
  /** Column-major 4x4 taking session coordinates to the Place frame in metres. See the header. */
  sessionToProject: number[]
  /** The frame's origin in session coordinates: the tag's plan position at the floor. */
  originSession: Vec3
  /** The session yaw of the frame's +Z, degrees, by `atan2(x, z)` as `twoPointHeadingDeg` writes it. */
  headingYawDeg: number
  /** The floor, in session coordinates. */
  floorY: number
  /** `'datum'` a fitted floor; `'mount-height'` the sheet's number (flagged). */
  floorSource: 'datum' | 'mount-height'
  /** Height of the tag's centre above the floor, metres: the Place-frame `y` of the tag. */
  tagHeightM: number
  /** Floor from the datum less the floor from the mount height, metres, when both exist. Positive: the datum is higher. */
  floorGapM: number | null
  /** The tag's normal's vertical component, signed: how wall-like (near 0) or flat (near +-1) it is. */
  normalY: number
  flags: TagFrameFlag[]
}

export interface TagFrameRefused {
  status: 'refused'
  reason: TagFrameRefusal
  /** The vertical component of the measured normal, when there was a pose to measure it on. */
  normalY: number | null
}

function refused(reason: TagFrameRefusal, normalY: number | null): TagFrameRefused {
  return { status: 'refused', reason, normalY }
}

/**
 * The Place frame the fused tag pose defines, or the reason it cannot define one. Never throws for a fusion that was
 * rejected or a number that is not finite: those are `'refused'`.
 *
 * Floor: `options.floorY` (a fitted floor, session units) when the caller has one; otherwise the tag's session height less
 * `mountHeightM`, converted to session units, with the flag `'floor-from-mount-height'`. When both exist they are
 * compared and the fitted floor wins, with `'floor-disagrees-with-mount-height'` if they are apart by more than
 * {@link FLOOR_MOUNT_DISAGREE_M}.
 */
export function tagFrameTransform(fused: Pick<FusedTagPose, 'status' | 'pose'>, options: TagFrameOptions): TagFrame | TagFrameRefused {
  const pose = fused.status === 'ok' ? fused.pose : null
  if (!pose) return refused('not-fused', null)
  const p = pose.position
  const rot = quatToMatrix(pose.rotation)
  if (![p.x, p.y, p.z, ...rot].every(Number.isFinite)) return refused('not-fused', null)
  const k = options.sessionUnitsPerMetre
  if (!(Number.isFinite(k) && k > 0)) return refused('bad-scale', null)

  // The tag's outward normal in session coordinates: the third column of its rotation.
  const normalY = rot[5]!
  const mount = classifyMount(normalY)
  if (mount === 'tilted') return refused('tilted', normalY)
  if (options.mount && options.mount !== mount) return refused('mount-mismatch', normalY)

  const mountHeightM = options.mountHeightM
  if (mountHeightM !== null && !(Number.isFinite(mountHeightM) && mountHeightM >= 0 && mountHeightM <= TAG_HEIGHT_MAX_M)) return refused('bad-height', normalY)
  if (options.floorY !== null && !Number.isFinite(options.floorY)) return refused('bad-height', normalY)

  let floorY: number
  let floorSource: TagFrame['floorSource']
  let floorGapM: number | null = null
  const flags: TagFrameFlag[] = []
  if (options.floorY !== null) {
    floorY = options.floorY
    floorSource = 'datum'
    if (mountHeightM !== null) {
      floorGapM = (floorY - (p.y - mountHeightM * k)) / k
      if (Math.abs(floorGapM) > FLOOR_MOUNT_DISAGREE_M) flags.push('floor-disagrees-with-mount-height')
    }
  } else if (mountHeightM !== null) {
    floorY = p.y - mountHeightM * k
    floorSource = 'mount-height'
    flags.push('floor-from-mount-height')
  } else {
    return refused('no-floor', normalY)
  }
  const tagHeightM = (p.y - floorY) / k
  if (tagHeightM < TAG_HEIGHT_MIN_M || tagHeightM > TAG_HEIGHT_MAX_M) return refused('bad-height', normalY)

  // +Z: the horizontal part of the outward normal (a wall tag) or of the printed up axis (a horizontal one): the axis the fusion measures the heading spread of.
  const heading = tagHeadingAxis(rot, mount)
  const dx0 = heading[0]
  const dz0 = heading[2]
  const len = Math.hypot(dx0, dz0)
  // A wall normal has |n_y| < 0.3, so its horizontal part is at least 0.95; a flat tag's up axis lies in a horizontal plane
  // within 26 degrees, so it is at least 0.9. A zero here is not a tag that passed the mount test.
  if (!(len > 1e-9)) return refused('tilted', normalY)
  const dx = dx0 / len
  const dz = dz0 / len

  const s = 1 / k
  // Column-major: columns are the images of session x, y and z; rows of the rotation are [dz 0 -dx], [0 1 0], [dx 0 dz].
  const sessionToProject = [
    s * dz, 0, s * dx, 0,
    0, s, 0, 0,
    -s * dx, 0, s * dz, 0,
    -s * (dz * p.x - dx * p.z),
    -s * floorY,
    -s * (dx * p.x + dz * p.z),
    1,
  ]
  return {
    status: 'ok',
    mount,
    sessionToProject,
    originSession: { x: p.x, y: floorY, z: p.z },
    headingYawDeg: axisBearingDeg([dx, 0, dz]),
    floorY,
    floorSource,
    tagHeightM,
    floorGapM,
    normalY,
    flags,
  }
}
