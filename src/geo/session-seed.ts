/**
 * What a capture session records of where it is and which way it faces, as it goes: the replacement for the one GPS and
 * compass snapshot an export used to take (src/world/geo-session.ts says why, and what the server does with it).
 *
 * The scanner holds one `GeoSessionSampler` for the page. The AR frame loop hands it every pose (`onFrame`), the geo tracker hands
 * it every position fix (`noteFix`, from `GeoTracker.onPosition`), and an export asks it for what to write (`exportFields`): the
 * best fix of the first minute of the walk in the place of the one at the moment of export, and a `geoSession` record.
 *
 * ## What it samples
 *
 *  - **Fixes.** Every fix that arrives once the walk has begun is kept (up to a bound) with where the camera was in the session at
 *    that moment (its x and z). At export the one with the best accuracy in the first 60 s is the position, not a mean (fixes are
 *    correlated in time: `bestFixInWindow`), and the camera's position is what lets a server add back the distance the phone had
 *    walked from the session's origin.
 *  - **The compass, with the pose it was read with.** About four times a second the page's compass bearing for the camera
 *    (`GeoTracker.pairedCompass`, which already says which axis it follows and hands none over when it cannot) is turned into
 *    the bearing of the session's +Z with the camera's own yaw at that instant (`sessionFrameBearingDeg`: the compass reading plus
 *    the camera's yaw in the session, which is the same direction seen two ways), and the rate the camera was turning at is read
 *    from the last two poses. Only steady samples count (`BearingAccumulator`): a compass lags the pose by about a tenth of
 *    a second, so a reading taken while the phone is swinging says where it was a moment ago.
 *  - **The declination.** A compass is magnetic. The readings are accumulated as they are, and the declination of the place
 *    (WMM2025, `declinationRecord`, at the best fix) is added to the mean at export. With no declination (no fix, a date outside
 *    the model, a place the model refuses) there is no true bearing, and the record says none rather than a magnetic one.
 *
 * ## What it does not do
 *
 * It does not say a bearing is right. The mean of steady samples with the spread, and a sigma that is never below the floor of the
 * platform's compass, is what it records; whether the building's steel agreed is for a device (DX3, DX7). It samples a session, not
 * a Place: the Place's georeference is a person's, and a seed from many scans is the server's (server/world/georef_seed.ts).
 *
 * Pure but for the clock the caller gives it: browser-safe, no DOM, nothing stored between page loads.
 */
import { sessionFrameBearingDeg } from '../world/geo.ts'
import { GEO_SESSION_VERSION, type GeoSession } from '../world/geo-session.ts'
import {
  BearingAccumulator,
  bestFixInWindow,
  BEARING_SIGMA_FLOOR_SEED_DEG,
  declinationRecord,
  type SeedFix,
} from '../world/georef.ts'
import type { Quat, Vec3 } from '../world/types.ts'
import type { CompassReading, CompassSource, PairedCompass } from './compass-heading.ts'
import type { GeoFix } from './geo-tracker.ts'

/**
 * How often a compass sample is taken, ms: four a second. A frame loop runs at 30 to 60 Hz and a sample per frame would be
 * hundreds of near-identical readings; this is the pace at which a walk's compass changes. **Adopted, not measured** (ADR 0005 rule 5).
 */
export const SAMPLE_INTERVAL_MS = 250

/** How many fixes of a walk are kept, at most. GPS is about one a second, so this is a bound on memory and not a figure. Adopted, not measured. */
export const MAX_KEPT_FIXES = 128

/** What a sampler reads from the page: the geo tracker's compass pairing, and a clock. */
export interface SessionSamplerSources {
  /** `GeoTracker.pairedCompass`: the bearing the camera faces (magnetic) for this pose, or null when there is none to give. */
  pairedCompass: (rotation: Quat) => PairedCompass | null
  /** `GeoTracker.compassReading`: where the last reading came from and how uncertain it is. */
  compassReading: () => CompassReading | null
  /** The time in ms since the epoch, which a position fix's own timestamp is on. */
  now?: () => number
}

export interface PoseSample {
  position: Vec3
  rotation: Quat
}

/** What an export takes: the fix to write in the flat `geo*` fields, and the `geoSession` record. Either may be absent. */
export interface SessionExportFields {
  geoFix?: GeoFix
  geoSession?: GeoSession
}

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/** The angle between two orientations, degrees: `2 acos(|q1 . q2|)`. */
function rotationAngleDeg(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
  return 2 * Math.acos(Math.min(1, dot)) * RAD_TO_DEG
}

const finitePose = (pose: PoseSample): boolean =>
  [pose.position.x, pose.position.y, pose.position.z, pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w].every(Number.isFinite)

/** How far apart two positions are, metres, roughly: enough to tell a fix from another street. */
function roughDistanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD * 6_371_000
  const dLng = (b.lng - a.lng) * DEG_TO_RAD * 6_371_000 * Math.cos(((a.lat + b.lat) / 2) * DEG_TO_RAD)
  return Math.hypot(dLat, dLng)
}

export class GeoSessionSampler {
  private readonly sources: SessionSamplerSources
  private startedAtMs: number | null = null
  private lastPose: PoseSample | null = null
  private lastSample: { tMs: number; rotation: Quat } | null = null
  private readonly fixes: SeedFix[] = []
  private readonly bearings = new BearingAccumulator()
  private sigmaFloorDeg = BEARING_SIGMA_FLOOR_SEED_DEG
  private source: CompassSource | null = null

  constructor(sources: SessionSamplerSources) {
    this.sources = sources
  }

