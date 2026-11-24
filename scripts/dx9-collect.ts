#!/usr/bin/env -S deno run --allow-read --allow-env=WORLDS_DIR,SESSIONS_DIR,SCANS_DIR
/**
 * DX9 collector: what the owner's real scans say about server registration, as one table.
 *
 *   deno run --allow-read --allow-env=WORLDS_DIR,SESSIONS_DIR,SCANS_DIR scripts/dx9-collect.ts \
 *     [--worlds <dir>] [--sessions <dir>] [--labels <file>] [--all] [--json]
 *
 * DX9 is the only data that can tune the acceptance values of `place-register` (docs/testing/DEVICE_TESTING.md, "DX9"; the values are
 * adopted, not measured, ADR 0005 rule 5). This reads what the job already records and measures nothing itself:
 *
 *  - every `place-register` proposal artifact in the worlds folder (`WORLDS_DIR`, default `./worlds`): one row per scan pair the wall
 *    match compared, proposed or refused, with the numbers of the pair (overlap, inlier residual, score, the share of the query that
 *    lines up, the coverage of the reference, observability, the field score, the global second-peak ratio, which starting values it
 *    missed, the size it recovered, how long it took), and one row for the photo method of each job that ran it (photographs
 *    registered, inliers, rms, the unit mismatch, the tilt dropped, how long it took, whether the reference model was made or reused);
 *  - how far apart the two methods put the scan, when both proposed;
 *  - the constellation fit of the scan's own calibration (`calibrationFitRmsM`, `calibrationFitMaxM`, from the world's scan
 *    manifests) and the disagreement between that and the registration: the absolute difference between the farthest a wall cell would
 *    move under the registration's proposal (`maxShiftM`) and the largest horizontal gap the calibration's fit measured at its check
 *    points (`calibrationFitMaxM`). They are two independent estimates of how far a frame is off, the taps' and the geometry's. Null
 *    where either is absent, which every visit that compared only the separation of two points is. A job that did not run (the
 *    `place-register-skip` artifact) has no pair and gives no row;
 *  - the keyframes of the session each scan names (`ScanManifest.sessionId`; `<sessions>/<id>/keyframes.jsonl`, `SESSIONS_DIR`,
 *    default `<SCANS_DIR>/sessions`): how many frames and how many bytes each frame took, which is what sizes the storage and the
 *    upload. A scan finalized from more than one session is counted for the one session it names.
 *
 * A pair compared by more than one job gives one row per method, the newest, so a re-run replaces what it re-ran. `--all` keeps every run.
 *
 * With `--labels` (a JSON object, scan id to room name) a pair is **same room** when both scans carry a label and the labels are the
 * same, and **cross room** when both carry one and they differ. The summary then says how each was answered per method: the share of
 * same-room pairs proposed and the share of cross-room pairs proposed (a false accept) are the two numbers the starting values were
 * set against. A label is the person's word; nothing here checks it.
 *
 * ## What the numbers can and cannot say
 *
 * DX9 needs at least 8 rooms of 3 sessions each: 24 same-room pairs and 252 cross-room pairs. Zero false accepts in n independent
 * negatives bounds the true rate below 10% at n >= 29, 5% at n >= 59, 2% at n >= 149 and 1% at n >= 299 (95% confidence), and a
 * success rate to +-10% needs about 97 independent pairs (worst case, 95% confidence). Two scans of one room are ONE same-room pair:
 * a smoke test that the pipeline runs on real data, not a tuning set. The summary prints how many distinct labelled pairs it has
 * against that, so a table of three rows is never read as a measurement. The pairs of one room share sessions, so they are not
 * independent, and the bounds above are the most they can show.
 *
 * Read-only and offline: it opens files for reading and nothing else. It writes nothing, runs nothing and opens no connection.
 * Scan names are printed (they are what the editor shows); no path to a photograph is, and none is read.
 */
