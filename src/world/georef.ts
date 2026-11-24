/**
 * A Place's georeference: where its frame is on Earth, what may be stored as one, how sure it is, and what it
 * becomes in an export.
 *
 * Pure and browser-safe on purpose (ADR 0002): no Node or DOM reference. The server places scans through it
 * (server/world/world_origin.ts), validates and compare-and-swaps it (server/world/georef_write.ts), and the editor,
 * the scanner and a test read the same functions. The decision is docs/adr/0015-scene-convention-and-georeference.md.
 * The type is `ProjectGeoreference` in ./types.ts (ADR 0001: one record, not a second one beside it), and the
 * geodesy is ./enu.ts's. Nothing here converts a latitude by a formula of its own.
 *
 * ## What the record is
 *
 * The origin of a Place frame (its landmark, on the floor) as latitude and longitude, how accurate that is as an R68
 * radius, and the TRUE bearing of the frame's +Z axis (the landmark-to-heading-marker direction) with one standard
 * deviation. Two numbers and their accuracies relate a Place to a map, and every calibrated scan of the Place follows,
 * because a scan's own frame comes from geometry (ADR 0005) and the georeference only turns and moves the Place frame
 * as a whole.
 *
 * ## Accuracy is stated as it was obtained, and no better (ADR 0005 rules 3 and 5)
 *
 * A map click cannot place a point better than the imagery it was made on: a vendor's CE90 of 4 to 5 m is about 3.5 m
 * as a 68% radius. A bearing from the 1 to 3 m landmark-to-marker baseline is 5.7 to 17 degrees at 0.3 m of click noise,
 * from a 30 m building edge under one degree. A compass seed indoors is tens of degrees. So each source has a floor under
 * the accuracy it may claim ({@link ACCURACY_FLOORS}), and `validateGeoreference` refuses a record under it. **Every figure
 * in this file is adopted, not measured** (ADR 0005 rule 5): each constant says where it comes from and when to replace it.
 * The device experiments that replace them are DX3 (compass sign, tilt, indoor steel) and DX7 (seed quality against a
 * surveyed bearing, map click against the phone's fix).
 *
 * ## What it does not do
 *
 * It does not say a georeference is right. A well-formed record from a mis-clicked map is well formed. A seed is
 * approximate, is never averaged into a registration a person confirmed, and carries no `confirmedAt` until a person
 * says so.
 */
import { declinationDeg, decimalYear, DECLINATION_MODEL, MAX_HEIGHT_M, MIN_HEIGHT_M } from './declination.ts'
import { invertAffine } from './anchor-placement.ts'
import { geodeticToEnu, sceneYawForBearingDeg } from './enu.ts'
import { composeYUpTransform, normaliseBearingDeg } from './geo.ts'
import { normaliseZeros } from './scan-placement.ts'
import { isFrameId, isFrameRevision, isPlaceFrameMethod, sameSpatialFrame, type SpatialFrameMethod } from './spatial-frame.ts'
import type { GeoPose, GeoreferenceOrigin, GeoreferenceSource, ProjectGeoreference } from './types.ts'

export type { GeoreferenceOrigin, GeoreferenceSource }

/** A Place's registration onto the map. The one record (`Project.georeference`): see ./types.ts. */
export type Georeference = ProjectGeoreference

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

// ─── Adopted constants (ADR 0005 rule 5) ─────────────────────────────────────

/**
 * The least R68 radius an origin from a map click, a footprint snap or typed numbers may claim, metres. Aerial imagery
 * carries its own absolute error: a vendor's CE90 of 4 to 5 m converts to a per-axis sigma of 1.7 to 2.3 m and an R68 of
 * about 3.5 m (R6 section 6.2; the NAIP 2008 specification's 6 m at 95% gives 3.7 m). Click precision, 0.1 to 0.9 m at the
 * highest zoom, is below that and is not the figure to quote. **Adopted, not measured.** Revisit when DX7 has compared a
 * click with a surveyed point, or when the owner supplies better imagery or control (then `source: 'survey'`).
 */
export const ORIGIN_ACCURACY_FLOOR_IMAGERY_M = 3.5

/**
 * The least R68 radius an origin from surveyed control may claim, metres: RTK GNSS is good to a few centimetres, and a
 * claim below this is not one a person marking a point can make. **Adopted, not measured.**
 */
export const ORIGIN_ACCURACY_FLOOR_SURVEY_M = 0.05

/**
 * The least R68 radius a phone-fix origin may claim, metres: the seed rule `max(reported, 10)` (R6 section 4.4). Outdoors
 * a phone reports 4 to 8 m, indoors 10 to 50 m with wild outliers, and the figure it reports is a claim and not a
 * guarantee. **Adopted, not measured** (DX7).
 */
export const ORIGIN_ACCURACY_FLOOR_SEED_M = 10

/** The most an origin's accuracy may be, metres. Only rules out a number that says nothing: 1000 m is already a map-scale guess. Adopted, not measured. */
export const ORIGIN_ACCURACY_MAX_M = 1000

/**
 * The least one-sigma bearing a bearing from a long building edge, a map click or typed numbers may claim, degrees: a
 * 30 to 50 m edge at 0.3 m of click noise gives 0.2 to 0.8, and the wall measured in the scan being parallel to that edge
 * is its own error (R6 section 6.3 budgets about 1 degree in all). **Adopted, not measured** (DX7).
 */
export const BEARING_SIGMA_FLOOR_EDGE_DEG = 1

/**
 * The least one-sigma bearing a bearing from a short baseline (the 1 to 3 m landmark-to-marker pair, clicked on a map)
 * may claim, degrees: `sqrt(2) x 0.3 m / B` is 5.7 to 17 degrees at 1 to 3 m (R6 section 6.3). Used by
 * {@link predictedBearingSigmaDeg}: a record does not store its baseline, so the validator holds every source to the
 * edge floor and the writer that knows the baseline is responsible for this one. **Adopted, not measured.**
 */
export const BEARING_SIGMA_FLOOR_SHORT_BASELINE_DEG = 8

/** The least one-sigma bearing surveyed control may claim, degrees. **Adopted, not measured.** */
export const BEARING_SIGMA_FLOOR_SURVEY_DEG = 0.1

/**
 * The least one-sigma bearing a compass seed may claim, degrees: `bearingAccuracyDeg = max(circular SD, 15)`. Indoor
 * steel moves a compass by 10 to 80 microtesla against about 53 expected (R6 section 1.1, an old study), so a spread
 * across samples is not the error. **Adopted, not measured** (DX3).
 */
export const BEARING_SIGMA_FLOOR_SEED_DEG = 15

/**
 * The same, on an iPhone, until DX3: nothing has measured an iPhone's heading against a known bearing, or told whether
 * it follows the camera or the top edge of a tilted phone. The figure is `IOS_COMPASS_SIGMA_FLOOR_DEG` in
 * src/geo/compass-heading.ts (that file reads DOM types, so a server module cannot import it, and a test holds the two
 * equal). **Adopted, not measured.**
 */
export const BEARING_SIGMA_FLOOR_SEED_IOS_DEG = 25

/**
 * The least one-sigma bearing a course-over-ground bearing may claim, degrees. The best of R6's modelled walks (50 m, a
 * good fix) is 2.7 degrees at 68%, and nothing has measured one; this keeps clear of it. No code in this repository
 * writes this source yet. **Adopted, not measured** (DX7).
 */
export const BEARING_SIGMA_FLOOR_COURSE_DEG = 5

/** The most a bearing's accuracy may be, degrees: 180 says the bearing is not known at all. A bound on the number, not a figure. */
export const BEARING_SIGMA_MAX_DEG = 180

