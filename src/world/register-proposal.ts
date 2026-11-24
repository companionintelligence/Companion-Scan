/**
 * What the `place-register` job hands the editor, and the rules for turning it
 * into a scan patch.
 *
 * The server half (server/register/scan_match.ts, place_register.ts) produces a
 * {@link PlaceRegisterResult} and stores it as a job artifact; the editor half
 * (src/viewer/register-proposal.ts) reads it back, previews it and, when a
 * person presses Apply, writes an ordinary scan EditPatch. Both halves import
 * this one file, which is why it lives here and not beside either of them: it
 * has no Node references and no THREE, so the browser, the server and a Node
 * test can all load it (ADR 0002).
 *
 * ## What a proposal is, and is not
 *
 * A proposal is a measurement and a suggestion. It is never applied by the
 * server (owner decision D17), it never touches `scan.status`, and it never
 * touches the scan's raw `sessionToProject`: the sidecar keeps what the capture
 * measured. The refined placement is the EditPatch a person applies, and the
 * number that backs it travels with the patch as `provenance.residualM`.
 *
 * ## Conventions
 *
 * Matrices are column-major `number[16]`, the layout of `scan.localToWorld`,
 * `THREE.Matrix4.fromArray` and `transformPoint` in ./geo.ts. A proposal's
 * `transform` is a correction **in the Place frame**: it maps a point where the
 * new scan sits now to where it should sit. The new `localToWorld` is therefore
 * `transform · localToWorld`, and {@link multiplyMat4} is the one place that
 * product is taken, so the server's guard and the editor's Apply cannot differ.
 * Yaw is a rotation about +Y (up) by the right-hand rule, the sense
 * `composeYUpTransform` in ./geo.ts uses.
 */
import type { EditPatch, EditPatchProvenance, Quat, ScanManifest, Vec3, WorldJob } from './types.ts'
import { decomposeMat4, isMatrix16, matricesAgree, multiplyMat4 } from './mat4.ts'
import { wholeCentimetres } from './distance-text.ts'

/** `EditPatchProvenance.source` for a patch applied from a place-register proposal. */
export const PLACE_REGISTER_SOURCE = 'place-register' as const
/** The job artifact that carries a {@link PlaceRegisterResult}. */
export const PLACE_REGISTER_PROPOSAL_ARTIFACT = 'place-register-proposal'
/** The job artifact a run leaves when there was nothing to compare. Its metadata is `{ reason, message }`. */
export const PLACE_REGISTER_SKIP_ARTIFACT = 'place-register-skip'

/**
 * Why a comparison produced no transform. Every one of these means "no move is
 * proposed"; none means "the scans are wrong". The matcher reports the first gate
 * that failed, in the order listed by `matchScans`.
 */
export type RegistrationRefusal =
  /** Fewer wall and obstacle cells than the matcher needs in one of the two scans. */
  | 'too-few-points'
  /** A scan wider than the matcher's working size. */
  | 'too-large'
  /** One of the scans shows no floor to measure heights from. */
  | 'no-floor'
  /** Both floors were found and sit further apart than the vertical bound: probably another level. */
  | 'floor-mismatch'
  /** Too little of the smaller scan lines up with the other at the best position found. */
  | 'low-overlap'
  /** What lines up does not line up closely enough. */
  | 'loose-fit'
  /**
   * The walls do not settle one position: another place within the bound fits about as well (a symmetric room,
   * a row of pillars), or the score barely changes as the scan slides (a corridor, two parallel walls, one wall).
   */
  | 'ambiguous'
  /** The best match needs a bigger move than the named bound allows. */
  | 'correction-too-large'
  /** Every gate passed and the combined score is still below the acceptance score. */
  | 'low-score'

/** The named limits a correction is held to. Each is adopted, not measured (ADR 0005 rule 5). */
export interface CorrectionBound {
  /** Largest move of the scan's centre across the floor, metres. */
  translationM: number
  /** Largest turn about the vertical axis, degrees. */
  yawDeg: number
  /** Largest height change, metres. */
  dyM: number
}

/**
 * How big the best match's correction is, set against the bound it is held to.
 * Present on a refusal too, when the matcher got as far as a best position: the
 * size of a refused correction is the useful part of "too large".
 */
export interface BoundedCorrection {
  /** How far the scan's centre moves across the floor, metres. */
  translationM: number
  /** The turn, degrees. Positive is the right-hand rule about +Y (up). */
  yawDeg: number
  /** The height change, metres. 0 unless both floors were measured. */
  dyM: number
  /** The farthest any wall cell of the scan moves, metres. Information only; the bound is on the three above. */
  maxShiftM: number
  /** True when translation, yaw and height are all inside {@link CorrectionBound}. */
  withinBound: boolean
  bound: CorrectionBound
}

/**
 * Where one scan's floor came from. `'cloud'`: its own lowest well-supported layer, believed.
 * `'hint'`: the cloud showed none, so the calibration's promise (project y = 0) was used.
 * `'hint-over-cloud'`: the cloud's lowest layer sat too far from that promise to be a floor
 * (a platform, a step, a ceiling), so the promise was used instead.
 */
export type FloorSource = 'cloud' | 'hint' | 'hint-over-cloud'

/** What the matcher measured along the way. Kept so a later tuning run can see why a pair passed or failed. */
export interface RegistrationDetails {
  /** Wall and obstacle cells the new scan contributed. */
  movingCells: number
  /** Wall and obstacle cells the reference contributed. */
  referenceCells: number
  /** Share of the new scan's cells that sit within the match gate of a reference cell at the best position. */
  movingMatchedFraction: number
  /** Share of the reference's cells that sit within the match gate of a new-scan cell at the best position. */
  referenceMatchedFraction: number
  /**
   * 0 to 1: how much better the best position is than the best one somewhere else. 1 means nothing
   * comparable was found elsewhere in the search window; 0 means a position elsewhere is as good.
   */
  distinctiveness: number
  /** 0 to 1: how close the lined-up cells are. 1 at or under a 4 cm residual, falling to 0 at the 8 cm residual gate. */
  fit: number
  /** Best other local maximum of the coarse score over the best position's score, 0 to 1. Near 1 means a second place fits as well. */
  peakRatio: number
  /**
   * How far the region of near-best positions reaches, metres: every position that scores at least 85% of the
   * best, joined to it. Small means the walls pin the scan down; null means the region runs to the edge of the
   * search window, so the position is not pinned. A turn counts as the distance the scan's typical cell moves.
   */
  nearBestReachM: number | null
  /** True when both floors were measured from the clouds, so `dyM` is a measurement and not 0 by default. */
  verticalChecked: boolean
  /** Where each floor came from. Only `'cloud'` on both sides makes `verticalChecked` true. Absent on records an earlier build wrote. */
  floors?: { reference: FloorSource; moving: FloorSource }
  /** How far the matcher searched, per axis, metres. */
  searchedTranslationM: number
  /** How far the matcher searched in yaw, degrees, each way. */
  searchedYawDeg: number
  /** What the global ambiguity probe found. Absent on records an earlier build wrote, and on a pair turned away before any search. */
  globalProbe?: GlobalProbe
  /** The numbers the starting acceptance values are judged on. Absent as `globalProbe` is. */
  evidence?: RegistrationEvidence
  /** How those numbers stand against the starting values. Absent as `globalProbe` is. */
  startingValues?: StartingValuesVerdict
  /** Set only when the two scans' units were different and the matcher searched for the size between them. */
  scale?: ScaleSearch
}