import {
  type PlaceRegisterComparison,
  type PlaceRegisterResult,
  readPlaceRegisterResult,
} from '../src/world/register-proposal.ts'
import { SESSION_ID_RE } from '../src/shared/session-id.ts'
import type { ScanManifest, WorldJob, WorldProject } from '../src/world/types.ts'

/** Rooms and sessions DX9 needs, and the pairs they make: 8 rooms of 3 sessions are 24 same-room pairs and 252 cross-room pairs. */
export const DX9_MIN_ROOMS = 8
export const DX9_MIN_SESSIONS_PER_ROOM = 3
export const DX9_SAME_ROOM_PAIRS = DX9_MIN_ROOMS * (DX9_MIN_SESSIONS_PER_ROOM * (DX9_MIN_SESSIONS_PER_ROOM - 1)) / 2
const DX9_SESSIONS = DX9_MIN_ROOMS * DX9_MIN_SESSIONS_PER_ROOM
export const DX9_CROSS_ROOM_PAIRS = DX9_SESSIONS * (DX9_SESSIONS - DX9_MIN_SESSIONS_PER_ROOM) / 2

export type Method = 'scan-match' | 'sfm'
type ByMethod<T> = Record<Method, T>
type Labels = Readonly<Record<string, string>>

export interface KeyframeStats {
  sessions: number
  frames: number
  bytes: number
  meanBytes: number | null
}

