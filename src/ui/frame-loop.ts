/**
 * The scanner's per-frame loop, for what has to follow the camera between scanner ticks (F-13).
 *
 * Detection pins were positioned only from the 8th Wall camera pipeline: `AROverlay.mount()` registered
 * a pipeline module when the page chose 8th Wall, and `AROverlay.tick()`, the entry point documented for
 * WebXR, had no caller. A WebXR session and a native ARKit or ARCore session never showed a pin, and nor
 * did a native session that handed over to a web runtime. `src/main.ts` now runs this loop for every
 * runtime once AR is running, and the overlay decides each frame whether the pipeline already drew it
 * (`pipelineDrewRecently`).
 *
 * `window.requestAnimationFrame` keeps firing during an immersive WebXR session with a DOM overlay. The
 * WebXR provider relies on the same thing (see Three's `setAnimationLoop` note in src/ar/webxr.ts).
 *
 * Pure apart from the scheduler, which a test passes in.
 */

/** Asks for the next frame and returns a handle that cancels the request. */
export type ScheduleFrame = (callback: (timeMs: number) => void) => unknown
export type CancelFrame = (handle: unknown) => void

/**
 * How long after an 8th Wall pipeline tick the loop leaves the pins alone. The pipeline draws in step
 * with the engine's own render, so while it runs it is the better clock. One frame at 60 Hz is about
 * 17 ms. 100 ms is several of them, so a pipeline that skips a frame does not hand over for one
 * frame. It is also short enough that a pipeline that has stopped hands over at once.
 */
export const PIPELINE_GRACE_MS = 100

/** Whether a pipeline tick at `lastPipelineMs` is recent enough, at `nowMs`, to leave this frame to it. */
export function pipelineDrewRecently(lastPipelineMs: number | null, nowMs: number): boolean {
  return lastPipelineMs !== null && nowMs - lastPipelineMs >= 0 && nowMs - lastPipelineMs < PIPELINE_GRACE_MS
}

/**
 * Run `tick` once per frame until the returned function is called. A tick that throws is logged and the
 * loop goes on: one bad frame must not stop the pins for the rest of the session.
 */
export function startFrameLoop(
  tick: (timeMs: number) => void,
  schedule: ScheduleFrame = (callback) => requestAnimationFrame(callback),
  cancel: CancelFrame = (handle) => cancelAnimationFrame(handle as number),
): () => void {
  let stopped = false
  let handle: unknown = null
  const frame = (timeMs: number): void => {
    if (stopped) return
    try {
      tick(timeMs)
    } catch (error) {
      console.warn('[frame-loop] tick failed:', error)
    }
    if (!stopped) handle = schedule(frame)
  }
  handle = schedule(frame)
  return () => {
    if (stopped) return
    stopped = true
    cancel(handle)
  }
}
