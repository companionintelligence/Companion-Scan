/**
 * What a Place's scans say, together, about where it is and which way it faces: the compass estimate the Place location
 * panel offers ("Use compass estimate from N scans"), and `GET /projects/:id/georeference-seed` serves.
 *
 * Deno-API-free like ./world_origin.ts (ADR 0004). It reads sidecars (the nested `geoSession` of src/world/geo-session.ts, the
 * `projectTransform`, the calibration tier) and answers with numbers and how sure they are; it writes nothing. A seed is
 * **approximate** (ADR 0015): the compass is magnetic and indoors it is off by tens of degrees, the phone's fix by 10 to 50 m,
 * and none of it is checked against anything. The panel offers it as a starting point and says so, and a record made from it
 * is `source: 'gps-compass'` with no `confirmedAt` until a person confirms it.
 *
 * ## How the estimate is made
 *
 *  - Which scans. Those calibrated in the Place's frame (`inPlaceFrame`: the tier the Place's frame was made with, and a frame
 *    generation that is the Place's or unknown), with a matrix that is a `sessionToProject`, and a session bearing from steady
 *    compass samples. A one-point scan of a two-point Place is in another frame, and a scan of a replaced frame is in the old one.
 *  - The bearing. Each scan's own estimate of the Place's +Z, `B_Z - atan2(m[2], m[10])` (`projectBearingFromSession`), then the
 *    circular mean across scans with their circular spread, and `bearingAccuracyDeg = max(spread, 15)`, 25 if any is an iPhone
 *    (`placeBearingSeed`). Low confidence is said when there are fewer than three scans or the spread is over 30 degrees.
 *  - The origin. Each scan's fix is the phone's position at some moment of the first minute, not the Place's landmark: the
 *    landmark is where the session's frame has its origin on the floor, so the camera's position at the fix and the landmark's
 *    session position give the offset between them, turned into east and north by the scan's own bearing
 *    (`frameOffsetToEnu`). The scan with the best accuracy gives the origin: the best fix, not a mean (fixes are correlated in
 *    time), with `seedOriginAccuracyM` of its accuracy, plus the bearing's error at the length of the offset when that is over 3 m.
 *  - The declination. The one the scans were corrected by, which they record.
 */
import { enuToGeodetic } from '../../src/world/enu.ts'
import { hasGeoPose } from '../../src/world/geo.ts'
import { GEO_SESSION_KEY, parseGeoSession } from '../../src/world/geo-session.ts'
import {
  BEARING_SIGMA_FLOOR_SEED_DEG,
  BEARING_SIGMA_FLOOR_SEED_IOS_DEG,
  type FrameMethod,
  frameOffsetToEnu,
  inPlaceFrame,
  LEVER_ARM_MIN_M,
  placeBearingSeed,
  type PlaceBearingSeed,
  projectBearingFromSession,
  SEED_FIX_MAX_ACCURACY_M,
  seedOriginAccuracyM,
} from '../../src/world/georef.ts'
import type { GeoPose, Project } from '../../src/world/types.ts'
import { asCalibrationMethod, calibrationFromMeta } from '../calibration_fields.ts'

const DEG_TO_RAD = Math.PI / 180

export interface SeedScan {
  filename: string
  meta: Record<string, unknown>
}

export interface SeedHost {
  geoPoseFor: (meta: Record<string, unknown>) => GeoPose
  matrixFor: (value: unknown) => number[] | null
}

export interface GeoreferenceSeed {
  /** The bearing of the Place frame's +Z from the compass, or null when no scan can give one. */
  bearing: (Pick<PlaceBearingSeed, 'spreadDeg' | 'sigmaDeg' | 'scans' | 'lowConfidence'> & { deg: number }) | null
  /** The Place's landmark as a phone's fix puts it, or null when no scan has a usable fix with the camera's position at it. */
  origin: { lat: number; lng: number; accuracyM: number } | null
  /** The declination the scans' bearings were corrected by, east positive, or null when none recorded one. */
  declination: { deg: number; model: 'WMM2025'; year: number } | null
  /** How many scans of the Place the seed looked at. */
  considered: number
  /** How many gave a bearing. */
  used: number
}

