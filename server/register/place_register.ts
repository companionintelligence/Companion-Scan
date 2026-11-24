/**
 * The `place-register` WorldJob: compare a new scan with the Place's other
 * calibrated scans and propose a small move. Slice 1 of server registration
 * (WP-15a): the scan-matching verifier and the proposal flow. No GPU, no COLMAP,
 * no Python.
 *
 * ## One job system
 *
 * This is a `WorldJob` type, not a queue (ADR 0001, ADR 0003). Dedupe on
 * `(type, scanId)`, single-flight execution, boot-time requeue and the bounded
 * history all come from `createWorldJob`, `WorldJobPump` and
 * `recoverStuckWorldJobs` as they do for `memory-push` and `lingbot-map-reconstruct`;
 * nothing here re-implements any of them. Re-running after a crash is safe: the
 * job reads the scans' files and writes one artifact, the same artifact every time.
 *
 * ## What the job does, and the three things it will not do
 *
 * It reads the new scan's point cloud and each reference's from their GLBs
 * (`readScanGlb` and `collectPointPositions`, the readers `export-world` and
 * `panoptic-lift` already use), carries each through its `localToWorld` into the
 * Place frame, and hands the pair to `matchScans`. The result is stored on the
 * job as a `place-register-proposal` artifact.
 *
 *  1. **It never moves a scan.** A proposal is a measurement and a suggestion;
 *     a person applies it in the editor, which writes an ordinary scan EditPatch
 *     (owner decision D17, approved). `scan.localToWorld` is untouched here.
 *  2. **It never sets `scan.status`.** `'aligned'` is a claim that something was
 *     aligned. A run that proposes nothing, or proposes something nobody has
 *     applied, has aligned nothing, and `applyCompletedJobToWorld` has no branch
 *     for this type for that reason.
 *  3. **It never touches the raw calibration.** The sidecar's `projectTransform`
 *     and `calibration.sessionToProject` stay as the capture measured them. The
 *     refined placement is the patch; the measured residual travels with it as
 *     `provenance.residualM` (PLACE_SCAN_DESIGN.md, "Spatial Alignment Contract":
 *     alignment jobs retain raw AR pose and user transform as separate provenance).
 *
 * ## The injected host
 *
 * `server/main.ts` cannot be imported by a test (it serves at import), so the job
 * takes the few pieces of main.ts it needs as a {@link PlaceRegisterHost}: claim,
 * world read, GLB bytes, commit, fail. main.ts passes its own functions; a test
 * passes fakes. That keeps the hook in main.ts to a dozen lines.
 */
import type { EditPatch, EditPatchProvenance, ScanManifest, WorldJob, WorldProject } from '../../src/world/types.ts'
import {
  agreementOf,
  findAppliedRegisterPatch,
  isMatrix16,
  matricesAgree,
  methodProposal,
  multiplyMat4,
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  PLACE_REGISTER_SKIP_ARTIFACT,
  PLACE_REGISTER_SOURCE,
  type PlaceRegisterComparison,
  type PlaceRegisterResult,
  readPlaceRegisterResult,
  type RegistrationMethod,
  type RegistrationProposal,
  type RegistrationRefusal,
  registerApplyState,
  refusalText,
  requestsPhotoMethod,
  sfmReasonText,
  type SfmResult,
  type StartingValue,
} from '../../src/world/register-proposal.ts'
import { scaleKindOfMode } from '../../src/world/scale-mode.ts'
import { isPlaceFrameMethod } from '../../src/world/spatial-frame.ts'
import { collectPointPositions } from '../panoptic/panoptic_lift.ts'
import { readScanGlb } from '../world_export.ts'
import { matchParams, matchScansYielding, transformPositions } from './scan_match.ts'
import { runSfmRegistration, type SfmHost, skippedResult } from './place_register_sfm.ts'

/**
 * Most reference scans the matcher searches one new scan against, in the order
 * {@link planPlaceRegister} ranks them. Each search is a fraction of a second to a
 * few seconds of CPU on the one thread the server shares with the upload routes, so
 * the count is bounded. A pair that is turned away before any search (no wall points,
 * no floor, footprints too far apart to touch) is not a search and does not count.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** a Place with many
 * scans needs the older ones considered, or the time per comparison on real
 * scans (DX9 records it) says there is room.
 */
export const MAX_REFERENCE_SCANS = 4

