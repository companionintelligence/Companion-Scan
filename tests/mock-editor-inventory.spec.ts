/**
 * The editor with a loaded world, for the inventory fixes of wave 14 ticket 0005 (FN-075): the Scene layers rows (F-19,
 * F-21), the hidden-object list and its Show (F-20), the SenseNova result and the world GLB link (F-23), the Advanced
 * queue's scan guard (F-24), the reconstruction and placed-object panels' "not known" lines (F-22), and one access token
 * on every request (F-10).
 *
 * The world API is mocked with page.route, so no Scan server is needed and nothing is written anywhere. The fixture's
 * scan has no geometry (its GLB answers 404), a manifest that reports camera poses but no frame set, a Hide patch, and
 * a completed SenseNova job and world export.
 *
 * Run against a Vite server started from this checkout:
 *   VITE_URL=https://127.0.0.1:5199 npx playwright test --project=chromium-mock mock-editor-inventory
 */
import { test, expect, type Page } from '@playwright/test'

// The world API is mocked with page.route, which cannot see a request the editor's service worker makes. Once the
// worker controls the page, the Show button's POST went through it to the real test server, which has no such world
// and answered 404 (F-03), and the spec failed about eight times in ten. Block the worker, as the other mock specs
// that route the API do.
test.use({ serviceWorkers: 'block' })

const SLUG = 'inventory-fixture'
const TOKEN = 'inventory-test-token'
const NOW = '2026-11-20T10:00:00.000Z'

function layer(type: string, count: number | null) {
  return { id: `layer-${type}`, type, label: type, visibleByDefault: true, encodedInGlb: true, source: 'glb', count }
}

const HIDE_PATCH = { patchId: 'patch-hide', worldId: 'world-inventory', scope: 'object', scanId: 'scan-a', targetId: 'scan-a/0-chair', visible: false, createdAt: NOW }