/**
 * The global ambiguity probe: the score is read again over a much wider window than the one a correction may use
 * (a coarse level over about 3 m and a full turn), looking for a second position that fits about as well as the
 * best, outside a zone around the best. The bounded window is where a move is applied; this window is where
 * "somewhere else fits as well" is detected, because a narrow window hides a symmetric room's other fits.
 */
export interface GlobalProbe {
  /** How far the probe looked, per axis, metres. */
  windowM: number
  /** How far the probe looked in yaw, degrees, each way. */
  windowYawDeg: number
  /** A position is "somewhere else" when it is farther than this from the best, metres, or turned farther than the next. */
  exclusionM: number
  exclusionYawDeg: number
  /**
   * The best score of a local maximum outside that zone, over the score at the best position, 0 to 1. 1 means a place
   * elsewhere fits as well as the best or better. Near 0 means nothing elsewhere comes close.
   */
  secondPeakRatio: number
  /** True when `secondPeakRatio` is at least `SYMMETRIC_PEAK_RATIO` (server/register/scan_match.ts): a symmetric room or a repeating plan. */
  symmetric: boolean
}

/**
 * The measurements the starting acceptance values are judged on, recorded for every pair that was searched, refused
 * or not, so DX9 can see where real pairs fall (docs/pipelines/place-register.md, "DX9").
 *
 * "Query" is whichever scan the search turned, the one that reaches less far, and "reference" is the other. The same
 * rule decides which scan turns whichever scan is new, so two scans of one room and a walk through several rooms
 * against one of them are judged by the same words either way round.
 */
export interface RegistrationEvidence {
  /**
   * The mean of a likelihood field (the distance of each of the query's cells to the nearest reference cell, through a
   * Gaussian of 10 cm) over the query's cells at the best position, 0 to 1. Null when the field was too large to build.
   * A bare score cannot tell a symmetric room from the right one: a square room scores 0.96 against itself at four turns.
   */
  fieldScore: number | null
  /**
   * How much the field score falls when the query slides 25 cm from the best position, the smallest fall over 16 directions
   * as a share of the score, 0 to 1. Near 0 means the position is not pinned in some direction (a corridor, two parallel
   * walls). Null as `fieldScore` is.
   */
  observability: number | null
  /** The share of the query's cells with a reference cell within the match gate at the best position, 0 to 1. */
  queryInlierShare: number
  /** The share of the reference's cells inside the query's footprint with a query cell within the gate, 0 to 1. */
  referenceCoverage: number
  /** RMS gap of the lined-up cells, metres. Null when none line up. */
  inlierRmsM: number | null
}

/** Which of the starting values a pair did not meet. */
export type StartingValue =
  | 'field-score'
  | 'global-peak-ratio'
  | 'observability'
  | 'query-inliers'
  | 'reference-coverage'
  | 'inlier-rms'

/** How a pair stands against the starting acceptance values. All of them must be met for a proposal to be offered. */
export interface StartingValuesVerdict {
  passed: boolean
  /** The values not met, in the order the job reports them. Empty when `passed`. */
  failed: StartingValue[]
}

/**
 * The search for the size between two scans, made when their sessions ran in different units (an 8th Wall session in its
 * own scale and a metric WebXR session): the new scan was tried at each of `steps` sizes from `minRatio` to `maxRatio`
 * times, and `recovered` is the size at which its walls fit best, as the factor the new scan must be scaled by.
 */
export interface ScaleSearch {
  searched: true
  steps: number
  minRatio: number
  maxRatio: number
  /** The factor to scale the new scan by. 1 when no size fits better than the one it has. */
  recovered: number
}

/**
 * The matcher's answer for one pair of scans.
 *
 * `status: 'proposed'` is the only case with a transform. A refusal still carries
 * the numbers it measured, so a person can see how close it was, but `transform`
 * is null: low overlap, an ambiguous position or an oversize move never leave
 * this function as something a caller could apply by accident.
 */
export interface RegistrationProposal {
  status: 'proposed' | 'refused'
  /** Column-major 4x4 correction in the Place frame. Null unless `status` is `'proposed'`. */
  transform: number[] | null
  /**
   * 0 to 1: how much of the smaller scan lines up with the other at the best position, taking whichever
   * scan is more fully explained by the other (a small scan inside a big one counts as fully overlapping).
   */
  overlapFraction: number
  /** RMS gap, metres, between the cells that line up. Null when none do. */
  inlierResidualM: number | null
  /**
   * 0 to 1: `overlapFraction` times `details.distinctiveness` times `details.fit`, as measured. Reported for
   * refusals too. A refusal for size alone (`'correction-too-large'`) keeps the high score its good match earned,
   * with the size reported beside it; an ambiguous or loose match scores under 0.3.
   */
  score: number
  boundedCorrection: BoundedCorrection | null
  /** Set exactly when `status` is `'refused'`. */
  reason: RegistrationRefusal | null
  details: RegistrationDetails
}

/** A scan as the job saw it, so a stale proposal can be told from a fresh one. */
export interface PlaceRegisterScanRef {
  scanId: string
  filename: string
  name: string
  /** The scan's `localToWorld` when the job ran. A proposal only applies while the scan still has this. */
  localToWorld: number[]
}

/** One reference scan compared with the new scan. Every pair the job tried gets a row, refused or not. */
export interface PlaceRegisterComparison {
  referenceScanId: string
  referenceName: string
  /** `'skipped'` means no comparison ran: the reference had no readable geometry. */
  status: 'proposed' | 'refused' | 'skipped'
  reason: RegistrationRefusal | 'no-geometry' | null
  score: number
  overlapFraction: number
  /** The residual RMS for this pair, metres; null when nothing lined up or nothing was compared. */
  inlierResidualM: number | null
  elapsedMs: number
  // What DX9 needs from every pair that was searched, refused or not. All absent on a row an earlier build wrote, and on
  // a pair turned away before any search.
  /** The share of the query's cells that line up (see {@link RegistrationEvidence}). */
  queryInlierShare?: number
  /** The share of the reference's cells inside the query's footprint that line up. */
  referenceCoverage?: number
  observability?: number | null
  fieldScore?: number | null
  /** The global probe's second peak over the best, 0 to 1; null when the pair was not probed. */
  globalPeakRatio?: number | null
  symmetric?: boolean
  /** The starting values the pair did not meet, when the matcher proposed a move and the job refused it for them. */
  startingValuesFailed?: StartingValue[]
  /** The factor the new scan was scaled by, when the units were searched. */
  scaleRecovered?: number
}

