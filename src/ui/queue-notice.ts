/**
 * What the page says about the offline upload queue, whichever queue it was: the service worker's
 * (public/sw.js, through src/pwa.ts's message listener) or the page's own in a native shell
 * (src/page-upload-queue.ts). One table of words for both.
 *
 * FN-011: every queued write used to read "Offline - scan queued for sync", the keyframe uploads, Place
 * writes and processing requests included, and every one wrote "Saved offline - sync pending" into the
 * scan's autosave line. A queued write is now named by its kind. The worker records the kind in the
 * message, and in the queue id for a worker from before that. Only a scan upload touches the autosave
 * line, because only a scan upload is the scan being saved.
 *
 * FN-010: the status line is written through writeStatus() (./status-line.ts), so its hold applies.
 * A loss (dropped, gave up, rejected, not stored) is 'sticky', because it is an event the person must
 * be able to read. A queued or synced write is 'normal', so it does not hide a capture result that
 * just arrived; the autosave line carries the scan's state either way.
 */
import { queueKindOfId, type QueueKind } from '../page-upload-queue.ts'
import { writeStatus, type StatusPriority } from './status-line.ts'

/** The fields of a queue message this module reads. Both queues post this shape. */
export interface QueueMessage {
  type?: string
  queueId?: string
  kind?: string
  status?: number
  message?: string
}

export interface QueueNoticeLines {
  /** For #autosave-status, the scan's save line. Absent when the message is not about the scan. */
  autosave?: string
  /** For #status-text. Absent when the status line has nothing to add. */
  status?: string
  priority: StatusPriority
}

/** What a queued write of each kind is called in the status line. */
const QUEUED_STATUS: Record<QueueKind, string> = {
  scan: 'Offline — scan saved on this device\n• It syncs when you are back online',
  summary: 'Offline — summary saved on this device\n• It syncs when you are back online',
  session: 'Offline — camera frames held\n• They are sent when you are back online',
  place: 'Offline — Place change saved\n• It syncs when you are back online',
  world: 'Offline — editor change saved\n• It syncs when you are back online',
  process: 'Offline — processing request held\n• It runs when you are back online',
  other: 'Offline — upload saved on this device\n• It syncs when you are back online',
}

/** The kind a message is about: the one it names, else the one in its queue id, else 'other'. */
export function noticeKind(message: QueueMessage): QueueKind {
  if (message.kind && Object.prototype.hasOwnProperty.call(QUEUED_STATUS, message.kind)) return message.kind as QueueKind
  return message.queueId ? queueKindOfId(message.queueId) : 'other'
}

/** The lines a queue message puts on screen, or null for a message that is not a queue notice. */
export function queueNoticeLines(message: QueueMessage): QueueNoticeLines | null {
  const kind = noticeKind(message)
  const aboutScan = kind === 'scan'
  switch (message.type) {
    case 'offline-queued':
      return { autosave: aboutScan ? 'Saved offline - sync pending' : undefined, status: QUEUED_STATUS[kind], priority: 'normal' }
    case 'offline-flushed':
      // sw.js only posts this for a delivered upload now; an older worker still controlling the page can post a 4xx through it.
      if (typeof message.status === 'number' && message.status >= 400) {
        return { autosave: 'Sync needs review', status: `Queued upload rejected (${message.status})`, priority: 'sticky' }
      }
      return { autosave: aboutScan ? 'Offline scan synced' : undefined, priority: 'normal' }
    case 'offline-queue-failed':
      return { autosave: 'Not saved - storage full', status: message.message ?? 'Could not save this upload for later - device storage is full.', priority: 'sticky' }
    case 'offline-dropped':
      return { autosave: 'Queue full - oldest uploads dropped', status: message.message ?? 'Dropped queued upload(s) - the offline queue is full.', priority: 'sticky' }
    case 'offline-gave-up':
      return { autosave: 'Upload failed - not synced', status: message.message ?? 'Gave up on a queued upload after repeated failures.', priority: 'sticky' }
    case 'offline-rejected':
      return { autosave: 'Upload rejected - not synced', status: message.message ?? 'The server rejected a queued upload - it could not be saved.', priority: 'sticky' }
    default:
      return null
  }
}

/**
 * Show a queue message. The scanner (index.html) has both lines. The editor (viewer.html) has neither,
 * so there nothing is shown, rather than the listener throwing.
 */
export function showQueueNotice(message: QueueMessage): void {
  const lines = queueNoticeLines(message)
  if (!lines) return
  if (lines.autosave !== undefined) {
    const autosave = document.getElementById('autosave-status')
    if (autosave) autosave.textContent = lines.autosave
  }
  if (lines.status !== undefined) writeStatus(document.getElementById('status-text'), lines.status, lines.priority)
}