  private now(): number {
    return this.sources.now ? this.sources.now() : Date.now()
  }

  /** A new walk: a scan that was cleared, or ended at a frame shift and begun again, is another session with its own origin. */
  reset(): void {
    this.startedAtMs = null
    this.lastPose = null
    this.lastSample = null
    this.fixes.length = 0
    this.bearings.clear()
    this.sigmaFloorDeg = BEARING_SIGMA_FLOOR_SEED_DEG
    this.source = null
  }

  /** When the walk began, in ms, or null before its first pose. */
  get startedAt(): number | null {
    return this.startedAtMs
  }

  /** How many steady compass samples there have been. */
  get steadySamples(): number {
    return this.bearings.count
  }

  /**
   * One AR pose. The first one begins the walk. `usable` is false while the runtime's tracking is degraded (or recording is held for
   * a choice about the scan's frame): the pose is not trusted, and no sample is taken from it. Takes a compass sample at most every
   * {@link SAMPLE_INTERVAL_MS}.
   */
  onFrame(pose: PoseSample, usable = true, nowMs: number = this.now()): void {
    if (!finitePose(pose)) return
    if (this.startedAtMs === null) this.startedAtMs = nowMs
    this.lastPose = pose
    if (!usable) {
      this.lastSample = null
      return
    }
    if (this.lastSample !== null && nowMs - this.lastSample.tMs < SAMPLE_INTERVAL_MS) return
    const previous = this.lastSample
    this.lastSample = { tMs: nowMs, rotation: pose.rotation }

    const paired = this.sources.pairedCompass(pose.rotation)
    if (!paired) return
    const bearing = sessionFrameBearingDeg(paired.bearingDeg, pose.rotation)
    if (bearing === null) return
    const dt = previous ? (nowMs - previous.tMs) / 1000 : 0
    const rateDegS = previous && dt > 0 ? rotationAngleDeg(previous.rotation, pose.rotation) / dt : null
    const reading = this.sources.compassReading()
    // The platform's own uncertainty rides with every sample, and the largest wins: an iPhone is never claimed better than 25 degrees.
    if (reading?.sigmaDeg != null) this.sigmaFloorDeg = Math.max(this.sigmaFloorDeg, reading.sigmaDeg)
    if (reading) this.source = reading.source
    this.bearings.add({ tS: (nowMs - this.startedAtMs) / 1000, bearingDeg: bearing, rateDegS })
  }

  /**
   * A position fix, with the time the phone took it (`GeolocationPosition.timestamp`), kept with the camera's position in the session
   * when it was taken. Which of them is in the first minute, and usable, is `bestFixInWindow`'s to say at export. A fix that arrives
   * before the first pose is the phone's last (the page asks for GPS early) and is not part of the walk; the export falls back to it
   * when nothing better came.
   */
  noteFix(fix: Pick<GeoFix, 'lat' | 'lng' | 'accuracy' | 'altitudeM'>, takenAtMs: number): void {
    if (this.startedAtMs === null || this.fixes.length >= MAX_KEPT_FIXES) return
    const tS = (takenAtMs - this.startedAtMs) / 1000
    const pose = this.lastPose
    this.fixes.push({
      lat: fix.lat,
      lng: fix.lng,
      accuracyM: fix.accuracy,
      altitudeM: fix.altitudeM,
      tS,
      sessionX: pose ? pose.position.x : null,
      sessionZ: pose ? pose.position.z : null,
    })
  }

  /**
   * What an export writes. `snapshot` is the geo tracker's current fix, the fallback and the source of the address. With a fix in the
   * first minute the position is the best of them (its accuracy, its height as the platform said it, the time it was taken) and the
   * address stays only if it is still about the same place. The `geoSession` record is there whenever the walk began: the fix, the
   * bearing when there is one, and the declination it was turned by. No walk and no snapshot, nothing.
   */
  exportFields(snapshot: GeoFix | null, date: Date = new Date(this.now())): SessionExportFields {
    if (this.startedAtMs === null) return snapshot ? { geoFix: snapshot } : {}
    const best = bestFixInWindow(this.fixes)
    let geoFix: GeoFix | undefined = snapshot ?? undefined
    if (best) {
      const sameCell = snapshot !== null && roughDistanceM(snapshot, best) < 50
      geoFix = {
        lat: best.lat,
        lng: best.lng,
        accuracy: best.accuracyM,
        altitudeM: best.altitudeM,
        bearing: snapshot?.bearing ?? null,
        fixedAt: new Date(this.startedAtMs + best.tS * 1000).toISOString(),
        address: sameCell ? snapshot!.address : null,
        displayAddress: sameCell ? snapshot!.displayAddress : null,
        addressComponents: sameCell ? snapshot!.addressComponents : null,
      }
    }
    const place = best ?? (snapshot ? { lat: snapshot.lat, lng: snapshot.lng } : null)
    const declination = place ? declinationRecord(place.lat, place.lng, date) : null
    const seed = declination ? this.bearings.seed(this.sigmaFloorDeg, declination.deg) : null
    const geoSession: GeoSession = {
      v: GEO_SESSION_VERSION,
      startedAt: new Date(this.startedAtMs).toISOString(),
      fix: best ? { offsetS: best.tS, sessionX: best.sessionX, sessionZ: best.sessionZ } : null,
      bearing: seed && declination
        ? { deg: seed.bearingDeg, spreadDeg: seed.spreadDeg, sigmaDeg: seed.sigmaDeg, samples: seed.samples, spanS: seed.spanS, source: this.source }
        : null,
      declination,
    }
    return geoFix ? { geoFix, geoSession } : { geoSession }
  }
}