/**
 * Most other scans whose clouds the job will read to find those searches: the
 * candidates, ranked, of which the first {@link MAX_REFERENCE_SCANS} that can touch
 * the new scan are searched. Wider than the search cap so that four newer scans of
 * other rooms cannot crowd out the earlier scan of this one. Each is read, compared
 * and released before the next, so the bound is on reading time, not memory.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** reading a scan's GLB
 * is slow on real scans (DX9 records the time per comparison).
 */
export const MAX_REFERENCE_CANDIDATES = 8

/**
 * Whether a scan that joins a Place with other calibrated scans gets a proposal
 * queued for it without anyone asking. The brief's recommendation, and the narrowest
 * switch there is: set it to false and the only way to run the job is the
 * editor's Advanced queue or `POST /worlds/:slug/jobs`. Listed under needsDecision.
 */
export const PLACE_REGISTER_AUTO_QUEUE = true

/**
 * Whether a scan filed under another area than the new scan's is left out of the comparison (true), or only ranked
 * after the scans of its own area and of no area (false). The brief's recommendation is to leave it out: two rooms of
 * a similar plan match each other by coincidence and the score cannot tell, but the person's filing can. The cost is
 * that a scan filed under the wrong area gets no proposal until its filing is fixed. Listed under needsDecision.
 */
export const PLACE_REGISTER_EXCLUDE_OTHER_AREAS = true

/**
 * Whether a pair that the matcher's own gates pass but that misses one of the starting acceptance values (R2's six, in
 * scan_match.ts: score, how far apart a second place is, observability, share lined up, coverage, gap) is refused, or offered as the
 * matcher said. The brief's recommendation is to refuse: the starting values are the tightest case and a verifier that offers little
 * is the safe way to be wrong. The cost is that rooms that look the same turned round (an empty rectangle, a square with a door gap)
 * are refused as ambiguous, which R2 found they should be. The narrowest switch there is: set it to false and the numbers are still
 * recorded on every pair, and nothing is refused for them. Listed under needsDecision.
 */
export const PLACE_REGISTER_ENFORCE_STARTING_VALUES = true

/** The refusal each starting value is reported as. The vocabulary is the matcher's own, so no new sentence is needed for a pair that fails one. */
const REFUSAL_FOR_STARTING_VALUE: Record<StartingValue, RegistrationRefusal> = {
  'global-peak-ratio': 'ambiguous',
  'observability': 'ambiguous',
  'query-inliers': 'low-overlap',
  'reference-coverage': 'low-overlap',
  'inlier-rms': 'loose-fit',
  'field-score': 'low-score',
}

/**
 * `proposal` as the job offers it: a proposal that misses a starting value becomes a refusal for the first one it missed, with every
 * number it measured and no transform. Anything else is returned as it came.
 */
export function applyStartingValues(proposal: RegistrationProposal): RegistrationProposal {
  if (!PLACE_REGISTER_ENFORCE_STARTING_VALUES || proposal.status !== 'proposed') return proposal
  const verdict = proposal.details?.startingValues
  if (!verdict || verdict.passed) return proposal
  return { ...proposal, status: 'refused', transform: null, reason: REFUSAL_FOR_STARTING_VALUE[verdict.failed[0]!] }
}

/**
 * Whether the two scans' sessions ran in different units, as both recorded their `scaleMode` (src/world/scale-mode.ts): the modes differ.
 * An unrecorded mode says nothing, so it is not a difference, and two runtimes whose unit is the metre by contract (WebXR and the native
 * plugin) agree whatever their modes are called. Two scans in one 8th Wall responsive mode can still differ in unit, since that unit
 * follows the phone's height at the start (the scale-mode header says so); the size search is not made for them, because it costs about
 * five times the work and the brief asks for it when the modes differ. DX1 settles whether it should be.
 */
export function unitsDiffer(a: Pick<ScanManifest, 'scaleMode'>, b: Pick<ScanManifest, 'scaleMode'>): boolean {
  if (a.scaleMode === undefined || b.scaleMode === undefined || a.scaleMode === b.scaleMode) return false
  return !(scaleKindOfMode(a.scaleMode) === 'metric' && scaleKindOfMode(b.scaleMode) === 'metric')
}

/**
 * Whether the scan's calibration tier is one whose `localToWorld` is a frame of the Place: the tiers
 * `isPlaceFrameMethod` names (src/world/spatial-frame.ts), so a tier added there is compared here with no edit.
 */
export function isPlaceCalibrated(scan: Pick<ScanManifest, 'calibrationMethod'>): boolean {
  return isPlaceFrameMethod(scan.calibrationMethod)
}

// ─── Choosing what to compare ────────────────────────────────────────────────

