/**
 * The DX8 kit: `?debug=tag` and `?debug=tagneg`, the two instruments device experiment DX8 reads (docs/testing/DEVICE_TESTING.md,
 * Procedure 8). Nothing here changes what the scanner does; it reads what the marker reader sees and writes lines.
 *
 * ## `?debug=tag`: one `[tag]` line a second, and a `[tagcam]` line now and then
 *
 * The numbers DX8 replaces adopted constants with, summarised over the frames read since the last line (medians, so one slow
 * frame does not move them): the stage times of a frame (the feed's copy, the worker's round trip and detector time, the
 * main thread's pose work, and, on the main thread, the detector's own stages), the tag's apparent size, how ambiguous its
 * two mirror solutions are, the reprojection residual, a rolling fusion's spread (position, heading, whole orientation), the session
 * units to the metre that the printed size implies (`upm`, with the camera travel it rests on), and the **lag fit**. What the camera
 * and the view were (the projection matrix entries P[0], P[5], P[8], P[9], the pixel array's columns and rows, the canvas, the fit)
 * is `[tagcam]`: it does not change from one second to the next, so it is written when the first frame is read, every 30 s, and when
 * the sizes or the fit change, and it leaves `[tag]` short enough to cross the relay whole (see below). The columns and what each
 * means are in the Procedure 8 tables of DEVICE_TESTING.md, and `tests/unit/node/fiducial_device_doc.test.ts` keeps those tables
 * equal to {@link TAG_KEYS} and {@link TAGCAM_KEYS}. `null` is "not available", never zero.
 *
 * **A line crosses the relay whole or not at all.** The `?debug=remote` relay cuts a message at `MAX_MSG_CHARS` (`src/debug/remote-log.ts`),
 * which leaves invalid JSON, so every line is bounded by construction, as the probe line is: a number is kept to the decimals and the
 * largest magnitude its column is declared for ({@link TAG_BOUNDS}) and is null beyond it (never a clipped value that reads as a
 * measurement), and a word is cut at its column's length. The test builds the longest line the bounds allow, and reads the relay's
 * own constant to measure it against.
 *
 * **One run follows another.** The session is a state machine that ends, and an instrument that sat on its last answer would go on
 * reporting the first run's numbers for every later one (a phone held at one mark, then walked to the next, on one page load). So when
 * the session ends (done, failed or timed out) the kit writes that outcome in the next line and begins a new session: each line is
 * about the frames since the last, and `ph`, `hint`, `ver` and `q` are those of the run in progress.
 *
 * The **lag fit** answers the question `pose-history.ts` leaves open: how many frames the pixels trail the pose. For each lag in 0, 1
 * and 2 the same detections are paired with the pose that many frames back, the tag's session pose is fused, and the fused tag
 * is reprojected through each frame's camera; the lag with the smallest median error is `lagBest`. It means something only
 * while the camera's speed CHANGES: a phone held still fits every lag equally, and so does one swept at a steady speed along a
 * steady arc about the tag, because a lag then only shifts the whole path in time, which a rotation of the tag's pose explains
 * exactly. Swing the phone past the tag and back, a few times (`lagTurn`, degrees, says how far it turned, not whether it
 * accelerated: the fit's own error figures, which differ between the lags only when it did, say that).
 *
 * ## `?debug=tagneg`: counters, and nothing else
 *
 * For the false-accept gate: how many frames were read with no tag in view, how many quads the geometry stage found
 * (`DetectorStats.candidates`, the denominator the gate counts), how many were decoded, and how many were taken for a tag. Every
 * number is a count. **No image leaves the phone and nothing is stored**: the counter adds up numbers from each frame's
 * `DetectorStats` and keeps no pixel, no corner, no crop and no frame; the line carries counts only; the module uses no storage and
 * no network (`tests/unit/node/fiducial_tag_debug.test.ts` reads this file to hold that). A tag in view during the run is a
 * detection that is not a false accept, so the walk is made with none in view.
 *
 * ## Arming
 *
 * `?debug=tag` and `?debug=tagneg` are tokens of the usual `?debug=` list (`src/shared/debug-flags.ts`), so
 * `?debug=remote,probe,tagneg` arms the relay, the probe line and the counters together. The lines go out as warnings, like the
 * probe line, so the relay carries them without `?debug=verbose`. Page parameters, all optional and checked: `tagsize`
 * (printed edge, millimetres, default 200), `tagfamily` (default `DEFAULT_TAG_FAMILY_NAME`), `taglag` (the lag the session is
 * paired at, 0 to 8, default `DEFAULT_PIXEL_LAG_FRAMES`), `tagrate` (frames a second asked of the feed, 1 to 30, default
 * `DEFAULT_TAG_MAX_HZ`: DX8's 5-minute run is made at 10), `tagid` (a registered tag id: the detector then reads only it, with no
 * bit errors) and `tagheight` (the tag centre's height above the floor, metres, so a session can place a frame).
 *
 * Browser-safe (ADR 0002). It takes its clock and its output as arguments, so a test runs it without a page.
 */
import type { ARProvider, Pose } from '../provider.ts'
import type { CameraFeedStats, CameraFrame } from '../camera-frame-feed.ts'
import type { ScaleKind } from '../../world/scale-mode.ts'
import { parseDebugFlags } from '../../shared/debug-flags.ts'
import { DEFAULT_PIXEL_LAG_FRAMES } from './pose-history.ts'
import { DEFAULT_TAG_FAMILY_NAME, tagFamilyByName } from './families.ts'
import { DEFAULT_TAG_MAX_HZ, startTagCapture, type TagCapture, type TagCaptureOptions, type TagCaptureUpdate } from './tag-capture.ts'
import { cornerRmsPx, estimateSessionScale, fuseTagObservations, meanSidePx, observationFromDetection, reprojectSessionTag, rotationAngleBetweenDeg, quatToMatrix } from './tag-pose.ts'
import { detectorOptionsForSession, TagSession, type TagSessionState } from './tag-session.ts'
import type { DetectorStats } from './detector.ts'
import type { CameraIntrinsics, FiducialDetection, Quad, TagObservation } from './types.ts'

