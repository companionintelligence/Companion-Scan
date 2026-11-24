/**
 * Spatial Editor v1 (viewer.html at /editor): the top bar, the View menu, the SHARE entries,
 * the drawer chevrons, the object editor panel and the origin decal (wave 16).
 *
 * Where wave 14 got there first, these checks follow wave 14's editor: the hidden-objects list and
 * its Show buttons (F-20), the toolbar's layer count (F-19), the camera layers (F-21) and the one
 * switch per layer (F-41). tests/mock-editor-inventory.spec.ts covers those on their own.
 *
 * The backend is mocked with page.route, so this runs against the Vite dev server alone. The
 * place has one scan whose GLB is a single synthetic mesh named "chair". Every edit the object
 * editor makes is recorded as the POST /worlds/default/patches body it sends, and the mock
 * answers with the updated world, as the server does.
 *
 * Run: node scripts/test-box.mjs tests/mock-spatial-editor.spec.ts --workers=1 --retries=0
 */
import { test, expect, type Page, type Route } from '@playwright/test'

const WORLD_SLUG = 'default'
const WORLD_ID = 'world-default'
const SCAN_ID = 'chair-scan'
const GLB_PATH = '/scans/chair-scan.glb'
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const GEO = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
const STAMP = '2026-11-16T10:00:00.000Z'

const LAYER_INDEX = [
  { id: 'layer-points', type: 'points', label: 'Point cloud', visibleByDefault: true, encodedInGlb: true, source: 'glb', count: 0 },
  { id: 'layer-mesh', type: 'mesh', label: 'Meshes', visibleByDefault: true, encodedInGlb: true, source: 'glb', count: null },
  { id: 'layer-floor', type: 'floor', label: 'Floors', visibleByDefault: true, encodedInGlb: true, source: 'glb', count: null },
  { id: 'layer-detections', type: 'detections', label: 'Detections', visibleByDefault: true, encodedInGlb: true, source: 'glb', count: 0 },
  { id: 'layer-cameraPath', type: 'cameraPath', label: 'Camera path', visibleByDefault: true, encodedInGlb: true, source: 'derived', count: 0 },
  { id: 'layer-cameraFrustums', type: 'cameraFrustums', label: 'Camera frustums', visibleByDefault: false, encodedInGlb: false, source: 'derived', count: 0 },
  { id: 'layer-rgbFrames', type: 'rgbFrames', label: 'RGB frames', visibleByDefault: false, encodedInGlb: false, source: 'future', count: 0 },
  { id: 'layer-splat', type: 'splat', label: 'Gaussian splat', visibleByDefault: false, encodedInGlb: false, source: 'future', count: null },
]

const JOBS = [
  { jobId: 'job-1', worldId: WORLD_ID, type: 'ingest', status: 'completed', scanId: SCAN_ID, capabilities: [], progress: 100, createdAt: STAMP, updatedAt: STAMP },
  { jobId: 'job-2', worldId: WORLD_ID, type: 'splat-train', status: 'processing', scanId: SCAN_ID, capabilities: [], progress: 40, createdAt: STAMP, updatedAt: STAMP },
  { jobId: 'job-3', worldId: WORLD_ID, type: 'semantic-pass', status: 'queued', scanId: SCAN_ID, capabilities: [], createdAt: STAMP, updatedAt: STAMP },
]

interface MockState {
  patches: Array<Record<string, unknown>>
  posted: Array<Record<string, unknown>>
}