export type PlaceRegisterSkipReason = 'scan-missing' | 'not-calibrated' | 'no-other-scan' | 'no-geometry'

export type PlaceRegisterPlan =
  | { ok: true; scan: ScanManifest; references: ScanManifest[] }
  | { ok: false; reason: PlaceRegisterSkipReason; message: string }

/** The area a scan was filed under, or null when it was filed under none. */
function areaOf(scan: Pick<ScanManifest, 'areaId'>): string | null {
  return typeof scan.areaId === 'string' && scan.areaId.trim() !== '' ? scan.areaId.trim() : null
}

/**
 * Whether two scans are filed under the same area of the Place. `'unknown'` when either has no area: nothing was
 * said, so nothing is ruled out. `'different'` when both name an area and they are not the same one.
 */
export function areaRelation(a: Pick<ScanManifest, 'areaId'>, b: Pick<ScanManifest, 'areaId'>): 'same' | 'unknown' | 'different' {
  const left = areaOf(a)
  const right = areaOf(b)
  if (left === null || right === null) return 'unknown'
  return left === right ? 'same' : 'different'
}

/**
 * Which scans to compare `scanId` with, best candidate first.
 *
 * The candidates are the Place's other scans that carry a Place calibration, at most `limit`
 * ({@link MAX_REFERENCE_CANDIDATES}). Both sides must be calibrated: an uncalibrated scan is placed by GPS or on a
 * grid and its `localToWorld` says nothing about where it is in the Place, so a match against it would be a
 * coincidence of a different kind.
 *
 * Scans filed under the same area come first, then those with no area, then (only when
 * {@link PLACE_REGISTER_EXCLUDE_OTHER_AREAS} is off) those filed under another area, each group newest first. With
 * the switch on, which is the default, scans filed under another area are left out. Two rooms of a similar plan
 * whose frames overlap (what a one-point scan or a replaced frame does) match each other by coincidence, and the
 * score cannot tell that from the right room; the person's own filing can. Putting the same area first means the
 * earlier scan of this room is never dropped because newer scans of other rooms filled the list.
 */
export function planPlaceRegister(
  world: Pick<WorldProject, 'scans'>,
  scanId: string,
  limit = MAX_REFERENCE_CANDIDATES,
  options: { excludeOtherAreas?: boolean } = {},
): PlaceRegisterPlan {
  const excludeOtherAreas = options.excludeOtherAreas ?? PLACE_REGISTER_EXCLUDE_OTHER_AREAS
  const scan = world.scans.find((candidate) => candidate.scanId === scanId)
  if (!scan) return { ok: false, reason: 'scan-missing', message: 'This scan is no longer in the Place.' }
  if (!isPlaceCalibrated(scan)) {
    return {
      ok: false,
      reason: 'not-calibrated',
      message: 'This scan has no Place calibration, so there is nothing to compare it against the Place frame.',
    }
  }
  const others = world.scans.filter((other) =>
    other.scanId !== scan.scanId && other.filename !== scan.filename && isPlaceCalibrated(other)
  )
  const rank = (other: ScanManifest): number => ({ same: 0, unknown: 1, different: 2 })[areaRelation(scan, other)]
  const references = others
    .filter((other) => !excludeOtherAreas || areaRelation(scan, other) !== 'different')
    .sort((a, b) => rank(a) - rank(b) || (b.capturedAt ?? '').localeCompare(a.capturedAt ?? '') || a.scanId.localeCompare(b.scanId))
    .slice(0, limit)
  if (references.length === 0) {
    return {
      ok: false,
      reason: 'no-other-scan',
      message: others.length > 0
        ? 'No other calibrated scan in this scan\'s area to compare it with. The Place\'s other scans are filed under other areas.'
        : 'No other calibrated scan in this Place to compare it with.',
    }
  }
  return { ok: true, scan, references }
}

/**
 * Queues a `place-register` job for a scan that has just joined a Place, when
 * there is something to compare it with. Pure: the caller supplies the job
 * factory (`createWorldJob` in server/main.ts), which is where dedupe and
 * history trimming happen, and enqueues the returned job on the pump after the
 * world lock is released. Null means nothing was queued.
 */
export function queuePlaceRegisterForScan(
  world: WorldProject,
  scanId: string,
  create: (world: WorldProject, type: 'place-register', scanId: string, payload: Record<string, unknown>) => WorldJob,
): WorldJob | null {
  if (!PLACE_REGISTER_AUTO_QUEUE) return null
  const plan = planPlaceRegister(world, scanId)
  if (!plan.ok) return null
  return create(world, 'place-register', scanId, {
    source: 'joined-place',
    referenceScanIds: plan.references.map((reference) => reference.scanId),
  })
}

