export const CAPTURE_GUIDANCE = {
  'tracking-interrupted': 'Tracking was interrupted: parts may be shifted',
  'closure-gap': 'A drift check found a gap: parts may be shifted',
  'tracking-not-started': 'Tracking has not started: wait for it, then scan',
  'tracking-lost': 'Tracking is lost: hold still until it returns',
  'low-point-count': 'Collect more tracking points before export',
  'low-coverage': 'Sweep the room more slowly',
  'sparse-floor': 'Rescan sparse floor areas from another angle',
  'too-dark': 'Too dark to track: turn on a light and rescan',
  'low-light': 'Add light, or check the dark surfaces',
  'fast-motion': 'Move slower to reduce drift',
  'reflective-surfaces': 'Review reflective surfaces for false geometry',
  'no-uploaded-keyframe': 'No camera frame has reached your server yet',
} as const

export type CaptureGuidanceCode = keyof typeof CAPTURE_GUIDANCE

export function readCaptureGuidanceCodes(value: unknown): CaptureGuidanceCode[] | undefined {
  if (!Array.isArray(value)) return undefined
  return [...new Set(value.filter((code): code is CaptureGuidanceCode =>
    typeof code === 'string' && Object.hasOwn(CAPTURE_GUIDANCE, code),
  ))]
}
