/**
 * Runs a detector on one frame at a time, searching only around where the tag was last seen once it has been found.
 *
 * This is the part of marker reading that is the same in a Web Worker (`tag-worker.ts`) and on the main thread (the fallback
 * in `tag-worker-client.ts`): the same object, so a frame gives the same answer in either. Pure, no DOM, no clock of its own.
 *
 * ## The detector is behind a seam
 *
 * {@link TagDetector} is all the runner needs of a detector: `detect(image)` and the counters of the last call. The in-house
 * `FiducialDetector` is one; the AprilTag build the WP-14b spec keeps as a contingency (if DX8 says the in-house one is not
 * good enough) would be another, wrapped to this shape, and nothing else in marker reading would change.
 *
 * ## The region of interest
 *
 * After a frame in which a tag was found, the next frames are searched only in a window around it, which is cheaper (the
 * detector's cost follows the pixels it is given) and finds the same tag. The window is the box around every detection's corners,
 * grown by a margin of `ROI_PAD_FRACTION` of the biggest quad side (never less than `ROI_MIN_PAD_PX`), because a phone swept
 * past a tag moves it tens of pixels between frames at 5 to 10 Hz. It is cut out without copying: the crop is a view of the
 * same bytes with the same row stride. A search of the window that finds nothing is followed, in the same call, by a search of
 * the whole frame, so a lost tag is found again in the frame it reappears in; after `ROI_MAX_MISSES` such misses in a row the window
 * is dropped and every frame is searched whole until something is found. A window that would cover most of the frame is not
 * worth having and is not used.
 *
 * Corners come back in FULL-FRAME pixels whichever way the frame was searched.
 */
import type { DetectorStats } from './detector.ts'
import type { FiducialDetection, FiducialImage } from './types.ts'

/** Anything that finds tags in a frame. The in-house `FiducialDetector` is one. */
export interface TagDetector {
  detect(image: FiducialImage): FiducialDetection[]
  /** Counters for the last `detect()`. */
  readonly stats: DetectorStats
}

/** The margin of the search window, as a fraction of the biggest quad side in it. Adopted, not measured (ADR 0005 rule 5): a sweep at 30 degrees a second at 10 Hz moves a tag about 40 px between frames. */
export const ROI_PAD_FRACTION = 1
/** The margin is never less than this, pixels. Adopted, not measured. */
export const ROI_MIN_PAD_PX = 48
/** Searches of the window that may find nothing, in a row, before it is dropped. Adopted, not measured. */
export const ROI_MAX_MISSES = 2
/** A window covering more of the frame than this is not used: the saving is not worth the chance of cutting the tag. Adopted, not measured. */
export const ROI_MAX_AREA_FRACTION = 0.6
/** Smallest window, pixels on a side: the detector reads nothing under 16. */
const ROI_MIN_SIDE_PX = 64

/** A rectangle of the frame, pixels. */
export interface RoiRect {
  x: number
  y: number
  width: number
  height: number
}

export interface TagRunResult {
  /** The tags read, best first, corners in full-frame pixels. */
  detections: FiducialDetection[]
  /** The counters of the pass that produced `detections` (the last pass). */
  stats: DetectorStats
  /** The window that produced them, or null for a search of the whole frame. */
  roi: RoiRect | null
  /** A window was searched, found nothing, and the whole frame was searched after it. */
  roiMissed: boolean
  /** Searches made: 1, or 2 after a miss. */
  passes: number
  /** Milliseconds spent in the detector, all passes. */
  detectMs: number
  width: number
  height: number
}

export interface TagRunnerOptions {
  /** Search around the last tag found. Default true. */
  roi?: boolean
  /** A millisecond clock. Default `performance.now()`. */
  now?: () => number
}

/** A view of `image` limited to `rect`: the same bytes, the same row stride, no copy. */
export function cropImage(image: FiducialImage, rect: RoiRect): FiducialImage {
  const rowBytes = image.rowBytes ?? image.width * image.channels
  const offset = rect.y * rowBytes + rect.x * image.channels
  return { data: image.data.subarray(offset), width: rect.width, height: rect.height, channels: image.channels, rowBytes }
}

/** The window to search next, around these detections, or null when it would not be worth one. */
export function roiAround(detections: readonly FiducialDetection[], frame: { width: number; height: number }): RoiRect | null {
  if (detections.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let side = 0
  for (const d of detections) {
    side = Math.max(side, d.sidePx)
    for (const c of d.corners) {
      x0 = Math.min(x0, c.x)
      y0 = Math.min(y0, c.y)
      x1 = Math.max(x1, c.x)
      y1 = Math.max(y1, c.y)
    }
  }
  const pad = Math.max(ROI_PAD_FRACTION * side, ROI_MIN_PAD_PX)
  const left = Math.max(0, Math.floor(x0 - pad))
  const top = Math.max(0, Math.floor(y0 - pad))
  const right = Math.min(frame.width, Math.ceil(x1 + pad))
  const bottom = Math.min(frame.height, Math.ceil(y1 + pad))
  const width = right - left
  const height = bottom - top
  if (width < ROI_MIN_SIDE_PX || height < ROI_MIN_SIDE_PX) return null
  if (width * height > ROI_MAX_AREA_FRACTION * frame.width * frame.height) return null
  return { x: left, y: top, width, height }
}

function translate(d: FiducialDetection, dx: number, dy: number): FiducialDetection {
  if (dx === 0 && dy === 0) return d
  const c = d.corners
  return { ...d, corners: [{ x: c[0].x + dx, y: c[0].y + dy }, { x: c[1].x + dx, y: c[1].y + dy }, { x: c[2].x + dx, y: c[2].y + dy }, { x: c[3].x + dx, y: c[3].y + dy }] }
}

export class TagRunner {
  private readonly detector: TagDetector
  private readonly useRoi: boolean
  private readonly now: () => number
  private window: RoiRect | null = null
  private misses = 0

  constructor(detector: TagDetector, options: TagRunnerOptions = {}) {
    this.detector = detector
    this.useRoi = options.roi ?? true
    this.now = options.now ?? (() => performance.now())
  }

  /** The window the next frame will be searched in first, or null. */
  get roi(): RoiRect | null {
    return this.window
  }

  /** Forget where the tag was: the next frame is searched whole. */
  reset(): void {
    this.window = null
    this.misses = 0
  }

  run(image: FiducialImage): TagRunResult {
    let detectMs = 0
    let passes = 0
    let roiMissed = false
    const timed = (img: FiducialImage): FiducialDetection[] => {
      const t0 = this.now()
      const found = this.detector.detect(img)
      detectMs += this.now() - t0
      passes++
      return found
    }

    if (this.useRoi && this.window) {
      const win = this.window
      const found = timed(cropImage(image, win)).map((d) => translate(d, win.x, win.y))
      if (found.length > 0) {
        this.misses = 0
        this.window = roiAround(found, image)
        return { detections: found, stats: this.detector.stats, roi: win, roiMissed: false, passes, detectMs, width: image.width, height: image.height }
      }
      roiMissed = true
      this.misses++
      if (this.misses > ROI_MAX_MISSES) this.window = null
    }

    const whole = timed(image)
    if (whole.length > 0) {
      // Found: the next search is round where it was found. Not found: the window the miss left stands until it has missed too often (above).
      this.window = this.useRoi ? roiAround(whole, image) : null
      this.misses = 0
    }
    return { detections: whole, stats: this.detector.stats, roi: null, roiMissed, passes, detectMs, width: image.width, height: image.height }
  }
}