// ─── Comparing ───────────────────────────────────────────────────────────────

/** A scan and its points in the Place frame. */
export interface PlacedCloud {
  scan: ScanManifest
  positions: ArrayLike<number>
}

function refStamp(scan: ScanManifest): PlaceRegisterResult['moving'] {
  return { scanId: scan.scanId, filename: scan.filename, name: scan.name || scan.filename, localToWorld: [...scan.localToWorld] }
}

/**
 * The scans whose placement a scan patch has set, by hand with the Edit gizmo or by an applied check. The
 * calibration's promise about the floor was about where the capture put the scan, and a patch can have lifted it.
 */
export function patchedScanIds(patches: readonly EditPatch[] | undefined): Set<string> {
  const ids = new Set<string>()
  for (const patch of patches ?? []) {
    if (patch.scope === 'scan' && patch.scanId && patch.transform?.matrix) ids.add(patch.scanId)
  }
  return ids
}

/**
 * Where the calibration promises the floor is. Both Place calibrations map the tapped landmark to the project
 * origin, height included (`anchorToProjectTransform` in src/world/geo.ts), and the landmark tap is gated to the
 * floor, so project y = 0 is the floor at the landmark. Any other kind of scan makes no such promise, and nor does
 * one a patch has placed: its floor is wherever the cloud shows it.
 */
function floorHintFor(scan: ScanManifest, patched: ReadonlySet<string>): number | undefined {
  return isPlaceCalibrated(scan) && !patched.has(scan.scanId) ? 0 : undefined
}

/** One scan the new scan may be compared with. Its cloud is read when the pair is reached, and dropped after. */
export interface ReferenceCandidate {
  scan: ScanManifest
  /** The scan's points in the Place frame, or null when it has none to read. */
  load(): Promise<ArrayLike<number> | null>
}

export interface CompareOptions {
  now?: () => string
  /**
   * Gives the rest of the server a turn between one pair and the next: a search is minutes of nothing but
   * arithmetic on the one thread the upload routes and the event stream share. Defaults to a macrotask.
   */
  yieldToServer?: () => Promise<void>
  /** Pairs to search before stopping. Defaults to {@link MAX_REFERENCE_SCANS}. */
  maxSearched?: number
  /** Scans a patch has placed: they get no hint about their floor ({@link patchedScanIds}). */
  patchedScanIds?: ReadonlySet<string>
}

const yieldMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * What DX9 needs from every pair that was searched, from its details: the evidence the starting values are judged on, the global
 * probe, the starting values it missed, and the size it recovered. Nothing for a pair that was turned away before a search.
 */
function comparisonNumbers(proposal: RegistrationProposal): Partial<PlaceRegisterComparison> {
  const { evidence, globalProbe, startingValues, scale } = proposal.details ?? {}
  return {
    ...(evidence
      ? {
        queryInlierShare: evidence.queryInlierShare,
        referenceCoverage: evidence.referenceCoverage,
        observability: evidence.observability,
        fieldScore: evidence.fieldScore,
      }
      : {}),
    ...(globalProbe ? { globalPeakRatio: globalProbe.secondPeakRatio, symmetric: globalProbe.symmetric } : {}),
    ...(startingValues && !startingValues.passed ? { startingValuesFailed: startingValues.failed } : {}),
    ...(scale ? { scaleRecovered: scale.recovered } : {}),
  }
}

/**
 * Matches `moving` against each candidate in order and picks the proposal to show.
 *
 * Every pair that was tried gets a row in `comparisons`, proposed or refused, with its overlap, residual and
 * score: the residual RMS for every Place scan pair is the measurement this package exists to produce. The
 * `proposal` is the highest-scoring proposed pair, or, when none proposed anything, the highest-scoring refusal,
 * so the editor can say why. A candidate with no cloud is a `'skipped'` row. Null when no pair could be compared
 * at all.
 *
 * Stops after `maxSearched` pairs that actually searched. A pair the matcher turns away before searching (the
 * footprints cannot touch, no floor, too few wall points) costs almost nothing and does not use up the count, so
 * newer scans of other rooms cannot crowd the right one out. Candidates not reached get no row.
 */
