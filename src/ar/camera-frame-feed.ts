/**
 * The camera-frame feed: pixels, and the pose and projection they go with, for a consumer that reads them (the printed-marker
 * detector, `src/ar/fiducial/tag-capture.ts`). `ARProvider.onCameraFrame` is this, behind the provider seam.
 *
 * ## What it is made of, and what it costs
 *
 * A provider calls {@link CameraFrameFeed.offer} once per runtime tick with what that tick produced, and the feed does nothing
 * unless somebody subscribed: the provider's hook is `if (feed.active) feed.offer(...)`, which is a field read, and `offer`
 * itself begins by leaving when there is no subscriber. When there is one, the feed
 *
 * - records the tick's camera pose in a short history (`PoseHistory`, ./fiducial/pose-history.ts), which is what lets the pixels
 *   be paired with a pose a whole number of frames older than the newest (`lagFrames`: see that file for why the lag is a
 *   hypothesis a device fits, not a fact);
 * - decides, per subscriber, whether this tick is due at its `maxHz`, and only then touches the runtime's pixel array: one
 *   COPY of the bytes per due subscriber, so that a subscriber may keep the buffer, hand it to a worker by transfer, or drop
 *   it, whatever the runtime does with its own. What a runtime promises about its buffer's lifetime is not something the
 *   8th Wall `CameraPixelArray` page says (https://8thwall.org/docs/api/engine/camerapixelarray/pipelinemodule), so nothing here relies
 *   on it: the runtime's array is read, copied and let go within the tick.
 *
 * It never changes how the runtime produces pixels. The 8th Wall provider already adds `XR8.CameraPixelArray.pipelineModule({
 * luminance: false })` for keyframe capture, which needs the full RGBA frame, and the feed takes that same array: no second
 * module, no change of size or format, and no cost to the keyframe path.
 *
 * ## What it does not do
 *
 * It does not deliver on a tick that has no new camera image (`repeatFrame`), on a tick whose pose the runtime is holding over
 * from an earlier one (a pose that is not this frame's would pair the wrong pose with the pixels), without a usable projection, or
 * before the history is deep enough for the lag asked for. Each of those is counted in {@link CameraFeedStats} so that a
 * device run can say why no frame came. It does not interpolate poses, and it clears its history when the runtime's frame epoch
 * changes, so a pose and its pixels are never from either side of a frame shift, and when the runtime holds a pose over a tick, so that
 * a pose from before the gap is never paired with the pixels of a frame after it.
 *
 * WebXR delivers nothing: the browsers the app supports do not give the page the camera image the XR session sees, and the
 * companion `getUserMedia` stream is another camera image with unknown intrinsics and no shared clock. The WebXR provider
 * answers `onCameraFrame` with {@link unsupportedCameraFeed}, so a flow can say so rather than wait.
 *
 * Browser-safe (ADR 0002), no DOM.
 */
import type { Pose } from './provider.ts'
import { DEFAULT_PIXEL_LAG_FRAMES, PoseHistory } from './fiducial/pose-history.ts'

/** How the camera frame is mapped onto the canvas (see `CameraFit` in eighthwall.ts): a consumer that needs the projection to describe the pixels refuses `'cover'`. */
export type CameraFit = 'contain' | 'cover'

