/**
 * One marker calibration, as a state machine: frames in (what the detector found, and where the camera was), a verdict and a
 * Place frame out, and what to tell the person on the way.
 *
 * Pure: no DOM, no clock, no provider, nothing asynchronous. A frame arrives with its own time and its own camera pose and is
 * judged on those. The glue that feeds it from a camera (`tag-capture.ts`), the screen that shows it (the flow stage, a later
 * package) and the tests all drive the same object.
 *
 * ## What it does with a frame
 *
 * 1. **Identity.** The last eight frames are kept as "the id read, or nothing". When the Place already has a marker
 *    (`expected`), the frame counts toward identity only if it read THAT tag, and `'verified'` needs it in at least five of
 *    the eight. With no registered marker the first id read in five of eight is taken as the subject; nothing is verified,
 *    because there is nothing to match.
 * 2. **Per-frame gates.** A frame becomes a pose observation only if its quad is at least `minPoseSidePx` across, its
 *    corners were fitted to the edges (`cornersUsable`), the camera was turning slower than `maxAngularSpeedDegPerS` (a faster turn
 *    blurs the edges and, if the pixels are paired with a pose a frame out, moves the tag), its best solution reads between
 *    `minRangeM` and `maxRangeM`, no more than `maxViewAngleDeg` off its face, with corners that fit the square to
 *    `maxReprojectionRmsPx` (`solutionRefusal`), and the camera's frame epoch has not changed since the first frame kept (poses from
 *    either side of a frame shift are not in one frame). The fusion applies the same two predicates to every frame it is given, so
 *    the frames the session counts are the frames the fusion keeps, and what the person is told is about the frames that count.
 * 3. **Fusion.** Once `minFrames` observations span `minDurationMs` and the camera moved `minTravelM` or turned `minTurnDeg`,
 *    they are fused (`fuseTagObservations`: both mirror solutions carried, a consensus across frames, outliers and frames
 *    whose normal is more than `maxNormalDeviationDeg` from the others dropped, the scatter of position, heading and the whole
 *    orientation gated, and reprojection).
 * 4. **Scale.** On a metric runtime the tag's own estimate of the unit is only a check (a print at the wrong scale, a wrong
 *    focal length and a tracking scale error all show as one number and cannot be told apart); on any other runtime the
 *    unit IS the estimate. Either way it needs `MIN_SCALE_BASELINE_M` of camera travel, so the session keeps asking for movement
 *    until it has it; on a metric runtime only, a read that is otherwise complete is delivered, provisional and saying the print
 *    was not checked, when `fallbackAfterMs` runs out instead of being thrown away.
 * 5. **Frame and verdict.** `tagFrameTransform` makes `sessionToProject` (a tilted mount, or one that contradicts the sheet,
 *    is refused); `fiducialVerdict` judges the evidence against the gates.
 *
 * ## What `'verified'` means here, and what it does not
 *
 * ADR 0005 rule 3: a status that claims verification is derived from a measurement. `fiducialVerdict` returns `'verified'`
 * only when the tag read is the Place's registered tag (identity), in at least five of the last eight frames, and every gate above
 * holds on the numbers in the evidence, and, on a metric runtime, the print-scale check was done and agreed. It does NOT say the
 * marker is where it was when it was registered: a sheet moved to another wall is still the same sheet, and the frame
 * it defines moves with it. The copy (`./tag-copy.ts`) says so every time. A first marker calibration is `'provisional'`
 * with a quality badge: there was nothing to compare with.
 *
 * ## Constants
 *
 * Every number in {@link DEFAULT_FIDUCIAL_GATES} is adopted, not measured (ADR 0005 rule 5). Most are the WP-14b spec's, which
 * took them from R1's Monte Carlo (an ideal pinhole, known intrinsics and independent corner noise: lower bounds on real
 * error). The rest are the fusion's own adopted defaults (`tag-pose.ts`), named here so that the session's per-frame gates and the
 * fusion's cannot differ: the limit on the whole orientation's scatter (R1 gates only the heading), the range, the view angle and
 * the edge fit. Device experiment DX8 replaces each with a measurement.
 */
import type { Pose } from '../provider.ts'
import type { ScaleKind } from '../../world/scale-mode.ts'
import type { FiducialEvidence, FiducialMount, FiducialScaleSource, FiducialSizeSource } from '../../world/fiducial-evidence.ts'
import type { DetectorOptions } from './detector.ts'
import { tagFrameTransform, type TagFrame, type TagFrameFlag, type TagFrameRefusal } from './tag-frame.ts'
import {
  cornersUsable,
  DEFAULT_MAX_EDGE_RMS_PX,
  DEFAULT_MAX_ROTATION_SPREAD_DEG,
  DEFAULT_MAX_VIEW_ANGLE_DEG,
  DEFAULT_MIN_EDGE_INLIER_FRACTION,
  DEFAULT_MIN_RANGE_M,
  estimateSessionScale,
  fuseTagObservations,
  intrinsicsProblem,
  observationFromDetection,
  POSE_GRADE_MIN_SIDE_PX,
  quatToMatrix,
  rotationAngleBetweenDeg,
  solutionRefusal,
  solveTagPose,
} from './tag-pose.ts'
import type { CameraIntrinsics, FiducialDetection, FusedTagPose, FusionRejection, TagObservation, TagPoseSolution } from './types.ts'

// -------------------------------------------------------------------------------------------
// Gates
// -------------------------------------------------------------------------------------------

/**
 * Every threshold a marker calibration is judged by. Adopted, not measured (ADR 0005 rule 5), all of them: the WP-14b spec's
 * list, taken from R1. Each says what it guards, so that DX8's data can be read against it.
 */
