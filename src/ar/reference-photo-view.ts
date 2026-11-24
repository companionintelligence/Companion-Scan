/**
 * Showing a stored reference photo with its crosshair, the one way the calibration card's single photo
 * (./project-calibration.ts) and the return visit's two photos (./return-visit-aids.ts) both show one (wave 14, ticket
 * 0004; F-40, FN-037).
 *
 * What each panel says while a photo loads, or when it cannot, stays with the panel, and so does what makes a result
 * stale (the card has moved to another marker, or the modal has gone). This is the part they shared:
 *  - a loader that throws before it returns a promise is a loader that failed, as one that rejects or answers nothing is;
 *  - a picture that arrives after nobody wants it is not shown, and a blob URL for it is revoked, since nobody holds it
 *    (the page's loader makes a fresh object URL every call, src/main.ts);
 *  - a blob URL that is shown is handed to the panel to release when it closes; a data URL or a plain path is not one;
 *  - the crosshair is placed once the picture is in the element, and again when it finishes loading, from where the
 *    picture sits in its figure (`referenceCrosshairPixels`, ./reference-photo.ts).
 */
import type { CalibrationReferencePhoto } from '../world/types.ts'
import { referenceCrosshairPixels } from './reference-photo.ts'

/** What the page supplies to read a stored photo: a URL to show, or null when there is none to show. */
export type ReferencePhotoLoader = (photo: CalibrationReferencePhoto) => Promise<string | null>

/** The parts of an image element the crosshair is placed from. */
export interface PictureBox {
  clientWidth: number
  clientHeight: number
  offsetLeft?: number
  offsetTop?: number
}

/**
 * Places `cross` over the spot `tapPoint` names on `img`. The crosshair is in the figure's own space, and a picture held
 * to less than the figure's width is centred in it, so the picture's own offset in the figure is added. Where the
 * picture fills its figure, as the card's single photo does, that offset is 0.
 */
export function placeReferenceCrosshair(
  cross: { style: { left: string; top: string } },
  img: PictureBox,
  tapPoint: { x: number; y: number },
): void {
  const { left, top } = referenceCrosshairPixels(tapPoint, { width: img.clientWidth, height: img.clientHeight })
  cross.style.left = `${(img.offsetLeft ?? 0) + left}px`
  cross.style.top = `${(img.offsetTop ?? 0) + top}px`
}

export interface LoadReferencePhotoOptions {
  photo: CalibrationReferencePhoto
  load: ReferencePhotoLoader
  /** The element the picture goes in. Null when the panel has none, which shows nothing and is a failure. */
  img: { src: string; onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null } | null
  /** Whether the picture is still wanted when it arrives: false once the panel has moved on or gone. */
  isCurrent: () => boolean
  /** Takes a shown blob URL, for the panel to revoke when it closes. */
  keepObjectUrl: (url: string) => void
  /**
   * Shows the figure, and hides whatever the panel said while it waited. Called after the picture is in the element and
   * before the crosshair is placed: a hidden picture has no size to place it by.
   */
  reveal: () => void
  /** Places the crosshair over the picture. Called once it is shown, and again when it finishes loading. */
  placeCrosshair: () => void
}

/**
 * Loads `photo` through `load` and, while it is still wanted, puts it in `img`, shows it and places the crosshair.
 * Resolves `'shown'`, `'failed'` (the loader threw, rejected or answered nothing, or there is no element to show it in)
 * or `'stale'` (no longer wanted when it came). Never rejects.
 */
export async function loadReferencePhotoInto(options: LoadReferencePhotoOptions): Promise<'shown' | 'failed' | 'stale'> {
  const src = await Promise.resolve()
    .then(() => options.load(options.photo))
    .catch(() => null)
  const img = options.img
  const current = options.isCurrent()
  if (!current || !img || !src) {
    // Nobody will show it: a blob URL nobody holds is released here, and not left to leak.
    if (src && src.startsWith('blob:')) URL.revokeObjectURL(src)
    return current ? 'failed' : 'stale'
  }
  // Blob URLs are ours to release; a data URL or a plain path is not.
  if (src.startsWith('blob:')) options.keepObjectUrl(src)
  img.onload = () => options.placeCrosshair()
  img.src = src
  options.reveal()
  options.placeCrosshair()
  return 'shown'
}