export async function comparePlacedClouds(
  moving: PlacedCloud,
  candidates: ReadonlyArray<ReferenceCandidate>,
  options: CompareOptions = {},
): Promise<PlaceRegisterResult | null> {
  const now = options.now ?? (() => new Date().toISOString())
  const yieldToServer = options.yieldToServer ?? yieldMacrotask
  const maxSearched = options.maxSearched ?? MAX_REFERENCE_SCANS
  const patched = options.patchedScanIds ?? new Set<string>()
  const started = performance.now()
  const rows: PlaceRegisterComparison[] = []
  let best: { proposal: RegistrationProposal; reference: ScanManifest } | null = null
  let searched = 0

  for (const candidate of candidates) {
    if (searched >= maxSearched) break
    const { scan: reference } = candidate
    const positions = await candidate.load()
    if (!positions) {
      rows.push({
        referenceScanId: reference.scanId,
        referenceName: reference.name || reference.filename,
        status: 'skipped',
        reason: 'no-geometry',
        score: 0,
        overlapFraction: 0,
        inlierResidualM: null,
        elapsedMs: 0,
      })
      continue
    }
    await yieldToServer()
    const pairStarted = performance.now()
    const proposal = applyStartingValues(await matchScansYielding(
      { positions, floorHintY: floorHintFor(reference, patched) },
      { positions: moving.positions, floorHintY: floorHintFor(moving.scan, patched) },
      { scaleSearch: unitsDiffer(moving.scan, reference) },
      yieldToServer,
    ))
    rows.push({
      referenceScanId: reference.scanId,
      referenceName: reference.name || reference.filename,
      status: proposal.status,
      reason: proposal.reason,
      score: proposal.score,
      overlapFraction: proposal.overlapFraction,
      inlierResidualM: proposal.inlierResidualM,
      elapsedMs: Math.round(performance.now() - pairStarted),
      ...comparisonNumbers(proposal),
    })
    if (proposal.details.searchedTranslationM > 0) searched++
    const better = !best ||
      (proposal.status === 'proposed' && best.proposal.status !== 'proposed') ||
      (proposal.status === best.proposal.status && proposal.score > best.proposal.score)
    if (better) best = { proposal, reference }
  }
  if (!best) return null

  return {
    proposal: best.proposal,
    moving: refStamp(moving.scan),
    reference: refStamp(best.reference),
    comparisons: rows,
    params: matchParams(),
    comparedAt: now(),
    elapsedMs: Math.round(performance.now() - started),
  }
}

/** The sentence about the photo method, or '' when the artifact has no photo block. */
function photoSentence(sfm: SfmResult | undefined, name: string): string {
  if (!sfm) return ''
  if (sfm.status === 'proposed' && sfm.boundedCorrection) {
    const move = sfm.boundedCorrection
    return ` The photos of "${name}" propose ${Math.round(move.translationM * 100)} cm and a ${Math.abs(move.yawDeg).toFixed(1)}° turn.`
  }
  return ` Photo matching: ${sfmReasonText(sfm.reason)}`
}

/** The job's `result` text. Says what was measured; never "aligned" or "verified". */
export function placeRegisterResultText(result: PlaceRegisterResult): string {
  const { proposal, moving, reference } = result
  const name = moving.name
  const against = reference.name
  const others = result.comparisons.length > 1 ? ` (best of ${result.comparisons.length} scans compared)` : ''
  const photos = photoSentence(result.sfm, name)
  if (proposal.status === 'proposed' && proposal.boundedCorrection) {
    const move = proposal.boundedCorrection
    const gap = proposal.inlierResidualM === null ? '' : `, about ${Math.round(proposal.inlierResidualM * 100)} cm apart`
    return `Proposed a move for "${name}": ${Math.round(move.translationM * 100)} cm and a ${Math.abs(move.yawDeg).toFixed(1)}° turn, ` +
      `from its walls against "${against}"${others}. ${Math.round(proposal.overlapFraction * 100)}% of the smaller scan lines up${gap}.${photos} ` +
      'Nothing moves until you apply it in the editor.'
  }
  const wallsRan = result.comparisons.length > 0
  const photosProposed = result.sfm?.status === 'proposed' && result.sfm.boundedCorrection !== null
  if (!wallsRan && photosProposed) {
    return `The walls of "${name}" could not be compared.${photos} Nothing moves until you apply it in the editor.`
  }
  // The walls proposed nothing and the photos did: the sentence leads with what the walls did, and ends as every proposal's does.
  if (photosProposed) {
    return `The walls of "${name}" did not settle a move: ${refusalText(proposal.reason)} Compared with "${against}"${others}.${photos} ` +
      'Nothing moves until you apply it in the editor.'
  }
  return `No move proposed for "${name}": ${refusalText(proposal.reason)} Compared with "${against}"${others}.${photos}`
}