/** One camera frame, with the pose and projection it goes with. The pixels are a copy the receiver owns. */
export interface CameraFrame {
  /** The frame's bytes, `rowBytes * height` of them. Owned by the receiver: it may be transferred to a worker. */
  pixels: Uint8Array
  /** Columns. */
  width: number
  /** Rows. */
  height: number
  /** Bytes from the start of one row to the next. */
  rowBytes: number
  /** 4 for RGBA (what the app configures), 1 for a luma plane. */
  channels: 1 | 4
  /** The runtime's frame time for the tick that delivered these pixels, milliseconds. */
  timestampMs: number
  /** The camera pose to pair with these pixels: the newest tick's pose, or one `lagFrames` ticks older. */
  pose: Pose
  /** The frame time of `pose`, milliseconds. */
  poseTimestampMs: number
  /** How many ticks older than the newest `pose` is. The subscriber asked for it; see `PoseHistory`. */
  lagFrames: number
  /** When the subscriber asked for them: the newest poses, newest first (index 0 is this tick's), so a consumer can try other lags. */
  recentPoses?: Pose[]
  /** The runtime's projection matrix for this tick, 16 numbers, column-major (a copy). */
  projection: number[]
  /** Counts the frames delivered to this subscriber, from 0. */
  frameIndex: number
  /** The runtime's frame epoch. Frames either side of a change are not in one frame of reference. */
  epoch: number
  /** The runtime's own tracking status for the tick, as it spelled it. */
  trackingStatus: string
  /** How fast the camera turned between the newest two ticks, degrees per second. Null on the first. */
  angularSpeedDegPerS: number | null
  /** What the canvas and the fit were, for a consumer that checks the projection describes these pixels. */
  display?: { canvasWidth: number; canvasHeight: number; fit: CameraFit }
}

export interface CameraFrameOptions {
  /** The most frames per second to deliver. From 1 to 30: a marker detector needs 5 to 10. */
  maxHz: number
  /** Ticks the pixels are assumed to trail the newest pose by. Default `DEFAULT_PIXEL_LAG_FRAMES`. A whole number from 0 to 8. */
  lagFrames?: number
  /** Attach the newest this-many poses (1 to 9) as `recentPoses`. Off by default; the DX8 lag fit asks for it. */
  recentPoses?: number
}

/** Why a feed will never deliver, so a flow can say so. */
export type CameraFrameUnsupportedReason =
  /** WebXR: the session does not give the page the camera image (no `camera-access`), and the companion stream is not paired with the XR pose. */
  | 'webxr-no-camera-access'
  /** The provider has no `onCameraFrame` at all: the native provider, while its ScanAR session runs (src/ar/native.ts). */
  | 'no-frame-feed'

export interface CameraFrameSubscription {
  /** `'active'`: frames will come, when the runtime runs and the history is deep enough. `'unsupported'`: none ever will. */
  readonly status: 'active' | 'unsupported'
  readonly reason: CameraFrameUnsupportedReason | null
  /** Stop delivery. Safe to call more than once. */
  unsubscribe(): void
}

/** What a feed that will never deliver answers `onCameraFrame` with. */
export function unsupportedCameraFeed(reason: CameraFrameUnsupportedReason): CameraFrameSubscription {
  return { status: 'unsupported', reason, unsubscribe() {} }
}

/** What the provider hands the feed each tick. Everything about the pixels is lazy: the feed reads `pixelArray` only for a due subscriber. */
export interface EngineTick {
  /** The runtime's frame time for the tick, milliseconds. */
  timestampMs: number
  /** The camera has no new image this tick: the pose and pixels are the last tick's again. */
  repeatFrame: boolean
  /** This tick's camera pose, or null when there is none. */
  pose: Pose | null
  /** False when the pose is one the runtime is holding over because it has none for this tick. */
  poseCurrent: boolean
  epoch: number
  trackingStatus: string
  /** The projection matrix as the runtime published it (16 numbers, column-major), or null. */
  projection: ArrayLike<number> | null
  /** The runtime's pixel array: `{ pixels, rows, cols, rowBytes? }`. Not read unless a subscriber is due. */
  pixelArray: unknown
  display?: { canvasWidth: number; canvasHeight: number; fit: CameraFit }
}

/** Counters for a device run: why a frame did or did not come, and what it cost. */
export interface CameraFeedStats {
  ticks: number
  repeatFrames: number
  heldPose: number
  /** Due ticks whose pixel array was missing or not a usable array. */
  noPixels: number
  /** Due ticks with no usable projection. */
  noProjection: number
  /** Due ticks for which the pose history was not deep enough for the lag asked for. */
  unpaired: number
  delivered: number
  copiedBytes: number
  /** Milliseconds spent copying, summed. */
  copyMs: number
  callbackErrors: number
}