export const TAG_LINE_PREFIX = '[tag] '
export const TAGNEG_LINE_PREFIX = '[tagneg] '
export const TAGCAM_LINE_PREFIX = '[tagcam] '
/** Frame time between `[tag]` lines, milliseconds. */
export const TAG_LINE_PERIOD_MS = 1000
/** Frame time between `[tagcam]` lines, milliseconds, when nothing has changed. The line repeats, so a lost one costs nothing but its own moment. Adopted, not measured (ADR 0005 rule 5). */
export const TAGCAM_LINE_PERIOD_MS = 30_000
/** Least frame time between two `[tagcam]` lines, milliseconds: a runtime that changed its sizes every frame would otherwise write a line a frame. Adopted, not measured (ADR 0005 rule 5). */
export const TAGCAM_CHANGE_MIN_MS = 1000
/**
 * Whether a line is due: the first one, one `periodMs` of frame time after the last, or the frame clock having gone BACKWARDS (a runtime that restarts its clock
 * would otherwise silence the kit until the new clock caught up with the old, and the frames of the window it was not writing would pile up in the meantime).
 */
function lineDue(lastMs: number | null, nowMs: number, periodMs: number): boolean {
  return lastMs === null || nowMs < lastMs || nowMs - lastMs >= periodMs
}
/** Frame time between `[tagneg]` lines, milliseconds. The line is cumulative, so a lost one costs nothing but its own moment. */
export const TAGNEG_LINE_PERIOD_MS = 30_000
/** The lags the lag fit tries: the pose of the same frame, and one and two frames older. */
export const LAG_FIT_LAGS: readonly number[] = [0, 1, 2]
/** Frames the lag fit and the rolling fusion look at, and the fewest it needs. Adopted, not measured (ADR 0005 rule 5). */
export const LAG_FIT_MAX_FRAMES = 40
export const LAG_FIT_MIN_FRAMES = 8
/** A frame joins the lag fit only if its quad is at least this many pixels across: the fit is about pose, not identity. Adopted, not measured. */
const LAG_FIT_MIN_SIDE_PX = 40

// -------------------------------------------------------------------------------------------
// Arming and parameters
// -------------------------------------------------------------------------------------------

export function tagDebugModes(search: string): { tag: boolean; tagneg: boolean } {
  const tokens = parseDebugFlags(search)
  return { tag: tokens.includes('tag'), tagneg: tokens.includes('tagneg') }
}

export interface TagDebugParams {
  printedSizeMm: number
  family: string
  lagFrames: number
  /** Frames a second asked of the feed. */
  maxHz: number
  expectedTagId: number | null
  mountHeightM: number | null
}

const DEFAULT_PRINTED_SIZE_MM = 200