export interface PairRow {
  world: string
  jobId: string
  comparedAt: string
  scanId: string
  scanName: string
  referenceScanId: string
  referenceName: string
  method: Method
  /** Whether this is the pair the job offered (the wall match's best) or the photo method's own answer, when it proposed. */
  best: boolean
  status: 'proposed' | 'refused' | 'skipped'
  reason: string | null
  overlap: number | null
  residualM: number | null
  /** The wall match's score; for the photo method, the share of the new scan's photographs that found their place. */
  score: number | null
  queryInlierShare: number | null
  referenceCoverage: number | null
  observability: number | null
  fieldScore: number | null
  globalPeakRatio: number | null
  symmetric: boolean | null
  startingValuesFailed: string[]
  scaleRecovered: number | null
  registeredImages: number | null
  offeredImages: number | null
  inliers: number | null
  scaleRatio: number | null
  /** How well the photographs fix the turn (degrees) and the size (a fraction) of the proposal: one standard error, from the fit. Null on a record that has none. */
  turnUncertaintyDeg: number | null
  sizeUncertainty: number | null
  /** Photographs the fit was made without. */
  fitTrimmedFrames: number | null
  tiltDeg: number | null
  referenceModel: 'built' | 'reused' | null
  elapsedMs: number | null
  agreementTranslationM: number | null
  agreementYawDeg: number | null
  /** The photo method's size over the wall match's, 1 when they agree. Null when the record has none. */
  agreementScaleRatio: number | null
  agreementWithinBound: boolean | null
  /** How far the proposal moves the middle of the scan across the floor, metres. */
  correctionM: number | null
  /** The farthest any wall cell of the scan moves under the proposal, metres. */
  maxShiftM: number | null
  fitRmsM: number | null
  fitMaxM: number | null
  /** `|maxShiftM - fitMaxM|`: how far apart the two estimates of the frame's error are. Null unless both are there. */
  disagreementWithFitM: number | null
  keyframes: number | null
  keyframeBytes: number | null
  /** `true` same room, `false` cross room, null when no labels were given or either scan has none. */
  sameRoom: boolean | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The `place-register` jobs of a world that finished with a proposal artifact, in the order the world keeps them. */
export function placeRegisterResults(world: Pick<WorldProject, 'jobs'>): Array<{ job: WorldJob; result: PlaceRegisterResult }> {
  const found: Array<{ job: WorldJob; result: PlaceRegisterResult }> = []
  for (const job of world.jobs ?? []) {
    const result = readPlaceRegisterResult(job)
    if (result) found.push({ job, result })
  }
  return found
}

/** Whether a pair is the same room, from the labels: both scans labelled and the labels equal. Null with no labels or an unlabelled scan. */
export function sameRoomOf(labels: Labels | null, a: string, b: string): boolean | null {
  if (!labels) return null
  const left = labels[a]
  const right = labels[b]
  return typeof left === 'string' && typeof right === 'string' ? left === right : null
}

/**
 * The rows one world's artifacts give: every pair the wall match compared, with the numbers it recorded, and the photo method's answer
 * for each job that ran it. `keyframes` is the keyframe statistics by scan id, when the sessions were read.
 */
export function pairRows(
  worldName: string,
  world: Pick<WorldProject, 'jobs' | 'scans'>,
  options: { labels?: Labels | null; keyframes?: ReadonlyMap<string, KeyframeStats> } = {},
): PairRow[] {
  const labels = options.labels ?? null
  const rows: PairRow[] = []
  for (const { job, result } of placeRegisterResults(world)) {
    const scan = (world.scans ?? []).find((candidate) => candidate.scanId === result.moving.scanId)
    const fitRmsM = finite(scan?.calibrationFitRmsM)
    const fitMaxM = finite(scan?.calibrationFitMaxM)
    const frames = options.keyframes?.get(result.moving.scanId)
    const agreement = result.agreement
    const common = {
      world: worldName,
      jobId: job.jobId,
      comparedAt: result.comparedAt,
      scanId: result.moving.scanId,
      scanName: result.moving.name,
      fitRmsM,
      fitMaxM,
      keyframes: frames?.frames ?? null,
      keyframeBytes: frames?.bytes ?? null,
      agreementTranslationM: agreement ? agreement.translationM : null,
      agreementYawDeg: agreement ? agreement.yawDeg : null,
      agreementScaleRatio: agreement ? finite(agreement.scaleRatio) : null,
      agreementWithinBound: agreement ? agreement.withinBound : null,
    }
    const blank = {
      overlap: null, residualM: null, score: null, queryInlierShare: null, referenceCoverage: null, observability: null,
      fieldScore: null, globalPeakRatio: null, symmetric: null, startingValuesFailed: [] as string[], scaleRecovered: null,
      registeredImages: null, offeredImages: null, inliers: null, scaleRatio: null, tiltDeg: null,
      turnUncertaintyDeg: null, sizeUncertainty: null, fitTrimmedFrames: null,
      referenceModel: null, elapsedMs: null, correctionM: null, maxShiftM: null, disagreementWithFitM: null,
    }
    const against = (shift: number | null): number | null => (shift !== null && fitMaxM !== null ? Math.abs(shift - fitMaxM) : null)

    for (const comparison of result.comparisons as PlaceRegisterComparison[]) {
      const best = comparison.referenceScanId === result.reference.scanId
      const shift = best ? finite(result.proposal.boundedCorrection?.maxShiftM) : null
      rows.push({
        ...common,
        ...blank,
        referenceScanId: comparison.referenceScanId,
        referenceName: comparison.referenceName,
        method: 'scan-match',
        best,
        status: comparison.status,
        reason: comparison.reason,
        overlap: finite(comparison.overlapFraction),
        residualM: finite(comparison.inlierResidualM),
        score: finite(comparison.score),
        queryInlierShare: finite(comparison.queryInlierShare),
        referenceCoverage: finite(comparison.referenceCoverage),
        observability: finite(comparison.observability),
        fieldScore: finite(comparison.fieldScore),
        globalPeakRatio: finite(comparison.globalPeakRatio),
        symmetric: typeof comparison.symmetric === 'boolean' ? comparison.symmetric : null,
        startingValuesFailed: [...(comparison.startingValuesFailed ?? [])],
        scaleRecovered: finite(comparison.scaleRecovered),
        elapsedMs: finite(comparison.elapsedMs),
        correctionM: best ? finite(result.proposal.boundedCorrection?.translationM) : null,
        maxShiftM: shift,
        disagreementWithFitM: against(shift),
        sameRoom: sameRoomOf(labels, result.moving.scanId, comparison.referenceScanId),
      })
    }

    const sfm = result.sfm
    // A job that did not ask for the photo method says so with a 'not-needed' skip; that is no answer and no row.
    if (sfm && !(sfm.status === 'skipped' && sfm.reason === 'not-needed')) {
      const shift = finite(sfm.boundedCorrection?.maxShiftM)
      const referenceId = sfm.reference?.scanId ?? ''
      const ran = sfm.status !== 'skipped'
      rows.push({
        ...common,
        ...blank,
        referenceScanId: referenceId,
        referenceName: sfm.reference?.name ?? '',
        method: 'sfm',
        best: sfm.status === 'proposed',
        status: sfm.status,
        reason: sfm.reason,
        residualM: finite(sfm.residualM),
        score: finite(sfm.registeredFraction),
        registeredImages: ran ? finite(sfm.registeredImages) : null,
        offeredImages: ran ? finite(sfm.offeredImages) : null,
        inliers: ran ? finite(sfm.inliers) : null,
        scaleRatio: finite(sfm.scaleRatio),
        turnUncertaintyDeg: finite(sfm.turnUncertaintyDeg),
        sizeUncertainty: finite(sfm.sizeUncertainty),
        fitTrimmedFrames: ran ? finite(sfm.fitTrimmedFrames) : null,
        tiltDeg: finite(sfm.tiltDeg),
        referenceModel: sfm.referenceModel,
        elapsedMs: finite(sfm.elapsedMs),
        correctionM: finite(sfm.boundedCorrection?.translationM),
        maxShiftM: shift,
        disagreementWithFitM: against(shift),
        sameRoom: referenceId ? sameRoomOf(labels, result.moving.scanId, referenceId) : null,
      })
    }
  }
  return rows
}

function pairKey(row: PairRow): string {
  return `${row.world}|${row.method}|${row.scanId}|${row.referenceScanId}`
}

/**
 * One row per scan, reference and method: the newest. A pair that was run again is answered by its latest run, not counted twice.
 * The newest is the latest `comparedAt`, and among equal ones the later in the order the rows came.
 */
export function latestPerPair(rows: readonly PairRow[]): PairRow[] {
  const newest = new Map<string, PairRow>()
  for (const row of rows) {
    const held = newest.get(pairKey(row))
    if (!held || row.comparedAt >= held.comparedAt) newest.set(pairKey(row), row)
  }
  return rows.filter((row) => newest.get(pairKey(row)) === row)
}

// ─── Summarising ─────────────────────────────────────────────────────────────

/** Rows by how they were answered. A row is one pair for the wall match and one run for the photo method. */
export interface Tally {
  pairs: number
  proposed: number
  refused: number
  skipped: number
}

interface Spread {
  median: number | null
  p95: number | null
  max: number | null
}

export interface Summary {
  rows: number
  byMethod: ByMethod<Tally>
  /** The share of rows searched that were proposed, per method. Null with none searched. */
  proposedShare: ByMethod<number | null>
  reasons: Record<string, number>
  startingValuesMissed: Record<string, number>
  symmetricPairs: number
  /** Wall-match time per compared pair, ms. */
  runtimeMs: Spread
  /** Photo-method time per run, ms. */
  photoRuntimeMs: Spread
  agreement: { pairs: number; withinBound: number; medianTranslationM: number | null; medianYawDeg: number | null }
  /** `|maxShiftM - calibrationFitMaxM|` over the proposals that have both. */
  disagreementWithFit: { pairs: number; medianM: number | null; maxM: number | null }
  keyframes: KeyframeStats
  /** Null without labels. Same-room rows proposed are true accepts; cross-room rows proposed are false accepts. */
  sameRoom: ByMethod<Tally> | null
  crossRoom: ByMethod<Tally> | null
  unlabelled: number
  /** What DX9 needs against what the rows hold. `sufficient` is null without labels. */
  sample: {
    scans: number
    sameRoomPairs: number | null
    crossRoomPairs: number | null
    needsSameRoom: number
    needsCrossRoom: number
    sufficient: boolean | null
  }
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!
}

function spread(values: readonly number[]): Spread {
  return { median: quantile(values, 0.5), p95: quantile(values, 0.95), max: values.length ? Math.max(...values) : null }
}

function tally(rows: readonly PairRow[]): Tally {
  return {
    pairs: rows.length,
    proposed: rows.filter((row) => row.status === 'proposed').length,
    refused: rows.filter((row) => row.status === 'refused').length,
    skipped: rows.filter((row) => row.status === 'skipped').length,
  }
}

function byMethod(rows: readonly PairRow[]): ByMethod<Tally> {
  return { 'scan-match': tally(rows.filter((row) => row.method === 'scan-match')), sfm: tally(rows.filter((row) => row.method === 'sfm')) }
}

function proposedShare(of: Tally): number | null {
  const searched = of.proposed + of.refused
  return searched === 0 ? null : of.proposed / searched
}

/** How many distinct scans the rows name, as the new scan or as the reference. */
function scansIn(rows: readonly PairRow[]): number {
  const ids = new Set<string>()
  for (const row of rows) {
    ids.add(`${row.world}|${row.scanId}`)
    if (row.referenceScanId !== '') ids.add(`${row.world}|${row.referenceScanId}`)
  }
  return ids.size
}

/** Distinct scan pairs, whichever scan was the new one and whichever method answered, that were searched and labelled so. */
function distinctPairs(rows: readonly PairRow[], sameRoom: boolean): number {
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.sameRoom !== sameRoom || row.status === 'skipped' || row.referenceScanId === '') continue
    keys.add(`${row.world}|${[row.scanId, row.referenceScanId].sort().join('|')}`)
  }
  return keys.size
}

