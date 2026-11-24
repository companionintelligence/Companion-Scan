/**
 * The frame plumbing both web providers (./eighthwall.ts, ./webxr.ts) wrote out for themselves, in one place (wave 14,
 * ticket 0004; F-40, FN-031):
 *
 *  - the capture queue: one `captureFrame()` at a time, a timer that fails it, and the drain that settles or fails every
 *    waiting call, with the two refusals worded once;
 *  - the stale-pose rule: a pose older than `MAX_CAPTURE_POSE_AGE_MS` is not stamped onto a capture;
 *  - `poseAgeMs` on the tracking diagnostics;
 *  - the hidden-then-resumed bookkeeping, so a return from hidden is told from a first look and says how long it was away.
 *
 * What still differs stays with each provider, beside the reason:
 *  - 8th Wall only calls a pose old while it is being held over through NOT_AVAILABLE (`_poseHeld`); WebXR calls it old
 *    once no tracked pose has come for the bound.
 *  - WebXR refuses a capture at once when no session is running, before it would queue one.
 *  - WebXR tells its anchors about a resume before the epoch tracker hears it.
 *
 * The queue stays a plain array on each provider (`captureQueue`), which the providers' own tests reach into; these are
 * functions over it rather than a class in its place. No DOM, no clock of its own: the callers pass the times.
 */
import type { RawFrame } from './provider'
import { MAX_CAPTURE_POSE_AGE_MS } from './frame-epoch.ts'

/** One waiting `captureFrame()` call. */
export interface PendingCapture {
  resolve: (frame: RawFrame) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** What a second `captureFrame()` is refused with while one is waiting. */
export const CAPTURE_PENDING_MESSAGE = 'Capture already pending'

/** What a `captureFrame()` that no frame answered in time is refused with. */
export const CAPTURE_TIMEOUT_MESSAGE = 'Timed out waiting for camera frame'

/**
 * Queues one capture on `queue` and returns its promise: refused at once while another is waiting, and refused with
 * {@link CAPTURE_TIMEOUT_MESSAGE} if no frame settles it within `timeoutMs`, when it also leaves the queue.
 */
export function queueCapture(queue: PendingCapture[], timeoutMs: number): Promise<RawFrame> {
  if (queue.length > 0) {
    return Promise.reject(new Error(CAPTURE_PENDING_MESSAGE))
  }
  return new Promise((resolve, reject) => {
    const pending: PendingCapture = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        const idx = queue.indexOf(pending)
        if (idx >= 0) queue.splice(idx, 1)
        reject(new Error(CAPTURE_TIMEOUT_MESSAGE))
      }, timeoutMs),
    }
    queue.push(pending)
  })
}

/** Hands `frame` to every waiting capture (normally one) and empties the queue. */
export function settleCaptures(queue: PendingCapture[], frame: RawFrame): void {
  for (const pending of queue.splice(0)) {
    clearTimeout(pending.timeout)
    pending.resolve(frame)
  }
}

/** Refuses every waiting capture with `message` and empties the queue. */
export function failCaptures(queue: PendingCapture[], message: string): void {
  for (const pending of queue.splice(0)) {
    clearTimeout(pending.timeout)
    pending.reject(new Error(message))
  }
}

/**
 * Whether a pose last read at `poseAtMs` is too old, at `nowMs`, to stamp onto a capture: older than
 * `MAX_CAPTURE_POSE_AGE_MS` (./frame-epoch.ts). Never before the first pose. Stamping an old pose onto a photograph places
 * everything detected in it where the camera no longer is, so the capture is refused with `TRACKING_LOST_MESSAGE` instead.
 */
export function capturePoseTooOld(poseAtMs: number | null, nowMs: number): boolean {
  return poseAtMs !== null && nowMs - poseAtMs > MAX_CAPTURE_POSE_AGE_MS
}

/**
 * The tracker's diagnostics with `poseAgeMs` added: how old the pose a capture would carry is, as of the last frame the
 * runtime delivered, 0 while a fresh pose arrives every frame. Absent before the first pose or the first frame.
 */
export function withPoseAge<D extends object>(
  diagnostics: D,
  poseAtMs: number | null,
  frameMs: number | null,
): D & { poseAgeMs?: number } {
  const poseAgeMs = poseAtMs !== null && frameMs !== null ? Math.max(0, frameMs - poseAtMs) : undefined
  return { ...diagnostics, ...(poseAgeMs !== undefined ? { poseAgeMs } : {}) }
}

/**
 * Whether a page or an XR session was last seen hidden, and since when, so that a return to view can be told from a first
 * look and can say how long it was away. The providers make a return a resume, which starts an epoch: nothing said where
 * the camera was carried meanwhile.
 */
export class HiddenSpell {
  /** Whether it was last seen hidden. */
  hidden = false
  /** When it was last hidden (ms, the caller's clock), or null while it is in view. */
  hiddenAtMs: number | null = null

  /** Starts watching: `hidden` is what is seen now, and a spell that is already hidden counts from now. */
  begin(hidden: boolean, nowMs: number): void {
    this.hidden = hidden
    this.hiddenAtMs = hidden ? nowMs : null
  }

  /**
   * One look at the visibility. Null unless it is a return from hidden; then how long it was away (undefined if
   * that cannot be said). Going hidden twice keeps the first time.
   */
  note(hidden: boolean, nowMs: number): { awayMs: number | undefined } | null {
    if (hidden) {
      if (!this.hidden) this.hiddenAtMs = nowMs
      this.hidden = true
      return null
    }
    if (!this.hidden) return null
    this.hidden = false
    const awayMs = this.hiddenAtMs === null ? undefined : nowMs - this.hiddenAtMs
    this.hiddenAtMs = null
    return { awayMs }
  }

  /** Forgets the spell: a stopped session has none. */
  reset(): void {
    this.hidden = false
    this.hiddenAtMs = null
  }
}
