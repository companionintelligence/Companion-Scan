/**
 * How the drift check reads a tap: through the calibration's own sampler (`calibrationTapSampler`, ./calibration-taps.ts),
 * which runs `sampleTap` (./tap-sampling.ts), the one reader that judges a tap by a burst of hits and refuses an unsteady
 * one, and not one hit snapped to a feature. One construction for both readers (wave 14, ticket 0004; FN-034): a change
 * to how a tap is read is a change to both.
 *
 * A closure compares a re-tap with a point set by an earlier tap, so the re-tap's own jitter is what the check cannot
 * tell from drift (src/ar/closure.ts keeps its limits above it). The burst's median is the smallest that jitter can be
 * made. `hitTest` is the host's single-hit test, which `sampleTap` falls back to when the provider has no burst or its
 * burst saw no frame, and which WebXR needs because its synchronous hit test answers null.
 *
 * The fitted floor is read at each tap, not once: the floor estimate settles as the scan goes on. It takes part as a
 * cross-check (`floorRay: 'cross-check'`), as the calibration flow's does, so it can disagree with the hits and say so
 * without moving the point: nothing has measured the floor ray against a taped point yet (device experiment DX5).
 *
 * `?tap=` (DX2's arms: `single`, one hit through the same gates; `floor`, the floor ray setting the point) reaches the
 * drift check only when the host passes its query string as `search`. It does not read the address on its own: the page
 * builds this reader without one (src/main.ts), so a drift check reads a burst whatever the address says. Whether DX2's
 * arms should cover the drift check too is the owner's call.
 */
import type { HitResult } from './provider.ts'
import type { GroundReading } from './ground-gate.ts'
import type { TapProvider, TapResult } from './tap-sampling.ts'
import { calibrationTapSampler } from './calibration-taps.ts'

export interface DriftTapSources {
  provider: TapProvider
  /** The host's own hit test: one hit at normalised canvas coordinates. */
  hitTest: (x: number, y: number) => Promise<HitResult | null>
  /** The point cloud's current floor estimate, or null before there is one. */
  ground: () => GroundReading | null
  /**
   * The page's query string, for `?tap=`, read as the calibration's sampler reads it. Absent: no `?tap=` arm, so a burst
   * with the floor ray as a cross-check, whatever the address says.
   */
  search?: string
}

/** A function that reads one tap at normalised canvas coordinates, as `ReanchorHost.readTap` wants. */
export function driftTapReader(sources: DriftTapSources): (x: number, y: number) => Promise<TapResult> {
  const sample = calibrationTapSampler({
    provider: sources.provider,
    singleHit: sources.hitTest,
    ground: sources.ground,
    search: sources.search ?? '',
  })
  return (x, y) => sample(x, y)
}
