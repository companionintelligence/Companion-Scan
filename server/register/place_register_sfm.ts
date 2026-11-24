/**
 * The photo method of `place-register` (WP-15b slice 2): register a new scan's camera photographs against an earlier scan's, and
 * propose the move that the two scans' own cameras imply.
 *
 * The wall match (scan_match.ts) reads point clouds. This reads photographs: COLMAP finds where each of the new scan's keyframes
 * stands relative to the earlier scan's, and the AR poses both scans recorded say how each scan's own frame relates to that
 * solve, so the new scan's frame can be carried into the Place frame through the earlier scan's calibration:
 *
 *   T_new->Place = T_ref x Sim_ref^-1 x Sim_new
 *
 * where `Sim_s` is the similarity from a session's AR frame to the solve's frame, fitted (Umeyama) between the camera centres the
 * session recorded and the ones COLMAP solved, and `T_ref` is the earlier scan's placement. That algebra, the fit and its refusals
 * are server/register/sim3_chain.ts, and the pair list that decides which photographs to match is pair_list.ts; this file is the
 * method that runs them, and builds nothing they already do.
 *
 * ## What is new here
 *
 *  - **A frozen reference.** The earlier scan's photographs are solved once and kept (sfm_workspace.ts, colmap_reference.ts), and
 *    every new session is registered to that model with its cameras held fixed: star topology, never one new session against another.
 *    One fit of the reference to its own recorded poses is then good for every scan registered to it, and it is checked on every run
 *    that the reference did not move.
 *  - **Gravity.** The chain gives a full similarity. Both AR frames are gravity-aligned, so a correction between them is a turn about
 *    up, a shift and a size, and a tilt in the answer is the solve's error and the poses' noise. The proposal keeps the turn, the
 *    shift and the size and drops the tilt (it is recorded, and a tilt beyond a few degrees refuses the registration in the chain).
 *  - **A bound.** The same bound the wall match is held to: a correction past it is a different frame or a wrong match.
 *  - **The photographs that agree.** A few photographs COLMAP placed wrongly would turn and resize the scan and still pass the
 *    residual gate, so each fit is made without the worst of them, one at a time (sfm_fit.ts).
 *  - **How well the path fixes the turn and the size.** A path that is small against the noise in its positions says where the scan
 *    is and not how it is turned or how big it is. The standard error of each is estimated from the fit (sfm_fit.ts) and recorded
 *    on the proposal; a turn uncertain by more than a degree is refused, and a size is carried only when it clears three standard errors.
 *  - **The unit mismatch.** Two runtimes can disagree on what a unit is. The ratio between the two sessions' fitted scales is
 *    recorded with the proposal, and the proposal carries it as a size change when it is outside the 2% the fits can tell apart from
 *    noise and outside three of its own standard errors. A size past what a placement can hold is refused. Leaving a size out never
 *    moves the middle of the scan: it goes where the whole correction puts it.
 *
 * ## What it refuses, and what it does not run
 *
 * Not run (`status: 'skipped'`, never an error): the switch is off (`PLACE_REGISTER_SFM`), the wall match proposed and nobody asked,
 * COLMAP is not installed (with the install hint, as every optional tool), the scan has no photographs on the server, no other scan
 * has, the scans were calibrated against different generations of the Place's reference, or no photograph of one looks, by the poses,
 * at what a photograph of the other does. Run and refused: a COLMAP step failed or the run ran out of time; the earlier scan's
 * photographs did not join into one model; too few of the new ones found their place (with COLMAP 3.13 a session it cannot tie in
 * shows as none registered; a build that wrote them as a model of their own is the same refusal, told by which model holds the earlier
 * scan's photographs); the earlier scan moved while they were added; the solved camera path disagrees with the recorded one (a
 * straight line, a residual past the limit once the photographs that do not agree are left out, a tilt); the camera path is too small
 * for the photographs to fix the turn; the size between the scans is more than a placement can hold; the move is beyond the bound;
 * two sessions of one scan disagree.
 *
 * Nothing here says a scan is aligned or verified. A proposal is a measurement and a suggestion, applied only by a person (D17).
 *
 * ## What it cannot see
 *
 * Which room it is: photographs of a twin room with the same furniture register as well as the right one. A reference scan that was
 * tilted by hand: the proposal keeps the turn about up, the shift and the size, so that tilt is not followed. The two scans' shared
 * mistake: both calibrated against the same wrong landmark. The AR poses' own drift over a long walk, which the fit averages in.
 * A mirrored capture, whose camera path fits a nearly flat path almost as well as the real one (sim3_chain.ts has the numbers).
 *
 * ## Privacy
 *
 * The photographs stay where they are, and nothing leaves the machine. Work happens in a directory under the Place's own data
 * directory that is removed when the run ends, however it ends; the reference model is kept inside the earlier scan's session
 * directory, so it goes with those photographs (sfm_workspace.ts). Messages from COLMAP are scrubbed of paths and frame names before
 * they are stored or logged, and nothing logs a path.
 */
import type { ScanManifest } from '../../src/world/types.ts'
import {
  type BoundedCorrection,
  compareCorrections,
  isMatrix16,
  METHOD_AGREEMENT_BOUND,
  multiplyMat4,
  type PlaceRegisterScanRef,
  type SfmRefusal,
  type SfmResult,
  type SfmSessionRow,
  type SfmSkipReason,
} from '../../src/world/register-proposal.ts'
import { checkPlacementMatrix } from '../../src/world/scan-placement.ts'
import { cameraCentres, colmapNotFoundSkip, colmapStepBudgetMs, locateColmapBin, resolveParams, resolveQualityThresholds, frameFingerprint } from '../colmap/colmap_poses.ts'
import { locationOf, readFrameSize } from '../colmap/colmap_joint.ts'
import { type JointFrame, planSessionFrames, deriveSessionCameraPrior } from '../colmap/colmap_sessions.ts'
import {
  buildReferenceModel,
  type ColmapContext,
  deadlineSpawn,
  registerToReference,
  type SfmSessionInput,
  startWallClock,
  type ColmapSpawn,
} from '../colmap/colmap_reference.ts'
import { parseImagesBin } from '../colmap/colmap_model.ts'
import { budgetFromEnv } from '../run_with_deadline.ts'
import { sampleEvenly } from '../sample_even.ts'
import { loadSessionIndex } from '../scan_index.ts'
import { sessionDirPath } from '../session_id.ts'
import { sessionIdsLinkedToScan } from '../session_deletion.ts'
import { type KeyframeRecord, readKeyframes, recordHasPose } from '../splat/splat_train_dataset.ts'
import {
  DEFAULT_MAX_RESIDUAL_M,
  DEFAULT_MIN_CORRESPONDENCES,
  matVec3,
  type Vec3Tuple,
} from '../splat/splat_align.ts'
import { buildPairList, type ImagePair, planMatching } from './pair_list.ts'
import { INLIER_GATE_M } from './scan_match.ts'
import { combineUncertainty, fitUncertainty, fitWithTrim, sizeIsCarried, type TrimOptions } from './sfm_fit.ts'
import {
  chooseSessionEpoch,
  pairImagesFromKeyframes,
  recordEpoch,
  sessionCentres,
} from './session_priors.ts'
import {
  applySim3,
  composeSim3,
  describeCorrection,
  invertSim3,
  MAX_UP_AXIS_TILT_DEG,
  registerSessionsToReference,
  type Sim3,
  sim3FromColumnMajor,
  sim3ToColumnMajor,
} from './sim3_chain.ts'
import {
  discardStaleReferenceCache,
  lookupReferenceCache,
  publishReferenceCache,
  referenceCacheDir,
  scrubPaths,
  withWorkDir,
} from './sfm_workspace.ts'

