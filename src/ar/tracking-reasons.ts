/**
 * The one set of tracking reasons that say a runtime is unsure of its poses (wave 14, ticket 0004; F-40, FN-035).
 *
 * Two readers ask it:
 *  - `classifyTracking()` (./frame-epoch.ts) reads such a frame as degraded, so a stretch of them can begin an epoch;
 *  - `trackingIsStableForPlacement()` (./tracking-quality.ts) refuses a calibration tap in one.
 * Both read it beside a status that says NORMAL: a reason only ever makes a verdict worse, and LIMITED, NOT_AVAILABLE and
 * INITIALIZING are refused by status whatever the reason. The two readers each kept a copy of this set, and neither knew
 * the native layers' words. One set means a reason added for one reader is a reason for both.
 *
 * Where each name comes from:
 *  - INITIALIZING is the one reason 8th Wall documents beside UNSPECIFIED for `trackingReason`, with LIMITED and NORMAL for
 *    `trackingStatus` (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule). It is also the native shells' status
 *    word, and their reason for `limited.initializing`.
 *  - RELOCALIZING, TOO_MUCH_MOTION and NOT_ENOUGH_TEXTURE are not in 8th Wall's documentation. They are listed so that an
 *    engine which reports them is treated as unsure of its poses, not because one is known to. RELOCALIZING is also ARKit's
 *    `limited.relocalizing`, and is the one reason that is a discontinuity by itself (./frame-epoch.ts).
 *  - EXCESSIVE_MOTION and INSUFFICIENT_FEATURES are the native layers' own words, ARKit's and ARCore's, as the native codec
 *    spells them (`trackingReasonFromNative`, ./native-codec.ts). Today they only ever arrive with LIMITED, which is refused
 *    by status already. They are here so that no runtime this app runs can say "unsure" in a word one reader knows and the
 *    other does not.
 *
 * DX4 logs every status and reason transition on a phone, and that log is what keeps or removes each name. Pure and
 * import-free, so both readers and their tests can import it without importing each other.
 */

/**
 * The reason that names a relocalization. The only reason that is a discontinuity by itself.
 * Not in 8th Wall's documented set: it is acted on in case the engine reports it. ./frame-epoch.ts exports it too, and the
 * native codec imports it from there.
 */
export const REASON_RELOCALIZING = 'RELOCALIZING'

/** Every reason that makes a frame unsure of its pose beside a status that reads NORMAL. See the header for each name. */
export const UNSTABLE_TRACKING_REASONS: ReadonlySet<string> = new Set([
  'INITIALIZING',
  REASON_RELOCALIZING,
  'TOO_MUCH_MOTION',
  'NOT_ENOUGH_TEXTURE',
  'EXCESSIVE_MOTION',
  'INSUFFICIENT_FEATURES',
])

/** Whether `reason` is one of {@link UNSTABLE_TRACKING_REASONS}. No reason, or one this build does not know, is not. */
export function isUnstableTrackingReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && UNSTABLE_TRACKING_REASONS.has(reason)
}