export interface FiducialGates {
  /** Observations needed before a pose is offered. A few frames at 5-10 Hz cannot average down a flipped or blurred one. */
  minFrames: number
  /** First to last observation, milliseconds: fixes the span of the average in time, so one burst of near-identical frames is not twelve readings. */
  minDurationMs: number
  /** The camera must have moved this far, metres... */
  minTravelM: number
  /** ...or turned this many degrees: the tag's two mirror solutions are told apart by the camera moving relative to it. */
  minTurnDeg: number
  /** A frame taken while the camera turned this fast or faster is not used (blur, and a mismatch between pixels and pose). Degrees per second. */
  maxAngularSpeedDegPerS: number
  /** A frame whose quad is smaller than this, pixels, is not used for a pose. The same as `POSE_GRADE_MIN_SIDE_PX`. */
  minPoseSidePx: number
  /** A frame smaller than this, pixels, is not read at all: the detector is told, and it is not counted for identity. */
  minIdentitySidePx: number
  /** A frame whose tag normal is more than this from the consensus is dropped after fusion. Degrees. */
  maxNormalDeviationDeg: number
  /** The robust RMS scatter of the tag's position across frames may not exceed this. Metres. */
  maxPoseSpreadM: number
  /**
   * The same for its HEADING, degrees: the bearing of the axis the Place frame is built on (`tagHeadingAxis`), the one rotation a tag fixes for the frame
   * (roll and pitch come from gravity). R1's "robust spread of the heading at most 1 degree" is this number.
   */
  maxHeadingSpreadDeg: number
  /**
   * The same for the whole orientation, degrees: tilt and spin as well as heading. R1 sets no limit on it. The tilt of one frame's pose is the least certain
   * thing a few pixels of corner noise gives (about 1 degree at 3 m and 40 degrees, R1), and the frame does not use it, so this limit is wider than the
   * heading's and is there to refuse a fit whose tilt jumps from frame to frame. It is the fusion's own default. Adopted, not measured (ADR 0005 rule 5):
   * DX8 sets it from `fuseRotDeg` against `fuseHeadDeg`.
   */
  maxRotationSpreadDeg: number
  /** A frame whose corners disagree with its own best pose by more than this is dropped, and the median of those kept may not exceed it. Pixels. */
  maxReprojectionRmsPx: number
  /** A frame whose best solution reads the tag nearer than this, metres, is not used: it is the printed size entered too small, or a tag that fills the frame. */
  minRangeM: number
  /** A frame whose best solution reads the tag farther than this, metres, is not used. The pixel gates are what really limit range; this only stops a misread size from producing a pose at 50 m. */
  maxRangeM: number
  /** A frame whose tag is seen more than this off its face, degrees, is not used: its corners say little about the tilt. */
  maxViewAngleDeg: number
  /** A frame whose corners scatter about their fitted edge lines by more than this, pixels, is not used: the fit is not an edge. */
  maxEdgeRmsPx: number
  /** A frame in which fewer than this share of an edge's samples lay on its fitted line is not used. */
  minEdgeInlierFraction: number
  /** A median reprojection error at or under this, with every other gate met, is a `'good'` read. Pixels. */
  goodReprojectionRmsPx: number
  /** Of the last `identityWindowFrames` frames at least this many must read the tag. */
  identityMinFrames: number
  /** How many frames identity is judged over. */
  identityWindowFrames: number
  /** On a metric runtime, the unit the tag implies may differ from the metre by this fraction before the print, the lens or the tracking is called into question. */
  maxScaleOffFraction: number
}

/**
 * The default gates. Adopted, not measured (ADR 0005 rule 5): DX8 sets them. `Object.freeze`n: a caller that wants other
 * numbers passes its own, and does not change these for everyone.
 */
export const DEFAULT_FIDUCIAL_GATES: Readonly<FiducialGates> = Object.freeze({
  minFrames: 12,
  minDurationMs: 1000,
  minTravelM: 0.2,
  minTurnDeg: 15,
  maxAngularSpeedDegPerS: 10,
  minPoseSidePx: POSE_GRADE_MIN_SIDE_PX,
  minIdentitySidePx: 24,
  maxNormalDeviationDeg: 8,
  maxPoseSpreadM: 0.02,
  maxHeadingSpreadDeg: 1,
  maxRotationSpreadDeg: DEFAULT_MAX_ROTATION_SPREAD_DEG,
  maxReprojectionRmsPx: 0.8,
  minRangeM: DEFAULT_MIN_RANGE_M,
  maxRangeM: 10,
  maxViewAngleDeg: DEFAULT_MAX_VIEW_ANGLE_DEG,
  maxEdgeRmsPx: DEFAULT_MAX_EDGE_RMS_PX,
  minEdgeInlierFraction: DEFAULT_MIN_EDGE_INLIER_FRACTION,
  goodReprojectionRmsPx: 0.5,
  identityMinFrames: 5,
  identityWindowFrames: 8,
  maxScaleOffFraction: 0.03,
})

/**
 * How long a session looks before it says taps are the way to go, in milliseconds of frame time from the first frame. The
 * spec's 30 s. Adopted, not measured.
 */
export const FALLBACK_TO_TAPS_MS = 30_000

/**
 * `maxHamming` for a detector looking for the Place's registered tag: no bit errors, because the id is known and a read that
 * needs a correction is a read that is not that tag until proven otherwise. Adopted, not measured (ADR 0005 rule 5): DX8's
 * detection rate at range says whether this costs too many frames.
 */
export const REGISTERED_MAX_HAMMING = 0

/** A frame's solutions are called ambiguous below this ratio of the alternate's error to the best's. The fusion's own number. */
const AMBIGUOUS_RATIO = 2
/** Below this view angle, degrees, a tag's solutions are hard to tell apart in one frame (R1: 25 degrees, or a side of 90 px, or a ratio of 2). Adopted, not measured. */
const AMBIGUOUS_VIEW_ANGLE_DEG = 25
/**
 * Whether one frame's view is one in which the two mirror solutions cannot be told apart and a flip is likely: near face-on (under
 * {@link AMBIGUOUS_VIEW_ANGLE_DEG}) with the alternate's error not yet twice the best's ({@link AMBIGUOUS_RATIO}). Both together: a frame
 * that is either steeply tilted or already decisive is not asked to be seen from another side. `null` (a frame with no solution) is not ambiguous.
 */