/**
 * The click noise a person's map click has per axis, metres, when none is given: 0.3 m, which is R6's figure for a mouse
 * at zoom 20 and 51.5 N (one pixel is 0.093 m). A finger is 5 to 10 pixels. **Adopted, not measured** (DX7).
 */
export const DEFAULT_CLICK_SIGMA_M = 0.3

/**
 * A baseline shorter than this is a short one for {@link predictedBearingSigmaDeg}, metres. R6 warns the map editor under 10 m
 * and asks for 20 m or more from an edge. **Adopted, not measured.**
 */
export const SHORT_BASELINE_MAX_M = 10

/** How far into the future a `confirmedAt` may be, ms: a clock that is a little fast is not a refusal. Adopted, not measured. */
export const CONFIRMED_AT_FUTURE_SLACK_MS = 5 * 60_000

/** Latitudes past this are refused: east is not defined at a pole, and the module's guard is 89.999 (R6 section 7.1). */
export const MAX_ORIGIN_LATITUDE_DEG = 89.999

/** The window of a walk a seed's fix is chosen from, seconds (R6 section 4.4). Adopted, not measured. */
export const SEED_FIX_WINDOW_S = 60

/** A fix with a larger accuracy than this is dropped from a seed, metres (R6 section 4.4: "> 50 m"). Adopted, not measured. */
export const SEED_FIX_MAX_ACCURACY_M = 50

/**
 * The distance the phone has moved from the session's origin, metres, past which a seed's position is corrected for it
 * (R6 section 4.4 step 3: "beyond about 3 m"; a 10 m offset with a 15 degree bearing error leaves 2.6 m, so a smaller one
 * is left alone). Adopted, not measured.
 */
export const LEVER_ARM_MIN_M = 3

/**
 * How much worse than reported a seed's origin is claimed to be when the phone reported more than {@link ORIGIN_ACCURACY_FLOOR_SEED_M}:
 * indoors a phone's own accuracy figure is optimistic (R6 section 4.4 step 4). **Adopted, not measured** (ADR 0005 rule 5): replace it
 * with the ratio of surveyed error to reported accuracy when DX7 has measured one.
 */
export const SEED_ORIGIN_ACCURACY_WORSE_FACTOR = 1.5

/**
 * The least a seed's origin claims when the phone reported more than {@link ORIGIN_ACCURACY_FLOOR_SEED_M}, metres (R6 section 4.4
 * step 4). **Adopted, not measured** (ADR 0005 rule 5): replace it with a surveyed figure when DX7 has measured one.
 */
export const SEED_ORIGIN_ACCURACY_WORSE_FLOOR_M = 25

/**
 * A compass sample counts as steady while the phone turns slower than this, degrees per second: a compass reading lags
 * the pose by about 100 ms, which at 60 degrees per second is 6 degrees (R6 section 1.3 rule 5). **Adopted, not measured**
 * (DX3).
 */
export const STEADY_ROTATION_RATE_DEG_S = 10

/** A bearing needs steady samples over at least this long, seconds (R6 section 4.4). Adopted, not measured. */
export const STEADY_MIN_SPAN_S = 2

/** And at least this many of them, so a handful of readings in an instant is not a mean. Adopted, not measured. */
export const MIN_BEARING_SAMPLES = 8

/** A seed over fewer scans than this is low confidence (R6 section 4.4 step 6). Adopted, not measured. */
export const SEED_MIN_SCANS_FOR_CONFIDENCE = 3

/** A seed whose spread is over this is low confidence, degrees (R6 section 4.4 step 6). Adopted, not measured. */
export const SEED_MAX_CONFIDENT_SPREAD_DEG = 30

/**
 * Placement gates, the server's. A scan with no calibration is placed by GPS and compass only when its fix is no worse
 * than this, metres. The precedent is `PLACE_SUGGEST_MAX_ACCURACY_M` (src/main.ts), the figure past which a fix is not
 * trusted to suggest a Place; the owner's tablet indoors reads 5 to 33 m. **Adopted, not measured.**
 */
export const PLACEMENT_MAX_FIX_ACCURACY_M = 25

/**
 * ...its fix was taken no farther from the walk's beginning than this, seconds, before it or after it. Before: the phone's last fix is
 * stale. After: it is where the phone had walked to, and the capture records only the best fix of the first {@link SEED_FIX_WINDOW_S}
 * seconds with the camera's position at it, so a later one has no lever arm to carry it back to the session's origin and the error is
 * the distance walked. **Adopted, not measured.**
 */
export const PLACEMENT_MAX_FIX_AGE_S = 60

/** ...and the spread of its compass samples is no larger than this, degrees. **Adopted, not measured.** */
export const PLACEMENT_MAX_BEARING_SPREAD_DEG = 30

// ─── Accuracy floors ─────────────────────────────────────────────────────────

export interface AccuracyFloor {
  /** The least origin R68 radius, metres. */
  originM: number
  /** The least bearing sigma, degrees. */
  bearingDeg: number
}

/**
 * What each source may claim at best. A source not on a survey cannot claim better than the imagery a click was made on,
 * and a compass seed cannot claim better than a compass is.
 */
export const ACCURACY_FLOORS: Readonly<Record<GeoreferenceSource, AccuracyFloor>> = {
  'map-click': { originM: ORIGIN_ACCURACY_FLOOR_IMAGERY_M, bearingDeg: BEARING_SIGMA_FLOOR_EDGE_DEG },
  'footprint-snap': { originM: ORIGIN_ACCURACY_FLOOR_IMAGERY_M, bearingDeg: BEARING_SIGMA_FLOOR_EDGE_DEG },
  typed: { originM: ORIGIN_ACCURACY_FLOOR_IMAGERY_M, bearingDeg: BEARING_SIGMA_FLOOR_EDGE_DEG },
  survey: { originM: ORIGIN_ACCURACY_FLOOR_SURVEY_M, bearingDeg: BEARING_SIGMA_FLOOR_SURVEY_DEG },
  'gps-compass': { originM: ORIGIN_ACCURACY_FLOOR_SEED_M, bearingDeg: BEARING_SIGMA_FLOOR_SEED_DEG },
  'course-over-ground': { originM: ORIGIN_ACCURACY_FLOOR_SEED_M, bearingDeg: BEARING_SIGMA_FLOOR_COURSE_DEG },
}

/** Every source a record may name, in the order the type declares them. */
export const GEOREFERENCE_SOURCES = [
  'map-click',
  'footprint-snap',
  'gps-compass',
  'course-over-ground',
  'typed',
  'survey',
] as const

// Compile-time checks, types only: the source list and the validator's field list say what the type says.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type MustBe<T extends true> = T
export type GeoreferenceSourcesMatchTheType = MustBe<Equal<(typeof GEOREFERENCE_SOURCES)[number], GeoreferenceSource>>

/**
 * The fields of a stored georeference. Typed against the record: a field added to `ProjectGeoreference` that is missing here
 * is a compile error, and so is one listed that the record does not have, so the validator cannot drift from the type.
 */
export const GEOREFERENCE_FIELDS = {
  origin: true,
  heightDatum: true,
  bearingDeg: true,
  bearingAccuracyDeg: true,
  convention: true,
  datum: true,
  source: true,
  declination: true,
  seed: true,
  registeredAt: true,
  confirmedAt: true,
  anchorRef: true,
} as const satisfies Record<keyof ProjectGeoreference, true>
export type GeoreferenceFieldsMatchTheType = MustBe<Equal<keyof typeof GEOREFERENCE_FIELDS, keyof ProjectGeoreference>>

// ─── Validation ──────────────────────────────────────────────────────────────

export type GeoreferenceCheck =
  | { ok: true; georeference: ProjectGeoreference }
  | { ok: false; error: string; errors: string[] }