// ─── The photo method ────────────────────────────────────────────────────────

/**
 * Whether a `place-register` job's payload asks for the photo method: `method` is `'sfm'`, which is what the editor's "Check with
 * photos" queues. The server reads it to decide whether to run the photo method when the wall match has proposed, and the editor reads
 * the answer to its request with it: a scan that already has a check queued or running is answered with that job, which does not.
 */
export function requestsPhotoMethod(payload: WorldJob['payload']): boolean {
  return payload?.['method'] === 'sfm'
}

/** Which method made a proposal. A patch that carries no method came from the wall match. */
export type RegistrationMethod = 'scan-match' | 'sfm'

/**
 * Why the photo method did not run. None of these is a failure and none says anything about the scans.
 *  - `'off'`: the server's `PLACE_REGISTER_SFM` is not 1.
 *  - `'not-needed'`: the wall match proposed a move and nobody asked for photos.
 *  - `'colmap-missing'`: no COLMAP on this server.
 *  - `'no-place'`: the scan is in no Place whose folder can hold the working files.
 *  - `'no-keyframes'`: the scan has no camera photos on this server in the frame its calibration was made in.
 *  - `'no-reference'`: no other calibrated scan of the Place has camera photos.
 *  - `'frame-mismatch'`: the scans were calibrated against different generations of the Place's reference.
 *  - `'no-overlap'`: by their camera positions in the Place, no photo of the new scan looks at what a photo of the other scan does.
 */
export type SfmSkipReason =
  | 'off'
  | 'not-needed'
  | 'colmap-missing'
  | 'no-place'
  | 'no-keyframes'
  | 'no-reference'
  | 'frame-mismatch'
  | 'no-overlap'

/**
 * Why the photo method ran and offered nothing. Each means "no move is proposed"; none means the scans are wrong.
 *  - `'colmap-failed'`, `'timed-out'`: a COLMAP step failed, or the method ran past its time limit.
 *  - `'reference-weak'`: the earlier scan's photos did not join into one model, so there is nothing to register against.
 *  - `'too-few-registered'`, `'sub-model-split'`: too few of the new scan's photos found their place in the earlier scan's model,
 *    or they formed a model of their own.
 *  - `'reference-moved'`: the earlier scan's cameras did not stay where they were while the new photos were added.
 *  - `'reference-unusable'`, `'too-few-correspondences'`, `'collinear'`, `'degenerate-scale'`, `'high-residual'`,
 *    `'up-axis-disagrees'`: the solved camera path does not agree with the recorded one well enough to chain a placement
 *    through it (the refusals of server/register/sim3_chain.ts).
 *  - `'turn-uncertain'`: the camera paths are too small, or their positions too noisy, for the photos to fix the turn to within a
 *    degree (the one-standard-error uncertainty of the turn, which server/register/sfm_fit.ts estimates from the two fits, the earlier
 *    scan's and the new scan's, is past the limit). Either path being small is enough.
 *  - `'scale-out-of-range'`: the size between the two scans is beyond what a scan's placement can hold.
 *  - `'correction-too-large'`: the move is beyond the bound the wall match is held to as well.
 *  - `'sessions-disagree'`: two sessions of the new scan, in one frame, put it in different places.
 */
export type SfmRefusal =
  | 'colmap-failed'
  | 'timed-out'
  | 'reference-weak'
  | 'too-few-registered'
  | 'sub-model-split'
  | 'reference-moved'
  | 'reference-unusable'
  | 'too-few-correspondences'
  | 'collinear'
  | 'degenerate-scale'
  | 'high-residual'
  | 'up-axis-disagrees'
  | 'turn-uncertain'
  | 'scale-out-of-range'
  | 'correction-too-large'
  | 'sessions-disagree'

/** What became of one session of the new scan. Every session that was tried gets a row. */
export interface SfmSessionRow {
  sessionId: string
  /** Photos offered to COLMAP. */
  offeredImages: number
  /** Photos in the model that holds the earlier scan's. */
  registeredImages: number
  /** Photos COLMAP placed in a model of their own and not in that one. */
  inOtherModels: number
  /** Registered photos that also carry a recorded camera position, which is what the fit is made from. */
  fittedFrames: number
  /** Photos the fit was made without, because their solved camera was farther than the inlier gate from where the fit puts their recorded one. Absent on a record an earlier build wrote. */
  fitTrimmedFrames?: number
  /** Fitted photos whose camera lands within the inlier gate of its recorded position after the fit. */
  inliers: number
  /** RMS gap between the recorded camera positions and the solved ones after the fit, in Place metres. Null before a fit was made. */
  rmsM: number | null
  /**
   * How many units of the earlier scan's frame one unit of this session is: the unit mismatch between the two runtimes.
   * 1 when they agree. Null before a fit was made.
   */
  scaleRatio: number | null
  /**
   * The one-standard-error uncertainty of {@link scaleRatio} as a fraction of it, from how far from their middle the cameras are and
   * how well the fit left them agreeing (server/register/sfm_fit.ts). Null before a fit was made, or when the camera path has no extent.
   */
  sizeUncertainty?: number | null
  /** The same for the turn about up, degrees. */
  turnUncertaintyDeg?: number | null
  /** How far the solve tips this session's up axis against the earlier scan's, degrees. Null before a fit was made. */
  tiltDeg: number | null
  status: 'proposed' | 'refused'
  reason: SfmRefusal | null
  /** The detail the code cannot carry, with every path removed. Empty when there is none. */
  detail: string
  elapsedMs: number
}

/** What the photo method found for a scan, or why it did not run. */
export interface SfmResult {
  status: 'proposed' | 'refused' | 'skipped'
  /** The skip or refusal. Null when `status` is `'proposed'`. */
  reason: SfmSkipReason | SfmRefusal | null
  /** The detail a code cannot carry, such as the install hint for a missing COLMAP, with every path removed. */
  detail: string
  /** The scan whose photos the new scan's were registered against, as the job saw it. Null when nothing was chosen. */
  reference: PlaceRegisterScanRef | null
  /** Column-major 4x4 correction in the Place frame, as {@link RegistrationProposal.transform}. Null unless `status` is `'proposed'`. */
  transform: number[] | null
  boundedCorrection: BoundedCorrection | null
  /** RMS gap, metres, between the new scan's recorded camera positions and its solved ones, after the fit: the proposal's measured residual. */
  residualM: number | null
  /** The share of the new scan's photos that found their place, 0 to 1: the proposal's score when it is applied. */
  registeredFraction: number | null
  registeredImages: number
  offeredImages: number
  /** Photos whose solved camera lands within the inlier gate of its recorded position. */
  inliers: number
  /** The unit mismatch between the new scan's runtime and the earlier scan's (see {@link SfmSessionRow.scaleRatio}). Null when no fit was made. */
  scaleRatio: number | null
  /** The uncertainty of {@link scaleRatio} and of the turn, as for the session that made the proposal ({@link SfmSessionRow.sizeUncertainty}). Absent on a record an earlier build wrote. */
  sizeUncertainty?: number | null
  turnUncertaintyDeg?: number | null
  /** Photos the proposal's fit was made without ({@link SfmSessionRow.fitTrimmedFrames}). */
  fitTrimmedFrames?: number
  /** How far the correction tips the up axis, degrees. The proposal itself does not tip the scan. */
  tiltDeg: number | null
  /** Every session of the new scan that was tried. */
  sessions: SfmSessionRow[]
  /** Whether the earlier scan's model was made for this run or kept from an earlier one. Null when none was needed. */
  referenceModel: 'built' | 'reused' | null
  /** The Place frame generation the run was made against, or null when the Place records none. */
  frameId: string | null
  /** The limits this run used. */
  params: Record<string, number>
  elapsedMs: number
}