// ─── Reading a scan's points ─────────────────────────────────────────────────

export interface PlaceRegisterHost {
  /**
   * Starts the job: finds it, checks its scan exists, and hands the scan back, or marks the job failed and
   * returns null. main.ts's `claimJobScan`.
   */
  claim(slug: string, jobId: string): Promise<{ scan: ScanManifest; payload: WorldJob['payload'] } | null>
  /** A read-only snapshot of the world. main.ts's `loadWorld`. */
  loadWorld(slug: string): Promise<WorldProject>
  /** The scan GLB the editor draws (the optimized one when there is one), or null when it is not on disk. */
  readScanGlbBytes(filename: string): Promise<Uint8Array | null>
  /** Records a job transition in a fresh locked snapshot, then broadcasts it. main.ts's `commitWorldJob`. */
  commit<T>(slug: string, jobId: string, mutate: (job: WorldJob, world: WorldProject) => T): Promise<T | null>
  /** Marks the job failed. main.ts's `failWorldJob`. */
  fail(slug: string, jobId: string, reason: string): Promise<void>
  now?(): string
  /**
   * What the photo method needs from the server. Absent, the job is the wall match alone and its artifact has no photo block, as every
   * artifact an earlier build wrote. Present with `enabled: false`, the artifact says the photo method is off.
   */
  sfm?: PlaceRegisterSfmHost
}

/** What the photo method needs from the server, and the one thing the job reads for it: the Place's current frame generation. */
export interface PlaceRegisterSfmHost extends Omit<SfmHost, 'jobId'> {
  /** The `frameId` of the Place's stored frame, or null when the Place has no frame or its frame records none. */
  placeFrameId(projectId: string): Promise<string | null>
}

/**
 * Whether this run was asked for the photo method: a job queued with `payload.method === 'sfm'` (the editor's "Check with photos", or
 * `POST /worlds/:slug/jobs`). Anything else, including a payload that spells it another way, is not a request.
 */
export function asksForSfm(payload: WorldJob['payload']): boolean {
  return requestsPhotoMethod(payload)
}

/**
 * A scan's point cloud in the Place frame, or null when it has none to read.
 *
 * `collectPointPositions` returns the points in glTF scene coordinates, which is
 * the frame the viewer's scan root draws in, and applies every node's matrix on
 * the way (an optimized scan carries its dequantization on the node). The scan's
 * `localToWorld` then carries them into the Place, exactly as the editor places
 * the root. An unreadable GLB is no cloud, not a crash: the pair is reported as
 * skipped.
 */
export async function readPlacedCloud(host: Pick<PlaceRegisterHost, 'readScanGlbBytes'>, scan: ScanManifest): Promise<PlacedCloud | null> {
  if (!isMatrix16(scan.localToWorld)) return null
  const bytes = await host.readScanGlbBytes(scan.filename)
  if (!bytes) return null
  try {
    const { positions } = collectPointPositions(await readScanGlb(bytes))
    if (positions.length === 0) return null
    return { scan, positions: transformPositions(positions, scan.localToWorld) }
  } catch (err) {
    console.warn(`[place-register] could not read the point cloud of ${scan.filename}:`, err)
    return null
  }
}

// ─── The runner ──────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Runs one `place-register` job to a terminal state. Never throws: a failure is
 * recorded on the job. Compare `_runMemoryPushJob` and the other runners in
 * server/main.ts, whose shape this follows: claim, work, commit, with one catch
 * that fails the job.
 */