// ─── The switch, and the adopted constants ───────────────────────────────────

/** The environment variable that turns the photo method on: `1` and nothing else does. Off by default (decision D16 gates shipping, not building). */
export const PLACE_REGISTER_SFM_ENV = 'PLACE_REGISTER_SFM'

/** The environment variable that sets the wall-clock limit of one run, in milliseconds. */
export const PLACE_REGISTER_SFM_TIMEOUT_ENV = 'PLACE_REGISTER_SFM_TIMEOUT_MS'

/** Whether the server has the photo method on. */
export function sfmEnabled(read: (name: string) => string | undefined): boolean {
  return read(PLACE_REGISTER_SFM_ENV)?.trim() === '1'
}

/**
 * Longest one run of the method may take, from the first COLMAP command to the last: no step starts after it and none is allowed to
 * run past it (colmap_reference.ts `deadlineSpawn`), and the work directory is removed when it passes.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** Features, matches and a mapper for two sessions of about a hundred photographs on a
 * 32-thread CPU took under a minute on rendered rooms and nothing is known about real ones. **Revisit when** DX9 gives the real
 * time of a run (`sfm.elapsedMs` in the artifact).
 */
export const SFM_WALL_CLOCK_MS = 45 * 60 * 1000

/**
 * Fewest of the new session's photographs COLMAP must place for the registration to be read at all. Below it the fit has too little
 * to check itself against. **Adopted, not measured.** The share that must be placed is COLMAP's own registration ratio
 * (`DEFAULT_MIN_REGISTRATION_RATIO`, `COLMAP_MIN_REGISTRATION_RATIO`), which `colmap-poses` already holds a solve to. **Revisit when** DX9
 * shows registrations that were right with fewer.
 */
export const SFM_MIN_REGISTERED_IMAGES = 6

/**
 * Most photographs of one session offered to COLMAP, thinned evenly across the walk. A scan can hold 2000. R2 puts 150 keyframes at
 * about 170 MB of features before matches and 300 at 44,850 pairs exhaustively; the pair list (pair_list.ts) keeps the pairs to a few
 * thousand, and this keeps the database and the time bounded. **Adopted, not measured.** **Revisit when** DX9 gives time per pair on
 * real keyframes.
 */
export const SFM_MAX_FRAMES_PER_SESSION = 120

/** Most sessions of the new scan that are registered, the ones with the most photographs first. A scan is normally one session. **Adopted, not measured.** */
export const SFM_MAX_NEW_SESSIONS = 3

/**
 * How far an earlier scan's camera may move while new photographs are added, as a share of how far its cameras are spread. A
 * registration with the earlier cameras held fixed leaves them where they were to rounding; one that moved them has stopped being a
 * registration to a frozen reference, and the fit of that reference no longer describes the model. **Adopted, not measured.**
 */
export const SFM_REFERENCE_MOVE_TOLERANCE = 1e-3

/**
 * Two sessions of one scan share an AR frame, so a correct registration puts the scan in the same place by each. They may differ
 * by as much as two methods may ({@link METHOD_AGREEMENT_BOUND}). **Adopted, not measured.**
 */
export const SFM_SESSION_AGREEMENT_BOUND = METHOD_AGREEMENT_BOUND

/**
 * The size between two sessions' units is carried into the proposal only when it is at least this far from 1, and at least
 * {@link SFM_SCALE_CARRY_SIGMAS} standard errors from it ({@link sizeIsCarried}). This is the floor: on rendered rooms with 1 cm of
 * noise and a walk round a room (radius about 1.2 m) the two fits' scales agree to 0.3% (colmap_toy_sfm.test.ts), so a 1% scatter
 * is not a unit difference. The standard error is what keeps a small or noisy path from carrying a size that is its own scatter:
 * at a radius of 0.35 m and 3 cm of noise the scales of two fits of one room scatter by 3.4% (sfm_fit.test.ts). **Adopted, not
 * measured.** **Revisit when** DX1 (the tape test) says what the runtimes' units are.
 */
export const SFM_SCALE_CARRY_THRESHOLD = 0.02

/**
 * How many standard errors from 1 a size must be to be carried into a proposal. Three is the usual line between a measurement and
 * its noise: a size that is the fit's own scatter clears it in 0.3% of fits. **Adopted, not measured.** **Revisit when** DX1 and DX9
 * show which unit differences a person confirmed.
 */
export const SFM_SCALE_CARRY_SIGMAS = 3

/**
 * Whether a registration whose turn the photographs cannot fix well enough is refused (true) or offered with its uncertainty
 * recorded and shown (false). The narrowest switch there is: with it off the number is still on every proposal, and nothing is
 * refused for it. The recommendation is to refuse: a proposal whose turn is uncertain by more than the matcher is held to is a
 * stand-and-pan that says where the scan is and not how it is turned. Listed under needsDecision.
 */
export const SFM_ENFORCE_TURN_UNCERTAINTY = true

/**
 * Most the one-standard-error uncertainty of a proposal's turn may be, degrees: the 1 degree the wall match's own tests hold it to
 * (a turn recovered to under 1 degree). A camera path this small and this noisy (a stand-and-pan, 0.5 m across at 3 cm of noise)
 * has a turn uncertain by 1.4 degrees; a walk round a room has under a degree. **Adopted, not measured.** **Revisit when** DX2
 * gives the real noise of the AR poses and DX9 the registrations a person accepted.
 */
export const SFM_MAX_TURN_UNCERTAINTY_DEG = 1