export function summarise(
  rows: readonly PairRow[],
  options: { labelled?: boolean; keyframes?: ReadonlyMap<string, KeyframeStats> } = {},
): Summary {
  const wall = rows.filter((row) => row.method === 'scan-match')
  const photo = rows.filter((row) => row.method === 'sfm')
  const reasons: Record<string, number> = {}
  for (const row of rows) if (row.reason) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1
  const missed: Record<string, number> = {}
  for (const row of rows) for (const value of row.startingValuesFailed) missed[value] = (missed[value] ?? 0) + 1
  const numbers = (list: readonly PairRow[], pick: (row: PairRow) => number | null): number[] =>
    list.map(pick).filter((value): value is number => value !== null)
  const both = rows.filter((row) => row.method === 'scan-match' && row.best && row.agreementTranslationM !== null)
  const against = numbers(rows.filter((row) => row.best), (row) => row.disagreementWithFitM)

  const keyframes: KeyframeStats = { sessions: 0, frames: 0, bytes: 0, meanBytes: null }
  for (const stats of options.keyframes?.values() ?? []) {
    keyframes.sessions += stats.sessions
    keyframes.frames += stats.frames
    keyframes.bytes += stats.bytes
  }
  keyframes.meanBytes = keyframes.frames > 0 ? keyframes.bytes / keyframes.frames : null

  const labelled = options.labelled === true
  const roomTally = (flag: boolean) => (labelled ? byMethod(rows.filter((row) => row.sameRoom === flag)) : null)
  const sameCount = labelled ? distinctPairs(rows, true) : null
  const crossCount = labelled ? distinctPairs(rows, false) : null
  return {
    rows: rows.length,
    byMethod: byMethod(rows),
    proposedShare: { 'scan-match': proposedShare(tally(wall)), sfm: proposedShare(tally(photo)) },
    reasons,
    startingValuesMissed: missed,
    symmetricPairs: wall.filter((row) => row.symmetric === true).length,
    runtimeMs: spread(numbers(wall, (row) => row.elapsedMs)),
    photoRuntimeMs: spread(numbers(photo, (row) => row.elapsedMs)),
    agreement: {
      pairs: both.length,
      withinBound: both.filter((row) => row.agreementWithinBound === true).length,
      medianTranslationM: quantile(numbers(both, (row) => row.agreementTranslationM), 0.5),
      medianYawDeg: quantile(numbers(both, (row) => (row.agreementYawDeg === null ? null : Math.abs(row.agreementYawDeg))), 0.5),
    },
    disagreementWithFit: { pairs: against.length, medianM: quantile(against, 0.5), maxM: against.length ? Math.max(...against) : null },
    keyframes,
    sameRoom: roomTally(true),
    crossRoom: roomTally(false),
    unlabelled: labelled ? rows.filter((row) => row.sameRoom === null).length : rows.length,
    sample: {
      scans: scansIn(rows),
      sameRoomPairs: sameCount,
      crossRoomPairs: crossCount,
      needsSameRoom: DX9_SAME_ROOM_PAIRS,
      needsCrossRoom: DX9_CROSS_ROOM_PAIRS,
      sufficient: sameCount === null || crossCount === null ? null : sameCount >= DX9_SAME_ROOM_PAIRS && crossCount >= DX9_CROSS_ROOM_PAIRS,
    },
  }
}

