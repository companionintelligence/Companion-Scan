/**
 * The floor plan in the Spatial Editor, against the test box's server (PR #273's spec, ported).
 *
 * What this covers:
 *   1. The server serves the three floor-plan files through the scan artifact allowlist, with their types, the drawing
 *      under a policy that lets it run nothing, and turns away other suffixes and traversal.
 *   2. POST /worlds/:slug/jobs accepts `floor-plan` (202, and the job it returns is one).
 *   3. The Layers tab's Floor plan section, for the selected scan: the status, the numbers, the drawing and the two
 *      downloads, as viewer.ts renders them (not a copy of that code in the test).
 *   4. Generate posts a floor-plan job for the selected scan.
 *
 * Fixture: scripts/make-splat-fixture.mjs writes a synthetic 4 x 3 plan for the `splat-fixture` scan in the schema
 * scripts/floor_plan_worker.py writes. The test box generates it into its own scans dir before the servers start, so
 * readiness is asked of the server, not of the working tree. The worker itself runs in
 * tests/unit/server/floor_plan.test.ts and floor_plan_server.test.ts.
 *
 * Run:
 *   TEST_BOX_API_PORT=… TEST_BOX_VITE_PORT=… node scripts/test-box.mjs tests/mock-floor-plan.spec.ts --workers=1 --retries=0
 */
import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_BASE = 'splat-fixture'
const SCAN_ID = `scan-${SCAN_BASE}`

const API_URL = process.env['API_URL'] ?? ''
const apiPath = (p: string): string => (API_URL ? `${API_URL}${p}` : p)

let fixtureReady = false