/** The limits this method used, flat, for the job artifact. */
export function sfmParams(wallClockMs: number = SFM_WALL_CLOCK_MS): Record<string, number> {
  return {
    wallClockMs,
    minRegisteredImages: SFM_MIN_REGISTERED_IMAGES,
    minRegisteredRatio: resolveQualityThresholds().minRegistrationRatio,
    maxFramesPerSession: SFM_MAX_FRAMES_PER_SESSION,
    maxNewSessions: SFM_MAX_NEW_SESSIONS,
    referenceMoveTolerance: SFM_REFERENCE_MOVE_TOLERANCE,
    inlierGateM: INLIER_GATE_M,
    maxFitResidual: DEFAULT_MAX_RESIDUAL_M,
    minFitCorrespondences: DEFAULT_MIN_CORRESPONDENCES,
    maxUpAxisTiltDeg: MAX_UP_AXIS_TILT_DEG,
    sessionAgreementTranslationM: SFM_SESSION_AGREEMENT_BOUND.translationM,
    sessionAgreementYawDeg: SFM_SESSION_AGREEMENT_BOUND.yawDeg,
    sessionAgreementSizeRatio: SFM_SESSION_AGREEMENT_BOUND.sizeRatio,
    scaleCarryThreshold: SFM_SCALE_CARRY_THRESHOLD,
    scaleCarrySigmas: SFM_SCALE_CARRY_SIGMAS,
    maxTurnUncertaintyDeg: SFM_MAX_TURN_UNCERTAINTY_DEG,
    enforceTurnUncertainty: SFM_ENFORCE_TURN_UNCERTAINTY ? 1 : 0,
  }
}

// ─── What the method is given ────────────────────────────────────────────────

/** What the method needs from the server. main.ts passes its own; a test passes a temporary directory and a fake COLMAP. */
export interface SfmHost {
  /** Whether the server has the method on. Off is a skip with a reason, not an absence. */
  enabled: boolean
  /** `scans/sessions`: where keyframe sessions are. */
  sessionsDir: string
  /** The folder a Place keeps working files in, or null when the Place's id cannot name a folder. Not inside any session directory. */
  workRoot(projectId: string): string | null
  /** The scan's sidecar as the server reads it (its own `readScanMeta`), or `{}` when it has none. */
  readScanMeta(filename: string): Promise<Record<string, unknown>>
  /** The job this run belongs to: it names the work directory. */
  jobId: string
  /** The COLMAP binary, as `COLMAP_BIN` would name it. Defaults to the usual search. */
  colmapBin?: string
  /** Replaces the COLMAP subprocess, for a test. */
  _spawn?: ColmapSpawn
  /** The clock, in milliseconds. */
  now?: () => number
  /** The wall-clock limit of a run. Defaults to `PLACE_REGISTER_SFM_TIMEOUT_MS`, then {@link SFM_WALL_CLOCK_MS}. */
  wallClockMs?: number
  /** Replaces {@link SFM_ENFORCE_TURN_UNCERTAINTY}, for a test of both ways of the switch. */
  enforceTurnUncertainty?: boolean
}

export interface SfmRequest {
  /** The Place: its id and its current frame generation, or null for a Place that records none. */
  place: { projectId: string | null; frameId: string | null }
  /** The new scan, as the world holds it now. */
  moving: ScanManifest
  /**
   * The Place's other calibrated scans in the order the wall match would try them. The one whose photographs look, by their poses, at
   * what the new scan's do the most (the most pairs the pair list would match) is used, and a tie goes to the one that comes first.
   */
  references: readonly ScanManifest[]
}

/** The answer, and where in the Place the middle of the new scan is, for the card's comparison of the two methods. */
export interface SfmOutcome {
  result: SfmResult
  pivot: [number, number] | null
}

function emptyResult(status: SfmResult['status'], reason: SfmResult['reason'], detail: string, wallClockMs: number, started: number, now: () => number): SfmResult {
  return {
    status,
    reason,
    detail,
    reference: null,
    transform: null,
    boundedCorrection: null,
    residualM: null,
    registeredFraction: null,
    registeredImages: 0,
    offeredImages: 0,
    inliers: 0,
    scaleRatio: null,
    tiltDeg: null,
    sessions: [],
    referenceModel: null,
    frameId: null,
    params: sfmParams(wallClockMs),
    elapsedMs: Math.max(0, Math.round(now() - started)),
  }
}

/** A result for a run that did not happen, for the job to record when it decides not to run the method. */
export function skippedResult(reason: SfmSkipReason, detail = ''): SfmResult {
  return emptyResult('skipped', reason, detail, SFM_WALL_CLOCK_MS, 0, () => 0)
}

function refScan(scan: ScanManifest): PlaceRegisterScanRef {
  return { scanId: scan.scanId, filename: scan.filename, name: scan.name || scan.filename, localToWorld: [...scan.localToWorld] }
}

// ─── A scan's photographs ────────────────────────────────────────────────────

/** One keyframe session of a scan, reduced to what a registration reads: the frames offered, the records behind them, and the camera's start. */
interface ScanSession {
  sessionId: string
  sessionDir: string
  epoch: number
  /** The frames offered to COLMAP: posed, in the epoch, readable, thinned, all one size. In capture order. */
  frames: JointFrame[]
  /** Their keyframe records, in the same order. */
  records: KeyframeRecord[]
  prior: SfmSessionInput['prior']
}

function wholeEpoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * The calibration epoch a scan's sidecar records (`frameEpochs.calibrationEpoch`), or null when it records none, which makes the
 * poses' epoch the one with the most posed frames (`chooseSessionEpoch`).
 */
function calibrationEpochOf(meta: Record<string, unknown>): number | null {
  const epochs = meta['frameEpochs']
  return epochs && typeof epochs === 'object' ? wholeEpoch((epochs as Record<string, unknown>)['calibrationEpoch']) : null
}

const KEYFRAME_FILE = /^kf-\d+\.jpg$/

/**
 * The sessions of `scan` that have photographs to offer, the ones with the most first. A session is the scan's by the rule deletion
 * uses (`sessionIdsLinkedToScan`: its sidecar names it, or it was finalized against the scan or follows it). Only frames in the epoch
 * the scan's calibration was made in are used, because the placement says nothing about the frames of another; only frames that
 * carry a pose, because the fit to the AR poses is what chains them to the Place; and one size per session, because a camera has one.
 */