// ─── Reading the files ───────────────────────────────────────────────────────

/** The frames of one session directory and the bytes each took, from its `keyframes.jsonl` (the server writes `bytes` per frame). Never throws. */
export async function keyframeStats(sessionDir: string): Promise<KeyframeStats> {
  const stats: KeyframeStats = { sessions: 0, frames: 0, bytes: 0, meanBytes: null }
  let text: string
  try {
    text = await Deno.readTextFile(`${sessionDir}/keyframes.jsonl`)
  } catch {
    return stats
  }
  stats.sessions = 1
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as { bytes?: unknown }
      stats.frames += 1
      stats.bytes += finite(record.bytes) ?? 0
    } catch { /* a line cut short by a crash is not a frame */ }
  }
  stats.meanBytes = stats.frames > 0 ? stats.bytes / stats.frames : null
  return stats
}

/** The keyframe statistics of the session each scan names, by scan id. A scan with no session, or none on disk, has no entry. */
export async function scanKeyframes(
  sessionsDir: string,
  scans: readonly Pick<ScanManifest, 'scanId' | 'sessionId'>[],
): Promise<Map<string, KeyframeStats>> {
  const out = new Map<string, KeyframeStats>()
  for (const scan of scans) {
    if (!scan.sessionId || !SESSION_ID_RE.test(scan.sessionId)) continue
    const stats = await keyframeStats(`${sessionsDir}/${scan.sessionId}`)
    if (stats.sessions > 0) out.set(scan.scanId, stats)
  }
  return out
}

