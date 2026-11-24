/**
 * What a capture session says about where it was and which way it faced: the sample-based replacement for the one
 * GPS and compass snapshot an export used to take.
 *
 * The phone writes it into the upload sidecar (`geoSession`, src/export/gltf.ts) and the server reads it when it places
 * a scan that has no calibration (server/world/world_origin.ts). Pure and browser-safe (ADR 0002): this file is the
 * contract between the two, so neither side holds a copy of the other's shape.
 *
 * ## Why not a snapshot
 *
 * The earlier export read `GeoTracker.snapshot()` at the moment of export, wherever the person then stood and however
 * the phone was then held. Its position is the export spot's (not the walk's start), its altitude is a platform's mean
 * sea level or ellipsoid with no telling which, and its heading is the phone's own at that moment and not the heading
 * of the session's axes. A session records instead, as it goes (src/geo/session-seed.ts):
 *
 *  - the fix with the best accuracy in the first minute of the walk, with the camera's position in the session at that
 *    moment, so the distance the phone had moved from the session's origin can be corrected (the lever arm);
 *  - the circular mean, with its spread, of the TRUE bearing of the session's +Z from steady compass readings, each
 *    taken with the AR pose at the same instant, and the declination that turned magnetic into true.
 *
 * The position itself stays where it always was, in `geoLat`, `geoLng`, `geoAccuracy`, `geoAltitudeM` and `geoFixedAt`,
 * now holding that best fix. This record holds what those have no room for.
 *
 * A sidecar without `geoSession` is one the previous build wrote. It has a fix, a device heading that is not the
 * session's, and no way to tell either's age: the server places it on the grid in a world that has the scene
 * convention (docs/adr/0015-scene-convention-and-georeference.md), and as it always did in one that does not.
 */

/** The version of the record. A reader refuses one it does not know. */
export const GEO_SESSION_VERSION = 1

/** Where the record lives in a sidecar. */
export const GEO_SESSION_KEY = 'geoSession'

/** What a seed's bearing was read from. */
export type GeoSessionCompass = 'ios-compass' | 'android-absolute'

export interface GeoSessionBearing {
  /** The circular mean of the steady samples, the TRUE bearing of the session's +Z, degrees in [0, 360). */
  deg: number
  /** Their circular standard deviation, degrees. */
  spreadDeg: number
  /** `max(spreadDeg, the floor of the platform)`: what a placement from this may claim, degrees. */
  sigmaDeg: number
  /** How many steady samples. */
  samples: number
  /** The time they span, seconds. */
  spanS: number
  /** Which platform's compass, or null when the phone did not say. */
  source: GeoSessionCompass | null
}

export interface GeoSession {
  v: typeof GEO_SESSION_VERSION
  /** When the walk's sampling began, an ISO time: what a fix's age is measured from. */
  startedAt: string
  /**
   * The fix the position fields hold, or null when none arrived in the first minute (the position fields then hold the phone's last one,
   * which the server uses only when it was taken no more than 60 s before the walk began: a fix from after the first minute is where the
   * phone had walked to, and nothing here carries it back to the session's origin, so the scan stands on the grid).
   */
  fix: {
    /** Seconds from `startedAt` to the fix. */
    offsetS: number
    /** The camera's position in the session at that moment (x and z), when the pose was known. */
    sessionX: number | null
    sessionZ: number | null
  } | null
  /** The session's +Z true bearing, or null when there were too few steady samples or no declination. */
  bearing: GeoSessionBearing | null
  /** The declination the bearing's samples were turned by, east positive, or null when the model had no value there. */
  declination: { deg: number; model: 'WMM2025'; year: number } | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const finiteOrNull = (value: unknown): number | null => (finite(value) ? value : null)

/**
 * The record a sidecar holds, or null when it holds none or what it holds is not one this reader understands. Every
 * field is read defensively: a sidecar can be hand-edited, truncated, or written by a later build, and a field that is not
 * what its type says is left out, never trusted. A bearing that is not a number in [0, 360) or whose spread is negative
 * or not a number is no bearing at all, because a placement made from half a record would be a claim nothing backs
 * (ADR 0005 rule 3).
 */
export function parseGeoSession(value: unknown): GeoSession | null {
  if (!isObject(value) || value['v'] !== GEO_SESSION_VERSION) return null
  const startedAt = value['startedAt']
  if (typeof startedAt !== 'string' || !ISO_DATE.test(startedAt) || !Number.isFinite(Date.parse(startedAt))) return null

  let fix: GeoSession['fix'] = null
  const rawFix = value['fix']
  if (isObject(rawFix) && finite(rawFix['offsetS']) && rawFix['offsetS'] >= 0) {
    fix = { offsetS: rawFix['offsetS'], sessionX: finiteOrNull(rawFix['sessionX']), sessionZ: finiteOrNull(rawFix['sessionZ']) }
    // A position in the session is a pair or it is nothing: one coordinate of a lever arm is not a correction.
    if (fix.sessionX === null || fix.sessionZ === null) fix = { offsetS: fix.offsetS, sessionX: null, sessionZ: null }
  }

  let bearing: GeoSessionBearing | null = null
  const rawBearing = value['bearing']
  if (
    isObject(rawBearing) && finite(rawBearing['deg']) && rawBearing['deg'] >= 0 && rawBearing['deg'] < 360
    && finite(rawBearing['spreadDeg']) && rawBearing['spreadDeg'] >= 0
    && finite(rawBearing['sigmaDeg']) && rawBearing['sigmaDeg'] >= rawBearing['spreadDeg']
    && finite(rawBearing['samples']) && Number.isInteger(rawBearing['samples']) && rawBearing['samples'] >= 1
    && finite(rawBearing['spanS']) && rawBearing['spanS'] >= 0
  ) {
    const source = rawBearing['source']
    bearing = {
      deg: rawBearing['deg'],
      spreadDeg: rawBearing['spreadDeg'],
      sigmaDeg: rawBearing['sigmaDeg'],
      samples: rawBearing['samples'],
      spanS: rawBearing['spanS'],
      source: source === 'ios-compass' || source === 'android-absolute' ? source : null,
    }
  }

  let declination: GeoSession['declination'] = null
  const rawDeclination = value['declination']
  if (isObject(rawDeclination) && finite(rawDeclination['deg']) && Math.abs(rawDeclination['deg']) <= 90 && rawDeclination['model'] === 'WMM2025' && finite(rawDeclination['year'])) {
    declination = { deg: rawDeclination['deg'], model: 'WMM2025', year: rawDeclination['year'] }
  }
  // A true bearing is a magnetic one plus a declination: with none recorded there is no telling what north it counts from.
  if (declination === null) bearing = null

  return { v: GEO_SESSION_VERSION, startedAt, fix, bearing, declination }
}
