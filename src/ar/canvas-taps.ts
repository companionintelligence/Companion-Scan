/**
 * A single tap on the AR canvas, read the one way the calibration card (./project-calibration.ts) and the re-anchor
 * banner (./reanchor-banner.ts) both read it (wave 14, ticket 0004; F-40, FN-037).
 *
 * One finger on a touchscreen fires `touchstart` and then `pointerdown` for the same tap, so `pointerdown` skips touch:
 * one tap is one call. A controller-driven runtime (WebXR's dom-overlay on a Quest) has no touchscreen and synthesizes
 * pointer events from a ray and a select, which is what `pointerdown` is kept for. A two-finger touch is a pinch or a
 * recenter elsewhere in this app, not a tap. Neither listener calls `preventDefault`: the tap is for whoever else
 * listens, and `touchstart` is passive.
 *
 * What a tap may do is each caller's to decide (a tap already in flight, tracking that is not good enough): this only says
 * where one landed.
 */

/** Listens for single taps on `canvas` and calls `onTap` with the client coordinates of each. Returns the remover. */
export function listenForCanvasTaps(canvas: EventTarget, onTap: (clientX: number, clientY: number) => void): () => void {
  const onTouchStart = (event: Event): void => {
    const touches = (event as TouchEvent).touches
    const touch = touches?.[0]
    if (touches?.length !== 1 || !touch) return
    onTap(touch.clientX, touch.clientY)
  }
  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent
    if (pointer.pointerType === 'touch') return
    onTap(pointer.clientX, pointer.clientY)
  }
  canvas.addEventListener('touchstart', onTouchStart, { passive: true })
  canvas.addEventListener('pointerdown', onPointerDown)
  return () => {
    canvas.removeEventListener('touchstart', onTouchStart)
    canvas.removeEventListener('pointerdown', onPointerDown)
  }
}

/** Client coordinates as fractions of `element`'s box: 0,0 at its top left and 1,1 at its bottom right. */
export function fractionOfBox(element: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }, clientX: number, clientY: number): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height }
}