/** The world files of a folder (`<slug>.json`), skipping any JSON that is not one. */
export async function readWorlds(worldsDir: string): Promise<Array<{ name: string; world: WorldProject }>> {
  const names: string[] = []
  for await (const entry of Deno.readDir(worldsDir)) {
    if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name)
  }
  const worlds: Array<{ name: string; world: WorldProject }> = []
  for (const name of names.sort()) {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(`${worldsDir}/${name}`)) as WorldProject
      if (parsed && Array.isArray(parsed.jobs) && Array.isArray(parsed.scans)) worlds.push({ name: name.slice(0, -'.json'.length), world: parsed })
    } catch { /* not a world */ }
  }
  return worlds
}

// ─── The table ───────────────────────────────────────────────────────────────

function cell(value: unknown, digits: number): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(digits)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.join('+')
  return String(value)
}

const COLUMNS: Array<[name: string, pick: (row: PairRow) => unknown, digits?: number]> = [
  ['scan', (r) => r.scanName],
  ['against', (r) => r.referenceName],
  ['method', (r) => r.method],
  ['result', (r) => (r.reason ? `${r.status}: ${r.reason}` : r.status)],
  ['overlap', (r) => r.overlap],
  ['rms m', (r) => r.residualM, 3],
  ['score', (r) => r.score],
  ['query', (r) => r.queryInlierShare],
  ['cover', (r) => r.referenceCoverage],
  ['obs', (r) => r.observability],
  ['field', (r) => r.fieldScore],
  ['peak', (r) => r.globalPeakRatio],
  ['sym', (r) => r.symmetric],
  ['missed', (r) => r.startingValuesFailed],
  ['size', (r) => r.scaleRecovered ?? r.scaleRatio, 3],
  ['size +-', (r) => r.sizeUncertainty, 3],
  ['turn +- deg', (r) => r.turnUncertaintyDeg, 2],
  ['photos', (r) => (r.registeredImages === null ? null : `${r.registeredImages}/${r.offeredImages}`)],
  ['trimmed', (r) => r.fitTrimmedFrames, 0],
  ['ms', (r) => r.elapsedMs, 0],
  ['moves m', (r) => r.correctionM],
  ['fit max m', (r) => r.fitMaxM],
  ['vs fit m', (r) => r.disagreementWithFitM],
  ['kf', (r) => r.keyframes],
  ['kf bytes', (r) => r.keyframeBytes],
  ['room', (r) => (r.sameRoom === null ? null : r.sameRoom ? 'same' : 'cross')],
]

