/**
 * Whether a `<video>` fed by a camera is still delivering, read from its `currentTime` (wave 14, ticket 0004; F-40,
 * FN-033). `readyState` alone cannot tell a live frame from a corpse: it stays at HAVE_CURRENT_DATA (2) or above for a
 * stream that has stopped advancing, and drawing it gives the same frozen picture again and again. `currentTime` on a
 * MediaStream-backed video only moves while the source is delivering samples, so whether it has moved since the last look
 * is a direct, cheap signal.
 *
 * Two callers judge the frozen time against their own limits, which differ on purpose and stay with them:
 *  - src/ar/webxr.ts refuses a capture after `VIDEO_STALL_THRESHOLD_MS` (500 ms): a capture is one frame, and one
 *    re-encoded corpse is already a wrong photo;
 *  - ./sweep-cadence.ts ends a tripod sweep after `SWEEP_STALL_MS` (1500 ms), and also keeps what a sweep needs and a
 *    capture does not: whether the picture has been seen to move at all, and a reset while the page is hidden.
 * Pure: the callers read the video and the clock.
 */

/** What the looks at `currentTime` have seen so far. */
export interface VideoLiveness {
  /** The last `currentTime` seen. -1 before the first look, which no real `currentTime` is. */
  readonly lastCurrentTime: number
  /** When `currentTime` was first seen not to move (the caller's clock, ms), or null while it moves. */
  readonly stalledSinceMs: number | null
}

/** Before any look. */
export const VIDEO_UNSEEN: VideoLiveness = { lastCurrentTime: -1, stalledSinceMs: null }

/**
 * One look at `currentTime`, at `nowMs`. A reading different from the last is live and clears the stall clock; the same
 * reading starts the clock if it is not running and leaves it alone if it is. `moved` says which it was.
 */
export function lookAtVideo(state: VideoLiveness, currentTime: number, nowMs: number): VideoLiveness & { moved: boolean } {
  if (currentTime !== state.lastCurrentTime) {
    return { lastCurrentTime: currentTime, stalledSinceMs: null, moved: true }
  }
  return { lastCurrentTime: state.lastCurrentTime, stalledSinceMs: state.stalledSinceMs ?? nowMs, moved: false }
}

/** How long, at `nowMs`, the picture has sat frozen: 0 while it moves or before it was seen to stop. */
export function frozenForMs(state: VideoLiveness, nowMs: number): number {
  return state.stalledSinceMs === null ? 0 : nowMs - state.stalledSinceMs
}