test.describe('Floor plan: served files, the jobs API, and the editor\'s Floor plan section', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)
  // The viewer registers /sw.js, and a service worker sends fetches past page.route: the Generate test's POST would
  // reach the server and run a real job against the fixture scan. Block the worker, as the other mock specs do.
  test.use({ serviceWorkers: 'block' })

  test.beforeAll(async () => {
    if (API_URL) {
      const reply = await fetch(apiPath(`/scans/${SCAN_BASE}.floor-plan.manifest.json`)).catch(() => null)
      fixtureReady = reply?.ok === true
    } else {
      fixtureReady = existsSync(join(process.cwd(), 'scans', `${SCAN_BASE}.floor-plan.manifest.json`))
    }
  })

  test.beforeEach(() => {
    test.skip(!fixtureReady, 'Fixture missing: run npm run test:splat:make-fixture, or run this through scripts/test-box.mjs')
  })

  test('the server serves the manifest, the plan and the drawing, with their types', async ({ request }) => {
    const manifest = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.manifest.json`))
    expect(manifest.ok(), 'manifest 200').toBeTruthy()
    expect(manifest.headers()['content-type']).toContain('application/json')
    const body = await manifest.json() as { status: string; areaM2?: number; wallCount?: number; planPath?: string; svgPath?: string; disclaimer?: string }
    expect(body.status).toBe('ok')
    expect(body.areaM2).toBe(12)
    expect(body.wallCount).toBe(4)
    expect(body.planPath).toBe(`${SCAN_BASE}.floor-plan.json`)
    expect(body.svgPath).toBe(`${SCAN_BASE}.floor-plan.svg`)
    expect(body.disclaimer).toContain('own units')

    const plan = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.json`))
    expect(plan.ok(), 'plan 200').toBeTruthy()
    expect(plan.headers()['content-type']).toContain('application/json')
    const planBody = await plan.json() as { walls: unknown[]; rooms: unknown[]; disclaimer: string }
    expect(planBody.walls.length).toBe(4)
    expect(planBody.rooms.length).toBe(1)
    expect(planBody.disclaimer).toBe('derived, not survey-grade; in the point cloud\'s own units')

    const svg = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.svg`))
    expect(svg.ok(), 'svg 200').toBeTruthy()
    expect(svg.headers()['content-type']).toContain('image/svg+xml')
    expect(svg.headers()['content-security-policy']).toContain('default-src \'none\'')
    expect(await svg.text()).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
  })

  test('the artifact route turns away other suffixes and traversal', async ({ request }) => {
    const bad = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.exe`))
    expect([400, 404]).toContain(bad.status())
    const traversal = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.svg/../../main.ts`))
    expect([400, 404]).toContain(traversal.status())
  })

  test('the jobs API queues a floor-plan job', async ({ request }) => {
    // A scan id no world holds: the job is accepted and then fails by name, so it never runs against the fixture scan,
    // whose session has no LingBot-Map cloud (a run would replace the fixture's plan with a skip).
    const resp = await request.post(apiPath('/worlds/default/jobs'), {
      data: { type: 'floor-plan', scanId: 'scan-does-not-exist' },
    })
    expect(resp.status()).toBe(202)
    const job = await resp.json() as { type?: string; status?: string }
    expect(job.type).toBe('floor-plan')
    expect(job.status).toBe('queued')
  })

  test('the Floor plan section shows the selected scan\'s plan: status, numbers, drawing and downloads', async ({ page, request }) => {
    // A download is saved under the scan's name as the world has it (the fixture's is the one derived from its file).
    const world = await (await request.get(apiPath('/worlds/default'))).json() as { scans: Array<{ scanId: string; name: string }> }
    const scanName = world.scans.find((scan) => scan.scanId === SCAN_ID)?.name
    expect(scanName, `the default world lists ${SCAN_ID}`).toBeTruthy()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/viewer.html?world=default')
    const row = page.locator(`.scan-item[data-scan-id="${SCAN_ID}"]`)
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.click()
    await page.click('.sidebar-tab[data-tab="layers"]')
    const section = page.locator('#floor-plan-section')
    await section.locator('summary').click()

    await expect(page.locator('#floor-plan-status')).toContainText('Floor plan ready', { timeout: 20_000 })
    await expect(page.locator('#floor-plan-status')).toContainText('metres only if it was metric')
    await expect(page.locator('#floor-plan-stats')).toHaveText('4 walls · 1 room · area 12.0 · ceiling 2.50 (point-cloud units)')

    const preview = page.locator('#floor-plan-preview-img')
    await expect(page.locator('#floor-plan-preview')).toBeVisible()
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), {
      message: 'the drawing loads',
      timeout: 15_000,
    }).toBe(true)
    expect(await preview.getAttribute('src')).toContain(`${SCAN_BASE}.floor-plan.svg?v=`)

    const svgLink = page.locator('#floor-plan-download-svg')
    const jsonLink = page.locator('#floor-plan-download-json')
    await expect(svgLink).toBeVisible()
    await expect(jsonLink).toBeVisible()
    expect(await svgLink.getAttribute('href')).toContain(`${SCAN_BASE}.floor-plan.svg`)
    expect(await svgLink.getAttribute('download')).toBe(`${scanName}.floor-plan.svg`)
    expect(await jsonLink.getAttribute('href')).toContain(`${SCAN_BASE}.floor-plan.json`)
    expect(await jsonLink.getAttribute('download')).toBe(`${scanName}.floor-plan.json`)

    // The section is a tool of its own: the View menu keeps its six layers, and no Scene layers row is added for it.
    await expect(page.locator('#view-layer-list [data-view-layer]')).toHaveCount(6)

    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('floor-plan-section.png'), fullPage: false })
    expect(errors, `page errors: ${errors.join('; ')}`).toEqual([])
  })

  test('Generate posts a floor-plan job for the selected scan', async ({ page }) => {
    // The POST is answered here, so the server never runs a job against the fixture scan; every other request goes on.
    const posted: Array<{ type?: string; scanId?: string; payload?: { source?: string } }> = []
    await page.route('**/worlds/*/jobs*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      posted.push(route.request().postDataJSON() as (typeof posted)[number])
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: 'job-mock-floor-plan',
          worldId: 'world-default',
          type: 'floor-plan',
          status: 'queued',
          scanId: SCAN_ID,
          capabilities: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
      })
    })
    await page.goto('/viewer.html?world=default')
    const row = page.locator(`.scan-item[data-scan-id="${SCAN_ID}"]`)
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.click()
    await page.click('.sidebar-tab[data-tab="layers"]')
    await page.locator('#floor-plan-section summary').click()
    await expect(page.locator('#btn-floor-plan')).toHaveText('Generate floor plan')
    await page.click('#btn-floor-plan')
    await expect(page.locator('#btn-floor-plan')).toHaveText('Queued')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.type).toBe('floor-plan')
    expect(posted[0]?.scanId).toBe(SCAN_ID)
    expect(posted[0]?.payload?.source).toBe('viewer-floor-plan')
  })
})