/** The page parameters of the kit, or the first that is not usable. A value that is present and wrong is an error, not a default. */
export function tagDebugParams(search: string): TagDebugParams | { error: string } {
  const q = new URLSearchParams(search)
  const number = (name: string): number | null | 'bad' => {
    const raw = q.get(name)
    if (raw === null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : 'bad'
  }
  const size = number('tagsize')
  if (size === 'bad' || (size !== null && !(size >= 40 && size <= 600))) return { error: 'tagsize must be from 40 to 600 (millimetres)' }
  const family = q.get('tagfamily') ?? DEFAULT_TAG_FAMILY_NAME
  if (!tagFamilyByName(family)) return { error: `tagfamily ${family} is not a registered family` }
  const lag = number('taglag')
  if (lag === 'bad' || (lag !== null && !(Number.isInteger(lag) && lag >= 0 && lag <= 8))) return { error: 'taglag must be a whole number from 0 to 8' }
  const rate = number('tagrate')
  if (rate === 'bad' || (rate !== null && !(rate >= 1 && rate <= 30))) return { error: 'tagrate must be from 1 to 30 (frames a second)' }
  const id = number('tagid')
  if (id === 'bad' || (id !== null && !(Number.isInteger(id) && id >= 0))) return { error: 'tagid must be a whole number from 0' }
  if (id !== null && id >= tagFamilyByName(family)!.dictionary.size) return { error: `tagid ${id} is not an id of ${family}` }
  const height = number('tagheight')
  if (height === 'bad' || (height !== null && !(height >= 0 && height <= 4))) return { error: 'tagheight must be from 0 to 4 (metres)' }
  return { printedSizeMm: size ?? DEFAULT_PRINTED_SIZE_MM, family, lagFrames: lag ?? DEFAULT_PIXEL_LAG_FRAMES, maxHz: rate ?? DEFAULT_TAG_MAX_HZ, expectedTagId: id, mountHeightM: height }
}

// -------------------------------------------------------------------------------------------
// The lag fit
// -------------------------------------------------------------------------------------------

export interface LagFitSample {
  corners: Quad
  intrinsics: CameraIntrinsics
  /** Camera poses, newest first: index L is the pose L frames older than the newest. */
  poses: readonly Pose[]
}

export interface LagFitEntry {
  lag: number
  /** Samples that had a pose that far back. */
  frames: number
  /** Median distance between the detected corners and the fused tag reprojected through the frame's camera, pixels. */
  reprojectionRmsPx: number | null
  /** The fused tag position's robust scatter, metres, and its orientation's, degrees. */
  positionSpreadM: number | null
  rotationSpreadDeg: number | null
}

export interface LagFit {
  entries: LagFitEntry[]
  /** The lag with the smallest reprojection error (the lower on a tie), or null when none could be fitted. */
  best: number | null
  /** The largest turn between any two camera orientations in the samples, degrees: a fit means something only if this is not near zero. */
  turnDeg: number
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const a = Array.from(values).sort((x, y) => x - y)
  const n = a.length
  return n % 2 ? a[(n - 1) / 2]! : 0.5 * (a[n / 2 - 1]! + a[n / 2]!)
}

/**
 * Fit how many frames the pixels trail the pose, by trying each lag: pair every sample's corners with the camera pose that many
 * frames back, fuse the tag's session pose (a permissive fusion: the gates are not what is being measured), reproject it through
 * each frame's camera and take the median distance from the detected corners. `sessionUnitsPerMetre` converts the
 * session to metres (1 for a metric runtime; the tag's own estimate over the samples at lag 1 when omitted, else 1).
 */
export function fitPixelLag(samples: readonly LagFitSample[], tagSizeM: number, options: { lags?: readonly number[]; sessionUnitsPerMetre?: number } = {}): LagFit {
  const lags = options.lags ?? LAG_FIT_LAGS
  const at = (lag: number): Array<{ sample: LagFitSample; pose: Pose }> => samples.filter((s) => s.poses.length > lag).map((s) => ({ sample: s, pose: s.poses[lag]! }))
  let units = options.sessionUnitsPerMetre
  if (units === undefined) {
    const obs = at(Math.min(1, Math.max(...lags))).map(({ sample, pose }): TagObservation => ({ corners: sample.corners, intrinsics: sample.intrinsics, cameraPose: pose }))
    units = estimateSessionScale(obs, tagSizeM, { minSidePx: 0 })?.sessionUnitsPerMetre ?? 1
  }
  const entries: LagFitEntry[] = lags.map((lag) => {
    const paired = at(lag)
    const obs = paired.map(({ sample, pose }): TagObservation => ({ corners: sample.corners, intrinsics: sample.intrinsics, cameraPose: pose }))
    const fused = fuseTagObservations(obs, {
      tagSizeM,
      sessionUnitsPerMetre: units,
      minFrames: 3,
      minSidePx: 0,
      maxRangeM: 30,
      maxViewAngleDeg: 85,
      maxReprojectionRmsPx: 5,
      maxPoseSpreadM: Infinity,
      maxRotationSpreadDeg: Infinity,
    })
    if (!fused.pose) return { lag, frames: paired.length, reprojectionRmsPx: null, positionSpreadM: null, rotationSpreadDeg: null }
    const tag = fused.pose
    const errors = paired.map(({ sample, pose }) => cornerRmsPx(reprojectSessionTag(tag, pose, sample.intrinsics, tagSizeM, units!), sample.corners))
    return { lag, frames: paired.length, reprojectionRmsPx: median(errors), positionSpreadM: fused.poseSpreadM, rotationSpreadDeg: fused.rotationSpreadDeg }
  })
  let best: number | null = null
  let bestError = Infinity
  for (const e of entries) {
    if (e.reprojectionRmsPx !== null && e.reprojectionRmsPx < bestError) {
      bestError = e.reprojectionRmsPx
      best = e.lag
    }
  }
  const newest = samples.map((s) => quatToMatrix(s.poses[0]!.rotation))
  let turnDeg = 0
  for (let i = 0; i < newest.length; i++) for (let j = i + 1; j < newest.length; j++) turnDeg = Math.max(turnDeg, rotationAngleBetweenDeg(newest[i]!, newest[j]!))
  return { entries, best, turnDeg }
}

// -------------------------------------------------------------------------------------------
// The negative-corpus counter
// -------------------------------------------------------------------------------------------

export interface NegativeCounts {
  /** Frames read. */
  frames: number
  /** Quads the geometry stage found, all frames (`DetectorStats.candidates`): the denominator of the false-accept gate. */
  candidates: number
  groups: number
  /** Quads decoded (`DetectorStats.decodeAttempts`). */
  decodeAttempts: number
  /** Decoded quads that got as far as the dictionary: attempts less those refused earlier. The denominator of the dictionary's own false-accept arithmetic. */
  reachedMatcher: number
  /** Tags reported. On a corpus with no tag in view, every one is a false accept. */
  detections: number
  /** Frames on which the decode budget ran out with quads unread. */
  cappedFrames: number
  /** The most quads one frame had. */
  maxCandidates: number
  rejected: DetectorStats['rejected']
}

/**
 * Adds up `DetectorStats`, frame by frame. It keeps numbers and nothing else: no frame, no corner, no crop. A false accept is a
 * detection on a frame with no tag in it, so on a corpus made that way `detections` is the number of them.
 */
export class TagNegativeCounter {
  private counts: NegativeCounts = TagNegativeCounter.empty()

  private static empty(): NegativeCounts {
    return { frames: 0, candidates: 0, groups: 0, decodeAttempts: 0, reachedMatcher: 0, detections: 0, cappedFrames: 0, maxCandidates: 0, rejected: { offFrame: 0, contrast: 0, border: 0, quiet: 0, match: 0, ids: 0 } }
  }

  add(stats: DetectorStats): void {
    const c = this.counts
    c.frames++
    c.candidates += stats.candidates
    c.groups += stats.groups
    c.decodeAttempts += stats.decodeAttempts
    c.reachedMatcher += Math.max(0, stats.decodeAttempts - stats.rejected.offFrame - stats.rejected.contrast - stats.rejected.border - stats.rejected.quiet)
    c.detections += stats.detections
    if (stats.capped) c.cappedFrames++
    c.maxCandidates = Math.max(c.maxCandidates, stats.candidates)
    for (const key of Object.keys(c.rejected) as Array<keyof NegativeCounts['rejected']>) c.rejected[key] += stats.rejected[key]
  }

  snapshot(): NegativeCounts {
    return { ...this.counts, rejected: { ...this.counts.rejected } }
  }

  reset(): void {
    this.counts = TagNegativeCounter.empty()
  }
}

// -------------------------------------------------------------------------------------------
// The lines
// -------------------------------------------------------------------------------------------

/** The `[tag]` line's fields. Every one is a number, a short word or null. */
export interface TagRecord {
  v: 1
  n: number
  rt: string
  mode: string | null
  fb: string | null
  un: string | null
  fr: number
  hit: number
  drop: number
  id: number | null
  side: number | null
  amb: number | null
  vang: number | null
  rng: number | null
  rms: number | null
  spd: number | null
  roi: number | null
  tCopy: number | null
  tRound: number | null
  tDet: number | null
  tWorker: number | null
  tPose: number | null
  tLuma: number | null
  tPyr: number | null
  tQuad: number | null
  tRefine: number | null
  tDecode: number | null
  fuseN: number | null
  fuseSpreadM: number | null
  fuseRotDeg: number | null
  fuseHeadDeg: number | null
  fuseRms: number | null
  upm: number | null
  upmBase: number | null
  lagRms0: number | null
  lagRms1: number | null
  lagRms2: number | null
  lagSpread0: number | null
  lagSpread1: number | null
  lagSpread2: number | null
  lagBest: number | null
  lagTurn: number | null
  ph: string | null
  pr: number | null
  hint: string | null
  ver: string | null
  q: string | null
}

const TAG_KEY_TABLE: Record<keyof TagRecord, true> = {
  v: true, n: true, rt: true, mode: true, fb: true, un: true, fr: true, hit: true, drop: true, id: true, side: true, amb: true, vang: true, rng: true, rms: true, spd: true, roi: true,
  tCopy: true, tRound: true, tDet: true, tWorker: true, tPose: true, tLuma: true, tPyr: true, tQuad: true, tRefine: true, tDecode: true,
  fuseN: true, fuseSpreadM: true, fuseRotDeg: true, fuseHeadDeg: true, fuseRms: true, upm: true, upmBase: true,
  lagRms0: true, lagRms1: true, lagRms2: true, lagSpread0: true, lagSpread1: true, lagSpread2: true, lagBest: true, lagTurn: true,
  ph: true, pr: true, hint: true, ver: true, q: true,
}
/** The keys of a `[tag]` line, in the order they are written. The Procedure 8 table in DEVICE_TESTING.md is held equal to this. */
export const TAG_KEYS: ReadonlyArray<keyof TagRecord> = Object.keys(TAG_KEY_TABLE) as Array<keyof TagRecord>

/** The `[tagneg]` line's fields: cumulative counts. */
export interface TagNegRecord {
  v: 1
  n: number
  rt: string
  mode: string | null
  fb: string | null
  un: string | null
  /** Seconds of frame time since the first frame counted. */
  s: number
  frames: number
  cand: number
  groups: number
  attempts: number
  reach: number
  det: number
  capped: number
  maxCand: number
  rejOff: number
  rejContrast: number
  rejBorder: number
  rejQuiet: number
  rejMatch: number
  rejIds: number
  drop: number
  cols: number | null
  rows: number | null
}

const TAGNEG_KEY_TABLE: Record<keyof TagNegRecord, true> = {
  v: true, n: true, rt: true, mode: true, fb: true, un: true, s: true, frames: true, cand: true, groups: true, attempts: true, reach: true, det: true, capped: true, maxCand: true,
  rejOff: true, rejContrast: true, rejBorder: true, rejQuiet: true, rejMatch: true, rejIds: true, drop: true, cols: true, rows: true,
}
export const TAGNEG_KEYS: ReadonlyArray<keyof TagNegRecord> = Object.keys(TAGNEG_KEY_TABLE) as Array<keyof TagNegRecord>

/**
 * The `[tagcam]` line's fields: the camera and the view, as the frames showed them. Written when the first frame is read, every
 * {@link TAGCAM_LINE_PERIOD_MS}, and when the sizes or the fit change; and once, in place of the frames, when the view is one the reader refuses.
 */
export interface TagCamRecord {
  v: 1
  n: number
  rt: string
  /** Why no frame is read at all, when that is so (see `[tag]`'s `un`). */
  un: string | null
  /** Entries 0, 5, 8 and 9 of the projection matrix the engine published (column-major): the focal terms and the principal-point offsets of the clip square. */
  p0: number | null
  p5: number | null
  p8: number | null
  p9: number | null
  /** The camera pixel array. */
  cols: number | null
  rows: number | null
  /** The canvas the page draws the camera in. */
  cw: number | null
  ch: number | null
  /** How the canvas shows the camera: `contain` or `cover`. */
  fit: string | null
  /** Ticks the feed did not deliver because the runtime held its pose over, since the page loaded (`CameraFeedStats.heldPose`). The feed forgets the poses before such a tick. */
  held: number | null
  /** Due ticks the feed could not pair with a pose the lag back, for want of history, since the page loaded (`CameraFeedStats.unpaired`). */
  unp: number | null
}

const TAGCAM_KEY_TABLE: Record<keyof TagCamRecord, true> = { v: true, n: true, rt: true, un: true, p0: true, p5: true, p8: true, p9: true, cols: true, rows: true, cw: true, ch: true, fit: true, held: true, unp: true }
export const TAGCAM_KEYS: ReadonlyArray<keyof TagCamRecord> = Object.keys(TAGCAM_KEY_TABLE) as Array<keyof TagCamRecord>

// -------------------------------------------------------------------------------------------
// Bounds: a line is as long as its columns allow, and no longer
// -------------------------------------------------------------------------------------------

/**
 * What a numeric column keeps: decimals, and the largest magnitude it carries (a number beyond it is null). A column is not signed unless it says so: a negative
 * time, size, range or count is not a measurement, and is null.
 */
export interface FieldBound {
  decimals: number
  max: number
  signed?: boolean
}

const count = (max: number): FieldBound => ({ decimals: 0, max })
const ms1 = (max: number): FieldBound => ({ decimals: 1, max })

/**
 * The bound of every numeric column of the `[tag]` line. Adopted, not measured (ADR 0005 rule 5): each `max` is far above anything a phone is expected to
 * write (a frame side over 999 px, a round trip over ten seconds), and each decimals is finer than the quantity is measured to, so that the longest line the
 * bounds allow stays inside the relay's cap (`fiducial_tag_debug.test.ts` measures it). A column's number beyond its `max` is `null`, "not available", rather
 * than a clipped value that would read as a measurement.
 */
export const TAG_BOUNDS: Readonly<Record<string, FieldBound>> = Object.freeze({
  v: count(1),
  n: count(99_999),
  fr: count(999), hit: count(999), drop: count(999), id: count(999),
  side: ms1(999.9), amb: { decimals: 2, max: 10 }, vang: ms1(90), rng: { decimals: 3, max: 99.999 }, rms: { decimals: 3, max: 9.999 }, spd: ms1(999.9), roi: { decimals: 2, max: 1 },
  tCopy: { decimals: 2, max: 99.99 }, tRound: ms1(9999.9), tDet: ms1(9999.9), tWorker: ms1(9999.9), tPose: ms1(999.9),
  tLuma: ms1(999.9), tPyr: ms1(999.9), tQuad: ms1(999.9), tRefine: ms1(999.9), tDecode: ms1(999.9),
  fuseN: count(99), fuseSpreadM: { decimals: 4, max: 9.9999 }, fuseRotDeg: { decimals: 2, max: 180 }, fuseHeadDeg: { decimals: 2, max: 180 }, fuseRms: { decimals: 3, max: 9.999 },
  upm: { decimals: 4, max: 99.9999 }, upmBase: { decimals: 2, max: 99.99 },
  lagRms0: { decimals: 3, max: 9.999 }, lagRms1: { decimals: 3, max: 9.999 }, lagRms2: { decimals: 3, max: 9.999 },
  lagSpread0: { decimals: 4, max: 9.9999 }, lagSpread1: { decimals: 4, max: 9.9999 }, lagSpread2: { decimals: 4, max: 9.9999 }, lagBest: count(2), lagTurn: ms1(360),
  pr: { decimals: 2, max: 1 },
})

/** The bound of every numeric column of the `[tagcam]` line (as for {@link TAG_BOUNDS}). */
export const TAGCAM_BOUNDS: Readonly<Record<string, FieldBound>> = Object.freeze({
  v: count(1),
  n: count(99_999),
  p0: { decimals: 5, max: 99.99999 }, p5: { decimals: 5, max: 99.99999 }, p8: { decimals: 5, max: 9.99999, signed: true }, p9: { decimals: 5, max: 9.99999, signed: true },
  cols: count(99_999), rows: count(99_999), cw: count(99_999), ch: count(99_999),
  held: count(999_999_999), unp: count(999_999_999),
})

/** The bound of every numeric column of the `[tagneg]` line, whose counts are cumulative since the page loaded (as for {@link TAG_BOUNDS}). */
export const TAGNEG_BOUNDS: Readonly<Record<string, FieldBound>> = Object.freeze({
  v: count(1),
  n: count(99_999),
  s: ms1(99_999_999.9),
  frames: count(999_999_999), cand: count(999_999_999), groups: count(999_999_999), attempts: count(999_999_999), reach: count(999_999_999), det: count(999_999_999),
  capped: count(999_999_999), maxCand: count(99_999), rejOff: count(999_999_999), rejContrast: count(999_999_999), rejBorder: count(999_999_999), rejQuiet: count(999_999_999),
  rejMatch: count(999_999_999), rejIds: count(999_999_999), drop: count(999_999_999),
  cols: count(99_999), rows: count(99_999),
})

/** The longest a word column is, characters: the longest member of its vocabulary. A longer word is cut. */
export const TAG_WORD_MAX: Readonly<Record<string, number>> = Object.freeze({ rt: 7, mode: 11, fb: 15, un: 22, fit: 7, ph: 10, hint: 14, ver: 11, q: 4 })

/** `record` with every number kept to its column's bound and every word to its column's length. Key order is kept. */
function bounded<T extends object>(record: T, bounds: Readonly<Record<string, FieldBound>>): T {
  const out = {} as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    const bound = bounds[key]
    if (typeof value === 'number' && bound) {
      const f = 10 ** bound.decimals
      const rounded = Math.round(value * f) / f
      const inside = Number.isFinite(rounded) && Math.abs(rounded) <= bound.max && (bound.signed === true || rounded >= 0)
      out[key] = inside ? (rounded === 0 ? 0 : rounded) : null
    } else if (typeof value === 'string' && TAG_WORD_MAX[key] !== undefined) {
      out[key] = value.slice(0, TAG_WORD_MAX[key])
    } else {
      out[key] = value
    }
  }
  return out as T
}