function worldFixture(editPatches: unknown[]): Record<string, unknown> {
  const noGeo = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
  return {
    worldId: 'world-inventory',
    name: 'Inventory fixture',
    shareSlug: SLUG,
    projectId: null,
    originGeoPose: noGeo,
    localFrame: { type: 'ENU_Y_UP', origin: noGeo, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [{
      scanId: 'scan-a',
      projectId: null,
      sessionId: 'sess-a',
      filename: 'scan-a.glb',
      name: 'Room A',
      glbUrl: '/scans/scan-a.glb',
      metadataUrl: '/scans/scan-a.json',
      geoPose: noGeo,
      localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      accuracyM: null,
      status: 'raw',
      capturedAt: NOW,
      detectionCount: 0,
      // The capture recorded 40 poses, but there is no frame set to draw them from.
      layerIndex: [layer('points', 1200), layer('cameraPath', 40), layer('cameraFrustums', 40)],
    }],
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    editPatches,
    jobs: [
      {
        jobId: 'job-sensenova', worldId: 'world-inventory', type: 'sensenova-vision', status: 'completed', scanId: 'scan-a',
        capabilities: [], payload: { task: 'bbox_detection' },
        result: 'SenseNova bbox_detection completed with 2 artifacts.',
        artifacts: [{ type: 'sensenova-output', label: 'Room A SenseNova', metadata: { task: 'bbox_detection', files: ['/srv/out/job-sensenova/a.json', '/srv/out/job-sensenova/b.png'], outputDir: '/srv/out/job-sensenova' } }],
        createdAt: NOW, updatedAt: NOW,
      },
      {
        jobId: 'job-export', worldId: 'world-inventory', type: 'export-world', status: 'completed', capabilities: [],
        result: `Exported 1 scan and 0 Things to ${SLUG}.world.glb.`,
        artifacts: [{ type: 'world-glb', label: 'export', url: `/worlds/${SLUG}/export.glb` }],
        createdAt: NOW, updatedAt: NOW,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

interface Captured {
  urls: string[]
  posts: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }>
}

async function mockApi(page: Page): Promise<Captured> {
  const captured: Captured = { urls: [], posts: [] }
  let patches: unknown[] = [HIDE_PATCH]
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/worlds/**', async (route) => {
    const request = route.request()
    captured.urls.push(request.url())
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      captured.posts.push({ url: request.url(), authorization: request.headers()['authorization'] ?? null, body })
      const patch = { ...body, patchId: `patch-${captured.posts.length}`, worldId: 'world-inventory', createdAt: NOW }
      patches = [...patches, patch]
      await route.fulfill(json({ ok: true, patch, world: worldFixture(patches) }))
      return
    }
    if (path.endsWith('/share')) return route.fulfill(json({ worldId: 'world-inventory', shareSlug: SLUG, links: {} }))
    if (path.endsWith('/jobs')) return route.fulfill(json((worldFixture(patches) as { jobs: unknown[] }).jobs))
    return route.fulfill(json(worldFixture(patches)))
  })
  // Every scan artifact is missing: a JSON 404, as the artifact routes answer a missing file. The panoptic sidecar is
  // answered as today's generic /scans/:filename route answers a name that is not a .glb.
  await page.route('**/scans/**', (route) => {
    captured.urls.push(route.request().url())
    if (route.request().url().includes('.panoptic-lift.manifest.json')) return route.fulfill(json({ error: 'Only .glb files are served' }, 400))
    return route.fulfill(json({ error: 'Artifact not found' }, 404))
  })
  // No route serves the COLMAP report here: the framework's own text 404.
  await page.route('**/sessions/**', (route) => {
    captured.urls.push(route.request().url())
    return route.fulfill({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
  })
  await page.route('**/projects', (route) => route.fulfill(json([])))
  await page.route('**/project-locations', (route) => route.fulfill(json([])))
  await page.route('**/authenticate/**', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 Not Found' }))
  return captured
}

async function openEditor(page: Page): Promise<Captured> {
  const captured = await mockApi(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/viewer.html?world=${SLUG}&token=${TOKEN}`)
  await expect(page.locator('.scan-item')).toHaveCount(1, { timeout: 30_000 })
  // The GLB 404s, so the scan settles on its "no geometry" line.
  await expect(page.locator('.scan-status')).toContainText(/No geometry yet/, { timeout: 30_000 })
  expect(errors, errors.join('\n')).toEqual([])
  return captured
}

test.describe('editor inventory fixes with a loaded world', () => {
  test('the Scene layers rows, their counts and the toolbar metric', async ({ page }) => {
    await openEditor(page)
    await page.click('.sidebar-tab[data-tab="layers"]')
    const rows = await page.locator('#layer-list .layer-item').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset['layer']))
    expect(rows).toEqual(['points', 'mesh', 'floor', 'detections', 'labels', 'cameraPath', 'cameraFrustums', 'rgbFrames', 'splat4d', 'anchor'])
    await expect(page.locator('#layer-list .layer-item[data-layer="points"] .layer-meta')).toContainText('1,200 items')
    // 40 recorded poses and no frame set: nothing is drawn, and the row says so (F-21).
    await expect(page.locator('#layer-list .layer-item[data-layer="cameraPath"] .layer-meta')).toContainText('no frames')
    await expect(page.locator('#layer-list .layer-item[data-layer="cameraFrustums"] .layer-meta')).toContainText('no frames')
    // One row has something to show: the point cloud's reported count. Not 13.
    await expect(page.locator('#toolbar-layer-count')).toHaveText('1')
    // The bounds start hidden, and the HUD button and the row are one switch.
    await expect(page.locator('#layer-toggle-detections')).not.toBeChecked()
    await page.click('#btn-toggle-bounds')
    await expect(page.locator('#layer-toggle-detections')).toBeChecked()
    await expect(page.locator('#btn-toggle-bounds')).toHaveAttribute('aria-pressed', 'true')
  })

  test('a hidden object is listed, and Show posts visible: true with one token', async ({ page }) => {
    const captured = await openEditor(page)
    await page.click('.sidebar-tab[data-tab="edit"]')
    await expect(page.locator('#hidden-objects-section')).toBeVisible()
    const row = page.locator('#hidden-objects-list .hidden-object-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('scan-a/0-chair')
    await expect(row).toContainText('Room A')
    await row.locator('button', { hasText: 'Show' }).click()
    await expect.poll(() => captured.posts.length).toBe(1)
    expect(captured.posts[0]!.body).toEqual({ scope: 'object', targetId: 'scan-a/0-chair', scanId: 'scan-a', visible: true })
    expect(new URL(captured.posts[0]!.url).searchParams.getAll('token')).toEqual([TOKEN])
    expect(captured.posts[0]!.authorization).toBeNull()
    // The world the server answers with leaves nothing hidden, so the list goes.
    await expect(page.locator('#hidden-objects-section')).toBeHidden()
  })

  test('the world GLB link, the SenseNova result and the queue guard', async ({ page }) => {
    const captured = await openEditor(page)
    await page.click('.sidebar-tab[data-tab="world"]')
    await expect(page.locator('#world-export-section')).toBeVisible()
    const href = await page.locator('#world-export-link').getAttribute('href')
    const exportUrl = new URL(href!, 'https://placeholder.invalid')
    expect(exportUrl.pathname).toBe(`/worlds/${SLUG}/export.glb`)
    expect(exportUrl.searchParams.getAll('token')).toEqual([TOKEN])
    await expect(page.locator('#world-export-detail')).toHaveText(`Exported 1 scan and 0 Things to ${SLUG}.world.glb.`)

    // With no scan selected, a scan-backed job is refused before anything is sent (F-24).
    await page.locator('#tab-world details.layer-tool > summary', { hasText: 'Advanced queue' }).click()
    await page.selectOption('#job-type', 'splat-train')
    await expect(page.locator('#job-type-hint')).toHaveText('Needs a selected scan. Select one under Scans first.')
    await page.click('#btn-queue-job')
    await expect(page.locator('#btn-queue-job')).toHaveText('Select a scan first')
    expect(captured.posts).toEqual([])

    // Selecting the scan: the hint names it, and the SenseNova panel shows its finished run, never a server path.
    await page.click('.sidebar-tab[data-tab="scans"]')
    await page.click('.scan-item')
    await page.click('.sidebar-tab[data-tab="world"]')
    await expect(page.locator('#job-type-hint')).toHaveText('Runs on the selected scan, Room A.')
    await page.click('.sidebar-tab[data-tab="layers"]')
    await expect(page.locator('#sensenova-status')).toHaveText(/^SenseNova bbox_detection completed with 2 artifacts\./)
    await expect(page.locator('#sensenova-files')).toHaveText('Output: a.json, b.png.')
    await expect(page.locator('#sensenova-section')).not.toContainText('/srv/out')
  })

  test('the reconstruction and placed-object panels say "not known" when nothing serves their record', async ({ page }) => {
    const captured = await openEditor(page)
    await page.click('.scan-item')
    await page.click('.sidebar-tab[data-tab="layers"]')
    await expect(page.locator('#quality-verdict')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#quality-verdict-headline')).toHaveText('Whether the camera tracked through this capture is not known.')
    await expect(page.locator('#panoptic-objects-status')).toContainText('Whether things were placed in this scan is not known.', { timeout: 15_000 })
    // Every request the editor made to the server carried the access token, once.
    const toServer = captured.urls.filter((url) => /\/(worlds|scans|sessions)\//.test(new URL(url).pathname))
    expect(toServer.length).toBeGreaterThan(3)
    for (const url of toServer) expect(new URL(url).searchParams.getAll('token'), url).toEqual([TOKEN])
  })
})