export interface GeoreferenceCheckOptions {
  /** The time `confirmedAt` is judged against, ms. The clock when absent. */
  now?: number
  /**
   * Whether an accuracy under the floor of the record's source is a problem. True when absent: a write is held to the floors as they
   * are. A record already stored is read with false and then held to them ({@link readStoredGeoreference}), so that a floor raised
   * by a later measurement does not make the Place forget a registration it holds.
   */
  floors?: boolean
}

/** The most problems one refusal lists: a body with a hundred thousand unknown fields is answered in a few lines, not in a few megabytes. Adopted, not measured. */
export const MAX_REPORTED_PROBLEMS = 20

/** What every writer stores in a time field: `toISOString()`. A number or a word a date parser happens to read is not that. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

type Json = Record<string, unknown>

function isPlainObject(value: unknown): value is Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Bounds on the plain JSON a seed's audit values may hold. Adopted, not measured (ADR 0005 rule 5). */
const SEED_MAX_DEPTH = 4
const SEED_MAX_NODES = 200
const SEED_MAX_STRING = 500
const SEED_MAX_ENTRIES = 64

/** A copy of `value` if it is plain JSON within the seed's bounds, else the reason it is not. */
function cloneSeed(value: unknown, path: string, depth: number, state: { nodes: number }): { value: unknown } | { error: string } {
  state.nodes += 1
  if (state.nodes > SEED_MAX_NODES) return { error: `${path} is too large` }
  if (value === null || typeof value === 'boolean') return { value }
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : { error: `${path} must be a finite number` }
  if (typeof value === 'string') return value.length <= SEED_MAX_STRING ? { value } : { error: `${path} is too long` }
  if (depth >= SEED_MAX_DEPTH) return { error: `${path} is nested too deeply` }
  if (Array.isArray(value)) {
    if (value.length > SEED_MAX_ENTRIES) return { error: `${path} has too many entries` }
    const copy: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const item = cloneSeed(value[i], `${path}[${i}]`, depth + 1, state)
      if ('error' in item) return item
      copy.push(item.value)
    }
    return { value: copy }
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length > SEED_MAX_ENTRIES) return { error: `${path} has too many fields` }
    const copy: Json = {}
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) return { error: `${path} has a field the server will not store` }
      if (value[key] === undefined) continue
      const item = cloneSeed(value[key], `${path}.${key}`, depth + 1, state)
      if ('error' in item) return item
      copy[key] = item.value
    }
    return { value: copy }
  }
  return { error: `${path} must be plain data` }
}

function isSource(value: unknown): value is GeoreferenceSource {
  return typeof value === 'string' && (GEOREFERENCE_SOURCES as readonly string[]).includes(value)
}

const isoDate = (value: unknown): value is string => typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value))

/** A number to this many decimals in a message: no more than a person can read. */
const shown = (n: number) => String(Number(n.toPrecision(6)))

function originProblems(value: unknown, source: GeoreferenceSource | null, floors: boolean): { origin: GeoreferenceOrigin | null; problems: string[] } {
  const problems: string[] = []
  if (!isPlainObject(value)) return { origin: null, problems: ['origin must be an object with lat, lng, altitudeM and accuracyM'] }
  for (const key of Object.keys(value)) {
    if (key !== 'lat' && key !== 'lng' && key !== 'altitudeM' && key !== 'accuracyM') problems.push(`origin.${key} is not a field of a location`)
  }
  const { lat, lng, altitudeM, accuracyM } = value
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > MAX_ORIGIN_LATITUDE_DEG) {
    problems.push(`origin.lat must be a number from -${MAX_ORIGIN_LATITUDE_DEG} to ${MAX_ORIGIN_LATITUDE_DEG}`)
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) problems.push('origin.lng must be a number from -180 to 180')
  if (lat === 0 && lng === 0) problems.push('origin must not be latitude 0 and longitude 0: that is how a missing location is written')
  if (altitudeM !== null && (typeof altitudeM !== 'number' || !Number.isFinite(altitudeM) || altitudeM < MIN_HEIGHT_M || altitudeM > MAX_HEIGHT_M)) {
    problems.push(`origin.altitudeM must be a height in metres above the WGS-84 ellipsoid from ${MIN_HEIGHT_M} to ${MAX_HEIGHT_M}, or null`)
  }
  if (typeof accuracyM !== 'number' || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    problems.push('origin.accuracyM must be a number above 0 (a radius in metres)')
  } else {
    if (accuracyM > ORIGIN_ACCURACY_MAX_M) problems.push(`origin.accuracyM must be at most ${ORIGIN_ACCURACY_MAX_M} m`)
    if (floors && source !== null && accuracyM < ACCURACY_FLOORS[source].originM) {
      problems.push(`origin.accuracyM is below the ${shown(ACCURACY_FLOORS[source].originM)} m a location from '${source}' can claim`)
    }
  }
  if (problems.length > 0) return { origin: null, problems }
  return { origin: { lat: lat as number, lng: lng as number, altitudeM: altitudeM as number | null, accuracyM: accuracyM as number }, problems }
}

/**
 * Whether `value` is a georeference the server may store, and a copy of it if so. The copy is built field by field, so
 * nothing the input inherits or hides can reach it. Every problem is reported (`errors`), the first one is `error`.
 *
 * It checks that a record is well formed and that it does not claim more than its source can: numbers are finite and in
 * range, a height has a datum (a number is ellipsoidal, a null is unknown: a phone's `coords.altitude` is mean sea level
 * on iOS and has no place here), the bearing is in [0, 360), the sign rule is the corrected one, and no accuracy is under
 * the floor of the source ({@link ACCURACY_FLOORS}). A field this record does not have is refused rather than kept: a
 * georeference is a claim about accuracy, and a field no check has seen could carry one.
 *
 * It does not say the record is right. A mis-clicked origin is well formed.
 */
