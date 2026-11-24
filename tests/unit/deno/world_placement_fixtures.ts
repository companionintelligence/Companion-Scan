/**
 * The scans the placement golden is made of (world_placement_golden.test.ts), and the same scans' sidecars as the
 * georeference tests re-use. Not a test file.
 *
 * Every scan is a sidecar as `uploadToServer` in src/export/gltf.ts writes it, which is what is already on disk for
 * every scan the previous build stored: the flat `geo*` fields of ONE fix taken at export, the flat calibration
 * summaries, and the nested `calibration` record. Coordinates are in London so that the exact ENU module and the
 * legacy sphere differ by a few centimetres at these offsets, and a test that swapped one for the other would see it.
 */
import { twoPointSeparationM, twoPointToProjectTransform } from '../../../src/world/geo.ts'

export const LANDMARK = { x: 1.5, y: -1.2, z: -0.4 }
export const HEADING_MARKER = { x: 3.1, y: -1.2, z: 1.9 }

/** What `twoPointToProjectTransform` gives for the two points above: the `projectTransform` of every calibrated fixture. */
export const PROJECT_TRANSFORM = twoPointToProjectTransform(LANDMARK, HEADING_MARKER)

/** One fix, as the phone's `GeoTracker.snapshot()` hands it to the export. */
export interface FixtureFix {
  lat: number | null
  lng: number | null
  accuracy: number | null
  altitudeM: number | null
  bearing: number | null
  fixedAt: string | null
}

export interface FixtureScan {
  name: string
  /** The sidecar. */
  meta: Record<string, unknown>
  /** The modification time of its files, ms: the server lists scans newest first by it. */
  mtimeMs: number
}

const EXPORTED_AT = '2026-11-01T10:05:00.000Z'
const FIXED_AT = '2026-11-01T10:04:50.000Z'

/** The sidecar of one scan: a fix (or none) and a calibration (or none). */
export function sidecarOf(name: string, fix: FixtureFix | null, calibration: Record<string, unknown> | null): Record<string, unknown> {
  return {
    detectionCount: 0,
    labels: [],
    detections: [],
    exportedAt: EXPORTED_AT,
    capturedAt: '2026-11-01T10:04:30.000Z',
    sessionId: null,
    scanName: name,
    projectId: null,
    areaId: null,
    floorId: null,
    roomId: null,
    projectTransform: (calibration?.['sessionToProject'] as number[] | undefined) ?? null,
    calibrationMethod: (calibration?.['method'] as string | undefined) ?? null,
    calibrationStatus: (calibration?.['status'] as string | undefined) ?? 'uncalibrated',
    calibration,
    autoSaved: false,
    pointCount: 1303,
    poseCount: 412,
    geoLat: fix?.lat ?? null,
    geoLng: fix?.lng ?? null,
    geoAltitudeM: fix?.altitudeM ?? null,
    geoAccuracy: fix?.accuracy ?? null,
    geoBearing: fix?.bearing ?? null,
    geoAddress: null,
    geoDisplayAddress: null,
    geoFixedAt: fix?.fixedAt ?? null,
  }
}

const TWO_POINT = {
  method: 'two-point-ground',
  sessionToProject: PROJECT_TRANSFORM,
  separationM: twoPointSeparationM(LANDMARK, HEADING_MARKER),
  residualM: 0.022,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'verified',
}

const ONE_POINT = {
  method: 'ground-tap-compass',
  sessionToProject: PROJECT_TRANSFORM,
  anchorBearingDeg: 40,
  calibratedAt: '2026-11-02T08:30:00.000Z',
  status: 'provisional',
}

const fix = (lat: number, lng: number, accuracy: number | null, altitudeM: number | null, bearing: number | null): FixtureFix => ({
  lat,
  lng,
  accuracy,
  altitudeM,
  bearing,
  fixedAt: FIXED_AT,
})

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const minutes = (n: number) => T0 + n * 60_000

/**
 * The first scans of the golden world, in the order they were uploaded (oldest first). `gps-good` is the newest scan
 * with a fix, so it is the world's origin under today's rule (the newest located scan).
 */
export const FIRST_SCANS: FixtureScan[] = [
  { name: 'cal-two', meta: sidecarOf('cal-two', fix(51.5007, -0.1246, 6, 11, 81.5), TWO_POINT), mtimeMs: minutes(1) },
  { name: 'cal-one', meta: sidecarOf('cal-one', null, ONE_POINT), mtimeMs: minutes(2) },
  { name: 'no-fix', meta: sidecarOf('no-fix', null, null), mtimeMs: minutes(3) },
  { name: 'gps-outlier', meta: sidecarOf('gps-outlier', fix(51.5036, -0.1246, 8, 11, 10), null), mtimeMs: minutes(4) },
  { name: 'gps-poor', meta: sidecarOf('gps-poor', fix(51.50069, -0.12462, 60, null, 120), null), mtimeMs: minutes(5) },
  { name: 'gps-nobearing', meta: sidecarOf('gps-nobearing', fix(51.50072, -0.12458, 12, 11.5, null), null), mtimeMs: minutes(6) },
  { name: 'gps-nullalt', meta: sidecarOf('gps-nullalt', fix(51.50081, -0.12441, 20, null, 45), null), mtimeMs: minutes(7) },
  { name: 'gps-good', meta: sidecarOf('gps-good', fix(51.50075, -0.12455, 4, 12.5, 200), null), mtimeMs: minutes(8) },
]

/** Scans that arrive after the world has been written once: the refresh adds them, and the first ones must not move. */
export const LATER_SCANS: FixtureScan[] = [
  { name: 'late-gps', meta: sidecarOf('late-gps', fix(51.50082, -0.12452, 5, 13, 310), null), mtimeMs: minutes(20) },
  { name: 'late-cal', meta: sidecarOf('late-cal', fix(51.5007, -0.1246, 6, 11, 81.5), TWO_POINT), mtimeMs: minutes(21) },
  { name: 'late-nofix', meta: sidecarOf('late-nofix', null, null), mtimeMs: minutes(22) },
]