async function gatherSessions(
  sessionsDir: string,
  index: Awaited<ReturnType<typeof loadSessionIndex>>,
  scan: ScanManifest,
  meta: Record<string, unknown>,
): Promise<ScanSession[]> {
  const ids = new Set(sessionIdsLinkedToScan(index, scan.filename, meta))
  if (scan.sessionId) ids.add(scan.sessionId)
  const found: ScanSession[] = []
  for (const sessionId of [...ids].sort()) {
    const sessionDir = sessionDirPath(sessionsDir, sessionId)
    if (!sessionDir) continue
    const records = await readKeyframes(sessionDir)
    const choice = chooseSessionEpoch(records, calibrationEpochOf(meta))
    if (choice.epoch === null) continue
    const posed = records.filter((record) =>
      typeof record.file === 'string' && KEYFRAME_FILE.test(record.file) && recordHasPose(record) && recordEpoch(record) === choice.epoch
    )
    const picked = sampleEvenly(posed, SFM_MAX_FRAMES_PER_SESSION)
    const sized: Array<{ frame: JointFrame; record: KeyframeRecord }> = []
    for (const record of picked) {
      const size = await readFrameSize(`${sessionDir}/${record.file}`)
      if (size) sized.push({ frame: { file: record.file!, ...size }, record })
    }
    const planned = planSessionFrames(sized.map((entry) => entry.frame))
    if (!planned || planned.kept.length < 2) continue
    const keep = new Set(planned.kept.map((frame) => frame.file))
    const kept = sized.filter((entry) => keep.has(entry.frame.file))
    const records_ = kept.map((entry) => entry.record)
    found.push({
      sessionId,
      sessionDir,
      epoch: choice.epoch,
      frames: kept.map((entry) => entry.frame),
      records: records_,
      prior: deriveSessionCameraPrior(sessionId, records_, { width: planned.width, height: planned.height }),
    })
  }
  return found.sort((a, b) => b.frames.length - a.frames.length || (a.sessionId < b.sessionId ? -1 : 1))
}

/** A session's frames as pair-list images, positioned in the Place frame by the scan's own placement. */
function pairImagesOf(session: ScanSession, scan: ScanManifest) {
  return pairImagesFromKeyframes(session.records, session.sessionId, { sessionToProject: scan.localToWorld, epoch: session.epoch })
}

function asInput(session: ScanSession): SfmSessionInput {
  return { sessionId: session.sessionId, sessionDir: session.sessionDir, frames: session.frames, prior: session.prior }
}

// ─── The correction ──────────────────────────────────────────────────────────

/**
 * `correction` with its tilt taken out: the turn about +Y it carries, a size, and the shift that puts `pivot` where `correction`
 * puts it. Both AR frames are gravity-aligned, so the tilt of a correction between them is the solve's error and the poses' noise,
 * and a scan that is tilted to follow it would have a floor that is no longer level. The chain refuses a registration whose up
 * axes disagree by more than `MAX_UP_AXIS_TILT_DEG`; what is left under that is dropped here, and reported.
 *
 * `scale` is the size the answer carries: the correction's own by default, and 1 for a size that is not to be carried
 * ({@link sizeIsCarried}). The pivot lands where the **whole** correction carries it either way, so leaving the size out takes
 * nothing from where the middle of the scan goes, and only the parts away from the middle are not resized. Overwriting the size
 * of the correction before this and keeping its shift would move the pivot by `(size - 1)` times its distance from the Place
 * origin: 8 cm for a size of 1.015 at 5 m, and every scan on a runtime whose units differ by under 2% from the earlier one's.
 */
export function gravityConstrained(correction: Sim3, pivot: Vec3Tuple, scale: number = correction.scale): number[] {
  const r = correction.rotation
  const yaw = Math.atan2(r[0]![2]! - r[2]![0]!, r[0]![0]! + r[2]![2]!)
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const rotation = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
  const moved = applySim3(correction, pivot)
  const turned = matVec3(rotation, pivot)
  const translation: Vec3Tuple = [
    moved[0] - scale * turned[0],
    moved[1] - scale * turned[1],
    moved[2] - scale * turned[2],
  ]
  return sim3ToColumnMajor({ rotation, translation, scale })
}

// ─── One session against the reference ───────────────────────────────────────

interface SessionOutcome {
  row: SfmSessionRow
  /** The proposal for this session, when it made one. */
  transform: number[] | null
  /** What this session's registration said when it was refused after a fit (too large a move, too large a size): never offered, but evidence of where it put the scan. */
  measured: number[] | null
  bounded: BoundedCorrection | null
  tiltDeg: number | null
  pivot: [number, number] | null
}

function refusedRow(
  session: ScanSession,
  reason: SfmRefusal,
  detail: string,
  started: number,
  now: () => number,
  extra: Partial<SfmSessionRow> = {},
  scrub: (text: string) => string = scrubPaths,
): SessionOutcome {
  return {
    row: {
      sessionId: session.sessionId,
      offeredImages: session.frames.length,
      registeredImages: 0,
      inOtherModels: 0,
      fittedFrames: 0,
      inliers: 0,
      rmsM: null,
      scaleRatio: null,
      tiltDeg: null,
      status: 'refused',
      reason,
      detail: scrub(detail),
      elapsedMs: Math.max(0, Math.round(now() - started)),
      ...extra,
    },
    transform: null,
    measured: null,
    bounded: null,
    tiltDeg: null,
    pivot: null,
  }
}

/** The numbers a session's fit carries beyond the proposal's own, for the result that speaks for it. Only those the row has: an absent one stays absent. */
function uncertaintyOf(row: SfmSessionRow): Pick<SfmResult, 'sizeUncertainty' | 'turnUncertaintyDeg' | 'fitTrimmedFrames'> {
  return {
    ...(row.sizeUncertainty !== undefined ? { sizeUncertainty: row.sizeUncertainty } : {}),
    ...(row.turnUncertaintyDeg !== undefined ? { turnUncertaintyDeg: row.turnUncertaintyDeg } : {}),
    ...(row.fitTrimmedFrames !== undefined ? { fitTrimmedFrames: row.fitTrimmedFrames } : {}),
  }
}

const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null)

/** The frames a session's recorded positions and the solve both have. */
function pairedFiles(recorded: ReadonlyMap<string, Vec3Tuple>, solved: ReadonlyMap<string, Vec3Tuple>): string[] {
  return [...recorded.keys()].filter((key) => solved.has(key)).sort()
}

/** Every pair of a new session's photographs with each other, and each with each of the reference's, when the poses cannot say which overlap: the pairs that can be new, never the reference's own. */
function everyNewPair(refNames: readonly string[], newNames: readonly string[]): ImagePair[] {
  const pairs: ImagePair[] = []
  const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x])
  for (const n of newNames) {
    for (const r of refNames) {
      const [a, b] = ordered(n, r)
      pairs.push({ a, b, kind: 'cross-session' })
    }
  }
  for (let i = 0; i < newNames.length; i++) {
    for (let j = i + 1; j < newNames.length; j++) {
      const [a, b] = ordered(newNames[i]!, newNames[j]!)
      pairs.push({ a, b, kind: 'sequence' })
    }
  }
  return pairs
}

