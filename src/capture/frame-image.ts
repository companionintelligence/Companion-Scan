/**
 * A camera frame's image, the way the capture code makes one (wave 14, ticket 0004; F-40, FN-032): the downscaled JPEG
 * the capture button (./capture.ts) and the keyframe streamer (./keyframes.ts) each encoded for themselves, with the
 * same defaults, and the data URL a blob becomes, which ./capture.ts and src/inference/router.ts each wrote out.
 *
 * The one difference between the two encoders is kept as an option, not flattened: the capture button re-encodes once at
 * a lower quality when its first pass is too big for the inference request (`fallback`); a keyframe never does.
 *
 * Browser APIs only (ImageData, createImageBitmap, OffscreenCanvas, FileReader), read when a function runs and not when
 * the module loads, so the Node tests import it and supply stand-ins.
 */

/** Frames are downscaled so the long edge is at most this, in pixels: both encoders' default. */
export const FRAME_JPEG_MAX_LONG_EDGE_PX = 1280

/** JPEG quality, 0-1: both encoders' default. */
export const FRAME_JPEG_QUALITY = 0.8

/** The size a `width` x `height` frame is encoded at, so that its long edge is at most `maxLongEdgePx`. Never larger than it was. */
export function fitLongEdge(width: number, height: number, maxLongEdgePx: number): { width: number; height: number } {
  const scale = Math.min(1, maxLongEdgePx / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

export interface FrameJpegOptions {
  /** Long edge, in pixels. Default {@link FRAME_JPEG_MAX_LONG_EDGE_PX}. */
  maxLongEdgePx?: number
  /** JPEG quality, 0-1. Default {@link FRAME_JPEG_QUALITY}. */
  quality?: number
  /** Re-encode once at `quality` when the first pass is larger than `maxBytes`. Absent: one pass, whatever its size. */
  fallback?: { maxBytes: number; quality: number }
}

/**
 * Raw RGBA pixels as a downscaled JPEG. The pixels are copied before use (into a plain ArrayBuffer, which the ImageData
 * constructor needs), so a buffer the runtime reuses is not read after this returns.
 */
export async function encodeFrameJpeg(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  options: FrameJpegOptions = {},
): Promise<Blob> {
  const maxLongEdgePx = options.maxLongEdgePx ?? FRAME_JPEG_MAX_LONG_EDGE_PX
  const quality = options.quality ?? FRAME_JPEG_QUALITY
  const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height)
  const bitmap = await createImageBitmap(imageData)
  const size = fitLongEdge(width, height, maxLongEdgePx)
  const oc = new OffscreenCanvas(size.width, size.height)
  const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0, size.width, size.height)
  bitmap.close()
  let blob = await oc.convertToBlob({ type: 'image/jpeg', quality })
  if (options.fallback && blob.size > options.fallback.maxBytes) {
    blob = await oc.convertToBlob({ type: 'image/jpeg', quality: options.fallback.quality })
  }
  return blob
}

/** A blob as a `data:` URL. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