/**
 * How far apart the two methods' proposals put the new scan, measured at the middle of the scan. They are corrections of
 * one scan in one frame, so a disagreement is a measurement of how much the two methods' evidence differs.
 */
export interface MethodAgreement {
  /** The distance, metres, between the two methods' answers for the middle of the scan. */
  translationM: number
  /** The difference of the two turns about up, degrees, in the range -180 to 180. */
  yawDeg: number
  /**
   * The size of the photo method's correction over the wall match's, 1 when they agree. Absent on a record an earlier build wrote,
   * which is read as 1.
   */
  scaleRatio?: number
  /** True when all of them are inside {@link METHOD_AGREEMENT_BOUND}. */
  withinBound: boolean
  /** Where in the Place the middle of the scan was taken, x and z. */
  pivot: [number, number]
}

/**
 * How far the two methods may differ before the card says it will not prefer either. **Adopted, not measured (ADR 0005 rule
 * 5)**: the wall match's own match gate is 15 cm, a scan matched within 2 degrees is about 17 cm at 5 m, and a size within 5% is
 * about 25 cm at 5 m and a little more than one step of the wall match's size search (its sizes are 4.6% apart). **Revisit when**
 * DX9 gives the real spread between the two methods on pairs a person has judged.
 */
export const METHOD_AGREEMENT_BOUND = { translationM: 0.15, yawDeg: 2, sizeRatio: 0.05 } as const

/** Everything the editor needs to preview and apply one proposal. Stored as the job artifact's metadata. */
export interface PlaceRegisterResult {
  /**
   * The wall match's best comparison: the highest-scoring proposal, or the highest-scoring refusal when there was none.
   * When the wall match could not run at all (no readable cloud, and the photo method was asked for) this is a refusal for
   * too few wall points with nothing measured, and `comparisons` is empty.
   */
  proposal: RegistrationProposal
  moving: PlaceRegisterScanRef
  /** The reference scan `proposal` was measured against. */
  reference: PlaceRegisterScanRef
  comparisons: PlaceRegisterComparison[]
  /** The thresholds this run used, so a number in `proposal` can be read against them. */
  params: Record<string, number>
  comparedAt: string
  elapsedMs: number
  /** The photo method's answer. Absent on every record an earlier build wrote. */
  sfm?: SfmResult
  /** How far apart the two methods' proposals are. Present only when both proposed a move. */
  agreement?: MethodAgreement
}

// ─── Matrices ────────────────────────────────────────────────────────────────
//
// One copy of each, in ./mat4.ts (F-41). Re-exported here, where the server's place-register job and the editor's
// proposal cards already import them from.

export { isMatrix16, matricesAgree, multiplyMat4 }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Position, rotation and scale of a column-major affine matrix, as the Edit
 * gizmo's `serializeTransform` writes them beside `matrix`: three.js's
 * `Matrix4.decompose`, ported once in ./mat4.ts. Null for a matrix that is not
 * 16 finite numbers or has an axis of length 0.
 */
export function decomposeMatrix(m: readonly number[]): { position: Vec3; rotation: Quat; scale: Vec3 } | null {
  if (!isMatrix16(m)) return null
  if (!(Math.hypot(m[0]!, m[1]!, m[2]!) > 0 && Math.hypot(m[4]!, m[5]!, m[6]!) > 0 && Math.hypot(m[8]!, m[9]!, m[10]!) > 0)) return null
  return decomposeMat4(m)
}

// ─── Reading a proposal back out of a job ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readScanRef(value: unknown): PlaceRegisterScanRef | null {
  if (!isRecord(value)) return null
  const { scanId, filename, name, localToWorld } = value
  if (typeof scanId !== 'string' || scanId === '') return null
  if (typeof filename !== 'string' || filename === '') return null
  if (typeof name !== 'string') return null
  if (!isMatrix16(localToWorld)) return null
  return { scanId, filename, name, localToWorld }
}

/**
 * The proposal a completed `place-register` job carries, or null.
 *
 * The artifact came out of a JSON file, so every field the editor and the
 * server's guard rely on is checked here rather than trusted: a `'proposed'`
 * result without a 16-number transform, or with no measured residual, is not a
 * proposal. Anything else in the metadata is left alone.
 */
export function readPlaceRegisterResult(job: Pick<WorldJob, 'type' | 'status' | 'artifacts'>): PlaceRegisterResult | null {
  if (job.type !== 'place-register' || job.status !== 'completed') return null
  const metadata = job.artifacts?.find((artifact) => artifact.type === PLACE_REGISTER_PROPOSAL_ARTIFACT)?.metadata
  if (!isRecord(metadata)) return null

  const proposal = metadata['proposal']
  const moving = readScanRef(metadata['moving'])
  const reference = readScanRef(metadata['reference'])
  if (!isRecord(proposal) || !moving || !reference) return null

  const status = proposal['status']
  if (status !== 'proposed' && status !== 'refused') return null
  if (!isFiniteNumber(proposal['score']) || !isFiniteNumber(proposal['overlapFraction'])) return null
  const residual = proposal['inlierResidualM']
  if (residual !== null && !isFiniteNumber(residual)) return null

  const transform = proposal['transform']
  if (status === 'proposed') {
    if (!isMatrix16(transform) || !isFiniteNumber(residual)) return null
  } else if (transform !== null) {
    // A refusal never carries a transform. One that does is not something to offer for applying.
    return null
  }

  const comparisons = Array.isArray(metadata['comparisons']) ? metadata['comparisons'] as PlaceRegisterComparison[] : []
  const params = isRecord(metadata['params']) ? metadata['params'] as Record<string, number> : {}
  const sfm = readSfmResult(metadata['sfm'])
  const agreement = readAgreement(metadata['agreement'])
  return {
    proposal: proposal as unknown as RegistrationProposal,
    moving,
    reference,
    comparisons,
    params,
    comparedAt: typeof metadata['comparedAt'] === 'string' ? metadata['comparedAt'] : '',
    elapsedMs: isFiniteNumber(metadata['elapsedMs']) ? metadata['elapsedMs'] : 0,
    ...(sfm ? { sfm } : {}),
    // A difference between two methods is only meaningful when both are there, and a record that says otherwise is not believed.
    ...(agreement && sfm?.status === 'proposed' && status === 'proposed' ? { agreement } : {}),
  }
}