export function formatTable(rows: readonly PairRow[]): string {
  const table = [COLUMNS.map(([name]) => name), ...rows.map((row) => COLUMNS.map(([, pick, digits]) => cell(pick(row), digits ?? 2)))]
  const widths = table[0]!.map((_, i) => Math.max(...table.map((line) => line[i]!.length)))
  return table.map((line) => line.map((text, i) => text.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n')
}

function share(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`
}

function counts(of: Tally): string {
  return `${of.pairs} rows: ${of.proposed} proposed, ${of.refused} refused, ${of.skipped} skipped`
}

function timing(of: Spread): string {
  return of.median === null ? 'n/a' : `median ${Math.round(of.median)} ms, p95 ${Math.round(of.p95!)} ms, max ${Math.round(of.max!)} ms`
}

export function formatSummary(summary: Summary): string {
  const room = (label: string, of: ByMethod<Tally> | null): string => {
    if (!of) return `${label}: no labels`
    const wall = proposedShare(of['scan-match'])
    const photo = proposedShare(of.sfm)
    return `${label}: wall match ${counts(of['scan-match'])} (proposed ${share(wall)}); photo method ${counts(of.sfm)} (proposed ${share(photo)})`
  }
  const agreed = summary.agreement
  const fit = summary.disagreementWithFit
  const lines = [
    `Rows: ${summary.rows} (${summary.byMethod['scan-match'].pairs} wall-match pairs, ${summary.byMethod.sfm.pairs} photo-method runs)`,
    `Wall match: ${counts(summary.byMethod['scan-match'])}; proposed ${share(summary.proposedShare['scan-match'])} of those searched`,
    `Photo method: ${counts(summary.byMethod.sfm)}; proposed ${share(summary.proposedShare.sfm)} of those that ran`,
    `Refusals and skips by reason: ${Object.entries(summary.reasons).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `Starting values missed: ${Object.entries(summary.startingValuesMissed).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; ` +
      `pairs flagged symmetric: ${summary.symmetricPairs}`,
    `Wall-match time per pair: ${timing(summary.runtimeMs)}`,
    `Photo-method time per run: ${timing(summary.photoRuntimeMs)}`,
    `Two methods within their bound: ${agreed.withinBound} of ${agreed.pairs} jobs where both proposed` +
      (agreed.medianTranslationM === null ? '' : `; median ${(agreed.medianTranslationM * 100).toFixed(1)} cm and ${agreed.medianYawDeg!.toFixed(1)} degrees apart`),
    `Against the calibration's own fit: ${fit.pairs} proposals have both numbers; ` +
      (fit.medianM === null ? 'no figure' : `median ${(fit.medianM * 100).toFixed(1)} cm apart, largest ${(fit.maxM! * 100).toFixed(1)} cm`),
    `Keyframes: ${summary.keyframes.frames} frames in ${summary.keyframes.sessions} sessions, ${summary.keyframes.bytes} bytes` +
      (summary.keyframes.meanBytes === null ? '' : ` (${Math.round(summary.keyframes.meanBytes)} bytes a frame)`),
    room('Same room', summary.sameRoom),
    room('Cross room', summary.crossRoom),
    `Sample: ${summary.sample.scans} scans` +
      (summary.sample.sameRoomPairs === null ? '' : `, ${summary.sample.sameRoomPairs} same-room and ${summary.sample.crossRoomPairs} cross-room pairs searched`) +
      `. DX9 needs ${summary.sample.needsSameRoom} same-room and ${summary.sample.needsCrossRoom} cross-room pairs ` +
      `(at least ${DX9_MIN_ROOMS} rooms of ${DX9_MIN_SESSIONS_PER_ROOM} sessions). ` +
      (summary.sample.sufficient === null
        ? 'Without --labels there is no telling same-room from cross-room, so none of this is a tuning set.'
        : summary.sample.sufficient
        ? 'That many pairs were searched; their labels are the person\'s word.'
        : 'Not that many pairs were searched: this is a smoke test, not a tuning set.'),
  ]
  return lines.join('\n')
}

// ─── Command line ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = [...Deno.args]
  const flag = (name: string): boolean => {
    const at = args.indexOf(name)
    if (at < 0) return false
    args.splice(at, 1)
    return true
  }
  const take = (name: string): string | undefined => {
    const at = args.indexOf(name)
    if (at < 0) return undefined
    const [, value] = args.splice(at, 2)
    return value
  }
  const asJson = flag('--json')
  const keepAll = flag('--all')
  const worldsDir = take('--worlds') ?? Deno.env.get('WORLDS_DIR') ?? './worlds'
  const sessionsDir = take('--sessions') ?? Deno.env.get('SESSIONS_DIR') ?? `${Deno.env.get('SCANS_DIR') ?? './scans'}/sessions`
  const labelsPath = take('--labels')
  if (args.length > 0) {
    console.error(`Unknown argument: ${args[0]}`)
    Deno.exit(2)
  }
  let labels: Labels | null = null
  if (labelsPath) {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(labelsPath))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('--labels must be a JSON object of scan id to room name')
      Deno.exit(2)
    }
    labels = parsed as Labels
  }
  let worlds: Awaited<ReturnType<typeof readWorlds>>
  try {
    worlds = await readWorlds(worldsDir)
  } catch {
    console.error(`No worlds folder to read at ${worldsDir}. Pass --worlds <dir>.`)
    Deno.exit(2)
  }
  const gathered: PairRow[] = []
  const keyframes = new Map<string, KeyframeStats>()
  for (const { name, world } of worlds) {
    const stats = await scanKeyframes(sessionsDir, world.scans)
    for (const [id, value] of stats) keyframes.set(`${name}|${id}`, value)
    gathered.push(...pairRows(name, world, { labels, keyframes: stats }))
  }
  const rows = keepAll ? gathered : latestPerPair(gathered)
  const summary = summarise(rows, { labelled: labels !== null, keyframes })
  if (asJson) console.log(JSON.stringify({ rows, summary }, null, 2))
  else {
    console.log(rows.length === 0 ? 'No place-register proposal artifacts found.' : formatTable(rows))
    console.log()
    console.log(formatSummary(summary))
  }
}