interface Subscriber {
  cb: (frame: CameraFrame) => void
  intervalMs: number
  lagFrames: number
  recentPoses: number
  lastAtMs: number | null
  frameIndex: number
}

/** Frames this close to the interval count as due: a 10 Hz subscriber on a 30 Hz runtime gets every third frame, not every fourth when the clock rounds down. Milliseconds. Adopted, not measured. */
const DUE_TOLERANCE_MS = 1
/** The most ticks a lag or a list of recent poses may reach back. */
const MAX_LAG_FRAMES = 8
/** Poses kept: the deepest lag, the longest `recentPoses` and the pair used for the speed. */
const HISTORY_CAPACITY = MAX_LAG_FRAMES + 3

function emptyStats(): CameraFeedStats {
  return { ticks: 0, repeatFrames: 0, heldPose: 0, noPixels: 0, noProjection: 0, unpaired: 0, delivered: 0, copiedBytes: 0, copyMs: 0, callbackErrors: 0 }
}

interface ReadPixels {
  pixels: Uint8Array | Uint8ClampedArray
  rows: number
  cols: number
  rowBytes: number
  channels: 1 | 4
}

/**
 * The pixel array of a runtime, if it is one: whole-numbered size, a byte array, rows no narrower than the format and the
 * array long enough to hold them. `rowBytes` says which format it is (`4 * cols` is RGBA, `cols` a luma plane), as
 * `imageFromCameraPixelArray` reads it, and a missing `rowBytes` is taken from the array's length.
 */
function readPixelArray(pa: unknown): ReadPixels | null {
  if (typeof pa !== 'object' || pa === null) return null
  const { pixels, rows, cols } = pa as { pixels?: unknown; rows?: unknown; cols?: unknown }
  const given = (pa as { rowBytes?: unknown }).rowBytes
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) return null
  if (typeof rows !== 'number' || typeof cols !== 'number' || !Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return null
  const rowBytes = typeof given === 'number' && Number.isInteger(given) && given > 0 ? given : pixels.length >= rows * cols * 4 ? cols * 4 : cols
  const channels: 1 | 4 | null = rowBytes >= cols * 4 ? 4 : rowBytes >= cols ? 1 : null
  if (channels === null || pixels.length < rowBytes * rows) return null
  return { pixels, rows, cols, rowBytes, channels }
}

function readProjection(p: ArrayLike<number> | null): number[] | null {
  if (!p || p.length < 16) return null
  const out: number[] = []
  for (let i = 0; i < 16; i++) {
    const v = p[i]!
    if (!Number.isFinite(v)) return null
    out.push(v)
  }
  return out
}

export class CameraFrameFeed {
  private subs: Subscriber[] = []
  private history = new PoseHistory(HISTORY_CAPACITY)
  private epoch: number | null = null
  readonly stats: CameraFeedStats = emptyStats()

  /** Whether anybody is subscribed. A provider checks this before it builds an {@link EngineTick}. */
  get active(): boolean {
    return this.subs.length > 0
  }

  /**
   * Deliver frames to `cb` at up to `options.maxHz`. A frame is delivered only when the tick is due, has a pose that is this
   * tick's, a projection and a pixel array, and the history is `lagFrames` deep. `cb` runs inside the provider's tick: it must
   * return quickly (copy nothing, post to a worker) and a throw is caught and counted, never allowed into the runtime.
   */
  subscribe(cb: (frame: CameraFrame) => void, options: CameraFrameOptions): CameraFrameSubscription {
    const { maxHz } = options
    if (!Number.isFinite(maxHz) || maxHz < 1 || maxHz > 30) throw new RangeError(`maxHz ${maxHz} is not from 1 to 30`)
    const lag = options.lagFrames ?? DEFAULT_PIXEL_LAG_FRAMES
    if (!Number.isInteger(lag) || lag < 0 || lag > MAX_LAG_FRAMES) throw new RangeError(`lagFrames ${lag} is not a whole number from 0 to ${MAX_LAG_FRAMES}`)
    const recent = options.recentPoses ?? 0
    if (!Number.isInteger(recent) || recent < 0 || recent > MAX_LAG_FRAMES + 1) throw new RangeError(`recentPoses ${recent} is not a whole number from 0 to ${MAX_LAG_FRAMES + 1}`)
    const sub: Subscriber = { cb, intervalMs: 1000 / maxHz, lagFrames: lag, recentPoses: recent, lastAtMs: null, frameIndex: 0 }
    this.subs.push(sub)
    let live = true
    return {
      status: 'active',
      reason: null,
      unsubscribe: () => {
        if (!live) return
        live = false
        const at = this.subs.indexOf(sub)
        if (at >= 0) this.subs.splice(at, 1)
        if (this.subs.length === 0) this.forget()
      },
    }
  }