/** The session position of the Place's landmark, from a scan's `sessionToProject`: the project origin taken back through it. x and z only. */
function landmarkInSession(m: readonly number[]): { x: number; z: number } {
  const tx = m[12]!
  const ty = m[13]!
  const tz = m[14]!
  return {
    x: -(m[0]! * tx + m[1]! * ty + m[2]! * tz),
    z: -(m[8]! * tx + m[9]! * ty + m[10]! * tz),
  }
}

/** The seed from a Place's scans (every stored scan whose sidecar names that Place): see the header for what is and is not used. */
export function georeferenceSeedFromScans(
  place: Pick<Project, 'spatialFrame'> | null | undefined,
  scans: readonly SeedScan[],
  host: SeedHost,
): GeoreferenceSeed {
  const frame = place?.spatialFrame as { method?: unknown; frameId?: unknown } | undefined
  const frameMethod: FrameMethod | null = frame?.method === 'two-point-ground' || frame?.method === 'ground-tap-compass' ? frame.method : null
  const frameId = typeof frame?.frameId === 'string' ? frame.frameId : null

  const estimates: Array<{ bearingDeg: number; sigmaFloorDeg: number }> = []
  const declinations: Array<{ deg: number; year: number }> = []
  let origin: GeoreferenceSeed['origin'] = null
  const sigmaOf = (floor: number, spread: number) => Math.max(floor, spread)

  for (const { meta } of scans) {
    const projectTransform = host.matrixFor(meta['projectTransform'])
    if (!projectTransform) continue
    if (!inPlaceFrame(asCalibrationMethod(meta['calibrationMethod']), frameMethod, { scan: calibrationFromMeta(meta).calibrationFrameId, place: frameId })) continue

    const session = parseGeoSession(meta[GEO_SESSION_KEY])
    const bearing = session?.bearing
    if (!session || !bearing) continue
    const b = projectBearingFromSession(bearing.deg, projectTransform)
    if (b === null) continue
    const floor = bearing.source === 'ios-compass' ? BEARING_SIGMA_FLOOR_SEED_IOS_DEG : BEARING_SIGMA_FLOOR_SEED_DEG
    estimates.push({ bearingDeg: b, sigmaFloorDeg: floor })
    if (session.declination) declinations.push(session.declination)

    // The fix, as the Place's landmark: needs the camera's position at the fix and a usable accuracy.
    const geo = host.geoPoseFor(meta)
    const fix = session.fix
    if (!fix || fix.sessionX === null || fix.sessionZ === null || !hasGeoPose(geo)) continue
    const accuracy = geo.accuracyM
    if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy <= 0 || accuracy > SEED_FIX_MAX_ACCURACY_M) continue
    const landmark = landmarkInSession(projectTransform)
    const dx = landmark.x - fix.sessionX
    const dz = landmark.z - fix.sessionZ
    const offset = frameOffsetToEnu(bearing.deg, dx, dz)
    const length = Math.hypot(dx, dz)
    let uncertainty = seedOriginAccuracyM(accuracy)
    if (length > LEVER_ARM_MIN_M) uncertainty = Math.hypot(uncertainty, length * sigmaOf(floor, bearing.spreadDeg) * DEG_TO_RAD)
    if (origin === null || uncertainty < origin.accuracyM) {
      const at = enuToGeodetic({ lat: geo.lat, lng: geo.lng, altitudeM: 0 }, { east: offset.east, north: offset.north, up: 0 })
      origin = { lat: at.lat, lng: at.lng, accuracyM: uncertainty }
    }
  }

  const seed = placeBearingSeed(estimates)
  const used = estimates.length
  const declination = declinations.length === 0
    ? null
    : {
      deg: declinations.reduce((sum, d) => sum + d.deg, 0) / declinations.length,
      model: 'WMM2025' as const,
      year: Math.max(...declinations.map((d) => d.year)),
    }
  return {
    bearing: seed ? { deg: seed.bearingDeg, spreadDeg: seed.spreadDeg, sigmaDeg: seed.sigmaDeg, scans: seed.scans, lowConfidence: seed.lowConfidence } : null,
    origin,
    declination,
    considered: scans.length,
    used,
  }
}