/**
 * How far apart two sessions of one scan measured its size, as a fraction, when it is more than the bound allows and more than the
 * two fits' own uncertainty can account for (three standard errors, {@link SFM_SCALE_CARRY_SIGMAS}); null when they agree. A session
 * whose fit has no uncertainty on record (a row an earlier build wrote) is compared at the bound alone.
 */
function measuredSizeApart(a: SfmSessionRow, b: SfmSessionRow): number | null {
  if (a.scaleRatio === null || b.scaleRatio === null) return null
  const apart = Math.abs(Math.log(a.scaleRatio / b.scaleRatio))
  const own = Math.hypot(a.sizeUncertainty ?? 0, b.sizeUncertainty ?? 0)
  return apart > Math.max(SFM_SESSION_AGREEMENT_BOUND.sizeRatio, SFM_SCALE_CARRY_SIGMAS * own) ? Math.expm1(apart) : null
}

// ─── The method ──────────────────────────────────────────────────────────────

/**
 * Runs the photo method for one scan: chooses the earlier scan whose photographs overlap the new scan's, makes or reuses the model
 * of it, registers each of the new scan's sessions to that model, and proposes the move the best of them implies. Never throws:
 * whatever goes wrong is a result with its reason. The work directory is gone when this resolves.
 */
export async function runSfmRegistration(host: SfmHost, request: SfmRequest): Promise<SfmOutcome> {
  const now = host.now ?? Date.now
  const wallClockMs = host.wallClockMs ?? budgetFromEnv(PLACE_REGISTER_SFM_TIMEOUT_ENV, SFM_WALL_CLOCK_MS)
  const started = now()
  const done = (result: SfmResult, pivot: [number, number] | null = null): SfmOutcome => ({
    result: { ...result, frameId: request.place.frameId, params: sfmParams(wallClockMs), elapsedMs: Math.max(0, Math.round(now() - started)) },
    pivot,
  })
  // A skip's detail is written by this file or is an install hint naming a tool's location: nothing in it comes from a photograph.
  const skip = (reason: SfmSkipReason, detail = ''): SfmOutcome => done(emptyResult('skipped', reason, detail, wallClockMs, started, now))
  try {
    return await run(host, request, { now, started, wallClockMs, done, skip })
  } catch (error) {
    // A bug or a file system error must not fail the job that has a wall match to report. Only the error's name is logged: a message can hold a path.
    console.error(`[place-register-sfm] stopped on an error (${error instanceof Error ? error.name : 'Error'})`)
    return done({
      ...emptyResult('refused', 'colmap-failed', 'The photo method stopped on an unexpected error.', wallClockMs, started, now),
    })
  }
}

interface RunContext {
  now: () => number
  started: number
  wallClockMs: number
  done: (result: SfmResult, pivot?: [number, number] | null) => SfmOutcome
  skip: (reason: SfmSkipReason, detail?: string) => SfmOutcome
}