export function validateGeoreference(value: unknown, options: GeoreferenceCheckOptions = {}): GeoreferenceCheck {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'georeference must be an object', errors: ['georeference must be an object'] }
  }
  const problems: string[] = []
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      problems.push('georeference has a field the server will not store')
    } else if (!Object.hasOwn(GEOREFERENCE_FIELDS, key)) {
      problems.push(`georeference.${key} is not a field of a georeference`)
    }
  }

  const source = isSource(value['source']) ? value['source'] : null
  if (source === null) problems.push(`georeference.source must be one of ${GEOREFERENCE_SOURCES.join(', ')}`)

  const floors = options.floors !== false
  const checkedOrigin = originProblems(value['origin'], source, floors)
  problems.push(...checkedOrigin.problems)

  const heightDatum = value['heightDatum']
  if (heightDatum !== 'ellipsoid' && heightDatum !== 'unknown') {
    problems.push("georeference.heightDatum must be 'ellipsoid' or 'unknown'")
  } else if (checkedOrigin.origin) {
    const hasHeight = checkedOrigin.origin.altitudeM !== null
    if (hasHeight && heightDatum !== 'ellipsoid') problems.push("a height needs georeference.heightDatum 'ellipsoid': a height with no datum is not stored")
    if (!hasHeight && heightDatum !== 'unknown') problems.push("no height needs georeference.heightDatum 'unknown'")
  }

  const bearingDeg = value['bearingDeg']
  if (typeof bearingDeg !== 'number' || !Number.isFinite(bearingDeg) || bearingDeg < 0 || bearingDeg >= 360) {
    problems.push('georeference.bearingDeg must be a number from 0 up to 360 (degrees clockwise from true north)')
  }
  const bearingAccuracyDeg = value['bearingAccuracyDeg']
  if (typeof bearingAccuracyDeg !== 'number' || !Number.isFinite(bearingAccuracyDeg) || bearingAccuracyDeg <= 0) {
    problems.push('georeference.bearingAccuracyDeg must be a number above 0 (one standard deviation, in degrees)')
  } else {
    if (bearingAccuracyDeg > BEARING_SIGMA_MAX_DEG) problems.push(`georeference.bearingAccuracyDeg must be at most ${BEARING_SIGMA_MAX_DEG}`)
    if (floors && source !== null && bearingAccuracyDeg < ACCURACY_FLOORS[source].bearingDeg) {
      problems.push(`georeference.bearingAccuracyDeg is below the ${shown(ACCURACY_FLOORS[source].bearingDeg)} degrees a heading from '${source}' can claim`)
    }
  }

  if (value['convention'] !== 2) problems.push('georeference.convention must be 2 (the corrected bearing sign rule)')
  if (value['datum'] !== 'WGS84') problems.push("georeference.datum must be 'WGS84'")

  let declination: ProjectGeoreference['declination']
  if (value['declination'] !== undefined) {
    const d = value['declination']
    if (
      !isPlainObject(d) || Object.keys(d).some((key) => key !== 'deg' && key !== 'model' && key !== 'year')
      || typeof d['deg'] !== 'number' || !Number.isFinite(d['deg']) || Math.abs(d['deg']) > 90
      || d['model'] !== DECLINATION_MODEL
      || typeof d['year'] !== 'number' || !Number.isFinite(d['year']) || d['year'] < 1900 || d['year'] > 3000
    ) {
      problems.push(`georeference.declination must be { deg (east positive, within 90), model '${DECLINATION_MODEL}', year }`)
    } else {
      declination = { deg: d['deg'], model: d['model'] as 'WMM2025', year: d['year'] }
    }
  }

  let seed: Record<string, unknown> | undefined
  if (value['seed'] !== undefined) {
    const cloned = cloneSeed(value['seed'], 'georeference.seed', 0, { nodes: 0 })
    if ('error' in cloned) problems.push(cloned.error)
    else if (!isPlainObject(cloned.value)) problems.push('georeference.seed must be an object')
    else seed = cloned.value
  }

  if (!isoDate(value['registeredAt'])) problems.push('georeference.registeredAt must be an ISO date')

  let confirmedAt: string | undefined
  if (value['confirmedAt'] !== undefined) {
    const at = value['confirmedAt']
    if (!isoDate(at)) {
      problems.push('georeference.confirmedAt must be an ISO date')
    } else if (Date.parse(at) > (options.now ?? Date.now()) + CONFIRMED_AT_FUTURE_SLACK_MS) {
      problems.push('georeference.confirmedAt is in the future')
    } else {
      confirmedAt = at
    }
  }

  const anchorRef = value['anchorRef']
  if (anchorRef !== null && !isFrameId(anchorRef)) {
    problems.push('georeference.anchorRef must be the id of the Place frame it was made against, or null')
  }

  if (problems.length > 0 || checkedOrigin.origin === null || source === null) {
    const errors = problems.length > 0 ? reportedProblems(problems) : ['georeference is not valid']
    return { ok: false, error: errors[0]!, errors }
  }

  const georeference: ProjectGeoreference = {
    origin: checkedOrigin.origin,
    heightDatum: heightDatum as 'ellipsoid' | 'unknown',
    bearingDeg: bearingDeg as number,
    bearingAccuracyDeg: bearingAccuracyDeg as number,
    convention: 2,
    datum: 'WGS84',
    source,
    ...(declination ? { declination } : {}),
    ...(seed ? { seed } : {}),
    registeredAt: value['registeredAt'] as string,
    ...(confirmedAt ? { confirmedAt } : {}),
    anchorRef: anchorRef as string | null,
  }
  return { ok: true, georeference }
}

/** The problems a refusal lists: the first {@link MAX_REPORTED_PROBLEMS}, and how many more there were. */
function reportedProblems(problems: readonly string[]): string[] {
  if (problems.length <= MAX_REPORTED_PROBLEMS) return [...problems]
  return [...problems.slice(0, MAX_REPORTED_PROBLEMS), `and ${problems.length - MAX_REPORTED_PROBLEMS} more problems`]
}

/**
 * A record claims no better than its source can, as the floors are now: an accuracy under the floor is raised to it. A record that
 * is already at or over its floors is returned as it is (the same object).
 */
export function holdToFloors(record: ProjectGeoreference): ProjectGeoreference {
  const floor = ACCURACY_FLOORS[record.source]
  if (record.origin.accuracyM >= floor.originM && record.bearingAccuracyDeg >= floor.bearingDeg) return record
  return {
    ...record,
    origin: { ...record.origin, accuracyM: Math.max(record.origin.accuracyM, floor.originM) },
    bearingAccuracyDeg: Math.max(record.bearingAccuracyDeg, floor.bearingDeg),
  }
}

/**
 * A georeference that is already stored, read for use. It must still be well formed (a registry is a file a person can edit), but it
 * is not refused for claiming less error than the floors of today allow: the floors are adopted figures that a device measurement
 * will move, and a Place must not lose its registration the day one moves. What it claims is held to them instead
 * ({@link holdToFloors}), so nothing placed or printed from it claims more than a record written today could.
 */
export function readStoredGeoreference(value: unknown): GeoreferenceCheck {
  const check = validateGeoreference(value, { floors: false })
  return check.ok ? { ok: true, georeference: holdToFloors(check.georeference) } : check
}

/** Whether two records are the same georeference: every field equal, whatever order the keys came in. */
export function sameGeoreference(a: unknown, b: unknown): boolean {
  return sameSpatialFrame(a, b)
}

/**
 * The version of the georeference a Place holds: how many georeference writes the server accepted for it. A Place saved
 * before the field existed and one that has none read as 0, and so does a value that is not a whole number of at least 1.
 */
export function placeGeorefVersion(place: { georefVersion?: unknown } | null | undefined): number {
  const version = place?.georefVersion
  return typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 0
}

/** Whether `value` can be the version a writer expects to find: a whole number, 0 or more. */
export const isGeorefVersion: (value: unknown) => value is number = isFrameRevision

/** Whether a person has confirmed this georeference. A seed that nobody confirmed is approximate, and the map features are not for it. */
export function isConfirmedGeoreference(georef: Pick<ProjectGeoreference, 'confirmedAt'> | null | undefined): boolean {
  return typeof georef?.confirmedAt === 'string' && georef.confirmedAt.length > 0
}

/**
 * Whether a georeference was made against the frame the Place holds now. `'unknown'` when either side has no id (a frame
 * written before ids existed, or a record made without one): nothing says they differ, so nothing says they match.
 * `'other-frame'` only when both ids are known and differ: the Place's frame was replaced after the registration, and the
 * registration is of the earlier one.
 */
export function georeferenceFrameState(
  georef: Pick<ProjectGeoreference, 'anchorRef'> | null | undefined,
  frame: { frameId?: unknown } | null | undefined,
): 'matches' | 'unknown' | 'other-frame' {
  const ref = georef?.anchorRef
  const id = frame?.frameId
  if (typeof ref !== 'string' || typeof id !== 'string') return 'unknown'
  return ref === id ? 'matches' : 'other-frame'
}

/**
 * The matrix, column-major, that carries a point of the Place frame into the scene a georeference defines: the turn `Ry(180 - bearing)`
 * and no move, because the scene's (0, 0, 0) is the Place's own origin, the landmark (the georeference's origin is the world's,
 * ADR 0015). A calibrated scan's placement is this times its `projectTransform` (`placeCalibratedScan`, server/world/world_origin.ts); the
 * editor draws the Place's own points, such as the heading marker a calibration is checked against, through it.
 */
export function placeFrameToScene(georef: Pick<ProjectGeoreference, 'bearingDeg'>): number[] {
  return normaliseZeros(composeYUpTransform({ x: 0, y: 0, z: 0 }, sceneYawForBearingDeg(georef.bearingDeg), 1))
}