export function isAmbiguousView(ratio: number | null, viewAngleDeg: number | null): boolean {
  return ratio !== null && viewAngleDeg !== null && ratio < AMBIGUOUS_RATIO && viewAngleDeg < AMBIGUOUS_VIEW_ANGLE_DEG
}
/** Most observations kept; older ones go first. Bounds the work of a fusion and the memory of a session left running. Adopted, not measured. */
const MAX_OBSERVATIONS = 60
/** A fusion is tried again when this many observations have arrived since the last try. Adopted, not measured: it bounds the work per frame. */
const FUSE_EVERY_OBSERVATIONS = 2
/** The ambiguity ratio of one frame is capped here before a median is taken, as in the fusion. */
const RATIO_CAP = 10
/** Progress is 1 only when the result exists; until then it stops just short. A display convention, not a threshold. */
const MAX_PROGRESS_WITHOUT_RESULT = 0.99

// -------------------------------------------------------------------------------------------
// Configuration and input
// -------------------------------------------------------------------------------------------

export interface TagSessionConfig {
  /** The family (`Dictionary.name`) the detector reads. */
  family: string
  /** The edge of the black square as printed, millimetres: the sheet's number, or the person's. */
  printedSizeMm: number
  sizeSource: FiducialSizeSource
  /** The detected quad's edge over the printed edge (`TagFamily.quadFraction`). Default 1. */
  quadFraction?: number
  /** The marker the Place registered, or null on the first marker calibration. */
  expected: { family: string; tagId: number } | null
  /** What one unit of the runtime's session is worth (`ARProvider.scaleKind()`). */
  scaleKind: ScaleKind
  /** The mount the sheet states, if any. A measured normal that contradicts it refuses the frame. */
  mount?: FiducialMount | null
  /**
   * The floor and the sheet's mount height, read when the frame is built so a floor that is fitted while the session runs is
   * used. `floorY` is in session units. Absent: neither is known, and a marker frame cannot be built until one is.
   */
  floor?: () => { floorY: number | null; mountHeightM: number | null }
  /** Milliseconds of frame time before the session says taps are the way. Default {@link FALLBACK_TO_TAPS_MS}. */
  fallbackAfterMs?: number
}

/** One frame, after the detector: what it found, and the camera that took it. */
export interface TagFrameInput {
  /** Milliseconds on any monotonic clock the frames share. */
  timestampMs: number
  /** Everything the detector reported for the frame (the session picks the tag it is looking for). */
  detections: readonly FiducialDetection[]
  /** The camera the corners were measured through, built from the engine's projection and the pixel array's size. */
  intrinsics: CameraIntrinsics
  /** The camera pose the pixels are paired with. */
  cameraPose: Pose
  /** How fast the camera was turning, degrees per second, or null when the runtime could not say. */
  angularSpeedDegPerS: number | null
  /** The runtime's frame epoch. A change begins the session again. */
  epoch?: number
}

/** The options a detector should be made with for this session: restricted to the registered tag and read exactly when there is one. */
export function detectorOptionsForSession(config: Pick<TagSessionConfig, 'expected'>, gates: Readonly<FiducialGates> = DEFAULT_FIDUCIAL_GATES): DetectorOptions {
  // No `maxHamming` without a registered tag: the detector's own default stands (`DEFAULT_MAX_HAMMING`, one bit).
  return config.expected
    ? { ids: [config.expected.tagId], maxHamming: REGISTERED_MAX_HAMMING, minSidePx: gates.minIdentitySidePx }
    : { minSidePx: gates.minIdentitySidePx }
}

// -------------------------------------------------------------------------------------------
// Verdict
// -------------------------------------------------------------------------------------------

/** Why a marker calibration is `'provisional'`. Each names one measured thing; `'first-calibration'` names the absence of one. */
export type FiducialVerdictReason =
  /** The Place had no marker registered: nothing to match. Not a failure. */
  | 'first-calibration'
  /** The tag read is not the one the Place registered. */
  | 'identity-mismatch'
  /** The registered tag was read in fewer than the required share of the last frames. */
  | 'identity-unconfirmed'
  | 'too-few-frames'
  | 'too-short'
  | 'too-little-motion'
  | 'too-fast'
  | 'spread'
  /** The heading (the one angle the Place frame takes from the tag) scatters more than the gate between frames. */
  | 'heading-spread'
  /** The whole orientation, tilt and spin as well as heading, scatters more than its own, wider, gate. */
  | 'rotation-spread'
  | 'reprojection'
  /** On a metric runtime, the unit the tag implies is off the metre by more than the gate. */
  | 'scale-mismatch'
  /** On a metric runtime, the camera did not move enough to check the print's scale. */
  | 'scale-unchecked'

export type FiducialQuality = 'good' | 'fair' | 'poor'

export interface FiducialVerdict {
  status: 'verified' | 'provisional'
  /** Empty exactly when the status is `'verified'`. */
  reasons: FiducialVerdictReason[]
  /**
   * How well the marker was read, whatever the status: `'good'` every pose gate met and the median reprojection error at or under
   * `goodReprojectionRmsPx`, `'fair'` every pose gate met, `'poor'` at least one not.
   */
  quality: FiducialQuality
}

/**
 * Judge a marker calibration by the numbers in its evidence and the gates, and by nothing else. `'verified'` only when the
 * identity matched and every gate holds; otherwise `'provisional'` with the reasons. Pure and total: any evidence gives a
 * verdict, and stricter gates can be applied to evidence stored long ago.
 */