export async function runPlaceRegisterJob(host: PlaceRegisterHost, slug: string, jobId: string): Promise<void> {
  try {
    const claimed = await host.claim(slug, jobId)
    if (!claimed) return
    const world = await host.loadWorld(slug)
    const now = host.now ?? (() => new Date().toISOString())

    const skip = async (reason: PlaceRegisterSkipReason, message: string): Promise<void> => {
      await host.commit(slug, jobId, (job) => {
        job.status = 'completed'
        job.result = message
        job.artifacts = [{
          type: PLACE_REGISTER_SKIP_ARTIFACT,
          label: `${claimed.scan.name} alignment check skipped`,
          metadata: { reason, message },
        }]
        job.progress = 1
        job.updatedAt = now()
      })
    }

    const plan = planPlaceRegister(world, claimed.scan.scanId)
    if (!plan.ok) return await skip(plan.reason, plan.message)

    // ── The wall match first: it is cheap, and it needs no photographs ──
    const moving = await readPlacedCloud(host, plan.scan)
    let result: PlaceRegisterResult | null = null
    if (moving) {
      // Read lazily, one at a time, each released after its pair is compared: a scan can be a quarter of a million points.
      const candidates: ReferenceCandidate[] = plan.references.map((reference) => ({
        scan: reference,
        load: async () => (await readPlacedCloud(host, reference))?.positions ?? null,
      }))
      result = await comparePlacedClouds(moving, candidates, { now, patchedScanIds: patchedScanIds(world.editPatches) })
    }

    // ── The photo method: when the wall match proposed nothing, or when this run was asked for it ──
    let sfm: SfmResult | undefined
    let pivot: [number, number] | null = null
    if (host.sfm) {
      const asked = asksForSfm(claimed.payload)
      if (!host.sfm.enabled) sfm = skippedResult('off')
      else if (result?.proposal.status === 'proposed' && !asked) sfm = skippedResult('not-needed')
      else {
        // The wall match's best reference is offered to the photo method first, which keeps it unless another earlier scan's photographs
        // overlap the new scan's more (more pairs the pair list would match, then more photographs). The two methods can therefore
        // answer for different earlier scans, and the card says when they do.
        const best = result?.reference.scanId
        const references = best
          ? [...plan.references].sort((a, b) => Number(b.scanId === best) - Number(a.scanId === best))
          : plan.references
        const projectId = world.projectId
        const outcome = await runSfmRegistration(
          { ...host.sfm, jobId },
          { place: { projectId, frameId: projectId ? await host.sfm.placeFrameId(projectId) : null }, moving: plan.scan, references },
        )
        sfm = outcome.result
        pivot = outcome.pivot
      }
    }

    // Nothing from either method: the reasons a person can act on, as before.
    const photosAnswered = sfm !== undefined && sfm.status !== 'skipped'
    if (!result && !photosAnswered) {
      return moving
        ? await skip('no-geometry', 'None of the other scans in this Place has readable geometry, so there is nothing to compare.')
        : await skip('no-geometry', 'This scan has no readable geometry yet, so there is nothing to compare.')
    }
    // Only the photo method answered: the wall match has nothing to show, and says so in the shape the card already reads.
    const answer: PlaceRegisterResult = result ?? withoutWalls(plan.scan, sfm!, now())
    if (sfm) {
      answer.sfm = sfm
      const agreement = pivot ? agreementOf(answer.proposal.transform, sfm.transform, pivot) : null
      if (agreement) answer.agreement = agreement
    }

    // Deliberately no `scan.status` and no `localToWorld` here, and no applyCompletedJobToWorld: see the header.
    await host.commit(slug, jobId, (job) => {
      job.status = 'completed'
      job.result = placeRegisterResultText(answer)
      job.artifacts = [{
        type: PLACE_REGISTER_PROPOSAL_ARTIFACT,
        label: `${plan.scan.name} alignment check`,
        metadata: answer as unknown as Record<string, unknown>,
      }]
      job.progress = 1
      job.updatedAt = now()
    })
  } catch (err) {
    console.error('[place-register] job failed:', err)
    await host.fail(slug, jobId, errorText(err))
  }
}

/**
 * The result for a run where the wall match could not read a point cloud and the photo method answered: a refusal for too few wall points
 * with nothing measured and no comparison rows, so the card says the walls were not compared. It carries no transform, so nothing can be
 * applied from it, and its reference is the scan the photos were registered against.
 */
function withoutWalls(moving: ScanManifest, sfm: SfmResult, comparedAt: string): PlaceRegisterResult {
  return {
    proposal: {
      status: 'refused',
      transform: null,
      overlapFraction: 0,
      inlierResidualM: null,
      score: 0,
      boundedCorrection: null,
      reason: 'too-few-points',
      details: {
        movingCells: 0,
        referenceCells: 0,
        movingMatchedFraction: 0,
        referenceMatchedFraction: 0,
        distinctiveness: 0,
        fit: 0,
        peakRatio: 1,
        nearBestReachM: null,
        verticalChecked: false,
        searchedTranslationM: 0,
        searchedYawDeg: 0,
      },
    },
    moving: refStamp(moving),
    reference: sfm.reference ?? refStamp(moving),
    comparisons: [],
    params: matchParams(),
    comparedAt,
    elapsedMs: 0,
  }
}

// ─── Applying: the server's half of "never auto-apply, apply once" ───────────

/** The body of `POST /worlds/:slug/patches`, as far as this guard reads it. */
export interface RegistrationPatchBody {
  scope?: unknown
  scanId?: unknown
  transform?: { matrix?: unknown } | null
  provenance?: unknown
}