/**
 * The session-to-project matrix inside a placement made through a georeference: `inverse(placeToScene) x placement`, where the
 * placement is `placeToScene x sessionToProject` (`placeFrameToScene`, and a scan's `calibratedLocalToWorld` in a georeferenced
 * Place). With no turn (`placeToScene` null) the placement is the matrix itself and comes back as it is. This is the matrix the
 * editor's calibration pins are read from (`sessionAnchorPositions`, src/world/anchor-placement.ts, takes the matrix that carries the
 * session into the Place frame): read through the placement they are drawn at the point the turn carried away from the tap.
 */
export function sessionToProjectOfPlacement(placement: readonly number[], placeToScene: readonly number[] | null): number[] {
  if (!placeToScene) return [...placement]
  const back = invertAffine([...placeToScene])
  if (!back || placement.length !== 16) return [...placement]
  const out = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row]! += back[k * 4 + row]! * placement[column * 4 + k]!
    }
  }
  return normaliseZeros(out)
}

/**
 * The matrix that carries the Place frame into a world's scene for the scans of `scan`'s kind, or null when the scene is the Place
 * frame itself: a world with no georeference, and a scan that is not in the Place frame (`inPlaceFrame`), are placed as they were
 * calibrated, with no turn. This is what the editor asks to draw a calibration's own points (the heading marker, the Place's stored
 * pins) where the scan's calibration put them: a georeferenced scan's `calibratedLocalToWorld` holds the turn, and a point read
 * through it without the turn is drawn metres from where the person tapped.
 */
export function placeFrameToSceneFor(
  georeference: Pick<ProjectGeoreference, 'bearingDeg'> | null | undefined,
  scan: { calibrationMethod?: unknown; calibrationFrameId?: unknown },
  frame: { method?: unknown; frameId?: unknown } | null | undefined,
): number[] | null {
  if (!georeference) return null
  const frameMethod = isPlaceFrameMethod(frame?.method) ? frame.method : null
  const inFrame = inPlaceFrame(scan.calibrationMethod, frameMethod, {
    scan: typeof scan.calibrationFrameId === 'string' ? scan.calibrationFrameId : null,
    place: typeof frame?.frameId === 'string' ? frame.frameId : null,
  })
  return inFrame ? placeFrameToScene(georeference) : null
}

/** The method of a Place's stored frame: the one tier whose scans are in it. */
export type FrameMethod = SpatialFrameMethod

/**
 * Whether a scan's calibration is in the Place's frame, so that the Place's georeference carries it, and so that it is a scan of the
 * Place to be compared with the others:
 *
 *  - Only a tier a stored frame can have is (`isPlaceFrameMethod`): a known-distance matrix carries the camera solve's own coordinates.
 *  - Only the tier the Place's frame was made with: a one-point frame differs from a two-point one by the baseline's bearing, so a
 *    one-point scan of a two-point Place is in another frame. A Place with no frame has nothing to differ from.
 *  - Only the generation the Place holds now, when both generations are known and differ: a Place whose frame was replaced has scans
 *    of the earlier one, and they are not in this one. A generation that is not known on either side says nothing (a scan calibrated
 *    before frame ids existed reads as neutral, never as another).
 */
export function inPlaceFrame(
  method: unknown,
  frameMethod: FrameMethod | null,
  generations: { scan?: string | null; place?: string | null } = {},
): boolean {
  if (!isPlaceFrameMethod(method)) return false
  if (typeof generations.scan === 'string' && typeof generations.place === 'string' && generations.scan !== generations.place) return false
  return frameMethod === null || method === frameMethod
}

/** A georeference's origin as the `GeoPose` a world carries as its origin: a position, its accuracy, and no heading (a GeoPose's is a phone's). */
export function georeferenceOriginAsGeoPose(georef: ProjectGeoreference): GeoPose {
  return {
    lat: georef.origin.lat,
    lng: georef.origin.lng,
    altitudeM: georef.origin.altitudeM,
    bearing: null,
    accuracyM: georef.origin.accuracyM,
    fixedAt: georef.registeredAt,
  }
}

// ─── Bearing and accuracy ────────────────────────────────────────────────────

/** A position on the map: degrees. The height is not asked for, and no height is used. */
export interface MapPoint {
  lat: number
  lng: number
}

const onEllipsoid = (p: MapPoint) => ({ lat: p.lat, lng: p.lng, altitudeM: 0 })

/**
 * The TRUE bearing, degrees clockwise from true north in [0, 360), of the direction from `from` to `to`: the angle of the
 * local east and north offset between them on the ellipsoid (`atan2(east, north)` of `geodeticToEnu`, ./enu.ts), never
 * the planar shortcut on latitude and longitude. Two clicks on a long building edge give the edge's bearing; the
 * landmark and the heading marker clicked on a map give the Place frame's bearing directly (its +Z is the direction from
 * the first to the second). Null for a position that is not a number in range, and for two that are the same point,
 * which have no direction.
 */
export function bearingFromClicks(from: MapPoint, to: MapPoint): number | null {
  const ok = (p: MapPoint) => Number.isFinite(p.lat) && Math.abs(p.lat) <= MAX_ORIGIN_LATITUDE_DEG && Number.isFinite(p.lng)
  if (!ok(from) || !ok(to)) return null
  const enu = geodeticToEnu(onEllipsoid(from), onEllipsoid(to))
  if (Math.hypot(enu.east, enu.north) < 1e-9) return null
  return normaliseBearingDeg(Math.atan2(enu.east, enu.north) * RAD_TO_DEG)
}

/** The horizontal distance between two clicks, metres, on the ellipsoid. Null for a position that is not a number in range. */
export function baselineLengthM(from: MapPoint, to: MapPoint): number | null {
  const ok = (p: MapPoint) => Number.isFinite(p.lat) && Math.abs(p.lat) <= MAX_ORIGIN_LATITUDE_DEG && Number.isFinite(p.lng)
  if (!ok(from) || !ok(to)) return null
  const enu = geodeticToEnu(onEllipsoid(from), onEllipsoid(to))
  return Math.hypot(enu.east, enu.north)
}

/**
 * The one-sigma error of a bearing taken from two clicks `baselineM` apart, degrees: `sqrt(2) x clickSigmaM / B` radians
 * (two independent clicks, each `clickSigmaM` per axis; R6 section 6.3 prints the table), and no less than the floor of
 * the kind of baseline it is: {@link BEARING_SIGMA_FLOOR_EDGE_DEG} from a baseline of {@link SHORT_BASELINE_MAX_M} or
 * more, {@link BEARING_SIGMA_FLOOR_SHORT_BASELINE_DEG} from a shorter one. 1 to 3 m at 0.3 m gives 24 to 8 degrees before
 * the floor. Null for a baseline or a click noise that is not a positive number. The map editor calls it before it writes
 * the record, and shows it live.
 */
export function predictedBearingSigmaDeg(baselineM: number, clickSigmaM: number = DEFAULT_CLICK_SIGMA_M): number | null {
  if (!Number.isFinite(baselineM) || baselineM <= 0 || !Number.isFinite(clickSigmaM) || clickSigmaM <= 0) return null
  const geometric = ((Math.SQRT2 * clickSigmaM) / baselineM) * RAD_TO_DEG
  const floor = baselineM >= SHORT_BASELINE_MAX_M ? BEARING_SIGMA_FLOOR_EDGE_DEG : BEARING_SIGMA_FLOOR_SHORT_BASELINE_DEG
  return Math.max(geometric, floor)
}

/**
 * How far from where the georeference puts it a point `rM` metres from the Place origin may be, metres (R68): the origin's
 * radius and the bearing's sigma turned through the distance, `sqrt(accuracy^2 + (r x sigma_b)^2)` (R6 section 6.3; the
 * two are independent, and the small-angle form is within about 7%). At the origin it is the origin's accuracy. Null for a
 * distance that is not a number.
 */
