/**
 * Marker reading, end to end, without a screen: the camera feed in, the worker's detections and a `TagSession` out.
 *
 * It is the glue between three things that each know nothing of the others: the provider's frame feed
 * (`ARProvider.onCameraFrame`), the worker client (`tag-worker-client.ts`) and the session state machine (`tag-session.ts`).
 * The flow stage that asks the person to scan the marker (a later package) and the `?debug=tag` kit (`tag-debug.ts`) both start
 * one of these and read what it says.
 *
 * ## What it checks before a frame is used
 *
 * - **The projection describes the pixels.** The camera's intrinsics are built from the projection the runtime published and
 *   the size of the pixel array (`intrinsicsFromProjection`), and the session refuses a frame whose focal lengths disagree
 *   (`intrinsicsProblem`: an aspect mismatch means the projection and the pixels are about different frames, and a pose
 *   from them would be wrong without looking wrong). A frame the provider says was made under the `cover` fit (the
 *   canvas crops the camera frame) is refused outright: the projection is then the cropped canvas's, not the pixels'
 *   (`CameraFit` in eighthwall.ts), and the capture ends with `unavailable: 'cover-fit'`.
 * - **Support.** A provider with no `onCameraFrame`, or whose answer is `'unsupported'` (WebXR), makes the capture `'unavailable'`
 *   with the reason, and nothing starts.
 *
 * Browser-safe (ADR 0002).
 */
import type { ARProvider } from '../provider.ts'
import type { CameraFrame, CameraFrameUnsupportedReason } from '../camera-frame-feed.ts'
import type { DetectorOptions } from './detector.ts'
import { TagWorkerClient, type TagFrameResult, type TagWorkerClientOptions } from './tag-worker-client.ts'
import type { TagFrameInput, TagSession, TagSessionState } from './tag-session.ts'
import { intrinsicsFromProjection } from './tag-pose.ts'
import type { TagUnavailableReason } from './tag-copy.ts'
import type { CameraIntrinsics } from './types.ts'

/** Frames a second asked of the feed. The spec says 5 to 10; the middle. Adopted, not measured (ADR 0005 rule 5): DX8's 5-minute run at 10 Hz is what sets it. */
export const DEFAULT_TAG_MAX_HZ = 8

/** One frame's journey, for a listener that wants the numbers (the debug kit). */
export interface TagCaptureUpdate {
  /** What the worker (or the main-thread fallback) made of the frame. */
  result: TagFrameResult
  /** The intrinsics the frame was judged with. */
  intrinsics: CameraIntrinsics
  /** What was handed to the session, or null when no session is attached. */
  input: TagFrameInput | null
  /** The session's state after the frame, or null when no session is attached. */
  state: TagSessionState | null
  /** Milliseconds the page's thread spent handing the frame to the session, or null when no session is attached. */
  sessionMs: number | null
}

export interface TagCaptureOptions {
  provider: Pick<ARProvider, 'onCameraFrame'>
  /** The session to feed. Null for a capture that only counts (the negative-corpus mode). */
  session: TagSession | null
  /** The family to read, by `Dictionary.name`. */
  family: string
  /** Detector options, from `detectorOptionsForSession()` for a session. */
  detector?: DetectorOptions
  maxHz?: number
  /** See `PoseHistory`: how many frames the pixels are assumed to trail the pose. Default the history's own. */
  lagFrames?: number
  /** Ask the feed to attach the newest this-many poses to each frame (the lag fit's). */
  recentPoses?: number
  /** Passed to the worker client (a test injects a fake worker). */
  worker?: Pick<TagWorkerClientOptions, 'createWorker' | 'loadRunner' | 'now' | 'onFallback'>
  /** Told after every frame. */
  onUpdate?: (update: TagCaptureUpdate) => void
  /**
   * Told when the capture cannot go on: the feed is unsupported, or the view is cropped. `frame` is the frame that showed it, when there was one (a cropped
   * view is found on a frame; an unsupported feed on none), so that whoever reports it can say which camera and canvas it was. For an unsupported feed it
   * is told before `startTagCapture` returns.
   */
  onUnavailable?: (reason: TagUnavailableReason, frame?: CameraFrame) => void
}