export function fiducialVerdict(evidence: FiducialEvidence, gates: Readonly<FiducialGates> = DEFAULT_FIDUCIAL_GATES): FiducialVerdict {
  const identity: FiducialVerdictReason[] = []
  if (evidence.expectedTagId === null) identity.push('first-calibration')
  else if (evidence.expectedTagId !== evidence.tagId) identity.push('identity-mismatch')
  else if (evidence.identityFrames < gates.identityMinFrames) identity.push('identity-unconfirmed')

  const pose: FiducialVerdictReason[] = []
  if (evidence.nFrames < gates.minFrames) pose.push('too-few-frames')
  if (evidence.durationMs < gates.minDurationMs) pose.push('too-short')
  if (evidence.cameraTravelM < gates.minTravelM && evidence.cameraTurnDeg < gates.minTurnDeg) pose.push('too-little-motion')
  if (!(evidence.maxAngularSpeedDegPerS < gates.maxAngularSpeedDegPerS)) pose.push('too-fast')
  if (!(evidence.poseSpreadM <= gates.maxPoseSpreadM)) pose.push('spread')
  if (!(evidence.headingSpreadDeg <= gates.maxHeadingSpreadDeg)) pose.push('heading-spread')
  if (!(evidence.rotationSpreadDeg <= gates.maxRotationSpreadDeg)) pose.push('rotation-spread')
  if (!(evidence.reprojectionRmsPx <= gates.maxReprojectionRmsPx)) pose.push('reprojection')

  const scale: FiducialVerdictReason[] = []
  if (evidence.scaleSource === 'runtime-metric') {
    if (evidence.scaleOffFraction === null) scale.push('scale-unchecked')
    else if (!(Math.abs(evidence.scaleOffFraction) <= gates.maxScaleOffFraction)) scale.push('scale-mismatch')
  }

  const reasons = [...identity, ...pose, ...scale]
  const quality: FiducialQuality = pose.length > 0 ? 'poor' : evidence.reprojectionRmsPx <= gates.goodReprojectionRmsPx ? 'good' : 'fair'
  return { status: reasons.length === 0 ? 'verified' : 'provisional', reasons, quality }
}

// -------------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------------

/** What the person is asked to do, as a code and the numbers the text is made from (`tagHintText` in ./tag-copy.ts writes it). */
export type TagHint =
  | { code: 'no-tag' }
  | { code: 'move-closer'; sidePx: number; neededPx: number }
  | { code: 'keep-uncovered' }
  | { code: 'too-fast'; degPerS: number | null; limitDegPerS: number }
  | { code: 'ambiguous-view' }
  /** More camera movement is needed. `mount` is the sheet's stated mount: a flat marker is not asked to be seen from 40 degrees to one side, which is advice for a wall's. */
  | { code: 'sweep'; mount: FiducialMount | null }
  /** The scale needs the camera to move `MIN_SCALE_BASELINE_M`: to work the session's unit out from the marker (`'unit'`), or to check the print's size against the runtime's metre (`'print-check'`). */
  | { code: 'move-for-scale'; purpose: 'unit' | 'print-check' }
  /** The readings disagree. A number is given only when it is over its own gate, so that the text names what failed. */
  | { code: 'spread'; poseSpreadM: number | null; headingSpreadDeg: number | null; rotationSpreadDeg: number | null }
  | { code: 'steep-view'; viewAngleDeg: number; limitDeg: number }
  | { code: 'range'; rangeM: number; minM: number; maxM: number }
  | { code: 'poor-fit'; rmsPx: number; limitPx: number }
  | { code: 'reading'; accepted: number; needed: number }
  | { code: 'bad-intrinsics' }
  | { code: 'frame-shifted' }
  | { code: 'other-tag'; tagId: number }
  | { code: 'tilted'; normalY: number }
  | { code: 'mount-mismatch'; expected: FiducialMount }
  | { code: 'bad-height' }
  | { code: 'need-floor' }

export type TagSessionPhase =
  /** No frame has shown the tag yet, or it has not been seen in the frames since. */
  | 'searching'
  /** The tag is being read; the gates are not all met. */
  | 'collecting'
  /** A pose, a frame and a verdict exist. Sticky until `reset()`. */
  | 'done'
  /** The frame the tag defines cannot be built and more frames will not change it (a tilted or contradicting mount). Sticky. */
  | 'failed'
  /** `fallbackAfterMs` passed without a result: the flow offers taps. Sticky. */
  | 'timed-out'

/** Facts about the latest frame, for a HUD and for `?debug=tag`. Null where the frame did not have the thing. */
export interface TagLatest {
  sidePx: number | null
  ambiguityRatio: number | null
  viewAngleDeg: number | null
  rangeM: number | null
  reprojectionRmsPx: number | null
  angularSpeedDegPerS: number | null
}

export interface TagCounts {
  framesOffered: number
  /** Frames in which the subject tag was read. */
  framesWithTag: number
  /** Frames that became pose observations. */
  accepted: number
  /** Frames the detector read with another id than the subject's. */
  otherTag: number
  intrinsics: number
  /** Frames whose corners could not be solved for a pose at all (not a square seen from in front). */
  unsolved: number
  tooSmall: number
  cornerFit: number
  tooFast: number
  /** Frames whose best solution read nearer than `minRangeM` or farther than `maxRangeM`. */
  range: number
  /** Frames whose tag was seen more than `maxViewAngleDeg` off its face. */
  viewAngle: number
  /** Frames whose corners fit the square worse than `maxReprojectionRmsPx`. */
  reprojection: number
  frameShifts: number
}

export interface TagSessionSuccess {
  status: 'ok'
  fused: FusedTagPose
  evidence: FiducialEvidence
  verdict: FiducialVerdict
  frame: TagFrame
  scale: { sessionUnitsPerMetre: number; source: FiducialScaleSource; lambda: number | null; offFraction: number | null }
  /** Notes about the frame (the floor from the mount height, the floor disagreeing with it). */
  flags: TagFrameFlag[]
}

export type TagSessionFailureReason =
  /** The fusion's own rejection: the number of frames, the spread, the ambiguity, and the rest (`FusedTagPose.reason`). */
  | FusionRejection
  | 'needs-motion'
  | 'needs-scale'
  | TagFrameRefusal

export interface TagSessionFailure {
  status: 'failed'
  reason: TagSessionFailureReason
  fused: FusedTagPose | null
}

export type TagSessionResult = TagSessionSuccess | TagSessionFailure