  /** Forget the poses and the epoch (a session ended); subscriptions stay. */
  reset(): void {
    this.forget()
    for (const s of this.subs) {
      s.lastAtMs = null
      s.frameIndex = 0
    }
  }

  private forget(): void {
    this.history.clear()
    this.epoch = null
  }

  /** One runtime tick. Leaves at once with nobody subscribed. */
  offer(tick: EngineTick): void {
    if (this.subs.length === 0) return
    const stats = this.stats
    stats.ticks++
    if (tick.repeatFrame) {
      stats.repeatFrames++
      return
    }
    if (!tick.pose || !tick.poseCurrent) {
      stats.heldPose++
      // The poses on either side of a tick the runtime had none for are not neighbours: the pose "a frame ago" of the first tick after a gap is not the one
      // before the gap, which may be a second old and a long way back. The history starts again, and the lagged frames wait for it to fill.
      this.history.clear()
      return
    }
    // Poses from either side of a frame shift are not in one frame of reference, so the history starts again.
    if (this.epoch !== null && tick.epoch !== this.epoch) this.history.clear()
    this.epoch = tick.epoch
    this.history.push(tick.pose, tick.timestampMs)

    // Who is due. Nothing past this point runs for a tick nobody is due on.
    const due = this.subs.filter((s) => s.lastAtMs === null || tick.timestampMs - s.lastAtMs >= s.intervalMs - DUE_TOLERANCE_MS)
    if (due.length === 0) return

    const read = readPixelArray(tick.pixelArray)
    if (!read) {
      stats.noPixels++
      return
    }
    const projection = readProjection(tick.projection)
    if (!projection) {
      stats.noProjection++
      return
    }
    const speed = this.history.angularSpeedDegPerS()
    const bytes = read.rowBytes * read.rows
    for (const sub of due) {
      const paired = this.history.pairedSample(sub.lagFrames)
      if (!paired) {
        stats.unpaired++
        continue
      }
      const t0 = performance.now()
      const copy = new Uint8Array(bytes)
      copy.set(read.pixels.subarray(0, bytes))
      stats.copyMs += performance.now() - t0
      stats.copiedBytes += bytes
      const frame: CameraFrame = {
        pixels: copy,
        width: read.cols,
        height: read.rows,
        rowBytes: read.rowBytes,
        channels: read.channels,
        timestampMs: tick.timestampMs,
        pose: paired.pose,
        poseTimestampMs: paired.timestampMs,
        lagFrames: sub.lagFrames,
        projection: projection.slice(),
        frameIndex: sub.frameIndex,
        epoch: tick.epoch,
        trackingStatus: tick.trackingStatus,
        angularSpeedDegPerS: speed,
      }
      if (sub.recentPoses > 0) frame.recentPoses = this.history.newest(sub.recentPoses).map((s) => s.pose)
      if (tick.display) frame.display = { ...tick.display }
      sub.lastAtMs = tick.timestampMs
      sub.frameIndex++
      stats.delivered++
      try {
        sub.cb(frame)
      } catch (error) {
        stats.callbackErrors++
        console.warn('[camera-frame-feed] a subscriber threw:', error)
      }
    }
  }
}