export interface TagCapture {
  /** `'running'`, or `'unavailable'` with `unavailable` saying why. Stays `'unavailable'` once it is. */
  readonly status: 'running' | 'unavailable' | 'stopped'
  readonly unavailable: TagUnavailableReason | null
  /** The worker client, for its counters and its mode; null when unavailable. */
  readonly client: TagWorkerClient | null
  stop(): void
}

/** Intrinsics that fail `intrinsicsProblem`, for a projection that is not a perspective matrix: the session then says so, rather than the capture throwing. */
function unusableIntrinsics(frame: Pick<CameraFrame, 'width' | 'height'>): CameraIntrinsics {
  return { fx: NaN, fy: NaN, cx: NaN, cy: NaN, width: frame.width, height: frame.height }
}

/** The camera the corners of a frame were measured through: the projection, with the size of the pixel array. */
export function intrinsicsOfFrame(frame: Pick<CameraFrame, 'projection' | 'width' | 'height'>): CameraIntrinsics {
  try {
    return intrinsicsFromProjection(frame.projection, { width: frame.width, height: frame.height })
  } catch {
    return unusableIntrinsics(frame)
  }
}

/**
 * Start reading the marker. Returns at once; frames arrive at the provider's pace and the listener hears of each as it is read.
 */
export function startTagCapture(options: TagCaptureOptions): TagCapture {
  let status: TagCapture['status'] = 'running'
  let unavailable: TagUnavailableReason | null = null
  let client: TagWorkerClient | null = null
  let unsubscribeFeed: (() => void) | null = null
  let stopListening: (() => void) | null = null

  const end = (next: 'unavailable' | 'stopped', reason: TagUnavailableReason | null, frame?: CameraFrame): void => {
    if (status !== 'running') return
    status = next
    unavailable = reason
    unsubscribeFeed?.()
    stopListening?.()
    client?.close()
    if (next === 'unavailable' && reason) options.onUnavailable?.(reason, frame)
  }

  const subscribe = options.provider.onCameraFrame
  if (!subscribe) {
    end('unavailable', 'no-frame-feed' satisfies CameraFrameUnsupportedReason)
    return handle()
  }
  const subscription = subscribe.call(
    options.provider,
    (frame) => {
      if (status !== 'running' || !client) return
      // The projection of a cropped canvas is not the camera of the pixels: nothing read through it can be trusted.
      if (frame.display?.fit === 'cover') {
        end('unavailable', 'cover-fit', frame)
        return
      }
      client.submit(frame)
    },
    { maxHz: options.maxHz ?? DEFAULT_TAG_MAX_HZ, ...(options.lagFrames === undefined ? {} : { lagFrames: options.lagFrames }), ...(options.recentPoses === undefined ? {} : { recentPoses: options.recentPoses }) },
  )
  if (subscription.status === 'unsupported') {
    end('unavailable', subscription.reason ?? 'no-frame-feed')
    return handle()
  }
  unsubscribeFeed = () => subscription.unsubscribe()
  client = new TagWorkerClient({ family: options.family, detector: options.detector, ...options.worker })
  stopListening = client.onResult((result) => {
    if (status !== 'running') return
    const intrinsics = intrinsicsOfFrame(result.frame)
    let input: TagFrameInput | null = null
    let state: TagSessionState | null = null
    let sessionMs: number | null = null
    if (options.session) {
      const t0 = performance.now()
      input = {
        timestampMs: result.frame.timestampMs,
        detections: result.detections,
        intrinsics,
        cameraPose: result.frame.pose,
        angularSpeedDegPerS: result.frame.angularSpeedDegPerS,
        epoch: result.frame.epoch,
      }
      state = options.session.offer(input)
      sessionMs = performance.now() - t0
    }
    options.onUpdate?.({ result, intrinsics, input, state, sessionMs })
  })
  return handle()

  function handle(): TagCapture {
    return {
      get status() {
        return status
      },
      get unavailable() {
        return unavailable
      },
      get client() {
        return client
      },
      stop: () => end('stopped', null),
    }
  }
}