const SFM_STATUSES: ReadonlyArray<SfmResult['status']> = ['proposed', 'refused', 'skipped']

/**
 * The photo method's block of a stored artifact, or undefined when it is absent or is not one. As for the wall match,
 * a `'proposed'` result without a 16-number transform, or without a measured residual and share, is not a proposal, and
 * a refusal or a skip never carries a transform. A block that fails any of this is left out whole, so a damaged record
 * offers nothing to apply and the card says nothing about it.
 */
function readSfmResult(value: unknown): SfmResult | undefined {
  if (!isRecord(value)) return undefined
  const status = value['status']
  if (typeof status !== 'string' || !(SFM_STATUSES as readonly string[]).includes(status)) return undefined
  const transform = value['transform']
  const reference = value['reference'] === null || value['reference'] === undefined ? null : readScanRef(value['reference'])
  if (value['reference'] !== null && value['reference'] !== undefined && !reference) return undefined
  if (status === 'proposed') {
    if (!isMatrix16(transform) || !isFiniteNumber(value['residualM']) || !isFiniteNumber(value['registeredFraction']) || !reference) {
      return undefined
    }
  } else if (transform !== null && transform !== undefined) {
    return undefined
  }
  const number = (key: string, fallback = 0): number => isFiniteNumber(value[key]) ? value[key] as number : fallback
  const nullable = (key: string): number | null => isFiniteNumber(value[key]) ? value[key] as number : null
  return {
    status: status as SfmResult['status'],
    reason: typeof value['reason'] === 'string' ? value['reason'] as SfmResult['reason'] : null,
    detail: typeof value['detail'] === 'string' ? value['detail'] : '',
    reference,
    transform: status === 'proposed' ? transform as number[] : null,
    boundedCorrection: isRecord(value['boundedCorrection']) ? value['boundedCorrection'] as unknown as BoundedCorrection : null,
    residualM: nullable('residualM'),
    registeredFraction: nullable('registeredFraction'),
    registeredImages: number('registeredImages'),
    offeredImages: number('offeredImages'),
    inliers: number('inliers'),
    scaleRatio: nullable('scaleRatio'),
    // Absent on a record an earlier build wrote, and left absent here: nothing is read into a measurement that was not made.
    ...(isFiniteNumber(value['sizeUncertainty']) ? { sizeUncertainty: value['sizeUncertainty'] } : {}),
    ...(isFiniteNumber(value['turnUncertaintyDeg']) ? { turnUncertaintyDeg: value['turnUncertaintyDeg'] } : {}),
    ...(isFiniteNumber(value['fitTrimmedFrames']) ? { fitTrimmedFrames: value['fitTrimmedFrames'] } : {}),
    tiltDeg: nullable('tiltDeg'),
    sessions: Array.isArray(value['sessions']) ? value['sessions'] as SfmSessionRow[] : [],
    referenceModel: value['referenceModel'] === 'built' || value['referenceModel'] === 'reused' ? value['referenceModel'] : null,
    frameId: typeof value['frameId'] === 'string' ? value['frameId'] : null,
    params: isRecord(value['params']) ? value['params'] as Record<string, number> : {},
    elapsedMs: number('elapsedMs'),
  }
}

function readAgreement(value: unknown): MethodAgreement | undefined {
  if (!isRecord(value)) return undefined
  const { translationM, yawDeg, withinBound, pivot } = value
  if (!isFiniteNumber(translationM) || !isFiniteNumber(yawDeg) || typeof withinBound !== 'boolean') return undefined
  if (!Array.isArray(pivot) || pivot.length !== 2 || !pivot.every(isFiniteNumber)) return undefined
  const scaleRatio = value['scaleRatio']
  return {
    translationM,
    yawDeg,
    ...(isFiniteNumber(scaleRatio) && scaleRatio > 0 ? { scaleRatio } : {}),
    withinBound,
    pivot: [pivot[0] as number, pivot[1] as number],
  }
}

/**
 * One method's proposal in the form every consumer of a proposal reads: whether it proposed, the correction, the two numbers a
 * patch carries as its provenance, and the reference scan the correction was measured against. The editor's Apply, the server's
 * guard and the apply state all ask for a method's proposal through this, so they cannot read two different things.
 *
 * `score` is the wall match's score for `'scan-match'`; for `'sfm'` it is the share of the new scan's photos that found their
 * place, because the photo method has no composite score and a made-up one would be a claim nothing measured.
 */
export interface MethodProposal {
  method: RegistrationMethod
  status: 'proposed' | 'refused' | 'skipped'
  transform: number[] | null
  score: number
  residualM: number | null
  reference: PlaceRegisterScanRef
}

export function methodProposal(result: PlaceRegisterResult, method: RegistrationMethod = 'scan-match'): MethodProposal | null {
  if (method === 'scan-match') {
    const { proposal } = result
    return {
      method,
      status: proposal.status,
      transform: proposal.transform,
      score: proposal.score,
      residualM: proposal.inlierResidualM,
      reference: result.reference,
    }
  }
  const { sfm } = result
  if (!sfm || !sfm.reference) return null
  return {
    method,
    status: sfm.status,
    transform: sfm.transform,
    score: sfm.registeredFraction ?? 0,
    residualM: sfm.residualM,
    reference: sfm.reference,
  }
}

/** The methods of `result` that proposed a move, wall match first. */
export function proposedMethods(result: PlaceRegisterResult): RegistrationMethod[] {
  const methods: RegistrationMethod[] = []
  for (const method of ['scan-match', 'sfm'] as const) {
    if (methodProposal(result, method)?.status === 'proposed') methods.push(method)
  }
  return methods
}

// ─── Applying a proposal ─────────────────────────────────────────────────────

/** The body POSTed to `/worlds/:slug/patches`. An ordinary scan patch, plus where its numbers came from. */
export interface RegisterPatchBody {
  scope: 'scan'
  scanId: string
  /** The scan's filename, as the gizmo's scan-root patches use. */
  targetId: string
  transform: { matrix: number[]; position: Vec3; rotation: Quat; scale: Vec3 }
  provenance: EditPatchProvenance
}

/**
 * The patch that applies `result`'s proposal by `method`, or null when that method proposed nothing. The wall match is the
 * default, so every caller that predates the photo method asks for what it always did.
 *
 * The matrix is the scan's `localToWorld` at proposal time with the correction
 * applied on top, which is what `applyPatchToWorld` on the server stores and
 * what the viewer's `applyStoredPatches` puts on the scan root. Position,
 * rotation and scale ride along exactly as the Edit gizmo writes them. A photo-method patch
 * names its method in its provenance; a wall-match patch carries no method, as every patch
 * written before the photo method existed.
 */