export type RegistrationPatchGuard =
  /** Not a place-register patch. Nothing here to check. */
  | { kind: 'plain' }
  /** A place-register patch that is what its job proposed, for a scan that has not moved. Store `provenance`. */
  | { kind: 'ok'; provenance: EditPatchProvenance }
  /** This job was applied already. Hand back the patch that applied it and write nothing. */
  | { kind: 'duplicate'; patch: EditPatch }
  | { kind: 'refused'; status: 400 | 409; error: string }

/** Both are finite numbers and equal to the precision a JSON round trip keeps. */
function sameNumber(a: unknown, b: unknown): boolean {
  return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9
}

function refused(status: 400 | 409, error: string): RegistrationPatchGuard {
  return { kind: 'refused', status, error }
}

/**
 * Decides what a patch that claims to come from a place-register job may do.
 *
 * Provenance is a statement about where a number came from, so the server only
 * writes it for a patch that is exactly what the named job proposed:
 *
 *  - The job exists, completed, and proposed a move for this scan.
 *  - The scan, and the reference the move was measured against, are where the job
 *    found them. A scan moved by hand since then is a different arrangement, and
 *    the proposal would silently overwrite that move (`applyPatchToWorld` assigns
 *    the matrix; it does not compose).
 *  - The matrix is the job's correction applied on top of the scan's placement at
 *    the time, and the provenance numbers are the job's own.
 *  - The job has not been applied. A second application, from a second tab or a
 *    double press, gets the first patch back and writes nothing, and that check
 *    runs before the freshness check, because applying moves the scan.
 *
 * Anything without `provenance` is an ordinary patch and passes through untouched.
 */
export function guardRegistrationPatch(
  world: Pick<WorldProject, 'jobs' | 'scans' | 'editPatches'>,
  body: RegistrationPatchBody,
): RegistrationPatchGuard {
  if (body.provenance === undefined || body.provenance === null) return { kind: 'plain' }

  const claimed = body.provenance as Record<string, unknown>
  // The wall match writes no method; the photo method writes 'sfm'. Anything else is a form this server does not read.
  const method: RegistrationMethod | null = claimed['method'] === undefined ? 'scan-match' : claimed['method'] === 'sfm' ? 'sfm' : null
  if (
    typeof claimed !== 'object' || Array.isArray(claimed) ||
    method === null ||
    claimed['source'] !== PLACE_REGISTER_SOURCE ||
    typeof claimed['jobId'] !== 'string' || claimed['jobId'] === '' ||
    typeof claimed['score'] !== 'number' || !Number.isFinite(claimed['score']) ||
    typeof claimed['residualM'] !== 'number' || !Number.isFinite(claimed['residualM'])
  ) {
    return refused(400, 'The patch says where it came from, but not in a form this server reads.')
  }
  const jobId = claimed['jobId']
  if (body.scope !== 'scan') return refused(400, 'An alignment check can only move a whole scan.')

  const applied = findAppliedRegisterPatch(world.editPatches ?? [], jobId)
  if (applied) return { kind: 'duplicate', patch: applied }

  const job = world.jobs.find((candidate) => candidate.jobId === jobId)
  const result = job ? readPlaceRegisterResult(job) : null
  if (!job || !result) return refused(400, 'That alignment check is no longer in this Place. Run it again.')
  const proposal = methodProposal(result, method)
  if (!proposal || proposal.status !== 'proposed' || !isMatrix16(proposal.transform)) {
    return refused(400, 'That alignment check did not propose a move.')
  }
  if (body.scanId !== result.moving.scanId) return refused(400, 'That alignment check was run for a different scan.')

  const state = registerApplyState(result, jobId, world.scans, world.editPatches ?? [], method)
  if (state === 'stale') return refused(409, 'This scan, or the scan it was checked against, has moved since the check. Run it again.')
  if (state !== 'ready') return refused(400, 'That alignment check cannot be applied.')

  const expected = multiplyMat4(proposal.transform, result.moving.localToWorld)
  if (!matricesAgree(body.transform?.matrix, expected)) return refused(400, 'The patch is not the move the check proposed.')
  if (!sameNumber(claimed['score'], proposal.score) || !sameNumber(claimed['residualM'], proposal.residualM)) {
    return refused(400, 'The score on the patch is not the one the check measured.')
  }

  return {
    kind: 'ok',
    provenance: {
      source: PLACE_REGISTER_SOURCE,
      jobId,
      score: proposal.score,
      residualM: proposal.residualM as number,
      ...(method === 'sfm' ? { method } : {}),
    },
  }
}