export function accuracyAt(
  georef: { origin: Pick<GeoreferenceOrigin, 'accuracyM'>; bearingAccuracyDeg: number },
  rM: number,
): number | null {
  if (!Number.isFinite(rM)) return null
  return Math.hypot(georef.origin.accuracyM, Math.abs(rM) * georef.bearingAccuracyDeg * DEG_TO_RAD)
}

/**
 * The true bearing of a Place frame's +Z, from one session's: the session's +Z has true bearing `sessionBearingDeg`
 * (`B_Z`, from the compass and the camera pose, plus the declination), and the Place frame's +Z has session yaw
 * `atan2(m[2], m[10])` where `m` is that session's `sessionToProject` (column-major): the third row of its rotation is the
 * Place +Z axis written in session coordinates. So `b = B_Z - atan2(m[2], m[10])`. On a two-point frame that yaw is
 * `twoPointHeadingDeg(landmark, marker)`, `b = B_Z - atan2(H.x - L.x, H.z - L.z)` (R6 section 1.3 rule 7). Null for a
 * bearing or a matrix that does not give a number.
 */
export function projectBearingFromSession(sessionBearingDeg: number, sessionToProject: readonly number[]): number | null {
  if (!Number.isFinite(sessionBearingDeg) || sessionToProject.length !== 16) return null
  const x = sessionToProject[2]!
  const z = sessionToProject[10]!
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) < 1e-9) return null
  return normaliseBearingDeg(sessionBearingDeg - Math.atan2(x, z) * RAD_TO_DEG)
}

/**
 * A horizontal offset in a right-handed y-up frame whose +Z has true bearing `bearingDeg`, as east and north metres. A
 * session frame or a Place frame, alike: `E = z sin b - x cos b`, `N = z cos b + x sin b` (R6 section 2, checked against a
 * physical model to 1e-14). It is how a point in a frame is turned into a ground offset, and how a lever arm is.
 */
export function frameOffsetToEnu(bearingDeg: number, x: number, z: number): { east: number; north: number } {
  const b = bearingDeg * DEG_TO_RAD
  return { east: z * Math.sin(b) - x * Math.cos(b), north: z * Math.cos(b) + x * Math.sin(b) }
}

// ─── GeoPose export ──────────────────────────────────────────────────────────

/**
 * What an OGC GeoPose 1.0 Basic-Quaternion pose has to hold, from the schema `GeoPose.Basic.Quaternion.Schema.json` at
 * https://schemas.opengis.net/geopose/1.0/schemata/ (the Basic-Quaternion file, dated 2025-04-09, as the research recorded
 * it; the Basic-YPR, Basic-Euler and strict variants have other required fields): `position` with `lat`, `lon` and `h`,
 * and `quaternion` with `x`, `y`, `z` and `w`, all numbers. The strict variant adds `additionalProperties: false`, which
 * is why the accuracy and provenance travel beside the pose and not in it.
 */
export interface GeoPoseBasicQuaternion {
  position: { lat: number; lon: number; h: number }
  quaternion: { x: number; y: number; z: number; w: number }
}

export interface GeoPoseExport {
  /** The pose itself: valid against the Basic-Quaternion schema, and against its strict variant. */
  geopose: GeoPoseBasicQuaternion
  /** What the schema has no room for. */
  meta: {
    /** Horizontal accuracy of the position, metres (R68). */
    horizontalM68: number
    /** One standard deviation of the heading, degrees. */
    bearingDeg1sigma: number
    source: GeoreferenceSource
    /** `'ellipsoid'`: `h` is the origin's ellipsoidal height. `'nominal'`: no height is known, `h` is 0 and means nothing. */
    hSource: 'ellipsoid' | 'nominal'
    /** Whether a person confirmed the registration. */
    confirmed: boolean
    /** What the pose is the pose of: the Place frame's origin and axes, which no GeoPose field says. */
    objectFrame: string
  }
}

/** The object frame of an exported pose, as text, so the file says what its quaternion turns. */
export const GEOPOSE_OBJECT_FRAME =
  'Place frame: origin at the landmark on the floor; X = Place +X, Y = Place -Z (forward), Z = Place +Y (up); '
  + 'identity is plain ENU (x east, y north, z up); the Place +Z axis has the bearing of the georeference'