export function buildRegisterPatch(
  result: PlaceRegisterResult,
  jobId: string,
  method: RegistrationMethod = 'scan-match',
): RegisterPatchBody | null {
  const { moving } = result
  const proposal = methodProposal(result, method)
  if (!proposal || proposal.status !== 'proposed' || !isMatrix16(proposal.transform) || !isFiniteNumber(proposal.residualM)) return null
  const matrix = multiplyMat4(proposal.transform, moving.localToWorld)
  const parts = decomposeMatrix(matrix)
  if (!parts) return null
  return {
    scope: 'scan',
    scanId: moving.scanId,
    targetId: moving.filename,
    transform: { matrix, ...parts },
    provenance: {
      source: PLACE_REGISTER_SOURCE,
      jobId,
      score: proposal.score,
      residualM: proposal.residualM,
      ...(method === 'sfm' ? { method } : {}),
    },
  }
}

/** The patch already written for this job, if any. One job is applied at most once. */
export function findAppliedRegisterPatch(patches: readonly EditPatch[], jobId: string): EditPatch | null {
  return patches.find((patch) =>
    patch.scope === 'scan' && patch.provenance?.source === PLACE_REGISTER_SOURCE && patch.provenance.jobId === jobId
  ) ?? null
}

/**
 * Where a proposal stands.
 *
 *  - `'applied'`: a patch with this job's id already exists. Checked first, because
 *    applying moves the scan, and a moved scan would otherwise read as stale.
 *  - `'refused'`: the job proposed no move.
 *  - `'stale'`: the new scan, or the reference it was measured against, is no longer
 *    where the job found it. The proposal described a different arrangement.
 *  - `'ready'`: nothing has moved since the job ran, so Apply is meaningful.
 */
export type RegisterApplyState = 'ready' | 'applied' | 'stale' | 'refused'

export function registerApplyState(
  result: PlaceRegisterResult,
  jobId: string,
  scans: readonly Pick<ScanManifest, 'scanId' | 'localToWorld'>[],
  patches: readonly EditPatch[],
  method: RegistrationMethod = 'scan-match',
): RegisterApplyState {
  if (findAppliedRegisterPatch(patches, jobId)) return 'applied'
  const proposal = methodProposal(result, method)
  if (!proposal || proposal.status !== 'proposed') return 'refused'
  const moving = scans.find((scan) => scan.scanId === result.moving.scanId)
  const reference = scans.find((scan) => scan.scanId === proposal.reference.scanId)
  if (!moving || !reference) return 'stale'
  if (!matricesAgree(moving.localToWorld, result.moving.localToWorld)) return 'stale'
  if (!matricesAgree(reference.localToWorld, proposal.reference.localToWorld)) return 'stale'
  return 'ready'
}

/** What the world looks like to the Apply step, and how it writes. Injected so the step can be tested without a DOM. */
export interface RegisterApplyDeps {
  scans(): readonly Pick<ScanManifest, 'scanId' | 'localToWorld'>[]
  patches(): readonly EditPatch[]
  /** Writes the patch and, on success, makes `patches()` and `scans()` reflect it. Rejects when the server refuses. */
  post(body: RegisterPatchBody): Promise<void>
}

export type RegisterApplyOutcome = 'applied' | 'already-applied' | 'stale' | 'refused'

/** Jobs whose patch is on its way to the server. A second press while it travels must not send a second one. */
const applying = new Set<string>()

/**
 * Applies a proposal once.
 *
 * Idempotent three ways: a patch for this job already in the world answers
 * `'already-applied'` without writing; a second press while the first is still
 * in flight answers the same; and the server refuses a second patch for one job
 * on its own (`guardRegistrationPatch`), so two tabs cannot both apply it.
 */
export async function applyRegistrationProposal(
  result: PlaceRegisterResult,
  jobId: string,
  deps: RegisterApplyDeps,
  method: RegistrationMethod = 'scan-match',
): Promise<RegisterApplyOutcome> {
  if (applying.has(jobId)) return 'already-applied'
  const state = registerApplyState(result, jobId, deps.scans(), deps.patches(), method)
  if (state === 'applied') return 'already-applied'
  if (state === 'stale') return 'stale'
  if (state === 'refused') return 'refused'
  const body = buildRegisterPatch(result, jobId, method)
  if (!body) return 'refused'
  applying.add(jobId)
  try {
    await deps.post(body)
  } finally {
    applying.delete(jobId)
  }
  return 'applied'
}

// ─── Words ───────────────────────────────────────────────────────────────────

/**
 * One short sentence per refusal. These say what was measured and nothing about the
 * scans being right or wrong; no line here says "aligned" or "verified", because
 * nothing this job does earns either word.
 */
const REFUSAL_TEXT: Record<RegistrationRefusal, string> = {
  'too-few-points': 'One of the scans has too few wall points to compare.',
  'too-large': 'One of the scans is too wide to compare.',
  'no-floor': 'No floor was found in one of the scans, so heights cannot be compared.',
  'floor-mismatch': 'The two floors sit too far apart in height. They may be different levels.',
  'low-overlap': 'Too little of the two scans lines up.',
  'loose-fit': 'The walls do not line up closely enough.',
  'ambiguous': 'The walls do not settle one position.',
  'correction-too-large': 'It would take a bigger move than this check allows.',
  'low-score': 'The match is too weak to propose a move.',
}

export function refusalText(reason: RegistrationRefusal | 'no-geometry' | null): string {
  if (reason === 'no-geometry') return 'The reference scan has no readable geometry.'
  return reason ? REFUSAL_TEXT[reason] : 'No move was proposed.'
}

/** The last line of a proposal's description. The card, which shows two methods, says it once for both. */
export const NOTHING_MOVES_LINE = 'Nothing moves until you apply it.'

/** Whole centimetres for a distance, or null for a number that does not exist: the one reading (./distance-text.ts). */
const centimetres = wholeCentimetres

function percent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
}

/** The lines the editor shows for one result. No claim here goes past what the matcher measured. */
export function describeRegisterResult(result: PlaceRegisterResult): { headline: string; lines: string[] } {
  const { proposal, reference } = result
  const lines: string[] = [`Compared with ${reference.name || reference.filename}.`]

  if (proposal.status !== 'proposed') {
    lines.unshift(refusalText(proposal.reason))
    if (proposal.reason !== 'too-few-points' && proposal.reason !== 'no-floor' && proposal.reason !== 'too-large') {
      lines.push(`${percent(proposal.overlapFraction)} of the smaller scan lines up.`)
    }
    return { headline: 'No move proposed', lines }
  }

  const move = proposal.boundedCorrection
  const shift = centimetres(move?.translationM)
  const turn = move && Number.isFinite(move.yawDeg) ? Math.abs(move.yawDeg).toFixed(1) : null
  const gap = centimetres(proposal.inlierResidualM)
  // `details` comes back out of a JSON artifact, so a record written by an older build may lack it.
  const lift = move && proposal.details?.verticalChecked === true ? centimetres(move.dyM) : null

  const headline = shift !== null && turn !== null
    ? `Proposed move: ${shift} cm and a ${turn}° turn`
    : 'Proposed move'
  lines.push(
    `${percent(proposal.overlapFraction)} of the smaller scan lines up${gap !== null ? `, about ${gap} cm apart` : ''}.`,
  )
  if (lift !== null && lift !== '0') lines.push(`Height changes by ${lift} cm.`)
  lines.push(`Score ${proposal.score.toFixed(2)} out of 1.`)
  lines.push(NOTHING_MOVES_LINE)
  return { headline, lines }
}

