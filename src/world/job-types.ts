/**
 * Which world jobs need a scan (F-24).
 *
 * A job of these types reads one scan's files: its GLB, its session's keyframes, or its sidecars. Queued with no
 * scan it has nothing to read. The server refuses such a job (`jobFailureReason` in server/main.ts), and the
 * editor's Advanced queue asks for a selected scan before it sends one.
 *
 * One list for both (ADR 0001). The server's own list is still an inline array beside `jobFailureReason`; this is
 * that array plus `sensenova-vision`, `panoptic-scan` and `panoptic-lift`, which read a scan's session as well and
 * were missing from it, so they failed with a TypeError instead of a sentence. The server can import this constant
 * in place of its copy.
 *
 * Browser-safe on purpose (ADR 0002): no Node or DOM references.
 */
import type { WorldJobType } from './types.ts'

export const SCAN_REQUIRED_JOB_TYPES: readonly WorldJobType[] = [
  'align-scan',
  'extract-layers',
  'semantic-pass',
  'depth-reconstruct',
  'lingbot-map-reconstruct',
  'colmap-poses',
  'splat-train',
  'splat-align',
  'splat-detect',
  'splat-finish',
  'memory-push',
  'person-4d-reconstruct',
  'thing-interactive-asset',
  'place-register',
  'sensenova-vision',
  'panoptic-scan',
  'panoptic-lift',
]

/** Whether a job of `type` needs a scan to run. */
export function jobRequiresScan(type: string): boolean {
  return (SCAN_REQUIRED_JOB_TYPES as readonly string[]).includes(type)
}
