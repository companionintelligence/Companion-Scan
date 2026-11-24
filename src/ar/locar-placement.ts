/**
 * Where the locar.js pages draw a point, and how far the compass's north is from true north.
 *
 * locar's scene puts east at +x and north at −z. So do `sceneFromEnu` (src/world/enu.ts) and `latLngToScene`
 * (src/viewer/map-plane-math.ts) when the frame has no bearing. Placement therefore uses the repo's own exact
 * ENU, not locar's Web Mercator default, whose scale grows as 1/cos(latitude) (ADR 0014, ADR 0001).
 *
 * One rule places everything. `scenePlacement().toScene` replaces `LocAR.lonLatToWorldCoords` on the instance, so
 * the camera's own GPS fixes and every Place go through the same origin and the same turn. The origin is the first
 * point placed, which is locar's first accepted fix, and it never moves for the life of the page.
 *
 * locar turns the camera with the compass, so the scene's −z is magnetic north. With declination on, positions are
 * turned into that magnetic frame (true = magnetic + D, east positive, src/world/declination.ts), and the camera is
 * left to locar. Because the camera's position is turned by the same rule as the Places, nothing drifts as the user
 * walks, and locar's orientation smoothing is untouched.
 *
 * It also says which marker a tap on the screen means, and names a bearing's compass point, for the Place card.
 *
 * Pure: no DOM, no three.js and no locar runtime, so Node tests it (tests/unit/node/locar_placement.test.ts).
 */
import type { Geodetic } from '../world/enu.ts'
import type { ProjectLocationEntry } from '../viewer/geomap.ts'
import { latLngToScene, sceneToLatLng } from '../viewer/map-plane-math.ts'
import { declinationDeg, type Declination } from '../world/declination.ts'
import { normaliseBearingDeg } from '../world/geo.ts'

const DEG = Math.PI / 180

/**
 * A Place with a usable pin: an entry of `GET /project-locations` (server/main.ts), read with the map's own type
 * (`ProjectLocationEntry`, src/viewer/geomap.ts), whose lat and lng are on the globe.
 */
export type PinnedPlace = ProjectLocationEntry & { lat: number; lng: number }

/** A position in locar's scene: metres east (x) and south (z) of the page's origin. */
export interface ScenePoint {
  x: number
  z: number
}