// ─── The photo method's words, and how the two methods compare ───────────────

/** One short sentence per reason the photo method did not run. */
const SFM_SKIP_TEXT: Record<SfmSkipReason, string> = {
  'off': 'Photo matching is turned off on this server.',
  'not-needed': 'Photo matching was not run, because the wall match proposed a move.',
  'colmap-missing': 'Photo matching needs COLMAP, and this server has none.',
  'no-place': 'Photo matching needs the scan to be in a Place.',
  'no-keyframes': 'This scan has no camera photos on the server.',
  'no-reference': 'No other calibrated scan in this Place has camera photos.',
  'frame-mismatch': 'These scans were calibrated against different versions of the Place reference.',
  'no-overlap': 'By their camera positions, none of this scan\'s photos looks at the same place as an earlier scan\'s.',
}

/** One short sentence per reason the photo method ran and proposed nothing. */
const SFM_REFUSAL_TEXT: Record<SfmRefusal, string> = {
  'colmap-failed': 'The photo solve failed.',
  'timed-out': 'The photo solve ran out of time.',
  'reference-weak': 'The earlier scan\'s photos did not join into one model.',
  'too-few-registered': 'Too few of this scan\'s photos found their place.',
  'sub-model-split': 'This scan\'s photos formed a model of their own.',
  'reference-moved': 'The earlier scan\'s photos moved during the solve, so the result cannot be used.',
  'reference-unusable': 'The earlier scan\'s photos could not be matched to its recorded camera path.',
  'too-few-correspondences': 'Too few photos have both a solved and a recorded camera position.',
  'collinear': 'The camera positions lie on a line, which cannot fix the turn.',
  'degenerate-scale': 'The photo solve gave no usable size for this scan.',
  'high-residual': 'The solved and recorded camera paths do not agree closely enough.',
  'up-axis-disagrees': 'The solve tips this scan against the earlier one.',
  'turn-uncertain': 'The camera paths are too small for the photos to fix the turn.',
  'scale-out-of-range': 'The two scans differ in size by more than a placement can hold.',
  'correction-too-large': 'It would take a bigger move than this check allows.',
  'sessions-disagree': 'Two parts of this scan give different answers.',
}

/** The sentence for a skip or refusal of the photo method. Never says "aligned" or "verified". */
export function sfmReasonText(reason: SfmResult['reason']): string {
  if (reason === null) return 'No move was proposed.'
  return (SFM_SKIP_TEXT as Record<string, string>)[reason] ?? (SFM_REFUSAL_TEXT as Record<string, string>)[reason] ?? 'No move was proposed.'
}

/** Whether the photo method did not run, as opposed to running and proposing nothing. */
export function sfmWasSkipped(sfm: SfmResult | undefined): boolean {
  return sfm?.status === 'skipped'
}

/**
 * The lines the editor shows for the photo method, or null when the artifact has no photo block (a record an earlier build
 * wrote). A skip is one line and no headline; a refusal and a proposal have the same shape as the wall match's.
 */
export function describeSfmResult(result: PlaceRegisterResult): { headline: string | null; lines: string[] } | null {
  const { sfm } = result
  if (!sfm) return null
  if (sfm.status === 'skipped') return { headline: null, lines: [sfmReasonText(sfm.reason)] }

  const lines: string[] = []
  if (sfm.reference) lines.push(`Compared with ${sfm.reference.name || sfm.reference.filename}.`)
  if (sfm.status !== 'proposed') {
    lines.unshift(sfmReasonText(sfm.reason))
    if (sfm.offeredImages > 0) lines.push(`${sfm.registeredImages} of ${sfm.offeredImages} photos found their place.`)
    if (sfm.reason === 'turn-uncertain' && isFiniteNumber(sfm.turnUncertaintyDeg)) {
      // Two places: a refusal for 1.04 degrees against a limit of 1 reads as a mistake when it says 1.0.
      lines.push(`The photos fix the turn to only about ${sfm.turnUncertaintyDeg.toFixed(2)}°.`)
    }
    return { headline: 'No move proposed', lines }
  }

  const move = sfm.boundedCorrection
  const shift = centimetres(move?.translationM)
  const turn = move && Number.isFinite(move.yawDeg) ? Math.abs(move.yawDeg).toFixed(1) : null
  const gap = centimetres(sfm.residualM)
  const headline = shift !== null && turn !== null ? `Proposed move: ${shift} cm and a ${turn}° turn` : 'Proposed move'
  lines.push(
    `${sfm.registeredImages} of ${sfm.offeredImages} photos found their place${gap !== null ? `, camera positions about ${gap} cm apart` : ''}.`,
  )
  const left = sfm.fitTrimmedFrames ?? 0
  if (left > 0) {
    const gate = sfm.params['inlierGateM']
    const far = isFiniteNumber(gate) ? `more than ${Math.round(gate * 100)} cm` : 'too far'
    lines.push(`${left} of them ${left === 1 ? 'was' : 'were'} left out of the fit, because their solved camera was ${far} from the one this scan recorded.`)
  }
  const lift = centimetres(move?.dyM)
  if (lift !== null && lift !== '0') lines.push(`Height changes by ${lift} cm.`)
  // The size is read from the move itself, which says what the scan will be resized by; the measured unit mismatch is said only when
  // it is there and the move leaves it alone, so the card never says a size differs and then does not say what happens to it.
  const resize = matrixScale(sfm.transform)
  if (resize !== null && Math.abs(resize - 1) >= SIZE_SAID_FROM) {
    lines.push(`The two scans differ in size by ${Math.round(Math.abs(resize - 1) * 100)}%, and this move resizes the scan.`)
  } else if (sfm.scaleRatio !== null && Math.abs(sfm.scaleRatio - 1) >= SIZE_MEASURED_SAID_FROM) {
    lines.push(`The photos measure a size difference of ${Math.round(Math.abs(sfm.scaleRatio - 1) * 100)}%, and the scan is not resized.`)
  }
  if (isFiniteNumber(sfm.turnUncertaintyDeg) && isFiniteNumber(sfm.sizeUncertainty)) {
    lines.push(`The photos fix the turn to about ${sfm.turnUncertaintyDeg.toFixed(1)}° and the size to about ${(sfm.sizeUncertainty * 100).toFixed(1)}%.`)
  }
  if (move && isFiniteNumber(move.maxShiftM) && isFiniteNumber(move.translationM) && move.maxShiftM - move.translationM >= FAR_SHIFT_SAID_FROM_M) {
    lines.push(`The farthest camera position moves ${centimetres(move.maxShiftM)} cm.`)
  }
  lines.push(NOTHING_MOVES_LINE)
  return { headline, lines }
}