async function run(host: SfmHost, request: SfmRequest, ctx: RunContext): Promise<SfmOutcome> {
  const { now, started, wallClockMs, done, skip } = ctx
  const { moving, place } = request
  if (!host.enabled) return skip('off')
  const workRoot = place.projectId ? host.workRoot(place.projectId) : null
  if (!workRoot) return skip('no-place')

  const index = await loadSessionIndex(host.sessionsDir)
  // A reference model made for another generation of the Place's reference is of no use to anyone and is made from photographs, so it
  // goes now, including the ones of the scans this run leaves out for being of an earlier generation.
  for (const scan of [moving, ...request.references]) {
    const meta = await host.readScanMeta(scan.filename)
    const ids = new Set(sessionIdsLinkedToScan(index, scan.filename, meta))
    if (scan.sessionId) ids.add(scan.sessionId)
    for (const id of ids) {
      const dir = sessionDirPath(host.sessionsDir, id)
      if (dir) await discardStaleReferenceCache(dir, { projectId: place.projectId!, frameId: place.frameId })
    }
  }
  // Which scans may be compared: the same generation of the Place's reference, or one that records none (an unknown generation is
  // neutral, never a different one: src/world/types.ts `ProjectSpatialFrame.frameId`).
  const generation = (scan: ScanManifest): string | null => scan.calibrationFrameId ?? null
  const differs = (a: string | null, b: string | null): boolean => a !== null && b !== null && a !== b
  const sameFrame = request.references.filter((reference) =>
    !differs(generation(reference), place.frameId) && !differs(generation(reference), generation(moving))
  )
  if (request.references.length > 0 && sameFrame.length === 0) return skip('frame-mismatch')

  const movingMeta = await host.readScanMeta(moving.filename)
  const newSessions = (await gatherSessions(host.sessionsDir, index, moving, movingMeta)).slice(0, SFM_MAX_NEW_SESSIONS)
  if (newSessions.length === 0) return skip('no-keyframes')

  const candidates: Array<{ scan: ScanManifest; meta: Record<string, unknown>; sessions: ScanSession[] }> = []
  for (const reference of sameFrame) {
    const meta = await host.readScanMeta(reference.filename)
    const sessions = await gatherSessions(host.sessionsDir, index, reference, meta)
    if (sessions.length > 0) candidates.push({ scan: reference, meta, sessions })
  }
  if (candidates.length === 0) return skip('no-reference')

  // The earlier session whose photographs look, by the AR poses in the Place frame, at what the new scan's do: the most pairs the
  // pair list would match between them. A tie goes to the one with more photographs, then to the order the caller gave.
  const lead = newSessions[0]!
  const leadImages = pairImagesOf(lead, moving)
  let chosen: { scan: ScanManifest; meta: Record<string, unknown>; session: ScanSession; pairs: number } | null = null
  for (const candidate of candidates) {
    for (const session of candidate.sessions) {
      const built = buildPairList([...pairImagesOf(session, candidate.scan), ...leadImages], { referenceSessionId: session.sessionId })
      const pairs = built.ok ? built.stats.crossSessionPairs : 0
      if (!chosen || pairs > chosen.pairs || (pairs === chosen.pairs && session.frames.length > chosen.session.frames.length)) {
        chosen = { scan: candidate.scan, meta: candidate.meta, session, pairs }
      }
    }
  }
  const reference = chosen!
  const referenceRef = refScan(reference.scan)

  // Which photographs to match, decided from the poses alone, before anything is solved: a session no pair can tie to the reference is
  // not worth a reference model.
  const refImagesIn = pairImagesOf(reference.session, reference.scan)
  const planned: Array<{ session: ScanSession; pairs: ImagePair[] }> = []
  const noOverlap: string[] = []
  for (const session of newSessions) {
    const newImages = pairImagesOf(session, moving)
    const plan = planMatching([...refImagesIn, ...newImages], { referenceSessionId: reference.session.sessionId })
    let pairs: ImagePair[] = []
    if (plan.kind === 'pairs') {
      pairs = plan.pairs.filter((pair) => pair.a.startsWith(`${session.sessionId}/`) || pair.b.startsWith(`${session.sessionId}/`))
    } else if (plan.kind === 'exhaustive') {
      pairs = everyNewPair(refImagesIn.map((image) => image.name), newImages.map((image) => image.name))
    } else {
      noOverlap.push(plan.message)
    }
    if (pairs.length > 0) planned.push({ session, pairs })
  }
  if (planned.length === 0) return skip('no-overlap', noOverlap[0] ?? '')

  const colmapBin = resolveParams({ sessionDir: host.sessionsDir, colmapBin: host.colmapBin }).colmapBin
  const located = await locateColmapBin(colmapBin)
  if (!located.bin) {
    const hint = colmapNotFoundSkip(colmapBin, located.pathProbe)
    // The hint names where COLMAP was looked for, which is a path under the operator's home folder; the result is stored in the world,
    // which every member of it can read.
    return skip('colmap-missing', scrubPaths(`${hint.skippedReason}. ${hint.remediation}`, [colmapBin, workRoot, host.sessionsDir]))
  }

  // The work directory must be somewhere nothing else lives: never a session directory or inside one.
  const workLocation = await locationOf(workRoot)
  for (const dir of [host.sessionsDir, lead.sessionDir, reference.session.sessionDir]) {
    const location = await locationOf(dir)
    if (workLocation === location || workLocation.startsWith(`${location}/`)) return skip('no-place')
  }

  const clock = startWallClock(wallClockMs, now)
  const params = resolveParams({ sessionDir: host.sessionsDir, colmapBin: located.bin })
  const imageRoot = await Deno.realPath(host.sessionsDir)
  const colmap: ColmapContext = { bin: located.bin, imageRoot, params, spawn: deadlineSpawn(clock, colmapStepBudgetMs(), host._spawn), logs: [] }
  const thresholds = resolveQualityThresholds()

  return await withWorkDir(workRoot, host.jobId, async (workDir): Promise<SfmOutcome> => {
    // COLMAP's words can name the folders it was given. They are known, so they are removed whole whatever characters they hold.
    const roots = [host.sessionsDir, imageRoot, workRoot, workDir, await Deno.realPath(workDir).catch(() => workDir), colmap.bin]
    const scrub = (text: string): string => scrubPaths(text, roots)
    const failed = (reason: SfmRefusal, detail: string, extra: Partial<SfmResult> = {}): SfmOutcome =>
      done({ ...emptyResult('refused', reason, scrub(detail), wallClockMs, started, now), reference: referenceRef, ...extra })

    // ── The earlier scan's model: kept from an earlier run, or made now ──
    const refSession = reference.session
    const refFingerprint = await frameFingerprint(refSession.sessionDir, refSession.frames.map((frame) => frame.file))
    const expectation = {
      projectId: place.projectId!,
      frameId: place.frameId,
      scanId: reference.scan.scanId,
      sessionId: refSession.sessionId,
      epoch: refSession.epoch,
      frameFingerprint: refFingerprint,
    }
    let cache = await lookupReferenceCache(refSession.sessionDir, expectation)
    let referenceModel: 'built' | 'reused' = 'reused'
    if (cache.state !== 'valid') {
      referenceModel = 'built'
      const built = await buildReferenceModel({
        ctx: colmap,
        workDir: `${workDir}/reference`,
        session: asInput(refSession),
        pairImages: pairImagesOf(refSession, reference.scan),
        minRegisteredImages: SFM_MIN_REGISTERED_IMAGES,
        minRegisteredRatio: thresholds.minRegistrationRatio,
      })
      if (!built.ok) {
        const reason: SfmRefusal = built.reason
        return failed(reason, built.message, { referenceModel: null })
      }
      const published = await publishReferenceCache(
        refSession.sessionDir,
        { dbPath: built.dbPath, modelDir: built.modelDir },
        {
          schemaVersion: 1,
          kind: 'place-register-sfm-reference',
          ...expectation,
          frameCount: built.offered,
          registeredImages: built.registered,
          createdAt: new Date(now()).toISOString(),
        },
      )
      // A session deleted while its model was being built has no directory to keep a model in, and nothing of it is kept.
      if (!published) return skip('no-reference')
      cache = await lookupReferenceCache(refSession.sessionDir, expectation)
      if (cache.state !== 'valid') return failed('reference-weak', 'The reference model could not be kept.', { referenceModel: null })
    }

    // ── The reference's own fit, from the model the cache holds: made every run, so it can never be stale ──
    const refImages = parseImagesBin(await Deno.readFile(`${cache.modelDir}/images.bin`))
    const refSolverCentres = cameraCentres(refImages, { keepFolder: true })
    const refRecorded = sessionCentres(refSession.records, refSession.sessionId, refSession.epoch)
    const placeFromReference = sim3FromColumnMajor(reference.scan.localToWorld)
    // Photographs COLMAP placed away from where the reference's cameras were are left out of its fit, as they are of every session's
    // (sfm_fit.ts): the gap is measured in the solver's units, so the gate in metres goes through the fit's own size.
    const trimOptions = (metresPerSolverUnit: TrimOptions['metresPerSolverUnit']): TrimOptions => ({
      gateM: INLIER_GATE_M,
      metresPerSolverUnit,
      minFrames: SFM_MIN_REGISTERED_IMAGES,
      minShare: thresholds.minRegistrationRatio,
    })
    const refTrim = fitWithTrim(
      { sessionId: refSession.sessionId, sessionCentres: refRecorded, solverCentres: refSolverCentres },
      trimOptions((first) => (placeFromReference?.scale ?? 1) / first.sessionToSolver.scale),
    )
    const refFit = refTrim.fit
    const refUncertainty = refFit.ok && refTrim.rho !== null ? fitUncertainty(refFit.files.map((file) => refRecorded.get(file)!), refTrim.rho) : null

    // How far apart the reference's cameras are, to read "did not move" against.
    const refPoints = [...refSolverCentres.values()]
    const spread = refPoints.length === 0 ? 0 : Math.hypot(
      Math.max(...refPoints.map((p) => p[0])) - Math.min(...refPoints.map((p) => p[0])),
      Math.max(...refPoints.map((p) => p[1])) - Math.min(...refPoints.map((p) => p[1])),
      Math.max(...refPoints.map((p) => p[2])) - Math.min(...refPoints.map((p) => p[2])),
    )

    const outcomes: SessionOutcome[] = []
    for (const { session, pairs } of planned) {
      const sessionStarted = now()
      const registered = await registerToReference({
        ctx: colmap,
        workDir: `${workDir}/session-${outcomes.length}`,
        reference: { dbPath: cache.dbPath, modelDir: cache.modelDir, session: asInput(refSession) },
        session: asInput(session),
        pairs,
      })
      if (!registered.ok) {
        outcomes.push(refusedRow(session, registered.reason, registered.message, sessionStarted, now, {}, scrub))
        if (registered.reason === 'timed-out') break
        continue
      }
      const counts = { registeredImages: registered.registered, inOtherModels: registered.inOtherModels }
      if (registered.registered < SFM_MIN_REGISTERED_IMAGES || registered.registered < thresholds.minRegistrationRatio * registered.offered) {
        const split = registered.inOtherModels > registered.registered
        outcomes.push(refusedRow(
          session,
          split ? 'sub-model-split' : 'too-few-registered',
          `${registered.registered} of ${registered.offered} photographs were placed in the reference's model.`,
          sessionStarted,
          now,
          counts,
        ))
        continue
      }

      // The reference's cameras were to stay where they were. If they did not, the fit of the reference no longer describes the model.
      const solverCentres = cameraCentres(registered.images, { keepFolder: true })
      let moved = 0
      for (const [key, was] of refSolverCentres) {
        const is = solverCentres.get(key)
        moved = Math.max(moved, is ? Math.hypot(is[0] - was[0], is[1] - was[1], is[2] - was[2]) : Infinity)
      }
      if (spread > 0 && moved > SFM_REFERENCE_MOVE_TOLERANCE * spread) {
        outcomes.push(refusedRow(session, 'reference-moved', 'The earlier scan\'s camera positions changed while the new photographs were added.', sessionStarted, now, counts))
        continue
      }

      const newRecorded = sessionCentres(session.records, session.sessionId, session.epoch)
      const newTrim = fitWithTrim(
        { sessionId: session.sessionId, sessionCentres: newRecorded, solverCentres },
        // Place metres per solver unit is the earlier scan's: the Place frame is the one its calibration defines.
        trimOptions(() => (refFit.ok ? (placeFromReference?.scale ?? 1) / refFit.sessionToSolver.scale : 1)),
      )
      const newFit = newTrim.fit
      const registration = registerSessionsToReference(
        { sessionId: refSession.sessionId, sessionToProject: reference.scan.localToWorld, fit: refFit },
        [{ sessionId: session.sessionId, fit: newFit }],
      )[0]!
      if (!registration.ok) {
        outcomes.push(refusedRow(session, registration.reason, registration.message, sessionStarted, now, {
          ...counts,
          fittedFrames: registration.correspondenceCount,
          fitTrimmedFrames: newTrim.trimmed,
          tiltDeg: registration.tiltDeg ?? null,
          scaleRatio: registration.fit?.umeyamaScale !== undefined && refFit.ok ? registration.fit.umeyamaScale / refFit.sessionToSolver.scale : null,
          rmsM: null,
        }))
        continue
      }

      // ── What it would change, and whether that can be offered ──
      const placed = sim3FromColumnMajor(moving.localToWorld)
      if (!newFit.ok || !refFit.ok || !placed || !placeFromReference) {
        outcomes.push(refusedRow(session, 'reference-unusable', 'The new scan\'s placement is not a similarity.', sessionStarted, now, counts))
        continue
      }
      const centres = newFit.files.map((file) => newRecorded.get(file)!)
      const correction = describeCorrection(registration.sessionToPlace, moving.localToWorld, centres)
      if (!correction) {
        outcomes.push(refusedRow(session, 'reference-unusable', 'The new scan\'s placement is not a similarity.', sessionStarted, now, counts))
        continue
      }
      const fromPlaced = centres.map((c) => applySim3(placed, c))
      const pivot: Vec3Tuple = [
        fromPlaced.reduce((sum, p) => sum + p[0], 0) / fromPlaced.length,
        fromPlaced.reduce((sum, p) => sum + p[1], 0) / fromPlaced.length,
        fromPlaced.reduce((sum, p) => sum + p[2], 0) / fromPlaced.length,
      ]
      // How well this session's camera path, and the earlier scan's, can fix a turn and a size at all (sfm_fit.ts).
      const newUncertainty = newTrim.rho === null ? null : fitUncertainty(centres, newTrim.rho)
      const uncertainty = refUncertainty && newUncertainty
        ? combineUncertainty(refUncertainty, newUncertainty)
        : { sizeRel: Infinity, turnDeg: Infinity }
      const fullCorrection = sim3FromColumnMajor(correction.transform)!
      // Both frames are gravity-aligned AR frames, so the correction is a turn about up, a shift and (when the units differ) a size.
      // A size within the noise of the fits is not carried: it would resize every scan by the scatter of the fits. The pivot goes
      // where the whole correction puts it either way.
      const sizeCarried = sizeIsCarried(correction.scale, uncertainty.sizeRel, SFM_SCALE_CARRY_THRESHOLD, SFM_SCALE_CARRY_SIGMAS)
      const transform = gravityConstrained(fullCorrection, pivot, sizeCarried ? fullCorrection.scale : 1)
      let maxShiftM = 0
      const constrained = sim3FromColumnMajor(transform)!
      for (const from of fromPlaced) {
        const to = applySim3(constrained, from)
        maxShiftM = Math.max(maxShiftM, Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]))
      }
      const moved_ = applySim3(constrained, pivot)
      const bounded: BoundedCorrection = {
        ...correction.bounded,
        translationM: Math.hypot(moved_[0] - pivot[0], moved_[2] - pivot[2]),
        dyM: moved_[1] - pivot[1],
        maxShiftM,
        withinBound: false,
      }
      bounded.withinBound = bounded.translationM <= bounded.bound.translationM && Math.abs(bounded.yawDeg) <= bounded.bound.yawDeg &&
        Math.abs(bounded.dyM) <= bounded.bound.dyM

      // The photograph's own gap: each fitted frame's solved camera against its recorded one, in Place metres. Counted over every frame
      // that was paired, the ones the fit left out as well, so the share of photographs that agree is the whole share.
      const placeFromSolver = composeSim3(placeFromReference, invertSim3(refFit.sessionToSolver))
      let inliers = 0
      for (const file of pairedFiles(newRecorded, solverCentres)) {
        const solved = solverCentres.get(file)!
        const predicted = applySim3(newFit.sessionToSolver, newRecorded.get(file)!)
        if (Math.hypot(predicted[0] - solved[0], predicted[1] - solved[1], predicted[2] - solved[2]) * placeFromSolver.scale <= INLIER_GATE_M) inliers++
      }

      const row: SfmSessionRow = {
        sessionId: session.sessionId,
        offeredImages: registered.offered,
        registeredImages: registered.registered,
        inOtherModels: registered.inOtherModels,
        fittedFrames: newTrim.paired,
        fitTrimmedFrames: newTrim.trimmed,
        inliers,
        rmsM: registration.residualPlaceM,
        scaleRatio: registration.scaleRatioToReference,
        sizeUncertainty: finiteOrNull(uncertainty.sizeRel),
        turnUncertaintyDeg: finiteOrNull(uncertainty.turnDeg),
        tiltDeg: correction.tiltDeg,
        status: 'proposed',
        reason: null,
        detail: '',
        elapsedMs: Math.max(0, Math.round(now() - sessionStarted)),
      }
      // A refusal after a fit still says where the session put the scan, which two sessions of one scan are compared by, unless the
      // fit cannot say it to within the matcher's own accuracy.
      const finish = (reason: SfmRefusal, detail: string, measurement = true): void => {
        const { status: _status, reason: _reason, detail: _detail, ...measured } = row
        outcomes.push({
          ...refusedRow(session, reason, detail, sessionStarted, now, measured),
          measured: measurement ? transform : null,
          pivot: [pivot[0], pivot[2]],
          bounded,
          tiltDeg: correction.tiltDeg,
        })
      }
      if ((host.enforceTurnUncertainty ?? SFM_ENFORCE_TURN_UNCERTAINTY) && !(uncertainty.turnDeg <= SFM_MAX_TURN_UNCERTAINTY_DEG)) {
        // Both fits make it: a small path on either side is enough, so the detail says which was how uncertain.
        const degrees = (u: { turnDeg: number } | null): string => (u && Number.isFinite(u.turnDeg) ? `${u.turnDeg.toFixed(2)} degrees` : 'more than can be said')
        finish(
          'turn-uncertain',
          `The turn is uncertain by ${degrees(uncertainty)}, past the ${SFM_MAX_TURN_UNCERTAINTY_DEG} degree limit: this scan's camera path fixes it to ${degrees(newUncertainty)} and the earlier scan's to ${degrees(refUncertainty)}.`,
          false,
        )
        continue
      }
      // The server refuses a placement the editor cannot hold at Apply; the job says so now, in words.
      const placement = checkPlacementMatrix(multiplyMat4(transform, moving.localToWorld))
      if (!placement.ok) {
        finish(placement.reason === 'scale-range' ? 'scale-out-of-range' : 'reference-unusable', placement.message)
        continue
      }
      if (!bounded.withinBound) {
        finish('correction-too-large', `The move is ${(bounded.translationM * 100).toFixed(0)} cm and ${Math.abs(bounded.yawDeg).toFixed(1)} degrees.`)
        continue
      }
      outcomes.push({ row, transform, measured: transform, bounded, tiltDeg: correction.tiltDeg, pivot: [pivot[0], pivot[2]] })
    }

    // ── Which session speaks for the scan ──
    const sessions = outcomes.map((outcome) => outcome.row)
    const proposed = outcomes.filter((outcome) => outcome.transform !== null)
    const registeredImages = sessions.reduce((n, row) => n + row.registeredImages, 0)
    const offeredImages = sessions.reduce((n, row) => n + row.offeredImages, 0)
    const base: Partial<SfmResult> = { reference: referenceRef, sessions, registeredImages, offeredImages, referenceModel }
    if (proposed.length === 0) {
      const lead = outcomes.find((outcome) => outcome.row.reason !== null) ?? outcomes[0]!
      return failed(lead.row.reason ?? 'too-few-registered', lead.row.detail, {
        ...base,
        boundedCorrection: lead.bounded,
        scaleRatio: lead.row.scaleRatio,
        ...uncertaintyOf(lead.row),
        tiltDeg: lead.tiltDeg,
        residualM: lead.row.rmsM,
      })
    }
    proposed.sort((a, b) => b.row.fittedFrames - a.row.fittedFrames || (a.row.rmsM ?? Infinity) - (b.row.rmsM ?? Infinity) || (a.row.sessionId < b.row.sessionId ? -1 : 1))
    const best = proposed[0]!
    const pivot = best.pivot!
    // Sessions of one scan share one AR frame, so a correct registration puts the scan in the same place by each of them, turned the
    // same and at the same size. A session refused for the size of its move is still a measurement of where it put the scan, and
    // disagrees with one that put it nearby. The size compared is the one each fit measured and not the one a proposal carries: two
    // sessions either side of the line a size is carried at agree.
    for (const other of outcomes.filter((outcome) => outcome !== best && outcome.measured !== null)) {
      const apart = compareCorrections(best.transform!, other.measured!, pivot)
      const sizeApart = measuredSizeApart(best.row, other.row)
      if (apart.translationM > SFM_SESSION_AGREEMENT_BOUND.translationM || Math.abs(apart.yawDeg) > SFM_SESSION_AGREEMENT_BOUND.yawDeg || sizeApart !== null) {
        const size = sizeApart === null ? '' : ` and ${(sizeApart * 100).toFixed(0)}% in size`
        return failed('sessions-disagree', `Two sessions of this scan differ by ${(apart.translationM * 100).toFixed(0)} cm and ${Math.abs(apart.yawDeg).toFixed(1)} degrees${size}.`, {
          ...base,
          boundedCorrection: best.bounded,
          scaleRatio: best.row.scaleRatio,
          ...uncertaintyOf(best.row),
          tiltDeg: best.tiltDeg,
          residualM: best.row.rmsM,
        })
      }
    }
    if (!isMatrix16(best.transform)) return failed('reference-unusable', 'The registration produced no usable transform.', base)
    return done({
      ...emptyResult('proposed', null, '', wallClockMs, started, now),
      ...base,
      transform: best.transform,
      boundedCorrection: best.bounded,
      residualM: best.row.rmsM,
      registeredFraction: best.row.offeredImages > 0 ? best.row.registeredImages / best.row.offeredImages : 0,
      registeredImages: best.row.registeredImages,
      offeredImages: best.row.offeredImages,
      inliers: best.row.inliers,
      scaleRatio: best.row.scaleRatio,
      ...uncertaintyOf(best.row),
      tiltDeg: best.tiltDeg,
    }, pivot)
  })
}

/** The folder of a session's reference cache, exported for the tests and the deletion tests that look for it. */
export { referenceCacheDir }
