/**
 * A Scan tap that lands before project selection is ready must not be lost.
 *
 * Regression: main() enables #start-ar-btn at the top of the boot, before it has
 * opened its IndexedDB stores and asked the server for the Place list (src/main.ts,
 * "Start-AR gesture gate"). The click handler answered a tap in that window with a
 * status line and nothing else, so the Place picker never opened and the person had
 * to tap again. On a quick machine the window is a few milliseconds and nobody sees
 * it; on a loaded one, or a slow phone, it is seconds, and about one start-AR spec in
 * 25 timed out waiting for #place-skip-btn.
 *
 * Timing cannot reproduce that reliably, so this holds the window open instead: an
 * init script keeps every IndexedDB open() from completing until the test releases
 * it. By then the button is enabled and its handler is live, which is the state a
 * real early tap meets.
 *
 * Run: npx playwright test --project=chromium-mock mock-start-tap-race
 */
import { test, expect, type Page } from '@playwright/test'

// Same mobile viewport as mock-ftue.spec.ts, the other spec about this screen.
test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

interface BootProbe {
  __releaseStoreOpens: () => void
  __pickerOpens: number
}

/**
 * Hold the stores closed until `releaseStores()`, and count Place picker opens.
 *
 * The two stores main() awaits before project selection is ready (the scan
 * database and the project database) wrap `indexedDB.open()` in a promise that
 * resolves from `request.onsuccess`. The request is the real one, so
 * `onupgradeneeded` still runs when it should (a schema that never gets created
 * would be a different bug) and only the success callback waits for the gate.
 *
 * Every open of the sheet asks the server for the Place list once, while the sheet
 * is showing; that is the one thing it does that cannot be done twice by accident,
 * so counting those requests counts the opens. `resolveInitialProject()` asks for
 * the same list too, but before the sheet exists, and is not counted.
 */
async function holdStoresAndCountPickerOpens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window as unknown as BootProbe
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    probe.__releaseStoreOpens = release
    probe.__pickerOpens = 0

    const realOpen = IDBFactory.prototype.open
    IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
      const request = realOpen.apply(this, args)
      let onsuccess: IDBOpenDBRequest['onsuccess'] = null
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        get: () => onsuccess,
        set: (handler: IDBOpenDBRequest['onsuccess']) => { onsuccess = handler },
      })
      request.addEventListener('success', (event) => {
        void gate.then(() => onsuccess?.call(request, event))
      })
      return request
    }

    const realFetch = window.fetch
    window.fetch = function (this: typeof globalThis, ...args: Parameters<typeof fetch>) {
      const target = args[0]
      const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url
      if (/\/projects$/.test(url) && document.getElementById('place-sheet')?.hidden === false) {
        probe.__pickerOpens += 1
      }
      return realFetch.apply(this, args)
    }
  })
}

const releaseStores = (page: Page) =>
  page.evaluate(() => (window as unknown as BootProbe).__releaseStoreOpens())

const pickerOpens = (page: Page) =>
  page.evaluate(() => (window as unknown as BootProbe).__pickerOpens)

test.describe('a Scan tap before project selection is ready', () => {
  test.setTimeout(90_000)

  test('is answered with the Place picker once selection is ready', async ({ page }) => {
    await holdStoresAndCountPickerOpens(page)
    await page.goto('/?mock=xr8')

    // Enablement is what marks the handler live (mock-ftue.spec.ts holds the button to
    // that). With the stores held it comes while project selection is not ready.
    const scan = page.locator('#start-ar-btn')
    await expect(scan).toBeEnabled({ timeout: 30_000 })
    await scan.click()

    // The tap landed in the window: the handler said so, and there is no sheet yet.
    // This much the old code did too, which is why it is asserted — a click that
    // reached the sheet-less handler is what makes the rest of the test mean something.
    await expect(page.locator('#status-text')).toContainText(/Preparing project/, { timeout: 5_000 })
    await expect(page.locator('#place-skip-btn')).toBeHidden()

    // The stores finish opening. The tap is still owed its answer.
    await releaseStores(page)
    await expect(page.locator('#place-skip-btn')).toBeVisible({ timeout: 15_000 })
  })

  test('twice opens one picker, and the next tap opens it again', async ({ page }) => {
    await holdStoresAndCountPickerOpens(page)
    await page.goto('/?mock=xr8')

    const scan = page.locator('#start-ar-btn')
    const skip = page.locator('#place-skip-btn')
    await expect(scan).toBeEnabled({ timeout: 30_000 })
    await scan.click()
    await scan.click()
    await expect(page.locator('#status-text')).toContainText(/Preparing project/, { timeout: 5_000 })
    await expect(skip).toBeHidden()

    await releaseStores(page)
    await expect(skip).toBeVisible({ timeout: 15_000 })
    // Both asks were issued in one go, so by the time the sheet shows, a second open
    // would already have counted itself.
    expect(await pickerOpens(page), 'the two early taps share one open').toBe(1)

    // The early taps are spent, not wedged in: Back closes the sheet, and a tap made
    // now, with project selection ready, opens it the way it always did.
    await page.locator('#place-back-btn').click()
    await expect(skip).toBeHidden()
    await scan.click()
    await expect(skip).toBeVisible({ timeout: 15_000 })
    expect(await pickerOpens(page), 'a live tap opens it once more').toBe(2)
  })
})