/** A longitude wrapped into [-180, 180]. One already in range is returned as it is: the arithmetic of a wrap would move its last bits. */
export function wrapLongitudeDeg(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

/**
 * A georeference as an OGC GeoPose Basic-Quaternion, with the accuracy and provenance beside it (R6 section 5.3).
 *
 * The object frame is the Place frame turned so that X is the Place's +X, Y its -Z and Z its +Y: with the Place's +Z at
 * true bearing `b`, that is yaw `psi = 180 - b` degrees counter-clockwise from east, pitch 0, roll 0, and the quaternion
 * is `(0, 0, sin(psi/2), cos(psi/2))`. `b = 180` is the identity, `b = 90` is (0, 0, 0.7071, 0.7071), `b = 0` is (0, 0, 1, 0).
 * `h` is the ellipsoidal height when the record has one and 0 when it has none, flagged `'nominal'` in `meta`: an MSL
 * altitude is never exported as `h`. The Basic-Quaternion class is used because its rotation is unambiguous (the YPR sign
 * is not stated in the normative text R6 read), and the community's reading of GeoPose agrees on the sign (yaw 90 is
 * (0, 0, 0.7071, 0.7071)).
 *
 * **GeoPose export is off by default** (docs/adr/0015): an export asks for it.
 */
export function toGeoPoseBasicQuaternion(georef: ProjectGeoreference): GeoPoseExport {
  const psi = (180 - georef.bearingDeg) * DEG_TO_RAD
  const hasHeight = georef.origin.altitudeM !== null && georef.heightDatum === 'ellipsoid'
  return {
    geopose: {
      position: {
        lat: georef.origin.lat,
        lon: wrapLongitudeDeg(georef.origin.lng),
        h: hasHeight ? georef.origin.altitudeM as number : 0,
      },
      quaternion: { x: 0, y: 0, z: Math.sin(psi / 2), w: Math.cos(psi / 2) },
    },
    meta: {
      horizontalM68: georef.origin.accuracyM,
      bearingDeg1sigma: georef.bearingAccuracyDeg,
      source: georef.source,
      hSource: hasHeight ? 'ellipsoid' : 'nominal',
      confirmed: isConfirmedGeoreference(georef),
      objectFrame: GEOPOSE_OBJECT_FRAME,
    },
  }
}

// ─── The block an export carries ─────────────────────────────────────────────

/** What a glTF's scene extras and a Companion Memory event say about where the Place is: the same block in both. */
export interface GeoreferenceBlock {
  crs: 'WGS84'
  origin: { lat: number; lng: number; altitudeM: number | null }
  heightDatum: 'ellipsoid' | 'unknown'
  /** TRUE bearing of the Place frame's +Z axis, degrees clockwise from true north. */
  bearingDeg: number
  /** What `bearingDeg` is the bearing of, and what the scene's axes are, in words. */
  convention: string
  accuracy: { positionM: number; bearingDeg: number }
  source: GeoreferenceSource
  /** When a person confirmed it, or null: a registration nobody confirmed is approximate. */
  confirmedAt: string | null
  georefVersion: number
  anchorRef: string | null
}

/** The sentence every block carries so a consumer reads the bearing and the axes as they are. */
export const GEOREFERENCE_CONVENTION =
  'bearingDeg is the true bearing (degrees clockwise from true north) of the Place frame +Z axis; '
  + 'scene axes: x east, y up, z south (scene = east, up, -north); the scene origin is the origin point'

/**
 * The block an export carries for a Place's georeference, or `null`, written explicitly: a Place with no georeference
 * says so, and a consumer must not read its coordinates as geographic. `georefVersion` is the version the record was
 * stored at (`Project.georefVersion`).
 */
export function georeferenceBlock(georef: ProjectGeoreference | null | undefined, georefVersion: number): GeoreferenceBlock | null {
  if (!georef) return null
  return {
    crs: 'WGS84',
    origin: { lat: georef.origin.lat, lng: georef.origin.lng, altitudeM: georef.origin.altitudeM },
    heightDatum: georef.heightDatum,
    bearingDeg: georef.bearingDeg,
    convention: GEOREFERENCE_CONVENTION,
    accuracy: { positionM: georef.origin.accuracyM, bearingDeg: georef.bearingAccuracyDeg },
    source: georef.source,
    confirmedAt: georef.confirmedAt ?? null,
    georefVersion,
    anchorRef: georef.anchorRef,
  }
}

// ─── Seeds: what a phone's fix and compass say, approximately ────────────────

/** A mean resultant below this is angles that cancel: sin and cos of opposite angles sum to about 1e-16, not 0. A numerical guard, not a threshold of evidence. */
const CANCELLED_RESULTANT = 1e-9

/** The circular mean of angles in degrees, with how tightly they cluster. */
export interface CircularStats {
  /** The mean direction, degrees in [0, 360). */
  meanDeg: number
  /** The length of the mean resultant vector, 0 to 1: 1 when every angle is the same, 0 when they cancel. */
  resultant: number
  /** The circular standard deviation, degrees: `sqrt(-2 ln R)`. Infinite when the angles cancel. */
  sdDeg: number
  count: number
}

/**
 * The circular mean and standard deviation of angles in degrees. A mean of 359 and 1 is 0, not 180, which is why a seed is
 * not an arithmetic average. Null for no angles, or any that is not a number.
 */
export function circularStats(anglesDeg: readonly number[]): CircularStats | null {
  if (anglesDeg.length === 0 || !anglesDeg.every(Number.isFinite)) return null
  let s = 0
  let c = 0
  for (const a of anglesDeg) {
    s += Math.sin(a * DEG_TO_RAD)
    c += Math.cos(a * DEG_TO_RAD)
  }
  const n = anglesDeg.length
  const resultant = Math.min(1, Math.hypot(s, c) / n)
  // Angles that cancel leave a resultant of a few 1e-17 and not a clean 0: below the bound there is no direction to a spread.
  const sd = resultant < CANCELLED_RESULTANT ? Infinity : Math.abs(Math.sqrt(-2 * Math.log(resultant)) * RAD_TO_DEG)
  return { meanDeg: normaliseBearingDeg(Math.atan2(s, c) * RAD_TO_DEG), resultant, sdDeg: sd, count: n }
}

/** One reading of the session's +Z bearing, taken while the phone moved or did not. */
export interface BearingSample {
  /** Seconds since the walk began. */
  tS: number
  /** The TRUE bearing of the session's +Z axis at this sample, degrees: the compass and the pose, plus the declination. */
  bearingDeg: number
  /** How fast the camera was turning, degrees per second, or null when it could not be told (the first sample). */
  rateDegS: number | null
}

export interface BearingSeed {
  /** Circular mean of the steady samples, degrees in [0, 360). */
  bearingDeg: number
  /** Their circular standard deviation, degrees. */
  spreadDeg: number
  /** `max(spreadDeg, floor)`: what a record made from this may claim. */
  sigmaDeg: number
  /** How many steady samples there were. */
  samples: number
  /** How long they span, seconds. */
  spanS: number
}

/**
 * Whether a sample is steady: the camera was turning slower than {@link STEADY_ROTATION_RATE_DEG_S}. A sample with no rate is
 * not (the first one has nothing to compare), and neither is one whose numbers are not numbers.
 */
function isSteady(s: BearingSample): boolean {
  return Number.isFinite(s.bearingDeg) && Number.isFinite(s.tS) && s.rateDegS !== null && Number.isFinite(s.rateDegS) && s.rateDegS < STEADY_ROTATION_RATE_DEG_S
}

/**
 * A session's compass samples as they arrive, kept as sums so a long walk costs no memory: the circular mean of the steady ones,
 * with their spread. A phone reads the session's +Z bearing a few times a second for as long as the scan lasts, and the mean is
 * wanted at the end; `bearingSeedFromSamples` is this over a list.
 *
 * The readings may be magnetic: a declination is one angle for the whole place, so it shifts the mean and leaves the spread
 * alone, and `seed` adds it at the end (`offsetDeg`) instead of turning every sample.
 */
export class BearingAccumulator {
  private sinSum = 0
  private cosSum = 0
  private n = 0
  private tMin = Infinity
  private tMax = -Infinity

  /** Takes one sample if it is steady; says whether it did. */
  add(sample: BearingSample): boolean {
    if (!isSteady(sample)) return false
    this.sinSum += Math.sin(sample.bearingDeg * DEG_TO_RAD)
    this.cosSum += Math.cos(sample.bearingDeg * DEG_TO_RAD)
    this.n += 1
    this.tMin = Math.min(this.tMin, sample.tS)
    this.tMax = Math.max(this.tMax, sample.tS)
    return true
  }

  /** How many steady samples have been taken. */
  get count(): number {
    return this.n
  }

  clear(): void {
    this.sinSum = 0
    this.cosSum = 0
    this.n = 0
    this.tMin = Infinity
    this.tMax = -Infinity
  }

  /**
   * The seed: needs {@link MIN_BEARING_SAMPLES} steady samples over at least {@link STEADY_MIN_SPAN_S} seconds, or there is no
   * bearing, never a worse one. `sigmaDeg` is the spread and no less than `sigmaFloorDeg` ({@link BEARING_SIGMA_FLOOR_SEED_DEG}, or
   * {@link BEARING_SIGMA_FLOOR_SEED_IOS_DEG} on an iPhone). `offsetDeg` is added to the mean: the declination, east positive, when
   * the samples were magnetic.
   */
  seed(sigmaFloorDeg: number = BEARING_SIGMA_FLOOR_SEED_DEG, offsetDeg = 0): BearingSeed | null {
    if (this.n < MIN_BEARING_SAMPLES) return null
    const spanS = this.tMax - this.tMin
    if (spanS < STEADY_MIN_SPAN_S) return null
    const resultant = Math.min(1, Math.hypot(this.sinSum, this.cosSum) / this.n)
    if (resultant < CANCELLED_RESULTANT) return null
    const spread = Math.abs(Math.sqrt(-2 * Math.log(resultant)) * RAD_TO_DEG)
    return {
      bearingDeg: normaliseBearingDeg(Math.atan2(this.sinSum, this.cosSum) * RAD_TO_DEG + offsetDeg),
      spreadDeg: spread,
      sigmaDeg: Math.max(spread, sigmaFloorDeg),
      samples: this.n,
      spanS,
    }
  }
}

/**
 * A session's bearing from a list of its compass samples: the circular mean of the steady ones, with their spread
 * ({@link BearingAccumulator}). Null when there are too few of them, or they span too little time, or they cancel.
 */
export function bearingSeedFromSamples(samples: readonly BearingSample[], sigmaFloorDeg: number = BEARING_SIGMA_FLOOR_SEED_DEG): BearingSeed | null {
  const accumulator = new BearingAccumulator()
  for (const sample of samples) accumulator.add(sample)
  return accumulator.seed(sigmaFloorDeg)
}

/** A position fix taken during a walk, with where the camera was in the session at that moment. */
export interface SeedFix {
  lat: number
  lng: number
  /** Horizontal accuracy as the phone reports it, metres. */
  accuracyM: number
  /** Height as the platform reports it: no datum is assumed and none is used. */
  altitudeM: number | null
  /** Seconds since the walk began. */
  tS: number
  /** The camera's position in the session at that moment (x and z), when it is known: what the lever arm is made of. */
  sessionX: number | null
  sessionZ: number | null
}

/**
 * The fix a seed takes its position from: the one with the best accuracy in the first {@link SEED_FIX_WINDOW_S} seconds of
 * the walk, not a mean (fixes are correlated in time, and averaging twenty of them is not a square-root-of-twenty gain; R6
 * section 4.4). Fixes with no usable accuracy (zero or below, or worse than {@link SEED_FIX_MAX_ACCURACY_M}), or outside
 * the window, are dropped. The earlier of two equally accurate fixes wins, being nearer the session's origin. Null when
 * none is left.
 */
export function bestFixInWindow(fixes: readonly SeedFix[]): SeedFix | null {
  let best: SeedFix | null = null
  for (const fix of fixes) {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || Math.abs(fix.lat) > MAX_ORIGIN_LATITUDE_DEG) continue
    if (!Number.isFinite(fix.accuracyM) || fix.accuracyM <= 0 || fix.accuracyM > SEED_FIX_MAX_ACCURACY_M) continue
    if (!Number.isFinite(fix.tS) || fix.tS < 0 || fix.tS > SEED_FIX_WINDOW_S) continue
    if (best === null || fix.accuracyM < best.accuracyM || (fix.accuracyM === best.accuracyM && fix.tS < best.tS)) best = fix
  }
  return best
}