/** True when a latitude and longitude are finite numbers on the globe. */
export function isUsableLatLng(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/**
 * The Places whose pin is usable, in the order given, each with everything the route gave for it. A missing,
 * non-finite or out-of-range pin is left out.
 */
export function pinnedPlaces(locations: readonly ProjectLocationEntry[]): PinnedPlace[] {
  const pinned: PinnedPlace[] = []
  for (const location of locations) {
    if (!isUsableLatLng(location.lat, location.lng)) continue
    pinned.push({ ...location, lat: location.lat as number, lng: location.lng as number })
  }
  return pinned
}

/**
 * A point given in the true-north scene, turned into the scene whose −z is magnetic north. A point at true
 * bearing b lands at magnetic bearing b − D, which is where the compass-turned camera sees it.
 */
export function toMagneticFrame(point: ScenePoint, declinationEastDeg: number): ScenePoint {
  const c = Math.cos(declinationEastDeg * DEG)
  const s = Math.sin(declinationEastDeg * DEG)
  return { x: point.x * c + point.z * s, z: point.z * c - point.x * s }
}

/** Where a latitude and longitude are in the true-north scene about `origin`, in metres (exact WGS-84 ENU). */
export function trueScenePoint(origin: Geodetic, lat: number, lng: number): ScenePoint {
  const s = latLngToScene({ origin }, lat, lng)
  return { x: s.x, z: s.z }
}

/** The latitude and longitude `eastM` metres east and `northM` metres north of `origin`, on its ground plane. */
export function latLngAt(origin: Geodetic, eastM: number, northM: number): { lat: number; lng: number } {
  return sceneToLatLng({ origin }, eastM, -northM)
}

/** The true bearing, degrees clockwise from north, of a point in the true-north scene, seen from the origin. */
export function trueBearingOf(point: ScenePoint): number {
  return normaliseBearingDeg(Math.atan2(point.x, -point.z) / DEG)
}

/** How far, and in which true direction, a Place's pin is from the origin. */
export function describePlace(origin: Geodetic, place: { lat: number; lng: number }): { distanceM: number; trueBearingDeg: number } {
  const point = trueScenePoint(origin, place.lat, place.lng)
  return { distanceM: Math.hypot(point.x, point.z), trueBearingDeg: trueBearingOf(point) }
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** The eight-point compass name of a bearing in degrees, the nearest of N, NE, E, SE, S, SW, W and NW. */
export function compassPoint(bearingDeg: number): string {
  return COMPASS_POINTS[Math.round(normaliseBearingDeg(bearingDeg) / 45) % 8]!
}

/**
 * A marker as the screen shows it: its centre in CSS pixels, how far from the centre a tap still counts, and
 * whether it is in front of the camera at all.
 */
export interface ScreenTarget {
  id: string
  x: number
  y: number
  radiusPx: number
  inFront: boolean
}

/**
 * The marker a tap at (x, y) means: the nearest one in front of the camera whose tap radius reaches the tap, or
 * null. A far marker is a few pixels across, so its radius is a fingertip's; a near one counts out to its own size.
 */
export function nearestOnScreen(targets: readonly ScreenTarget[], x: number, y: number): string | null {
  let nearest: string | null = null
  let nearestPx = Number.POSITIVE_INFINITY
  for (const target of targets) {
    if (!target.inFront || !Number.isFinite(target.x) || !Number.isFinite(target.y)) continue
    const px = Math.hypot(target.x - x, target.y - y)
    if (px <= target.radiusPx && px < nearestPx) {
      nearest = target.id
      nearestPx = px
    }
  }
  return nearest
}

/** The declination a page turns its positions by, and whether it could. */
export interface ViewerCorrection {
  declination: Declination | null
  turnDeg: number
  applied: boolean
}

/**
 * The model refuses in NOAA's blackout zone and outside 2025.0 to 2030.0, and throws on an origin it cannot use.
 * In every one of those cases the page turns nothing and says so, rather than guess.
 */
export function viewerCorrection(origin: Geodetic, date: Date): ViewerCorrection {
  let declination: Declination
  try {
    declination = declinationDeg(origin.lat, origin.lng, origin.altitudeM, date)
  } catch {
    return { declination: null, turnDeg: 0, applied: false }
  }
  return declination.declinationDeg === null
    ? { declination, turnDeg: 0, applied: false }
    : { declination, turnDeg: declination.declinationDeg, applied: true }
}

/** The one placement rule for a locar page. Install `toScene` as the instance's `lonLatToWorldCoords`. */
export interface ScenePlacement {
  /** The first usable point placed, which is locar's first accepted fix. Null until then. */
  readonly origin: Geodetic | null
  /** The declination turn in use. Null when declination is off, or before the origin is set. */
  readonly correction: ViewerCorrection | null
  /** locar's `lonLatToWorldCoords`: longitude first, then latitude, and `[x, z]` back. */
  toScene(lon: number, lat: number): [number, number]
}

export function scenePlacement(options: { applyDeclination: boolean; now: () => Date }): ScenePlacement {
  let origin: Geodetic | null = null
  let correction: ViewerCorrection | null = null
  return {
    get origin() {
      return origin
    },
    get correction() {
      return correction
    },
    toScene(lon: number, lat: number): [number, number] {
      if (!isUsableLatLng(lat, lon)) return [0, 0]
      if (origin === null) {
        origin = { lat, lng: lon, altitudeM: 0 }
        correction = options.applyDeclination ? viewerCorrection(origin, options.now()) : null
      }
      const point = toMagneticFrame(trueScenePoint(origin, lat, lon), correction?.turnDeg ?? 0)
      return [point.x, point.z]
    },
  }
}
