/**
 * Desktop world-editor UI/UX flow screenshots (viewer.html).
 *
 * Drives the desktop editor through every structuring/processing surface and
 * writes documentation screenshots into ../docs/product/ui-flow/desktop/. These illustrate
 * ../docs/product/UX_FLOW.md Phases 2-4 (Structure / Process / Export-Share).
 *
 * Runs under the chromium-mock project. Needs Vite + mock-Deno up with a seeded
 * default world (npm run gen:test-data && SERVER_URL=<api> npm run seed:test-data):
 *   VITE_URL=https://localhost:5174 API_URL=http://localhost:8100 \
 *     npx playwright test --project=chromium-mock mock-ui-desktop
 */
import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SHOTS = join(process.cwd(), 'docs', 'ui-flow', 'desktop')

test.use({ viewport: { width: 1440, height: 900 } })

async function openEditor(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/viewer.html?world=default')
  await page.locator('#viewer-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  // Wait for the world to populate the scan list, then let GLBs stream + camera fit. A world with no scans is the
  // missing seed this spec's header names, and fails here by name rather than screenshotting an empty editor.
  await page.waitForFunction(() => document.querySelectorAll('.scan-item').length > 0, undefined, { timeout: 30_000 })
  await page.waitForTimeout(3500)
}

/** Open the toolbar's Views menu, where the render mode and the GIS map live (viewer.html #view-menu). */
async function openViews(page: import('@playwright/test').Page): Promise<void> {
  const menu = page.locator('#view-menu')
  if (!(await menu.evaluate((node) => (node as HTMLDetailsElement).open))) await page.click('#view-menu > summary')
  await expect(page.locator('#view-mode-select')).toBeVisible()
}

async function tab(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.click(`.sidebar-tab[data-tab="${name}"]`)
  await page.waitForTimeout(500)
}

test.describe('desktop editor flow screenshots', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    await mkdir(SHOTS, { recursive: true })
  })

  test('01 editor overview', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await openEditor(page)
    await page.screenshot({ path: join(SHOTS, '01-editor-overview.png') })
  })

  test('02 Scans tab', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'scans')
    await page.screenshot({ path: join(SHOTS, '02-scans-tab.png') })
  })

  test('03 World tab (stats, share links, queue)', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'world')
    await page.screenshot({ path: join(SHOTS, '03-world-tab.png') })
  })

  test('04 Layers tab', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'layers')
    await page.screenshot({ path: join(SHOTS, '04-layers-tab.png') })
  })

  test('05 Splat Toolbox', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'layers')
    await page.locator('#splat-toolbox-section').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, '05-splat-toolbox.png') })
  })

  test('06 Edit tab (empty + selected)', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'edit')
    await page.screenshot({ path: join(SHOTS, '06-edit-tab-empty.png') })
    // Select the first scan → editor attaches the gizmo + shows transform/tag UI.
    await tab(page, 'scans')
    const first = page.locator('.scan-item').first()
    if (await first.count()) {
      await first.click()
      await page.waitForTimeout(1000)
      await tab(page, 'edit')
      await page.screenshot({ path: join(SHOTS, '06-edit-tab-selected.png') })
    }
  })

  // The render modes are the Views menu's select now (#view-mode-select), not the old #mode-* buttons, which the
  // page no longer has: clicking them waited out the test (FN-054, FN-089).
  test('07 render modes (points, semantic)', async ({ page }) => {
    await openEditor(page)
    await openViews(page)
    await page.selectOption('#view-mode-select', 'points')
    await expect(page.locator('#view-mode-select')).toHaveValue('points')
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SHOTS, '07-render-points.png') })
    await page.selectOption('#view-mode-select', 'semantic')
    await expect(page.locator('#view-mode-select')).toHaveValue('semantic')
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SHOTS, '08-render-semantic.png') })
    await page.selectOption('#view-mode-select', 'solid')
    await expect(page.locator('#view-mode-select')).toHaveValue('solid')
  })

  test('09 Measure tool', async ({ page }) => {
    await openEditor(page)
    await page.click('#btn-measure')
    await expect(page.locator('#btn-measure')).toHaveClass(/active/)
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOTS, '09-measure.png') })
  })

  // The map is the Views menu's "GIS map" toggle (#view-toggle-map), not the old #btn-geomap.
  test('10 Geomap drawer', async ({ page }) => {
    await openEditor(page)
    await openViews(page)
    await page.check('#view-toggle-map')
    await expect(page.locator('#geomap-drawer')).toHaveClass(/geomap-open/)
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(SHOTS, '10-geomap.png') })
  })
})