/** A binary glTF with one triangle in a node named "chair". */
function syntheticGlb(): Buffer {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]).buffer)
  let json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'chair', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0.5, 0.5, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    buffers: [{ byteLength: positions.length }],
  }))
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  header.write('glTF', 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + json.length + 8 + positions.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(json.length, 0)
  jsonHeader.write('JSON', 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(positions.length, 0)
  binHeader.write('BIN\0', 4)
  return Buffer.concat([header, jsonHeader, json, binHeader, positions])
}

function worldFixture(state: MockState, links: Record<string, string>): Record<string, unknown> {
  return {
    worldId: WORLD_ID,
    name: 'Test Place',
    shareSlug: WORLD_SLUG,
    projectId: null,
    originGeoPose: GEO,
    localFrame: { type: 'ENU_Y_UP', origin: GEO, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [{
      scanId: SCAN_ID,
      projectId: null,
      sessionId: null,
      filename: 'chair-scan.glb',
      name: 'Chair scan',
      glbUrl: GLB_PATH,
      geoPose: GEO,
      localToWorld: IDENTITY,
      accuracyM: null,
      geoDistanceM: null,
      capturedAt: null,
      pointCount: null,
      detectionCount: null,
      layerIndex: LAYER_INDEX,
      status: 'ready',
    }],
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    jobs: JOBS,
    editPatches: state.patches,
    createdAt: STAMP,
    updatedAt: STAMP,
    shareLinks: links,
  }
}

async function mockPlace(page: Page, links: Record<string, string>): Promise<MockState> {
  const state: MockState = { patches: [], posted: [] }
  const glb = syntheticGlb()
  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route(/\/projects(\?.*)?$/, (route) => json(route, []))
  // No other places: the viewer takes its name from the first location, so a live API would rename this world.
  await page.route(/\/project-locations(\?.*)?$/, (route) => json(route, []))
  // Playwright matches the most recently registered route first, so the catch-all goes first.
  await page.route(/\/scans\//, (route) => route.fulfill({ status: 404, body: 'not in this mock' }))
  await page.route(/\/scans\/chair-scan\.glb(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb }))
  await page.route(/\/worlds\/default\/share(\?.*)?$/, (route) => json(route, { worldId: WORLD_ID, shareSlug: WORLD_SLUG, links }))
  await page.route(/\/worlds\/default\/jobs(\?.*)?$/, (route) => json(route, JOBS))
  await page.route(/\/worlds\/default\/comments(\?.*)?$/, (route) => json(route, []))
  await page.route(/\/worlds\/default\/patches(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') return json(route, state.patches)
    const body = route.request().postDataJSON() as Record<string, unknown>
    state.posted.push(body)
    const patch = { ...body, patchId: `patch-${state.patches.length + 1}`, worldId: WORLD_ID, createdAt: new Date().toISOString() }
    state.patches.push(patch)
    return json(route, { ok: true, patch, world: worldFixture(state, links) })
  })
  await page.route(/\/worlds\/default(\?.*)?$/, (route) => json(route, worldFixture(state, links)))
  return state
}

const LINKS = {
  viewer: 'http://127.0.0.1:5199/editor?world=default&token=viewer-token',
  editor: 'http://127.0.0.1:5199/editor?world=default&token=editor-token',
  scanner: 'http://127.0.0.1:5199/scanner.html?world=default&token=scanner-token',
}

async function firstMeshVisible(page: Page): Promise<boolean | null> {
  return page.evaluate(() => (window as unknown as {
    __editorTest: { firstMeshVisible: (scanId: string) => boolean | null }
  }).__editorTest.firstMeshVisible('chair-scan'))
}

/** Open the View menu, unless it is already open (a click on its summary would close it). */
async function openViewMenu(page: Page): Promise<void> {
  const menu = page.locator('#view-menu')
  if (!(await menu.evaluate((node) => (node as HTMLDetailsElement).open))) await page.click('#view-menu > summary')
}

async function openEditor(page: Page): Promise<void> {
  await page.goto('/viewer.html?world=default&mock=editor')
  await page.locator('#viewer-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  await expect(page.locator('#toolbar-scan-count')).toHaveText('1', { timeout: 30_000 })
}

test.describe('Spatial Editor v1', () => {
  // The service worker would answer the page's POSTs itself, out of reach of page.route.
  test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test('the top bar names the product and shows scans, layers and job progress', async ({ page }) => {
    await mockPlace(page, LINKS)
    await openEditor(page)
    await expect(page).toHaveTitle(/Spatial Editor/)
    await expect(page.locator('#top-toolbar-title')).toContainText('Companion')
    await expect(page.locator('#top-toolbar-title')).toContainText('Scan')
    await expect(page.locator('#toolbar-project-name')).toHaveText('Test Place')
    await expect(page.locator('#toolbar-scan-count')).toHaveText('1')
    // One of three jobs has completed: current / total, with a bar at a third.
    await expect(page.locator('#toolbar-job-count')).toHaveText('1 / 3')
    await expect(page.locator('#toolbar-job-fill')).toHaveAttribute('style', /width: 33%/)
    // The layer count is the number of Layers rows with something to show (F-19): the synthetic mesh.
    await expect(page.locator('#toolbar-layer-count')).toHaveText('1', { timeout: 30_000 })
  })

  test('the View menu has six layer toggles; an empty layer is disabled with its reason', async ({ page }) => {
    await mockPlace(page, LINKS)
    await openEditor(page)
    await page.click('#view-menu > summary')
    await expect(page.locator('[data-view-layer]')).toHaveCount(6)
    await expect(page.locator('#view-show-all')).toBeVisible()
    await expect(page.locator('#view-hide-all')).toBeVisible()

    // The synthetic mesh is the only geometry, so the splat/photogrammetry layer is the one with data.
    await expect(page.locator('#view-toggle-mesh')).toBeEnabled({ timeout: 30_000 })
    await expect(page.locator('#view-toggle-mesh')).toBeChecked()

    const emptyLayers: Array<[string, string, string]> = [
      // The camera layers are drawn from a frame set alone (F-21), and this scan has none.
      ['#view-toggle-path', '#view-reason-cameraTrail', 'No camera trail: no scan here has frames to draw it from.'],
      ['#view-toggle-frustums', '#view-reason-scannedImages', 'No scanned images: no scan here has frames to draw them from.'],
      ['#view-toggle-detections', '#view-reason-detectedObjects', 'No detected objects: nothing has been detected in this place yet.'],
      ['#view-toggle-points', '#view-reason-hitPoints', 'No hit points: this place has no point cloud yet.'],
      ['#view-toggle-floor', '#view-reason-planes', 'No planes: no ground plane was found in this place.'],
    ]
    for (const [toggle, reason, text] of emptyLayers) {
      await expect(page.locator(toggle)).toBeDisabled()
      await expect(page.locator(reason)).toBeVisible()
      await expect(page.locator(reason)).toHaveText(text)
    }

    // Show all turns on what has data and leaves the rest off; hide all turns everything off.
    await page.click('#view-hide-all')
    await expect(page.locator('#view-toggle-mesh')).not.toBeChecked()
    await page.click('#view-show-all')
    await expect(page.locator('#view-toggle-mesh')).toBeChecked()
    await expect(page.locator('#view-toggle-floor')).not.toBeChecked()
    await expect(page.locator('#toolbar-layer-count')).toHaveText('1')
    // The menu writes the one switch per layer the Layers rows show (F-41).
    await page.click('#view-hide-all')
    await page.click('.sidebar-tab[data-tab="layers"]')
    await expect(page.locator('#layer-toggle-mesh')).not.toBeChecked()
    await openViewMenu(page)
    await page.click('#view-show-all')
    await expect(page.locator('#layer-toggle-mesh')).toBeChecked()
  })

  test('the SHARE menu copies the existing view-only link and says Coming soon for a missing one', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await mockPlace(page, LINKS)
    await openEditor(page)
    await page.click('#share-menu > summary')
    await expect(page.locator('#share-entry-view')).toBeEnabled({ timeout: 15_000 })
    await expect(page.locator('#share-entry-edit')).toBeEnabled()
    // No commenter link was issued for this place, so that entry is disabled.
    await expect(page.locator('#share-entry-comment')).toBeDisabled()
    await expect(page.locator('#share-entry-comment .share-entry-note')).toHaveText('Coming soon')

    await page.click('#share-entry-view')
    await expect(page.locator('#share-entry-view .share-entry-note')).toHaveText('Link copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LINKS.viewer)
  })

  test('the left and right drawers collapse and reopen from their chevrons', async ({ page }) => {
    await mockPlace(page, LINKS)
    await openEditor(page)
    await page.click('#sidebar-collapse-btn')
    await expect(page.locator('#sidebar')).toHaveClass(/collapsed/)
    await page.click('#sidebar-reopen-tab')
    await expect(page.locator('#sidebar')).not.toHaveClass(/collapsed/)

    await page.click('#details-collapse-btn')
    await expect(page.locator('#details-drawer')).toHaveClass(/collapsed/)
    await page.click('#details-reopen-tab')
    await expect(page.locator('#details-drawer')).not.toHaveClass(/collapsed/)
  })

  test('a scan root cannot be renamed or hidden from the object panel', async ({ page }) => {
    const state = await mockPlace(page, LINKS)
    await openEditor(page)
    await expect(page.locator('#view-toggle-mesh')).toBeEnabled({ timeout: 30_000 })
    const root = await page.evaluate(() => (window as unknown as {
      __editorTest: { selectScanRoot: (scanId: string) => { name: string } | null }
    }).__editorTest.selectScanRoot('chair-scan'))
    expect(root).not.toBeNull()
    await expect(page.locator('#edit-selected-info')).toBeVisible()
    await expect(page.locator('#edit-obj-rename')).toBeDisabled()
    await expect(page.locator('#edit-rename-btn')).toBeDisabled()
    // A whole scan is placed by Place precisely, where its size is locked, so it gets no XYZ fields.
    await expect(page.locator('#transform-fields')).toBeHidden()
    await expect(page.locator('#stitch-section')).toBeVisible()
    // Hide on a scan root says where its switch is, and saves nothing (F-20).
    await page.click('#edit-hide-object')
    await expect(page.locator('#edit-hide-object')).toHaveText('Untick the scan to hide it')
    expect(state.posted).toEqual([])
  })

  test('a verified two-point scan draws its origin decal with the heading arrow and no north tick', async ({ page }) => {
    const state = await mockPlace(page, LINKS)
    // The route registered last answers first, so this one scan is calibrated for this test only.
    await page.route(/\/worlds\/default(\?.*)?$/, (route) => {
      const world = worldFixture(state, LINKS) as { scans: Record<string, unknown>[] }
      world.scans[0] = { ...world.scans[0], calibrationStatus: 'verified', calibrationMethod: 'two-point-ground', calibrationSeparationM: 1.8 }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(world) })
    })
    await openEditor(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __editorTest: { originDecal: (scanId: string) => { decal: boolean; arrow: boolean; north: boolean } | null }
    }).__editorTest.originDecal('chair-scan')), { timeout: 30_000 }).toEqual({ decal: true, arrow: true, north: false })
  })

  test('the object editor edits name, XYZ transform and visibility, and records each change', async ({ page }) => {
    const state = await mockPlace(page, LINKS)
    await openEditor(page)
    await expect(page.locator('#view-toggle-mesh')).toBeEnabled({ timeout: 30_000 })

    const selected = await page.evaluate(() => (window as unknown as {
      __editorTest: { selectFirstMesh: (scanId: string) => { name: string; objectId: string } | null }
    }).__editorTest.selectFirstMesh('chair-scan'))
    expect(selected?.name).toBe('chair')

    await expect(page.locator('#edit-selected-info')).toBeVisible()
    await expect(page.locator('#edit-obj-rename')).toHaveValue('chair')
    await expect(page.locator('#edit-thing-link')).toHaveText('Not linked to a physical thing')
    await expect(page.locator('#xf-position-x')).toHaveValue('0')

    // Position: type a value and commit it; the saved transform carries it.
    await page.fill('#xf-position-x', '2.5')
    await page.press('#xf-position-x', 'Enter')
    await expect.poll(() => state.posted.length).toBe(1)
    expect((state.posted[0]['transform'] as { position: { x: number } }).position.x).toBeCloseTo(2.5, 6)
    // The save went through the Edit tab's save queue, whose status line reports it.
    await expect(page.locator('#edit-save-status')).toHaveText('Saved')

    // Rotation: typed degrees come back as typed degrees.
    await page.fill('#xf-rotation-z', '90')
    await page.press('#xf-rotation-z', 'Enter')
    await expect.poll(() => state.posted.length).toBe(2)
    await expect(page.locator('#xf-rotation-z')).toHaveValue('90')

    // A zero scale is refused before anything is saved.
    await page.fill('#xf-scale-x', '0')
    await page.press('#xf-scale-x', 'Enter')
    await expect(page.locator('#xf-scale-x')).toHaveClass(/is-invalid/)
    await expect(page.locator('#edit-object-status')).toHaveText('A scale cannot be zero.')
    expect(state.posted.length).toBe(2)

    // Rename writes a label patch for the same object, in the patch its tag and notes go in.
    await page.fill('#edit-obj-rename', 'Office chair')
    await page.click('#edit-rename-btn')
    await expect.poll(() => state.posted.length).toBe(3)
    expect(state.posted[2]['label']).toBe('Office chair')
    expect(state.posted[2]['scope']).toBe('object')
    await expect(page.locator('#edit-obj-name')).toHaveText('Office chair')

    // Hide, then show from the Edit tab's Hidden objects list (F-20), which names it by its new name.
    await page.click('#edit-hide-object')
    await expect.poll(() => state.posted.length).toBe(4)
    expect(state.posted[3]['visible']).toBe(false)
    await expect.poll(() => firstMeshVisible(page)).toBe(false)
    const hiddenRow = page.locator('#hidden-objects-list .hidden-object-row')
    await expect(hiddenRow).toHaveCount(1)
    await expect(hiddenRow).toContainText('Office chair')
    // A layer toggle must not bring a hidden object back.
    await openViewMenu(page)
    await page.click('#view-show-all')
    await expect(page.locator('#view-toggle-mesh')).toBeChecked()
    await expect.poll(() => firstMeshVisible(page)).toBe(false)
    await hiddenRow.locator('button', { hasText: 'Show' }).click()
    await expect.poll(() => state.posted.length).toBe(5)
    expect(state.posted[4]['visible']).toBe(true)
    await expect.poll(() => firstMeshVisible(page)).toBe(true)
    await expect(page.locator('#hidden-objects-section')).toBeHidden()
  })
})