export interface TagSessionState {
  phase: TagSessionPhase
  /** 0 to 1: the share of the gates met, the least of frames, time and motion. 1 only when the result exists. */
  progress: number
  hint: TagHint | null
  latest: TagLatest
  counts: TagCounts
  identity: { subjectTagId: number | null; frames: number; window: number }
  result: TagSessionSuccess | null
  /** Set once the session ended without a result: why. */
  failure: TagSessionFailure | null
}

// -------------------------------------------------------------------------------------------
// The session
// -------------------------------------------------------------------------------------------

interface Kept {
  tagId: number
  tMs: number
  obs: TagObservation
  sidePx: number
  ratio: number
  viewAngleDeg: number
  speed: number
}

function emptyCounts(): TagCounts {
  return { framesOffered: 0, framesWithTag: 0, accepted: 0, otherTag: 0, intrinsics: 0, unsolved: 0, tooSmall: 0, cornerFit: 0, tooFast: 0, range: 0, viewAngle: 0, reprojection: 0, frameShifts: 0 }
}

function median(values: readonly number[]): number {
  const a = Array.from(values).sort((x, y) => x - y)
  const n = a.length
  return n === 0 ? 0 : n % 2 ? a[(n - 1) / 2]! : 0.5 * (a[n / 2 - 1]! + a[n / 2]!)
}