export function formatTagLine(record: TagRecord): string {
  return TAG_LINE_PREFIX + JSON.stringify(bounded(record, TAG_BOUNDS))
}

export function formatTagNegLine(record: TagNegRecord): string {
  return TAGNEG_LINE_PREFIX + JSON.stringify(bounded(record, TAGNEG_BOUNDS))
}

export function formatTagCamLine(record: TagCamRecord): string {
  return TAGCAM_LINE_PREFIX + JSON.stringify(bounded(record, TAGCAM_BOUNDS))
}

function round(value: number | null | undefined, decimals: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

// -------------------------------------------------------------------------------------------
// Installing it
// -------------------------------------------------------------------------------------------

export interface TagDebugDeps {
  provider: Pick<ARProvider, 'onCameraFrame' | 'scaleKind'> & { cameraFeedStats?: () => Readonly<CameraFeedStats> }
  /** The AR runtime, as the probe line's `rt` names it (`probeRuntimeLabel` in src/main.ts): `native` while a ScanAR session runs. */
  runtime: '8thwall' | 'webxr' | 'native'
  /** Where a line goes. Default `console.warn`, which the `?debug=remote` relay carries without `?debug=verbose`. */
  emit?: (line: string) => void
  /** Passed to the capture (a test injects a fake worker). */
  worker?: TagCaptureOptions['worker']
}

interface WindowFrame {
  update: TagCaptureUpdate
  best: FiducialDetection | null
}

/** What a view looked like, for `[tagcam]`: the part of a frame that says which camera and which canvas it was. */
type CameraView = Pick<CameraFrame, 'projection' | 'width' | 'height' | 'display'>

/** The part of a view that changes rarely, as a string: a change in it earns a `[tagcam]` line of its own. */
function cameraViewKey(view: CameraView): string {
  return [view.width, view.height, view.display?.canvasWidth ?? '', view.display?.canvasHeight ?? '', view.display?.fit ?? ''].join(',')
}

/** The phases a session does not leave: its outcome, and then it ignores frames. */
function isEnded(state: TagSessionState | null): state is TagSessionState {
  return state !== null && (state.phase === 'done' || state.phase === 'failed' || state.phase === 'timed-out')
}

/**
 * Start the kit when the page was loaded with `?debug=tag` or `?debug=tagneg`. Returns the function that stops it, or null when it
 * is not armed (nothing was added to the page). `search` is injectable.
 */
export function installTagDebug(deps: TagDebugDeps, search?: string): (() => void) | null {
  const query = search ?? (typeof location === 'undefined' ? '' : location.search)
  const modes = tagDebugModes(query)
  if (!modes.tag && !modes.tagneg) return null
  const write = deps.emit ?? ((line: string) => console.warn(line))
  // A diagnostic does not break the page: a line that cannot be written is a gap in `n`.
  const emit = (line: string): void => {
    try {
      write(line)
    } catch {
      // See above.
    }
  }
  const params = tagDebugParams(query)
  if ('error' in params) {
    emit(TAG_LINE_PREFIX + JSON.stringify({ v: 1, error: params.error }))
    return null
  }
  const family = tagFamilyByName(params.family)!
  const tagSizeM = (params.printedSizeMm * family.quadFraction) / 1000
  const scaleKind: ScaleKind = deps.provider.scaleKind?.() ?? 'arbitrary'

  const session = modes.tag
    ? new TagSession({
        family: params.family,
        printedSizeMm: params.printedSizeMm,
        sizeSource: 'qr',
        quadFraction: family.quadFraction,
        expected: params.expectedTagId === null ? null : { family: params.family, tagId: params.expectedTagId },
        scaleKind,
        floor: () => ({ floorY: null, mountHeightM: params.mountHeightM }),
      })
    : null

  const counter = new TagNegativeCounter()
  let tagLines = 0
  let negLines = 0
  let camLines = 0
  // Only the `[tag]` window keeps frames, and only until its line is written: the negative-corpus run is a walk of tens of thousands of frames, and
  // keeping each (its pose, its detections, its corners) would be both the unbounded growth and the "nothing is kept" claim this kit makes, broken.
  let pending: WindowFrame[] = []
  const fitSamples: LagFitSample[] = []
  const fuseObservations: TagObservation[] = []
  let lastTagLineAtMs: number | null = null
  let lastNegLineAtMs: number | null = null
  let lastCamLineAtMs: number | null = null
  let lastCamKey: string | null = null
  let firstFrameAtMs: number | null = null
  let dropsAtLastTagLine = 0
  let latestSize: { cols: number | null; rows: number | null } = { cols: null, rows: null }
  /** The outcome of a session that ended since the last `[tag]` line, which is then written with it. */
  let endedSince: TagSessionState | null = null

  const clientStats = () => capture.client?.stats ?? null
  const dropsNow = (): number => {
    const s = clientStats()
    return s ? s.droppedBusy + s.droppedRate : 0
  }

  const camRecord = (view: CameraView | null, un: string | null): TagCamRecord => {
    const feed = deps.provider.cameraFeedStats?.()
    return {
      v: 1,
      n: ++camLines,
      rt: deps.runtime,
      un,
      p0: view ? view.projection[0] ?? null : null,
      p5: view ? view.projection[5] ?? null : null,
      p8: view ? view.projection[8] ?? null : null,
      p9: view ? view.projection[9] ?? null : null,
      cols: view ? view.width : null,
      rows: view ? view.height : null,
      cw: view?.display?.canvasWidth ?? null,
      ch: view?.display?.canvasHeight ?? null,
      fit: view?.display?.fit ?? null,
      held: feed ? feed.heldPose : null,
      unp: feed ? feed.unpaired : null,
    }
  }

  /** `[tagcam]` when the view was first seen, every period, and when its sizes or fit change (not oftener than {@link TAGCAM_CHANGE_MIN_MS}). */
  const noteCamera = (view: CameraView, frameMs: number): void => {
    const key = cameraViewKey(view)
    const sinceLast = lastCamLineAtMs === null || frameMs < lastCamLineAtMs ? Infinity : frameMs - lastCamLineAtMs
    if (lastCamLineAtMs !== null && sinceLast < TAGCAM_LINE_PERIOD_MS && !(key !== lastCamKey && sinceLast >= TAGCAM_CHANGE_MIN_MS)) return
    lastCamLineAtMs = frameMs
    lastCamKey = key
    emit(formatTagCamLine(camRecord(view, null)))
  }

  const flushTag = (): void => {
    if (pending.length === 0) return
    const frames = pending
    pending = []
    const hits = frames.filter((f) => f.best !== null)
    const med = (pick: (f: WindowFrame) => number | null | undefined): number | null => median(frames.map(pick).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)))
    const latest = frames[frames.length - 1]!.update
    const stage = (key: 'luma' | 'pyramid' | 'quads' | 'refine' | 'decode'): number | null => med((f) => f.update.result.stats.stageMs?.[key])
    const feed = deps.provider.cameraFeedStats?.()
    // The run's outcome if one ended in this window, else where the session stands after the last frame.
    const state = endedSince ?? latest.state
    endedSince = null
    // The unit the printed size implies, from the frames in the window (null while the camera has not travelled MIN_SCALE_BASELINE_M): logged on every runtime,
    // so that a metric runtime's claim is checked against it too. The kit's own fusions are in the session's units made metric: 1 on a metric runtime, else this estimate (1 if there is none).
    const scale = fuseObservations.length >= 3 ? estimateSessionScale(fuseObservations, tagSizeM, { minSidePx: 0 }) : null
    const units = scaleKind === 'metric' ? 1 : (scale?.sessionUnitsPerMetre ?? 1)
    const fit = fitSamples.length >= LAG_FIT_MIN_FRAMES ? fitPixelLag(fitSamples, tagSizeM, { sessionUnitsPerMetre: units }) : null
    const fused =
      fuseObservations.length >= 3
        ? fuseTagObservations(fuseObservations, { tagSizeM, sessionUnitsPerMetre: units, minFrames: 3, minSidePx: 0, maxRangeM: 30, maxViewAngleDeg: 85, maxReprojectionRmsPx: 5, maxPoseSpreadM: Infinity, maxRotationSpreadDeg: Infinity })
        : null
    const entry = (lag: number): LagFitEntry | null => fit?.entries.find((e) => e.lag === lag) ?? null
    const record: TagRecord = {
      v: 1,
      n: ++tagLines,
      rt: deps.runtime,
      mode: capture.client?.mode ?? null,
      fb: clientStats()?.fallbackReason ?? null,
      un: capture.unavailable,
      fr: frames.length,
      hit: hits.length,
      drop: dropsNow() - dropsAtLastTagLine,
      id: hits.length > 0 ? hits[hits.length - 1]!.best!.id : null,
      side: round(median(hits.map((f) => f.best!.sidePx)), 1),
      amb: round(med((f) => f.update.state?.latest.ambiguityRatio), 2),
      vang: round(med((f) => f.update.state?.latest.viewAngleDeg), 1),
      rng: round(med((f) => f.update.state?.latest.rangeM), 3),
      rms: round(med((f) => f.update.state?.latest.reprojectionRmsPx), 3),
      spd: round(med((f) => f.update.result.frame.angularSpeedDegPerS), 1),
      roi: round(frames.filter((f) => f.update.result.roi !== null).length / frames.length, 2),
      tCopy: feed && feed.delivered > 0 ? round(feed.copyMs / feed.delivered, 2) : null,
      tRound: round(med((f) => f.update.result.roundTripMs), 1),
      tDet: round(med((f) => f.update.result.detectMs), 1),
      tWorker: round(med((f) => f.update.result.workerMs), 1),
      tPose: round(med((f) => f.update.sessionMs), 1),
      tLuma: round(stage('luma'), 1),
      tPyr: round(stage('pyramid'), 1),
      tQuad: round(stage('quads'), 1),
      tRefine: round(stage('refine'), 1),
      tDecode: round(stage('decode'), 1),
      fuseN: fused?.pose ? fused.nFrames : null,
      fuseSpreadM: round(fused?.pose ? fused.poseSpreadM : null, 4),
      fuseRotDeg: round(fused?.pose ? fused.rotationSpreadDeg : null, 2),
      fuseHeadDeg: round(fused?.pose ? fused.headingSpreadDeg : null, 2),
      fuseRms: round(fused?.pose ? fused.reprojectionRmsPx : null, 3),
      upm: round(scale?.sessionUnitsPerMetre ?? null, 4),
      upmBase: round(scale?.baselineM ?? null, 2),
      lagRms0: round(entry(0)?.reprojectionRmsPx ?? null, 3),
      lagRms1: round(entry(1)?.reprojectionRmsPx ?? null, 3),
      lagRms2: round(entry(2)?.reprojectionRmsPx ?? null, 3),
      lagSpread0: round(entry(0)?.positionSpreadM ?? null, 4),
      lagSpread1: round(entry(1)?.positionSpreadM ?? null, 4),
      lagSpread2: round(entry(2)?.positionSpreadM ?? null, 4),
      lagBest: fit?.best ?? null,
      lagTurn: round(fit?.turnDeg ?? null, 1),
      ph: state?.phase ?? null,
      pr: round(state?.progress ?? null, 2),
      hint: state?.hint?.code ?? null,
      ver: state?.result?.verdict.status ?? null,
      q: state?.result?.verdict.quality ?? null,
    }
    dropsAtLastTagLine = dropsNow()
    emit(formatTagLine(record))
  }

  const flushNeg = (frameMs: number): void => {
    const c = counter.snapshot()
    if (c.frames === 0) return
    const record: TagNegRecord = {
      v: 1,
      n: ++negLines,
      rt: deps.runtime,
      mode: capture.client?.mode ?? null,
      fb: clientStats()?.fallbackReason ?? null,
      un: capture.unavailable,
      s: round(firstFrameAtMs === null ? 0 : (frameMs - firstFrameAtMs) / 1000, 1) ?? 0,
      frames: c.frames,
      cand: c.candidates,
      groups: c.groups,
      attempts: c.decodeAttempts,
      reach: c.reachedMatcher,
      det: c.detections,
      capped: c.cappedFrames,
      maxCand: c.maxCandidates,
      rejOff: c.rejected.offFrame,
      rejContrast: c.rejected.contrast,
      rejBorder: c.rejected.border,
      rejQuiet: c.rejected.quiet,
      rejMatch: c.rejected.match,
      rejIds: c.rejected.ids,
      drop: dropsNow(),
      cols: latestSize.cols,
      rows: latestSize.rows,
    }
    emit(formatTagNegLine(record))
  }

  let lastFrameMs = 0
  const capture: TagCapture = startTagCapture({
    provider: deps.provider,
    session,
    family: params.family,
    // The detector the scanner will run, not a looser or a tighter one: a false-accept count on any other configuration says nothing about this one
    // (`tagid` makes it the registered-tag configuration). `profile` times its stages, which DX8 asks for, at about ten clock reads a frame.
    detector: { ...detectorOptionsForSession({ expected: params.expectedTagId === null ? null : { family: params.family, tagId: params.expectedTagId } }), profile: true },
    lagFrames: params.lagFrames,
    maxHz: params.maxHz,
    recentPoses: LAG_FIT_LAGS.length,
    worker: deps.worker,
    onUpdate: (update) => {
      const t = update.result.frame.timestampMs
      lastFrameMs = t
      firstFrameAtMs ??= t
      latestSize = { cols: update.result.frame.width, rows: update.result.frame.height }
      if (modes.tagneg) counter.add(update.result.stats)
      if (modes.tag) {
        noteCamera(update.result.frame, t)
        const best = update.result.detections[0] ?? null
        pending.push({ update, best })
        if (best && best.refined && meanSidePx(best.corners) >= LAG_FIT_MIN_SIDE_PX && update.result.frame.recentPoses && update.result.frame.recentPoses.length >= LAG_FIT_LAGS.length) {
          fitSamples.push({ corners: best.corners, intrinsics: update.intrinsics, poses: update.result.frame.recentPoses })
          if (fitSamples.length > LAG_FIT_MAX_FRAMES) fitSamples.shift()
          const pose = update.result.frame.pose
          fuseObservations.push(observationFromDetection(best, update.intrinsics, pose, t))
          if (fuseObservations.length > LAG_FIT_MAX_FRAMES) fuseObservations.shift()
        }
        // A session that ended has said its piece: its outcome goes out with the next line, and the next run begins afresh.
        if (isEnded(update.state)) {
          endedSince = update.state
          session?.reset()
        }
        if (lineDue(lastTagLineAtMs, t, TAG_LINE_PERIOD_MS)) {
          lastTagLineAtMs = t
          flushTag()
        }
      }
      if (modes.tagneg && lineDue(lastNegLineAtMs, t, TAGNEG_LINE_PERIOD_MS)) {
        lastNegLineAtMs = t
        flushNeg(t)
      }
    },
    // A feed that will never deliver (WebXR, no feed at all) or a view the reader refuses (a cropped canvas: `cover`) is said once, in the same
    // shapes as every other line, and the camera line carries the view that was refused. It runs before `capture` exists when the refusal is at once.
    onUnavailable: (reason, frame) => {
      if (modes.tag) {
        emit(formatTagLine({ ...blankTagRecord(deps.runtime), n: ++tagLines, un: reason }))
        emit(formatTagCamLine(camRecord(frame ?? null, reason)))
      }
      if (modes.tagneg) emit(formatTagNegLine({ ...blankTagNegRecord(deps.runtime), n: ++negLines, un: reason }))
    },
  })

  const onHide = (): void => {
    if (modes.tag) flushTag()
    if (modes.tagneg) flushNeg(lastFrameMs)
  }
  if (typeof window !== 'undefined' && typeof (globalThis as { addEventListener?: unknown }).addEventListener === 'function') {
    ;(globalThis as unknown as { addEventListener: (t: string, l: () => void) => void }).addEventListener('pagehide', onHide)
  }
  return () => {
    onHide()
    capture.stop()
    if (typeof (globalThis as { removeEventListener?: unknown }).removeEventListener === 'function') {
      ;(globalThis as unknown as { removeEventListener: (t: string, l: () => void) => void }).removeEventListener('pagehide', onHide)
    }
  }
}

function blankTagRecord(runtime: string): TagRecord {
  const record = {} as Record<string, unknown>
  for (const key of TAG_KEYS) record[key] = null
  return { ...(record as unknown as TagRecord), v: 1, n: 0, rt: runtime, fr: 0, hit: 0, drop: 0 }
}

function blankTagNegRecord(runtime: string): TagNegRecord {
  return { v: 1, n: 0, rt: runtime, mode: null, fb: null, un: null, s: 0, frames: 0, cand: 0, groups: 0, attempts: 0, reach: 0, det: 0, capped: 0, maxCand: 0, rejOff: 0, rejContrast: 0, rejBorder: 0, rejQuiet: 0, rejMatch: 0, rejIds: 0, drop: 0, cols: null, rows: null }
}