// What the card says is not a claim about the scans, so these three are lines of display and not of measurement. All are adopted, not
// measured (ADR 0005 rule 5); each is revisited when a person reading the card says it says too much or too little.

/** A size change smaller than this is not worth a line: half a percent is 2.5 cm at 5 m. Adopted, not measured. */
const SIZE_SAID_FROM = 0.005
/** The measured unit mismatch is said when the move leaves it alone only from here: the 2% a size must clear before it is carried at all (`SFM_SCALE_CARRY_THRESHOLD`). Adopted, not measured. */
const SIZE_MEASURED_SAID_FROM = 0.02
/** The farthest camera is said to move when it moves this much more than the middle of the scan does, metres: a turn of 1 degree is 5 cm at 3 m. Adopted, not measured. */
const FAR_SHIFT_SAID_FROM_M = 0.05

/** The size a column-major similarity carries: the length of the image of the x axis. Null for anything that is not 16 numbers. */
export function matrixScale(m: readonly number[] | null | undefined): number | null {
  if (!isMatrix16(m)) return null
  return Math.hypot(m[0]!, m[1]!, m[2]!)
}

/**
 * What the card says about how the two methods compare, or null when only one of them proposed a move (there is nothing to
 * compare). When they differ by more than {@link METHOD_AGREEMENT_BOUND} the sentence says that neither is preferred, and the
 * card must not put either forward: `prefers` is always null, so no caller can read a preference out of this.
 */
export function describeAgreement(result: PlaceRegisterResult): { text: string; withinBound: boolean; prefers: null } | null {
  const { agreement } = result
  if (!agreement) return null
  const shift = centimetres(agreement.translationM)
  const turn = Number.isFinite(agreement.yawDeg) ? Math.abs(agreement.yawDeg).toFixed(1) : null
  if (shift === null || turn === null) return null
  // A record from a build that did not compare sizes has no size to say, and was held to the two bounds it was measured by.
  const sized = agreement.scaleRatio !== undefined
  const size = sized ? Math.abs(agreement.scaleRatio! - 1) : 0
  const parts = [`${shift} cm`, `${turn}°`]
  if (size >= SIZE_SAID_FROM) parts.push(`${Math.round(size * 100)}% in size`)
  const said = parts.length === 3 ? `${parts[0]}, ${parts[1]} and ${parts[2]}` : `${parts[0]} and ${parts[1]}`
  // The two methods each pick the earlier scan they compare with (the wall match the one that lines up best, the photos the one whose
  // photos overlap most), and they can pick different ones; then the difference is between two corrections measured against two scans.
  const apart = result.sfm?.reference && result.sfm.reference.scanId !== result.reference.scanId ? ' They were compared with different earlier scans.' : ''
  const measured = `The two methods differ by ${said}.${apart}`
  if (agreement.withinBound) return { text: measured, withinBound: true, prefers: null }
  const bound = sized
    ? `${Math.round(METHOD_AGREEMENT_BOUND.translationM * 100)} cm, ${METHOD_AGREEMENT_BOUND.yawDeg}° or ${Math.round(METHOD_AGREEMENT_BOUND.sizeRatio * 100)}% in size`
    : `${Math.round(METHOD_AGREEMENT_BOUND.translationM * 100)} cm or ${METHOD_AGREEMENT_BOUND.yawDeg}°`
  return { text: `${measured} That is more than ${bound}, so neither is preferred.`, withinBound: false, prefers: null }
}

/**
 * What a check did not look at, said on every card: neither method looks at which room a scan is of, or at the Place's place on Earth.
 */
export const NOT_CHECKED_SCOPE_TEXT = 'It does not check that these scans are of the same room, or where the Place is on a map.'

/**
 * What a proposal did not check, and that it is a proposal: the line a card with a move to apply carries. It is the same for both
 * methods.
 */
export const NOT_CHECKED_TEXT = `A proposal only. ${NOT_CHECKED_SCOPE_TEXT} ${NOTHING_MOVES_LINE}`

/** The caveat for a card: the proposal's when either method proposed a move, and only what was not looked at when neither did. */
export function notCheckedText(result: PlaceRegisterResult): string {
  return proposedMethods(result).length > 0 ? NOT_CHECKED_TEXT : NOT_CHECKED_SCOPE_TEXT
}

// ─── Comparing two corrections ───────────────────────────────────────────────

/** The turn of a column-major similarity about +Y, degrees, right-hand rule: the twist of its rotation about up. */
export function matrixYawDeg(m: readonly number[]): number {
  return (Math.atan2(m[8]! - m[2]!, m[0]! + m[10]!) * 180) / Math.PI
}

/**
 * How far apart two corrections of one scan put it: the distance between where each carries `pivot` (a point of the scan, in
 * the Place frame, x and z, at the floor), and the difference of their turns about up. Both are column-major 4x4s that are
 * similarities, as every proposal's `transform` is. The pivot should be the middle of the scan: a turn moves a point by its
 * distance from the pivot, so a difference of turns measured about a far-off point would read as a long shift.
 */
export function compareCorrections(
  a: readonly number[],
  b: readonly number[],
  pivot: readonly [number, number],
): { translationM: number; yawDeg: number; scaleRatio: number } {
  const at = (m: readonly number[]): [number, number] => [
    m[0]! * pivot[0] + m[8]! * pivot[1] + m[12]!,
    m[2]! * pivot[0] + m[10]! * pivot[1] + m[14]!,
  ]
  const [ax, az] = at(a)
  const [bx, bz] = at(b)
  let yawDeg = matrixYawDeg(a) - matrixYawDeg(b)
  while (yawDeg > 180) yawDeg -= 360
  while (yawDeg < -180) yawDeg += 360
  return { translationM: Math.hypot(ax - bx, az - bz), yawDeg, scaleRatio: matrixScale(b)! / matrixScale(a)! }
}

/**
 * The agreement of two methods' proposals for one scan, or null when either did not propose a move. `pivot` is the middle of
 * the scan in the Place frame; see {@link compareCorrections}. Size is compared as well as place and turn: two corrections that carry
 * the middle of the scan to one place at one turn and differ by 12% in size put its far wall 60 cm apart at 5 m.
 */
export function agreementOf(
  scanMatch: readonly number[] | null,
  sfm: readonly number[] | null,
  pivot: readonly [number, number],
): MethodAgreement | null {
  if (!isMatrix16(scanMatch) || !isMatrix16(sfm) || !pivot.every(isFiniteNumber)) return null
  const { translationM, yawDeg, scaleRatio } = compareCorrections(scanMatch, sfm, pivot)
  if (!(scaleRatio > 0) || !Number.isFinite(scaleRatio)) return null
  return {
    translationM,
    yawDeg,
    scaleRatio,
    withinBound: translationM <= METHOD_AGREEMENT_BOUND.translationM && Math.abs(yawDeg) <= METHOD_AGREEMENT_BOUND.yawDeg &&
      Math.abs(scaleRatio - 1) <= METHOD_AGREEMENT_BOUND.sizeRatio,
    pivot: [pivot[0], pivot[1]],
  }
}