/** Largest distance between any two camera positions, in session units, and the largest turn between any two orientations, degrees. */
function cameraExtent(poses: readonly Pose[]): { travel: number; turnDeg: number } {
  let travel = 0
  let turnDeg = 0
  const mats = poses.map((p) => quatToMatrix(p.rotation))
  for (let i = 0; i < poses.length; i++) {
    for (let j = i + 1; j < poses.length; j++) {
      const a = poses[i]!.position
      const b = poses[j]!.position
      travel = Math.max(travel, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
      turnDeg = Math.max(turnDeg, rotationAngleBetweenDeg(mats[i]!, mats[j]!))
    }
  }
  return { travel, turnDeg }
}

export class TagSession {
  private readonly config: TagSessionConfig
  private readonly gates: Readonly<FiducialGates>
  private readonly tagSizeM: number
  private readonly fallbackAfterMs: number

  private kept: Kept[] = []
  private window: Array<number | null> = []
  private startedAtMs: number | null = null
  private epoch: number | null = null
  private lastFuseAt = 0
  private phase: TagSessionPhase = 'searching'
  private hint: TagHint | null = { code: 'no-tag' }
  private latest: TagLatest = { sidePx: null, ambiguityRatio: null, viewAngleDeg: null, rangeM: null, reprojectionRmsPx: null, angularSpeedDegPerS: null }
  private counts: TagCounts = emptyCounts()
  private lockedTagId: number | null = null
  private progress = 0
  private result: TagSessionSuccess | null = null
  private failure: TagSessionFailure | null = null
  /** What the last attempt at a result said to do, kept for the frames between attempts so that the hint does not flicker. Null when nothing is being asked. */
  private standingHint: TagHint | null = null

  constructor(config: TagSessionConfig, gates: Readonly<FiducialGates> = DEFAULT_FIDUCIAL_GATES) {
    if (!(Number.isFinite(config.printedSizeMm) && config.printedSizeMm > 0)) throw new RangeError(`printed size ${config.printedSizeMm} mm is not a positive number`)
    const fraction = config.quadFraction ?? 1
    if (!(Number.isFinite(fraction) && fraction > 0 && fraction <= 1)) throw new RangeError(`quad fraction ${fraction} is not a number above 0 and at most 1`)
    if (config.expected && config.expected.family !== config.family) throw new RangeError(`the registered marker is in family ${config.expected.family}, and this session reads ${config.family}`)
    this.config = config
    this.gates = gates
    this.tagSizeM = (config.printedSizeMm * fraction) / 1000
    this.fallbackAfterMs = config.fallbackAfterMs ?? FALLBACK_TO_TAPS_MS
  }

  /** Forget everything and look again. The configuration stays. */
  reset(): void {
    this.kept = []
    this.window = []
    this.startedAtMs = null
    this.epoch = null
    this.lastFuseAt = 0
    this.phase = 'searching'
    this.hint = { code: 'no-tag' }
    this.latest = { sidePx: null, ambiguityRatio: null, viewAngleDeg: null, rangeM: null, reprojectionRmsPx: null, angularSpeedDegPerS: null }
    this.counts = emptyCounts()
    this.lockedTagId = null
    this.progress = 0
    this.result = null
    this.failure = null
    this.standingHint = null
  }

  state(): TagSessionState {
    return {
      phase: this.phase,
      // 1 only with the result: a read that has every share of its gates and is still being judged, or was refused, is not finished.
      progress: this.result ? 1 : Math.min(this.progress, MAX_PROGRESS_WITHOUT_RESULT),
      hint: this.hint,
      latest: { ...this.latest },
      counts: { ...this.counts },
      identity: { subjectTagId: this.subjectTagId(), frames: this.identityFrames(), window: this.window.length },
      result: this.result,
      failure: this.failure,
    }
  }

  /** The tag the session is reading: the registered one, or the first id read often enough, or null. */
  private subjectTagId(): number | null {
    return this.config.expected ? this.config.expected.tagId : this.lockedTagId
  }

  private identityFrames(): number {
    const id = this.subjectTagId()
    return id === null ? 0 : this.window.filter((w) => w === id).length
  }

  /**
   * Take one frame. Returns the state after it. A frame offered after the session ended (`'done'`, `'failed'` or
   * `'timed-out'`) is ignored: `reset()` begins again.
   */
  offer(frame: TagFrameInput): TagSessionState {
    if (this.phase === 'done' || this.phase === 'failed' || this.phase === 'timed-out') return this.state()
    this.counts.framesOffered++
    if (this.startedAtMs === null) this.startedAtMs = frame.timestampMs

    // A new epoch is a new frame of reference: what was kept is not in it.
    let shifted = false
    if (frame.epoch !== undefined) {
      if (this.epoch !== null && frame.epoch !== this.epoch) {
        const offered = this.counts.framesOffered
        const startedAt = this.startedAtMs
        const shifts = this.counts.frameShifts + 1
        this.reset()
        this.counts.framesOffered = offered
        this.counts.frameShifts = shifts
        this.startedAtMs = startedAt
        shifted = true
      }
      this.epoch = frame.epoch
    }
    this.latest = { sidePx: null, ambiguityRatio: null, viewAngleDeg: null, rangeM: null, reprojectionRmsPx: null, angularSpeedDegPerS: frame.angularSpeedDegPerS }

    const hit = this.pick(frame.detections)
    // Identity window: the id read in this frame, or nothing. Another tag in view is not this tag's identity.
    this.window.push(hit ? hit.id : null)
    while (this.window.length > this.gates.identityWindowFrames) this.window.shift()
    if (!this.config.expected && this.lockedTagId === null) this.lockedTagId = this.leadingId()

    let hint: TagHint | null = shifted ? { code: 'frame-shifted' } : null
    if (!hit) {
      const other = !this.config.expected ? null : frame.detections.find((d) => d.family === this.config.expected!.family && d.id !== this.config.expected!.tagId)
      if (other) this.counts.otherTag++
      this.hint = hint ?? (other ? { code: 'other-tag', tagId: other.id } : { code: 'no-tag' })
      this.phase = this.kept.length > 0 ? 'collecting' : 'searching'
      return this.checkTimeout(frame.timestampMs)
    }

    this.counts.framesWithTag++
    const problem = intrinsicsProblem(frame.intrinsics)
    if (problem !== null) {
      this.counts.intrinsics++
      this.hint = hint ?? { code: 'bad-intrinsics' }
      return this.checkTimeout(frame.timestampMs)
    }

    const solution = solveTagPose(hit.corners, frame.intrinsics, this.tagSizeM)
    if (solution) this.noteSolution(solution)
    else this.counts.unsolved++
    this.latest.sidePx = hit.sidePx
    const observation = observationFromDetection(hit, frame.intrinsics, frame.cameraPose, frame.timestampMs)
    const g = this.gates

    // The gates a frame must pass to count are the fusion's own (`cornersUsable`, `solutionRefusal`), so a frame counted here is a frame the fusion keeps,
    // and the hint is about the frames that count.
    let accepted = false
    if (hit.sidePx < g.minPoseSidePx) {
      this.counts.tooSmall++
      hint = hint ?? { code: 'move-closer', sidePx: hit.sidePx, neededPx: g.minPoseSidePx }
    } else if (!cornersUsable(observation, g.maxEdgeRmsPx, g.minEdgeInlierFraction)) {
      this.counts.cornerFit++
      hint = hint ?? { code: 'keep-uncovered' }
    } else if (!(frame.angularSpeedDegPerS !== null && frame.angularSpeedDegPerS < g.maxAngularSpeedDegPerS)) {
      this.counts.tooFast++
      hint = hint ?? { code: 'too-fast', degPerS: frame.angularSpeedDegPerS, limitDegPerS: g.maxAngularSpeedDegPerS }
    } else if (solution) {
      const refusal = solutionRefusal(solution.best, g)
      if (refusal === 'range') {
        this.counts.range++
        hint = hint ?? { code: 'range', rangeM: solution.best.rangeM, minM: g.minRangeM, maxM: g.maxRangeM }
      } else if (refusal === 'view-angle') {
        this.counts.viewAngle++
        hint = hint ?? { code: 'steep-view', viewAngleDeg: solution.best.viewAngleDeg, limitDeg: g.maxViewAngleDeg }
      } else if (refusal === 'reprojection') {
        this.counts.reprojection++
        hint = hint ?? { code: 'poor-fit', rmsPx: solution.best.reprojectionRmsPx, limitPx: g.maxReprojectionRmsPx }
      } else {
        accepted = true
        this.counts.accepted++
        this.kept.push({
          tagId: hit.id,
          tMs: frame.timestampMs,
          obs: observation,
          sidePx: hit.sidePx,
          ratio: Math.min(solution.ambiguityRatio, RATIO_CAP),
          viewAngleDeg: solution.best.viewAngleDeg,
          speed: frame.angularSpeedDegPerS!,
        })
        if (this.kept.length > MAX_OBSERVATIONS) this.kept.shift()
      }
    }

    this.phase = 'collecting'
    this.hint = hint
    if (accepted) this.advance()
    if (!this.result && this.phase === 'collecting' && this.hint === null) this.hint = this.standingHint ?? this.defaultHint()
    return this.checkTimeout(frame.timestampMs)
  }

  /** The tag this frame is about: the registered tag if one is read, else the best read of any id (before a subject is chosen) or of the subject. */
  private pick(detections: readonly FiducialDetection[]): FiducialDetection | null {
    const expected = this.config.expected
    const subject = this.subjectTagId()
    let best: FiducialDetection | null = null
    for (const d of detections) {
      if (expected ? !(d.family === expected.family && d.id === expected.tagId) : subject !== null && d.id !== subject) continue
      if (d.family !== this.config.family && !expected) continue
      if (!best || d.quality > best.quality) best = d
    }
    return best
  }

  /** The id read in at least `identityMinFrames` of the window, or null. More than half of the window is needed, so there is never a tie. */
  private leadingId(): number | null {
    const tally = new Map<number, number>()
    for (const w of this.window) if (w !== null) tally.set(w, (tally.get(w) ?? 0) + 1)
    let best: number | null = null
    let bestN = 0
    for (const [id, n] of tally) {
      if (n >= bestN) {
        best = id
        bestN = n
      }
    }
    return bestN >= this.gates.identityMinFrames ? best : null
  }

  private noteSolution(solution: TagPoseSolution): void {
    this.latest.ambiguityRatio = Math.min(solution.ambiguityRatio, RATIO_CAP)
    this.latest.viewAngleDeg = solution.best.viewAngleDeg
    this.latest.rangeM = solution.best.rangeM
    this.latest.reprojectionRmsPx = solution.best.reprojectionRmsPx
  }

  /** The hint when nothing is wrong with the frame: how it is going. */
  private defaultHint(): TagHint {
    const subject = this.subjectFrames()
    const ratio = this.latest.ambiguityRatio
    const viewAngle = this.latest.viewAngleDeg
    if (isAmbiguousView(ratio, viewAngle)) return { code: 'ambiguous-view' }
    const motion = this.motionShare(subject)
    if (subject.length >= this.gates.minFrames && motion < 1) return { code: 'sweep', mount: this.config.mount ?? null }
    // Frames counted toward the number needed: not more, for the person is told "12 of 12" and not "36 of 12".
    return { code: 'reading', accepted: Math.min(subject.length, this.gates.minFrames), needed: this.gates.minFrames }
  }

  private subjectFrames(): Kept[] {
    const id = this.subjectTagId() ?? this.kept[this.kept.length - 1]?.tagId ?? null
    return id === null ? [] : this.kept.filter((k) => k.tagId === id)
  }

  /** Share of the motion gate met by the subject frames: the larger of travel and turn, in units of the gate. Travel counts only when the metre is known. */
  private motionShare(frames: readonly Kept[], metresPerUnit: number | null = this.config.scaleKind === 'metric' ? 1 : null): number {
    if (frames.length < 2) return 0
    const { travel, turnDeg } = cameraExtent(frames.map((f) => f.obs.cameraPose))
    const travelShare = metresPerUnit === null ? 0 : (travel * metresPerUnit) / this.gates.minTravelM
    return Math.min(1, Math.max(travelShare, turnDeg / this.gates.minTurnDeg))
  }

  /** After a frame was kept: update progress, and fuse once the gates on the frames themselves are met. */
  private advance(): void {
    const subject = this.subjectFrames()
    const durationMs = subject.length > 1 ? subject[subject.length - 1]!.tMs - subject[0]!.tMs : 0
    const framesShare = Math.min(1, subject.length / this.gates.minFrames)
    const timeShare = Math.min(1, durationMs / this.gates.minDurationMs)
    this.progress = Math.min(framesShare, timeShare, this.motionShare(subject))

    if (!this.framesReady(subject, durationMs)) return
    if (this.counts.accepted - this.lastFuseAt < FUSE_EVERY_OBSERVATIONS) return
    this.lastFuseAt = this.counts.accepted
    const outcome = this.evaluate(subject, durationMs, true)
    if (outcome.status === 'ok') {
      this.deliver(outcome)
      return
    }
    this.standingHint = this.hintFor(outcome)
    this.hint = this.standingHint
    if (outcome.reason === 'tilted' || outcome.reason === 'mount-mismatch' || outcome.reason === 'bad-height') {
      this.failure = outcome
      this.phase = 'failed'
    }
  }

  /** Whether the frames kept meet the gates on the frames themselves: their number, their span in time, and, with a registered marker, its identity. */
  private framesReady(subject: readonly Kept[], durationMs: number): boolean {
    if (subject.length < this.gates.minFrames || durationMs < this.gates.minDurationMs) return false
    if (this.config.expected && this.identityFrames() < this.gates.identityMinFrames) return false
    if (!this.config.expected && this.subjectTagId() === null) return false
    return true
  }

  private deliver(result: TagSessionSuccess): void {
    this.result = result
    this.phase = 'done'
    this.hint = null
    this.standingHint = null
    this.progress = 1
  }

  /** The hint a failed attempt gives: what to change. */
  private hintFor(f: TagSessionFailure): TagHint | null {
    const g = this.gates
    switch (f.reason) {
      case 'ambiguous':
        return { code: 'ambiguous-view' }
      case 'spread': {
        // Only the figures that are over their own gate: the text says what failed, not a number that is fine beside a limit that is not.
        const over = (value: number | undefined, limit: number): number | null => (value !== undefined && Number.isFinite(value) && value > limit ? value : null)
        return {
          code: 'spread',
          poseSpreadM: over(f.fused?.poseSpreadM, g.maxPoseSpreadM),
          headingSpreadDeg: over(f.fused?.headingSpreadDeg, g.maxHeadingSpreadDeg),
          rotationSpreadDeg: over(f.fused?.rotationSpreadDeg, g.maxRotationSpreadDeg),
        }
      }
      case 'too-few-frames':
        // The frames offered are enough and pass every per-frame gate, so the fusion left some out as far from the others: the readings disagree.
        return { code: 'spread', poseSpreadM: null, headingSpreadDeg: null, rotationSpreadDeg: null }
      case 'needs-motion':
        return { code: 'sweep', mount: this.config.mount ?? null }
      case 'needs-scale':
        return { code: 'move-for-scale', purpose: this.config.scaleKind === 'metric' ? 'print-check' : 'unit' }
      case 'tilted':
        return { code: 'tilted', normalY: f.fused?.pose ? tagNormalY(f.fused.pose) : 0 }
      case 'mount-mismatch':
        return { code: 'mount-mismatch', expected: this.config.mount ?? 'wall' }
      case 'bad-height':
        return { code: 'bad-height' }
      case 'no-floor':
        return { code: 'need-floor' }
      case 'too-small':
        return { code: 'move-closer', sidePx: this.latest.sidePx ?? 0, neededPx: g.minPoseSidePx }
      case 'corner-fit':
        return { code: 'keep-uncovered' }
      default:
        return null
    }
  }

  /**
   * Try to turn the subject frames into a result now, whatever the gates on their number and span say, and say why not if
   * it cannot be done. Does not end the session or change its state: it is what `offer` calls once the gates on the frames are
   * met, and what a caller (a debug view, a test) may call at any time.
   */
  finish(): TagSessionResult {
    const subject = this.subjectFrames()
    const durationMs = subject.length > 1 ? subject[subject.length - 1]!.tMs - subject[0]!.tMs : 0
    return this.evaluate(subject, durationMs)
  }

  /**
   * `awaitScaleCheck`: on a metric runtime, a read whose print-scale check could not be made (the camera has not travelled `MIN_SCALE_BASELINE_M`) is not
   * a result yet but a request for movement (`'needs-scale'`), because a session that finished at 0.2 m would have no way to be told to move 0.1 m more.
   * `finish()` and the end of the time allowed leave it false: they take the read as it is, provisional, with the check named as not done.
   */
  private evaluate(subject: readonly Kept[], durationMs: number, awaitScaleCheck = false): TagSessionResult {
    const gates = this.gates
    const expected = this.config.expected
    const tagId = subject[0]?.tagId ?? null
    if (tagId === null) return { status: 'failed', reason: 'no-observations', fused: null }
    const observations = subject.map((k) => k.obs)

    // The unit. On a metric runtime it is 1 and the tag's own estimate is a check; otherwise it is the estimate.
    const estimate = estimateSessionScale(observations, this.tagSizeM, { minSidePx: gates.minPoseSidePx, minRangeM: gates.minRangeM, maxRangeM: gates.maxRangeM, maxReprojectionRmsPx: gates.maxReprojectionRmsPx })
    const metric = this.config.scaleKind === 'metric'
    let units: number
    let scaleSource: FiducialScaleSource
    if (metric) {
      units = 1
      scaleSource = 'runtime-metric'
    } else if (estimate) {
      units = estimate.sessionUnitsPerMetre
      scaleSource = 'tag-estimate'
    } else {
      return { status: 'failed', reason: 'needs-scale', fused: null }
    }

    const fused = fuseTagObservations(observations, {
      tagSizeM: this.tagSizeM,
      sessionUnitsPerMetre: units,
      minFrames: gates.minFrames,
      minSidePx: gates.minPoseSidePx,
      maxNormalDeviationDeg: gates.maxNormalDeviationDeg,
      maxPoseSpreadM: gates.maxPoseSpreadM,
      maxHeadingSpreadDeg: gates.maxHeadingSpreadDeg,
      maxRotationSpreadDeg: gates.maxRotationSpreadDeg,
      maxReprojectionRmsPx: gates.maxReprojectionRmsPx,
      minRangeM: gates.minRangeM,
      maxRangeM: gates.maxRangeM,
      maxViewAngleDeg: gates.maxViewAngleDeg,
      maxEdgeRmsPx: gates.maxEdgeRmsPx,
      minEdgeInlierFraction: gates.minEdgeInlierFraction,
    })
    if (fused.status !== 'ok' || !fused.pose) return { status: 'failed', reason: fused.reason ?? 'no-observations', fused }

    const motion = cameraExtent(subject.map((k) => k.obs.cameraPose))
    const travelM = motion.travel / units
    if (travelM < gates.minTravelM && motion.turnDeg < gates.minTurnDeg) return { status: 'failed', reason: 'needs-motion', fused }

    const floor = this.config.floor?.() ?? { floorY: null, mountHeightM: null }
    const frame = tagFrameTransform(fused, { floorY: floor.floorY, mountHeightM: floor.mountHeightM, mount: this.config.mount ?? null, sessionUnitsPerMetre: units })
    if (frame.status === 'refused') return { status: 'failed', reason: frame.reason, fused }

    const lambda = estimate ? estimate.sessionUnitsPerMetre : null
    if (metric && lambda === null && awaitScaleCheck) return { status: 'failed', reason: 'needs-scale', fused }
    const offFraction = metric && lambda !== null ? lambda - 1 : null
    const evidence: FiducialEvidence = {
      tagId,
      family: this.config.family,
      expectedTagId: expected ? expected.tagId : null,
      identityFrames: this.identityFrames(),
      identityWindow: this.window.length,
      printedSizeMm: this.config.printedSizeMm,
      sizeSource: this.config.sizeSource,
      mount: frame.mount,
      poseSpreadM: fused.poseSpreadM,
      headingSpreadDeg: fused.headingSpreadDeg,
      rotationSpreadDeg: fused.rotationSpreadDeg,
      reprojectionRmsPx: fused.reprojectionRmsPx,
      rangeM: fused.rangeM,
      nFrames: fused.nFrames,
      durationMs,
      cameraTravelM: travelM,
      cameraTurnDeg: motion.turnDeg,
      ambiguityRatio: median(subject.map((k) => k.ratio)),
      viewAngleDeg: median(subject.map((k) => k.viewAngleDeg)),
      sidePx: median(subject.map((k) => k.sidePx)),
      maxAngularSpeedDegPerS: Math.max(...subject.map((k) => k.speed)),
      sessionUnitsPerMetre: units,
      scaleSource,
      scaleOffFraction: offFraction,
      scaleBaselineM: estimate ? estimate.baselineM : null,
      scaleResidualM: estimate ? estimate.residualRms / estimate.sessionUnitsPerMetre : null,
    }
    return {
      status: 'ok',
      fused,
      evidence,
      verdict: fiducialVerdict(evidence, gates),
      frame,
      scale: { sessionUnitsPerMetre: units, source: scaleSource, lambda, offFraction },
      flags: frame.flags,
    }
  }

  private checkTimeout(nowMs: number): TagSessionState {
    if (!this.result && this.phase !== 'failed' && this.startedAtMs !== null && nowMs - this.startedAtMs >= this.fallbackAfterMs) {
      // A read that is complete except for a print-scale check the camera's travel never allowed is kept, provisional and saying so, rather than thrown away.
      const subject = this.subjectFrames()
      const durationMs = subject.length > 1 ? subject[subject.length - 1]!.tMs - subject[0]!.tMs : 0
      const last = this.framesReady(subject, durationMs) ? this.evaluate(subject, durationMs) : null
      if (last?.status === 'ok') this.deliver(last)
      else this.phase = 'timed-out'
    }
    return this.state()
  }
}

/** The vertical component of a fused tag's normal. */
function tagNormalY(pose: Pose): number {
  return quatToMatrix(pose.rotation)[5]!
}
