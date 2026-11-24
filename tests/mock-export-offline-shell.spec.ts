/**
 * The phone and desktop apps keep an upload made offline, and send it later (wave 14, ticket 0003, F-15).
 *
 * The apps have no service worker, so the scanner runs the worker's queue in the page there
 * (src/page-upload-queue.ts). This drives the real install, the real IndexedDB store and the real replay in a
 * browser: a Capacitor shell is faked before any page script runs (as tests/mock-native-ar.spec.ts does), the
 * worker is blocked so the page queue is the only queue, and the network is cut for /upload-scan.
 *
 * Run: npx playwright test --project=chromium-mock mock-export-offline-shell
 */
import { test, expect, type Page } from '@playwright/test'

// The page queue is the only queue here, as in an app: a worker would take the request first.
test.use({ serviceWorkers: 'block' })

/** The rows in the queue database the worker and the page queue share. */
function queuedRows(page: Page): Promise<Array<{ id: string, url: string, headers: Array<[string, string]> }>> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('companion-scan-offline-queue', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('requests', { keyPath: 'id' })
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('requests', 'readonly')
      const all = tx.objectStore('requests').getAll()
      all.onsuccess = () => {
        resolve(all.result.map((row: { id: string, url: string, headers: Array<[string, string]> }) => ({ id: row.id, url: row.url, headers: row.headers })))
        open.result.close()
      }
      all.onerror = () => reject(all.error)
    }
  }))
}

test.describe('an upload made offline in an app', () => {
  test.setTimeout(90_000)

  test('is kept in IndexedDB with the worker\'s answer, and sent once the network is back', async ({ page }) => {
    await page.addInitScript(() => {
      // An Android shell with no ScanAR plugin: the scanner takes the web runtime (?mock=xr8), and isNativeShell() is true.
      ;(window as unknown as Record<string, unknown>).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {},
      }
    })
    // Offline, for the scan upload only.
    let online = false
    let delivered = 0
    await page.route('**/upload-scan', async (route) => {
      if (!online) return route.abort('internetdisconnected')
      delivered += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ filename: 'room-scan.glb' }) })
    })

    await page.goto('/?mock=xr8')
    // The queue is installed during the boot, before the Start button is made ready.
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })

    const answer = await page.evaluate(async () => {
      const response = await fetch('/upload-scan', { method: 'POST', body: 'glb-bytes', headers: { Authorization: 'Bearer not-stored' } })
      return { status: response.status, queued: response.headers.get('X-Companion-Queued-Offline'), body: await response.json() }
    })
    expect(answer.status, 'the worker\'s answer for a queued write').toBe(202)
    expect(answer.queued).toBe('1')
    expect(answer.body).toMatchObject({ ok: false, queuedOffline: true })

    const rows = await queuedRows(page)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toMatch(/^\d+-scan-[a-z0-9]+$/)
    expect(rows[0]!.url).toMatch(/\/upload-scan$/)
    expect(rows[0]!.headers.map(([name]) => name.toLowerCase()), 'no token in IndexedDB').not.toContain('authorization')
    await expect(page.locator('#autosave-status')).toHaveText('Saved offline - sync pending')

    // Back online: the queue sends what it holds and empties.
    online = true
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => delivered, { timeout: 15_000 }).toBe(1)
    await expect.poll(async () => (await queuedRows(page)).length, { timeout: 15_000 }).toBe(0)
    await expect(page.locator('#autosave-status')).toHaveText('Offline scan synced')
  })
})
