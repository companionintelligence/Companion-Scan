import { SW_SYNC_TAG } from './shared/storage-keys'
import { whenPageLoaded } from './shared/page-load'
import { showQueueNotice, type QueueMessage } from './ui/queue-notice.ts'

export function registerPWA(options: { flushQueue?: boolean } = {}): void {
  // Only a page that owns the scan store flushes the offline queue. A read-only
  // scanner tab passes flushQueue: false, so it cannot resend a writer's uploads.
  const flushQueue = options.flushQueue !== false
  // The native shell is built with VITE_DISABLE_PWA set; see pwaSwitch() in vite.config.ts.
  if (import.meta.env.VITE_DISABLE_PWA) return
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (!window.isSecureContext) return

  // Not a bare 'load' listener: the scanner awaits its writer-role check before it calls this, so the
  // page may already have loaded, and a listener added after `load` never runs (see shared/page-load.ts).
  whenPageLoaded(window, document, () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((registration) => {
        const flush = () => {
          const syncRegistration = registration as ServiceWorkerRegistration & {
            sync?: { register(tag: string): Promise<void> }
          }
          registration.active?.postMessage({ type: 'flushQueue' })
          syncRegistration.sync?.register(SW_SYNC_TAG).catch(() => {
            // Background Sync is not available in every browser, especially iOS.
          })
        }
        if (flushQueue) {
          window.addEventListener('online', flush)
          flush()
        }
      })
      .catch((error) => {
        console.warn('[pwa] Service worker registration failed:', error)
      })
  })

  // registerPWA() runs in two documents — scanner (index.html) and the editor (viewer.html, via
  // src/viewer.ts) — and only the scanner has #autosave-status and #status-text, so showQueueNotice()
  // writes what a document has and nothing else. Its words are the ones the page's own queue uses in a
  // native shell (src/page-upload-queue.ts), so the two cannot drift (FN-011), and the status line is
  // written through its hold (FN-010).
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as QueueMessage | undefined
    if (!data?.type) return
    showQueueNotice(data)
  })
}