/**
 * The R68 radius a seed's origin carries, metres, from the accuracy the phone reported (R6 section 4.4 step 4):
 * `max(reported, 10)` when it reported 10 m or better ({@link ORIGIN_ACCURACY_FLOOR_SEED_M}), and
 * `max(reported x 1.5, 25)` when it reported worse ({@link SEED_ORIGIN_ACCURACY_WORSE_FACTOR},
 * {@link SEED_ORIGIN_ACCURACY_WORSE_FLOOR_M}), because a phone's own figure is a claim and indoors it is optimistic. The step
 * between the two is the research's, adopted, not measured: a fix of 10.1 m is not better known than one of 10 m, and the rule
 * still treats it as 2.5 times as uncertain.
 */
export function seedOriginAccuracyM(reportedM: number): number {
  return reportedM <= ORIGIN_ACCURACY_FLOOR_SEED_M
    ? ORIGIN_ACCURACY_FLOOR_SEED_M
    : Math.max(reportedM * SEED_ORIGIN_ACCURACY_WORSE_FACTOR, SEED_ORIGIN_ACCURACY_WORSE_FLOOR_M)
}

/** One scan's estimate of a Place's bearing, as the seed across scans reads it. */
export interface ScanBearingEstimate {
  /** The TRUE bearing of the Place frame's +Z from this scan's compass and its `sessionToProject` ({@link projectBearingFromSession}). */
  bearingDeg: number
  /** The least sigma a seed from this scan may claim: 25 on an iPhone, 15 elsewhere. */
  sigmaFloorDeg: number
}

export interface PlaceBearingSeed {
  /** The circular mean over the scans, degrees in [0, 360). */
  bearingDeg: number
  /** Their circular standard deviation, degrees. */
  spreadDeg: number
  /** `max(spreadDeg, the largest floor among the scans)`: what the record may claim. */
  sigmaDeg: number
  scans: number
  /** Fewer than {@link SEED_MIN_SCANS_FOR_CONFIDENCE} scans, or a spread over {@link SEED_MAX_CONFIDENT_SPREAD_DEG}. */
  lowConfidence: boolean
}

/**
 * A Place's bearing seed from many scans: the circular mean of each scan's estimate, with the spread across them, and a
 * sigma no smaller than the largest floor among them (a Place with one iPhone scan is held to 25). The scans share a
 * building and its magnetic field, so their agreement is not independent evidence: the floor is what guards against a
 * tight spread read as a small error. Null for no estimates, or one that is not a number.
 */
export function placeBearingSeed(estimates: readonly ScanBearingEstimate[]): PlaceBearingSeed | null {
  if (estimates.length === 0 || !estimates.every((e) => Number.isFinite(e.bearingDeg) && Number.isFinite(e.sigmaFloorDeg))) return null
  const stats = circularStats(estimates.map((e) => e.bearingDeg))
  if (!stats) return null
  const floor = Math.max(BEARING_SIGMA_FLOOR_SEED_DEG, ...estimates.map((e) => e.sigmaFloorDeg))
  const spread = Number.isFinite(stats.sdDeg) ? stats.sdDeg : BEARING_SIGMA_MAX_DEG
  return {
    bearingDeg: stats.meanDeg,
    spreadDeg: spread,
    sigmaDeg: Math.min(BEARING_SIGMA_MAX_DEG, Math.max(spread, floor)),
    scans: estimates.length,
    lowConfidence: estimates.length < SEED_MIN_SCANS_FOR_CONFIDENCE || spread > SEED_MAX_CONFIDENT_SPREAD_DEG,
  }
}

/**
 * The magnetic declination at a place and a date as a georeference records it, or null when the model has no value there
 * (a date outside WMM2025's years, or NOAA's blackout zone near a magnetic pole): a record that used a compass says what it
 * added, and one with no declination says none was available. Never throws: a position that is not a number in range is null.
 */
export function declinationRecord(lat: number, lng: number, date: Date): { deg: number; model: 'WMM2025'; year: number } | null {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || !Number.isFinite(date?.getTime?.())) return null
  const result = declinationDeg(lat, lng, 0, date)
  if (result.declinationDeg === null) return null
  return { deg: result.declinationDeg, model: DECLINATION_MODEL as 'WMM2025', year: decimalYear(date) }
}

// ─── Building a record ───────────────────────────────────────────────────────

export interface GeoreferenceInput {
  lat: number
  lng: number
  /** Ellipsoidal height, or null. Never a phone's `coords.altitude`. */
  altitudeM?: number | null
  originAccuracyM: number
  bearingDeg: number
  bearingAccuracyDeg: number
  source: GeoreferenceSource
  declination?: { deg: number; model: 'WMM2025'; year: number } | null
  seed?: Record<string, unknown> | null
  /** The `frameId` of the Place frame this is made against, or null when the frame has none. */
  anchorRef: string | null
  /** When it is made. */
  now: Date
  /** Whether a person pressed Confirm: only then does the record carry `confirmedAt`. */
  confirmed: boolean
}

/**
 * A georeference from what a writer holds. The bearing is folded into [0, 360), a null height is unknown and a number is
 * ellipsoidal, and `confirmedAt` is set only when `confirmed` is true: a seed is never confirmed by being built. Not
 * validated: `validateGeoreference` is what decides whether it may be stored.
 */
export function buildGeoreference(input: GeoreferenceInput): ProjectGeoreference {
  const altitudeM = typeof input.altitudeM === 'number' ? input.altitudeM : null
  const at = input.now.toISOString()
  return {
    origin: { lat: input.lat, lng: input.lng, altitudeM, accuracyM: input.originAccuracyM },
    heightDatum: altitudeM === null ? 'unknown' : 'ellipsoid',
    // A bearing already in range is stored as it was given: folding it through `+ 360` would put float noise on a number a person typed.
    bearingDeg: input.bearingDeg >= 0 && input.bearingDeg < 360 ? input.bearingDeg : normaliseBearingDeg(input.bearingDeg),
    bearingAccuracyDeg: input.bearingAccuracyDeg,
    convention: 2,
    datum: 'WGS84',
    source: input.source,
    ...(input.declination ? { declination: input.declination } : {}),
    ...(input.seed ? { seed: input.seed } : {}),
    registeredAt: at,
    ...(input.confirmed ? { confirmedAt: at } : {}),
    anchorRef: input.anchorRef,
  }
}
