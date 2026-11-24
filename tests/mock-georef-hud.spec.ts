/**
 * The editor's location readout and the Place location panel, on a mocked Place.
 *
 * The pure parts are pinned in tests/unit/node (georef_hud, georeference_form, placement_note, georef_client): what a readout says,
 * what a record claims, which words. What none of them can see is the wiring, and this spec runs it in a browser:
 *
 *  1. The HUD reads the world the editor loaded and the point under the orbit target: "Local (no georeference)" with no latitude,
 *     longitude or compass direction for a Place with no georeference, and east, north, up, latitude and longitude with the record's
 *     own claim of accuracy ("approximate to about N m", "not confirmed" until a person confirmed it) for one that has. The editor
 *     frames the world when it loads, so the target is not at the landmark; the latitude and longitude printed are checked against a
 *     flat-earth estimate from the east and north printed beside them and the record's origin, which is independent of the app's own
 *     geodesy and good to centimetres over a few metres (the geodesy itself is pinned to millimetres in
 *     tests/unit/deno/georef_vectors.test.ts). The target is then panned with the mouse, as a person pans, and the readout follows.
 *  2. A world file from before the scene was corrected (`z: 'north'`) says so: "Mirrored placement: N scans" counts the scans that
 *     were placed by GPS and compass and not moved, and "Re-place by GPS" opens the location panel (the World tab, the section open,
 *     the cursor in the latitude) and not something else.
 *  3. The panel's two save buttons send two different records to the server, each naming the version the panel read, and the
 *     editor follows the save: the flag goes, the readout turns geographic, and the message the save gave is still there once the
 *     editor has redrawn the world. A record that is saved as a compass seed and confirmed later stays a seed.
 *  4. Another editor's save is shown, never overwritten (409); a save with no connection says so and changes nothing; a number under
 *     what a map click can claim is refused before any request.
 *  5. The editor redraws the world whenever a scan arrives, and a redraw must not put saved numbers over what a person was typing.
 *     (An untouched panel does follow the Place.) Nor may a slow read of the Place that began before a save put the record from
 *     before it back.
 *
 * Every /worlds, /projects and /scans response is mocked, with a GLB that is a valid but empty glTF scene, and the mocked Place keeps
 * its record and its version as the server does: a write names the version it expects and a stale one is a 409. This covers the
 * client only. The server side of the same contract (the CAS, the validator, the world it places again) runs the real route in
 * tests/unit/deno/georef_route.test.ts and georef_world.test.ts; nothing here says what a real server would place where, because the
 * mocked world is written by this file.
 *
 * Run: npx playwright test --project=chromium-mock mock-georef-hud
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { composeYUpTransform } from '../src/world/geo'
import type { EditPatch, GeoPose, Project, ProjectGeoreference, ScanManifest, WorldProject } from '../src/world/types'

const SLUG = 'default'
const PROJECT_ID = 'proj-default'
const PLACE_NAME = 'Georeference test place'
const NO_FIX: GeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }

/** A record a person typed and saved, not confirmed: approximate to about 8 m. */
const RECORD: ProjectGeoreference = {
  origin: { lat: 51.500123, lng: -0.119876, altitudeM: null, accuracyM: 8 },
  heightDatum: 'unknown',
  bearingDeg: 41.5,
  bearingAccuracyDeg: 5,
  convention: 2,
  datum: 'WGS84',
  source: 'typed',
  registeredAt: '2026-11-17T10:00:00.000Z',
  anchorRef: null,
}

const CONFIRMED: ProjectGeoreference = { ...RECORD, confirmedAt: '2026-11-17T10:05:00.000Z' }

/** What another editor saves while this one is open. */
const OTHER: ProjectGeoreference = {
  origin: { lat: 48.858400, lng: 2.294500, altitudeM: null, accuracyM: 4 },
  heightDatum: 'unknown',
  bearingDeg: 120,
  bearingAccuracyDeg: 3,
  convention: 2,
  datum: 'WGS84',
  source: 'map-click',
  registeredAt: '2026-11-17T11:00:00.000Z',
  anchorRef: null,
}

/** What the server's compass estimate says of three scans. */
const SEED = {
  bearing: { deg: 41.3, spreadDeg: 4.2, sigmaDeg: 15, scans: 3, lowConfidence: false },
  origin: { lat: 51.5002, lng: -0.1199, accuracyM: 14.2 },
  declination: { deg: 0.6, model: 'WMM2025', year: 2026.88 },
  considered: 3,
  used: 3,
}

function scan(scanId: string, name: string, extra: Partial<ScanManifest>): ScanManifest {
  return {
    scanId,
    projectId: PROJECT_ID,
    sessionId: `sess-${scanId}`,
    filename: `${scanId}.glb`,
    name,
    glbUrl: `/scans/${scanId}.glb`,
    geoPose: NO_FIX,
    localToWorld: composeYUpTransform({ x: 2, y: 0, z: -3 }, 15, 1),
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: '2026-11-01T10:00:00.000Z',
    pointCount: null,
    detectionCount: 0,
    layerIndex: [],
    status: 'ready',
    ...extra,
  }
}

/** A scan with no calibration, placed by the phone's GPS fix and compass, that nothing has moved since. */
const GPS_SCAN = scan('scan-gps', 'Phone scan', {
  geoPose: { lat: 51.5, lng: -0.12, altitudeM: null, bearing: 90, accuracyM: 12 },
  accuracyM: 12,
  geoDistanceM: 7.2,
  calibrationStatus: 'uncalibrated',
  placementSource: 'gps-compass',
  placementUncertaintyM: 12,
})

/** A calibrated scan: it sits in the Place frame, and is not mirrored. */
const CALIBRATED_SCAN = scan('scan-calibrated', 'Calibrated scan', {
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'verified',
  calibrationSeparationM: 3.2,
  placementSource: 'place-frame',
})

/** A calibrated scan that a georeference carried onto the map. */
const MAPPED_SCAN = scan('scan-mapped', 'Mapped scan', {
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'verified',
  calibrationSeparationM: 3.2,
  placementSource: 'georeference',
  placementUncertaintyM: 8,
})

/** What the mocked server holds, and what the page asked of it. */
interface Store {
  /** The Place as the server holds it: its record and its version. */
  project: Project
  /** The scans the world lists. */
  scans: ScanManifest[]
  /** The axes a world declares while its Place has no georeference: a world file from before the correction says `'north'`. */
  axesZ: 'south' | 'north'
  /** What `GET /projects/:id/georeference-seed` answers with, or null for a server with nothing to say. */
  seed: typeof SEED | null
  /** Every PUT to `/projects/:id/georeference` that reached the server, in order. */
  puts: Array<{ expectedVersion: number; georeference: ProjectGeoreference }>
  /** Counts of what the page asked for. */
  reads: { world: number; place: number }
  /** True while the network is down for the save. */
  offline: boolean
  /** While set, an answer about the Place waits for it (a slow network): the answer is the Place as it was when it was asked. */
  placeGate: Promise<void> | null
  /** True while the server fails to answer for the world. */
  worldFails: boolean
  /** The patch log the world carries: a person's saved moves. */
  editPatches: EditPatch[]
  /** False when the server does not use the Place's georeference in its world (it was made for an earlier alignment of the Place). */
  worldUsesGeoreference: boolean
}

function newStore(extra: Partial<Store> = {}): Store {
  return {
    project: { projectId: PROJECT_ID, name: PLACE_NAME, createdAt: 0, updatedAt: 0, floors: [] },
    scans: [CALIBRATED_SCAN],
    axesZ: 'south',
    seed: null,
    puts: [],
    reads: { world: 0, place: 0 },
    offline: false,
    placeGate: null,
    worldFails: false,
    editPatches: [],
    worldUsesGeoreference: true,
    ...extra,
  }
}

/** The world the server would answer with: a Place with a georeference is in the scene the georeference defines. */
function worldOf(store: Store): WorldProject {
  const georeference = store.worldUsesGeoreference ? store.project.georeference : undefined
  return {
    worldId: 'world-georef-hud',
    name: PLACE_NAME,
    shareSlug: SLUG,
    projectId: PROJECT_ID,
    originGeoPose: NO_FIX,
    localFrame: { type: 'ENU_Y_UP', origin: NO_FIX, units: 'meters', axes: { x: 'east', y: 'up', z: georeference ? 'south' : store.axesZ } },
    ...(georeference ? { georeference, georefVersion: store.project.georefVersion ?? 0 } : {}),
    scans: store.scans,
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    jobs: [],
    editPatches: store.editPatches,
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
  }
}

/** A valid binary glTF whose scene has no nodes: enough for the viewer to build a scan root around. */
function emptyGlb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // 'glTF'
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + padded.length, 8)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(padded.length, 0)
  chunk.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  return Buffer.concat([header, chunk, padded])
}

async function mockApi(page: Page, store: Store): Promise<void> {
  await page.route('**/worlds/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `/worlds/${SLUG}` && route.request().method() === 'GET') {
      store.reads.world += 1
      if (store.worldFails) return route.fulfill({ status: 500, json: { error: 'the server is struggling' } })
      return route.fulfill({ json: worldOf(store) })
    }
    // Jobs, comments, patches and anything else the viewer polls: an empty list is a valid answer.
    return route.fulfill({ json: [] })
  })
  await page.route('**/scans/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.glb')) return route.fulfill({ body: emptyGlb(), contentType: 'model/gltf-binary' })
    return route.fulfill({ status: 404, json: { error: 'not in this mock' } })
  })
  await page.route('**/projects', (route) => route.fulfill({ json: [store.project] }))
  await page.route('**/projects/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const base = `/projects/${PROJECT_ID}`
    if (path === base && request.method() === 'GET') {
      store.reads.place += 1
      // The answer is the Place as it is when the question is asked, however long it takes to arrive.
      const asked = store.project
      if (store.placeGate) await store.placeGate
      return route.fulfill({ json: asked })
    }
    if (path === `${base}/georeference-seed` && request.method() === 'GET') {
      return store.seed ? route.fulfill({ json: store.seed }) : route.fulfill({ status: 404, json: { error: 'no estimate' } })
    }
    if (path === `${base}/georeference` && request.method() === 'PUT') {
      // The save fails as a fetch does when the network is down: the request never gets an answer.
      if (store.offline) return route.abort('internetdisconnected')
      const body = request.postDataJSON() as { georeference: ProjectGeoreference; expectedVersion: number }
      store.puts.push(body)
      // The server's compare-and-swap: a write names the version it expects to find, and a stale one is told what is there now.
      const held = store.project.georefVersion ?? 0
      if (body.expectedVersion !== held) {
        return route.fulfill({
          status: 409,
          json: { error: 'The location changed since it was read.', current: { georeference: store.project.georeference ?? null, georefVersion: held } },
        })
      }
      store.project = { ...store.project, georeference: body.georeference, georefVersion: held + 1 }
      return route.fulfill({ json: { georeference: body.georeference, georefVersion: held + 1 } })
    }
    return route.fulfill({ status: 404, json: { error: 'not in this mock' } })
  })
  await page.route('**/project-locations', (route) => route.fulfill({ json: [] }))
  await page.route('**/authenticate/whoami', (route) => route.fulfill({ status: 401, json: { error: 'not signed in' } }))
}

/**
 * Take over the editor's /events socket, so a test can deliver the server events it redraws the world on. Nothing is connected to a
 * server: the page sees an open socket, and only what `send` hands it arrives. Register this before the page navigates.
 */
async function mockEvents(page: Page): Promise<{ send: (message: object) => Promise<void> }> {
  const held: { socket: WebSocketRoute | null } = { socket: null }
  await page.routeWebSocket('**/events', (socket) => {
    held.socket = socket
  })
  return {
    async send(message) {
      await expect.poll(() => held.socket !== null, { message: 'the editor opened its /events socket' }).toBe(true)
      held.socket!.send(JSON.stringify(message))
    },
  }
}

/** A scan arrives: the editor reads the world and the Places again and redraws; resolves once it has, and the panel's own read with it. */
async function redraw(events: { send: (message: object) => Promise<void> }, store: Store): Promise<void> {
  const asked = store.reads.world
  await events.send({ type: 'scan-added', filename: 'phone-scan.glb', size: 4096 })
  await expect.poll(() => store.reads.world, { message: 'the editor read the world again', timeout: 15_000 }).toBeGreaterThan(asked)
  // The redraw's own work (the panel's read of the Place) is queued behind the world read; let it run.
  await new Promise((resolve) => setTimeout(resolve, 300))
}

/** Opens the editor on the mocked Place and waits until it has drawn the world. Returns the page errors seen so far, live. */
async function openEditor(page: Page, store: Store): Promise<string[]> {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await mockApi(page, store)
  await page.goto(`/viewer.html?world=${SLUG}`)
  await expect(page.locator('#sidebar-title')).toHaveText(PLACE_NAME)
  await expect(page.locator('.scan-status', { hasText: /Ready/ })).toHaveCount(store.scans.length, { timeout: 60_000 })
  return pageErrors
}

/** What the coordinate readout says, one entry for each line. */
async function readout(page: Page): Promise<string[]> {
  const text = await page.locator('#coord-readout').innerText()
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** The numbers on the readout's first line of a georeferenced world, and the latitude and longitude on its second. */
function readNumbers(lines: string[]): { east: number; north: number; up: number; lat: number; lng: number } {
  const first = /^East (-?\d+\.\d\d) · North (-?\d+\.\d\d) · Up (-?\d+\.\d\d) m$/.exec(lines[0] ?? '')
  const second = /^(-?\d+\.\d{6}), (-?\d+\.\d{6})$/.exec(lines[1] ?? '')
  expect(first, `the first line is east, north and up: ${JSON.stringify(lines)}`).not.toBeNull()
  expect(second, `the second line is a latitude and a longitude: ${JSON.stringify(lines)}`).not.toBeNull()
  return { east: Number(first![1]), north: Number(first![2]), up: Number(first![3]), lat: Number(second![1]), lng: Number(second![2]) }
}

/**
 * Checks that the latitude and longitude on the readout are where the east and north beside them put them, from `origin`: a flat-earth
 * estimate on a sphere, which is within 0.3 per cent of the ellipsoid and so within centimetres for a few metres. The readout
 * prints east and north to a centimetre and the angles to 1e-6 degrees (about 0.1 m), so the tolerance is 0.2 m.
 */
function expectNumbersAgree(numbers: { east: number; north: number; lat: number; lng: number }, origin: { lat: number; lng: number }): void {
  const metresPerDegreeLat = 111_195
  const metresPerDegreeLng = metresPerDegreeLat * Math.cos((origin.lat * Math.PI) / 180)
  expect(Math.abs((numbers.lat - origin.lat) * metresPerDegreeLat - numbers.north), 'latitude follows north').toBeLessThan(0.2)
  expect(Math.abs((numbers.lng - origin.lng) * metresPerDegreeLng - numbers.east), 'longitude follows east').toBeLessThan(0.2)
}

/** Pans the orbit target with the right mouse button, the way a person does, and waits for the camera to settle. */
async function panTarget(page: Page, dx: number): Promise<void> {
  const box = (await page.locator('#viewer-canvas').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(x + dx, y, { steps: 12 })
  await page.mouse.up({ button: 'right' })
  // The controls are damped: they keep moving for a moment after the button is up.
  let last = ''
  await expect.poll(async () => {
    const now = (await readout(page)).join('|')
    const settled = now === last
    last = now
    return settled
  }, { message: 'the camera settled', timeout: 10_000, intervals: [250] }).toBe(true)
}

/** Opens the Place location panel the way a person does when nothing has done it for them: the Project tab, then the section. */
async function openPanelByHand(page: Page): Promise<void> {
  await page.locator('#tab-btn-world').click()
  await page.locator('#georeference-section > summary').click()
  await expect(page.locator('#georeference-section')).toHaveJSProperty('open', true)
  // The fields wait for the first read of the Place.
  await expect(page.locator('#georef-lat')).toBeEnabled()
}

const field = (page: Page, id: 'lat' | 'lng' | 'heading' | 'origin-accuracy' | 'heading-accuracy') => page.locator(`#georef-${id}`)

test.describe('the location readout and the Place location panel on a mocked Place', () => {
  test.setTimeout(120_000)
  // The viewer registers /sw.js, and a service worker sends fetches past page.route, so the mocks would never see them. Block the
  // worker, as the other mock specs do.
  test.use({ serviceWorkers: 'block' })

  test('a Place with no georeference says Local, in the scene\'s own metres, with no latitude, longitude or flag', async ({ page }) => {
    const store = newStore()
    const pageErrors = await openEditor(page, store)

    await expect.poll(async () => (await readout(page))[0]).toBe('Local (no georeference)')
    const lines = await readout(page)
    expect(lines).toHaveLength(2)
    expect(lines[1], 'the point under the orbit target, in the scene\'s own metres').toMatch(/^-?\d+\.\d\d, -?\d+\.\d\d, -?\d+\.\d\d m$/)
    expect(lines.join(' '), 'nothing here is a place on Earth').not.toMatch(/East|North|Up |°|Approximate|\d\.\d{6}/)
    // A world in the corrected scene has no mirrored placements to flag.
    await expect(page.locator('#placement-flag')).toBeHidden()
    expect(pageErrors).toEqual([])
  })

  test('a georeferenced Place prints east, north, up, latitude and longitude at the orbit target, and the claim the record makes', async ({ page }) => {
    const store = newStore({ scans: [MAPPED_SCAN], project: { ...newStore().project, georeference: RECORD, georefVersion: 1 } })
    const pageErrors = await openEditor(page, store)

    // Where the editor framed the world: east, north and up of the landmark, the latitude and longitude that is, and the record's claim.
    await expect.poll(async () => (await readout(page))[0]).toMatch(/^East /)
    const before = await readout(page)
    expect(before).toHaveLength(3)
    expectNumbersAgree(readNumbers(before), RECORD.origin)
    expect(before[2], 'the record\'s own claim of accuracy, and that nobody has confirmed it').toBe('Approximate to about 8 m · not confirmed')
    // The scan list says how the scan was placed, in the record's own claim.
    await expect(page.locator('#scan-list')).toContainText('On the map, approximate to about 8 m')

    // Pan the target. The readout follows it, the latitude and longitude still agree with the east and north beside them, and the
    // claim is the same record's.
    await panTarget(page, 160)
    const after = await readout(page)
    const from = readNumbers(before)
    const to = readNumbers(after)
    expect(Math.hypot(to.east - from.east, to.north - from.north), 'the pan moved the target').toBeGreaterThan(0.5)
    expect(Math.abs(to.up - from.up), 'a sideways pan stays at the same height').toBeLessThan(0.05)
    expectNumbersAgree(to, RECORD.origin)
    expect(after[2]).toBe('Approximate to about 8 m · not confirmed')
    expect(pageErrors).toEqual([])
  })

  test('a confirmed record drops "not confirmed" and keeps the accuracy it claims', async ({ page }) => {
    const store = newStore({ project: { ...newStore().project, georeference: CONFIRMED, georefVersion: 2 } })
    const pageErrors = await openEditor(page, store)

    await expect.poll(async () => (await readout(page))[0]).toMatch(/^East /)
    const lines = await readout(page)
    expect(lines).toHaveLength(3)
    expectNumbersAgree(readNumbers(lines), CONFIRMED.origin)
    expect(lines[2], 'confirmed, so nothing says it is not').toBe('Approximate to about 8 m')
    expect(pageErrors).toEqual([])
  })

  test('an older world flags its mirrored GPS placements, and Re-place by GPS opens the location panel', async ({ page }) => {
    const store = newStore({ axesZ: 'north', scans: [GPS_SCAN, CALIBRATED_SCAN] })
    const pageErrors = await openEditor(page, store)

    // The calibrated scan sits in the Place frame and is not counted; the scan placed by GPS and compass is.
    const flag = page.locator('#placement-flag')
    await expect(flag).toBeVisible()
    await expect(flag).toContainText('Mirrored placement: 1 scan')
    await expect(flag.getByRole('button', { name: 'Re-place by GPS' })).toBeVisible()
    expect((await readout(page))[0], 'an older world has no georeference to print').toBe('Local (no georeference)')
    // The scan list says how that scan was placed, and that it is not in the Place frame.
    await expect(page.locator('#scan-list')).toContainText('Placed by GPS and compass, approximate to about 12 m')
    await expect(page.locator('#scan-list')).toContainText('Not in the Place frame')

    await expect(page.locator('#tab-world')).not.toHaveClass(/active/)
    await flag.getByRole('button', { name: 'Re-place by GPS' }).click()
    await expect(page.locator('#tab-world')).toHaveClass(/active/)
    await expect(page.locator('#georeference-section')).toHaveJSProperty('open', true)
    await expect(field(page, 'lat'), 'the cursor is in the first field').toBeFocused()
    await expect(page.locator('#georef-status')).toHaveText('No location saved yet.')
    // The panel says what a location does to scans that were placed before the update.
    await expect(page.locator('#georef-old-scans')).toHaveText(
      'Scans from before this update have no compass record of their session, so they stand on the grid until you move them.',
    )
    expect(pageErrors).toEqual([])
  })

  test('a mixed Place says how many scans are not in its frame, and a scan a person placed says so and claims nothing about the map', async ({ page }) => {
    const placedAt = composeYUpTransform({ x: 8, y: 0, z: 4 }, 40, 1)
    const calibratedAt = composeYUpTransform({ x: 2, y: 0, z: -3 }, 15, 1)
    const MOVED_SCAN = scan('scan-moved', 'Moved scan', {
      geoPose: { lat: 51.5, lng: -0.12, altitudeM: null, bearing: 90, accuracyM: 12 },
      accuracyM: 12,
      calibrationStatus: 'uncalibrated',
      placementSource: 'gps-compass',
      placementUncertaintyM: 12,
      localToWorld: placedAt,
      calibratedLocalToWorld: calibratedAt,
    })
    const patch: EditPatch = {
      patchId: 'patch-moved',
      worldId: 'world-georef-hud',
      scanId: MOVED_SCAN.scanId,
      targetId: MOVED_SCAN.filename,
      scope: 'scan',
      transform: { matrix: placedAt, position: { x: 8, y: 0, z: 4 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
      createdAt: '2026-11-17T09:00:00.000Z',
    }
    const store = newStore({
      project: { projectId: PROJECT_ID, name: PLACE_NAME, createdAt: 0, updatedAt: 0, floors: [], georeference: CONFIRMED, georefVersion: 1 },
      scans: [MAPPED_SCAN, GPS_SCAN, MOVED_SCAN],
      editPatches: [patch],
    })
    const pageErrors = await openEditor(page, store)
    // One scan stands outside the frame; the one a person placed is where they put it and is not counted.
    const flag = page.locator('#placement-flag')
    await expect(flag).toBeVisible()
    await expect(flag).toContainText('Not in the Place frame: 1 scan')
    await expect(flag).not.toContainText('Mirrored placement')
    // The scan list: the GPS scan keeps its claim, the moved one says it was placed by hand and makes none.
    const moved = page.locator('.scan-item', { hasText: 'Moved scan' })
    await expect(moved).toContainText('Placed by hand')
    await expect(moved).not.toContainText('GPS and compass')
    await expect(moved).not.toContainText('approximate to')
    await expect(page.locator('.scan-item', { hasText: 'Phone scan' })).toContainText('Placed by GPS and compass, approximate to about 12 m')
    expect(pageErrors).toEqual([])
  })

  test('a Place whose location is for an earlier alignment says so beside the Local readout, and Set location again opens the panel', async ({ page }) => {
    const frame = { version: 1, createdAt: '2026-11-16T09:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: 0, y: 0, z: 2 }, separationM: 2, toleranceM: 0.15, anchorBearingDeg: null, frameId: 'frame-b' }
    const store = newStore({
      project: { projectId: PROJECT_ID, name: PLACE_NAME, createdAt: 0, updatedAt: 0, floors: [], spatialFrame: frame, georeference: { ...CONFIRMED, anchorRef: 'frame-a' }, georefVersion: 3 } as unknown as Project,
      worldUsesGeoreference: false,
      scans: [CALIBRATED_SCAN],
    })
    const pageErrors = await openEditor(page, store)
    // The world does not use the location, so it reads Local: the flag says why and where to put it right.
    expect((await readout(page))[0]).toBe('Local (no georeference)')
    const flag = page.locator('#placement-flag')
    await expect(flag).toBeVisible()
    await expect(flag).toContainText('Location is for an earlier alignment')
    await expect(flag).not.toContainText('Mirrored placement')
    await flag.getByRole('button', { name: 'Set location again' }).click()
    await expect(page.locator('#georeference-section')).toHaveJSProperty('open', true)
    await expect(page.locator('#georef-earlier-frame')).toHaveText('This location was set for an earlier alignment of this Place.')
    expect(pageErrors).toEqual([])
  })

  test('Save as approximate and Confirm send two different records, each naming the version read, and the editor follows the save', async ({ page }) => {
    const store = newStore({ axesZ: 'north', scans: [GPS_SCAN, CALIBRATED_SCAN], seed: SEED })
    const events = await mockEvents(page)
    const pageErrors = await openEditor(page, store)
    await page.locator('#placement-flag').getByRole('button', { name: 'Re-place by GPS' }).click()

    // The estimate fills the form and saves nothing.
    const estimate = page.locator('#georef-estimate')
    await expect(estimate).toHaveText('Use compass estimate from 3 scans')
    await expect(estimate).toBeEnabled()
    await estimate.click()
    await expect(field(page, 'lat')).toHaveValue('51.5002')
    await expect(field(page, 'lng')).toHaveValue('-0.1199')
    await expect(field(page, 'heading')).toHaveValue('41.3')
    await expect(field(page, 'origin-accuracy')).toHaveValue('14.2')
    await expect(field(page, 'heading-accuracy')).toHaveValue('15')
    await expect(page.locator('#georef-estimate-note')).toContainText('Approximate. Indoors a compass can be off by tens of degrees.')
    await expect(page.locator('#georef-estimate-note')).toContainText('3 scans agree to about 4 degrees.')
    await expect(page.locator('#georef-message')).toHaveText('Filled from the compass estimate. Nothing is saved until you save.')
    expect(store.puts, 'filling the form from the estimate saved nothing').toHaveLength(0)
    // The filled form is a draft: a scan arriving, and the editor redrawing, leaves it as it is.
    await redraw(events, store)
    await expect(field(page, 'heading')).toHaveValue('41.3')
    await expect(page.locator('#georef-message')).toHaveText('Filled from the compass estimate. Nothing is saved until you save.')

    // Save as approximate: a compass seed, no confirmedAt, against version 0.
    await page.getByRole('button', { name: 'Save as approximate' }).click()
    await expect.poll(() => store.puts.length).toBe(1)
    const first = store.puts[0]!
    expect(first.expectedVersion).toBe(0)
    expect(first.georeference.confirmedAt, 'not confirmed by saving').toBeUndefined()
    expect(first.georeference.source).toBe('gps-compass')
    expect(first.georeference.origin).toMatchObject({ lat: 51.5002, lng: -0.1199, accuracyM: 14.2 })
    expect(first.georeference.bearingDeg).toBe(41.3)
    expect(first.georeference.bearingAccuracyDeg).toBe(15)
    expect(first.georeference.declination).toMatchObject({ deg: 0.6, model: 'WMM2025' })
    expect(first.georeference.seed).toMatchObject({ scans: 3, fromSeed: true })

    // The editor follows: the world is read again, it is in the scene the record defines, the mirrored flag goes and the readout is geographic.
    // The Place is still a mixed one (a scan with no calibration beside a calibrated one), and its banner says so.
    await expect(page.locator('#placement-flag')).not.toContainText('Mirrored placement')
    await expect(page.locator('#placement-flag')).toContainText('Not in the Place frame: 1 scan')
    await expect.poll(async () => (await readout(page))[0]).toMatch(/^East /)
    const followed = await readout(page)
    expectNumbersAgree(readNumbers(followed), first.georeference.origin)
    expect(followed[2]).toBe('Approximate to about 14 m · not confirmed')
    // The message the save gave is still there once the world was redrawn, and the status line reads the saved record.
    await expect(page.locator('#georef-message')).toHaveText('Saved as approximate. Scans you have not moved by hand follow it.')
    await expect(page.locator('#georef-status')).toHaveText('Saved: approximate, not confirmed.')
    await expect(page.locator('#georef-old-scans')).toBeHidden()

    // Confirm: the same numbers, now with confirmedAt, against version 1, and still a seed.
    await page.getByRole('button', { name: 'Confirm location and heading' }).click()
    await expect.poll(() => store.puts.length).toBe(2)
    const second = store.puts[1]!
    expect(second.expectedVersion).toBe(1)
    expect(typeof second.georeference.confirmedAt).toBe('string')
    expect(second.georeference.source, 'confirming a seed unedited confirms a seed').toBe('gps-compass')
    expect(second.georeference.declination).toMatchObject({ deg: 0.6 })
    expect(second.georeference.bearingAccuracyDeg, 'confirming does not improve the claim').toBe(15)
    await expect(page.locator('#georef-status')).toHaveText(/^Saved and confirmed \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/)
    await expect(page.locator('#georef-message')).toHaveText('Confirmed. Scans you have not moved by hand follow it.')
    await expect.poll(async () => (await readout(page))[2]).toBe('Approximate to about 14 m')
    expect(pageErrors).toEqual([])
  })

  test('another editor\'s save is shown and never overwritten', async ({ page }) => {
    const store = newStore({ project: { ...newStore().project, georeference: RECORD, georefVersion: 2 } })
    const pageErrors = await openEditor(page, store)
    await openPanelByHand(page)
    await expect(field(page, 'lat')).toHaveValue('51.500123')
    await expect(field(page, 'heading')).toHaveValue('41.5')
    await expect(page.locator('#georef-status')).toHaveText('Saved: approximate, not confirmed.')

    // This editor changes the heading; meanwhile another editor saves a location of their own.
    await field(page, 'heading').fill('50')
    store.project = { ...store.project, georeference: OTHER, georefVersion: 3 }
    await page.getByRole('button', { name: 'Save as approximate' }).click()

    // The server refused (this editor named version 2, it holds 3), and the other editor's location is what the panel shows now.
    await expect.poll(() => store.puts.length).toBe(1)
    expect(store.puts[0]!.expectedVersion).toBe(2)
    expect(store.project.georeference, 'the draft did not overwrite the other editor\'s record').toEqual(OTHER)
    expect(store.project.georefVersion).toBe(3)
    await expect(page.locator('#georef-message')).toHaveText(
      'Someone else saved a location for this Place first. Their location is shown. Check it and save again.',
    )
    await expect(field(page, 'lat')).toHaveValue('48.8584')
    await expect(field(page, 'lng')).toHaveValue('2.2945')
    await expect(field(page, 'heading')).toHaveValue('120')

    // Saving again now names the version the panel adopted, and wins.
    await page.getByRole('button', { name: 'Save as approximate' }).click()
    await expect.poll(() => store.puts.length).toBe(2)
    expect(store.puts[1]!.expectedVersion).toBe(3)
    expect(store.puts[1]!.georeference.source, 'their numbers, saved again as they were, are still their map click').toBe('map-click')
    expect(store.project.georefVersion).toBe(4)
    expect(pageErrors).toEqual([])
  })

  test('saving with no connection says so and changes nothing, and a number under what a map click can claim is refused first', async ({ page }) => {
    const store = newStore({ project: { ...newStore().project, georeference: RECORD, georefVersion: 1 } })
    const pageErrors = await openEditor(page, store)
    await openPanelByHand(page)
    await expect(field(page, 'lat')).toHaveValue('51.500123')

    // No connection: the save fails at once, loudly, and the Place is as it was.
    await field(page, 'heading').fill('50')
    store.offline = true
    await page.getByRole('button', { name: 'Save as approximate' }).click()
    await expect(page.locator('#georef-message')).toHaveText('Saving a location needs a connection')
    expect(store.puts, 'nothing reached the server').toHaveLength(0)
    expect(store.project.georeference).toEqual(RECORD)
    await expect(field(page, 'heading'), 'the draft is still there to save when the connection is back').toHaveValue('50')

    // Back online: the same draft saves.
    store.offline = false
    await page.getByRole('button', { name: 'Save as approximate' }).click()
    await expect.poll(() => store.puts.length).toBe(1)
    expect(store.puts[0]!.expectedVersion).toBe(1)
    expect(store.puts[0]!.georeference.bearingDeg).toBe(50)

    // A location accuracy under what a map click can claim is refused in words, and no request is made.
    await field(page, 'origin-accuracy').fill('1')
    await page.getByRole('button', { name: 'Save as approximate' }).click()
    await expect(page.locator('#georef-message')).toHaveText(
      'Check the numbers. Location accuracy cannot be better than 3.5 m: a map click is no better than that.',
    )
    expect(store.puts, 'the refused numbers never left the page').toHaveLength(1)
    expect(pageErrors).toEqual([])
  })

  test('a world redraw does not put saved numbers over a draft, and an untouched panel follows the Place', async ({ page }) => {
    const store = newStore({ project: { ...newStore().project, georeference: RECORD, georefVersion: 1 } })
    const events = await mockEvents(page)
    const pageErrors = await openEditor(page, store)
    await openPanelByHand(page)
    await expect(field(page, 'lat')).toHaveValue('51.500123')

    // Untouched: the panel follows what another editor saved, without being reopened.
    store.project = { ...store.project, georeference: OTHER, georefVersion: 2 }
    await redraw(events, store)
    await expect(field(page, 'lat')).toHaveValue('48.8584')
    await expect(page.locator('#georef-status')).toHaveText('Saved: approximate, not confirmed.')

    // Typed while the read was on its way: the answer arrives after the typing, and does not fill over it.
    let release!: () => void
    store.placeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = store.reads.place
    store.project = { ...store.project, georeference: { ...OTHER, bearingDeg: 99 }, georefVersion: 3 }
    await events.send({ type: 'scan-added', filename: 'phone-scan.glb', size: 4096 })
    await expect.poll(() => store.reads.place, { message: 'the read of the Place has begun', timeout: 15_000 }).toBeGreaterThan(slow)
    await field(page, 'lat').fill('7.5')
    store.placeGate = null
    release()
    await page.waitForTimeout(400)
    await expect(field(page, 'lat'), 'what was typed while the read was on its way stays').toHaveValue('7.5')
    await expect(field(page, 'heading'), 'and nothing of the answer is put beside it').toHaveValue('120')

    // A draft: a redraw leaves it, and does not re-read the Place under it, so the draft keeps the version it began from.
    await field(page, 'lat').fill('12.5')
    const placeReads = store.reads.place
    store.project = { ...store.project, georeference: { ...OTHER, bearingDeg: 200 }, georefVersion: 4 }
    await redraw(events, store)
    await expect(field(page, 'lat')).toHaveValue('12.5')
    await expect(field(page, 'heading')).toHaveValue('120')
    expect(store.reads.place, 'the Place was not read under the draft').toBe(placeReads)
    expect(pageErrors).toEqual([])
  })

  test('the fields wait for each read of the Place that opens the panel, so that nothing is typed against a record that has not been read', async ({ page }) => {
    const store = newStore({ project: { ...newStore().project, georeference: RECORD, georefVersion: 1 } })
    const pageErrors = await openEditor(page, store)
    const ids = ['lat', 'lng', 'heading', 'origin-accuracy', 'heading-accuracy'] as const
    const save = page.getByRole('button', { name: 'Save as approximate' })
    const confirm = page.getByRole('button', { name: 'Confirm location and heading' })

    // The first opening: nothing has been read, so there is nothing to save against, and the answer is slow.
    let release!: () => void
    store.placeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.locator('#tab-btn-world').click()
    await page.locator('#georeference-section > summary').click()
    for (const id of ids) await expect(field(page, id), `first opening, ${id}`).toBeDisabled()
    await expect(save).toBeDisabled()
    await expect(confirm).toBeDisabled()
    store.placeGate = null
    release()
    await expect(field(page, 'lat')).toBeEnabled()
    await expect(field(page, 'lat')).toHaveValue('51.500123')
    await expect(save).toBeEnabled()

    // Opened again, with a Place already read: the fields wait for the new read too (it may hold what another editor saved).
    await page.locator('#georeference-section > summary').click()
    await expect(page.locator('#georeference-section')).toHaveJSProperty('open', false)
    store.project = { ...store.project, georeference: OTHER, georefVersion: 2 }
    store.placeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.locator('#georeference-section > summary').click()
    for (const id of ids) await expect(field(page, id), `second opening, ${id}`).toBeDisabled()
    await expect(save).toBeDisabled()
    await expect(confirm).toBeDisabled()
    store.placeGate = null
    release()
    await expect(field(page, 'lat')).toBeEnabled()
    await expect(field(page, 'lat'), 'and what it read is what is shown').toHaveValue('48.8584')
    expect(pageErrors).toEqual([])
  })

  test('a slow read of the Place that began before a save does not put the record from before it back', async ({ page }) => {
    const store = newStore({ project: { ...newStore().project, georeference: RECORD, georefVersion: 1 } })
    const events = await mockEvents(page)
    const pageErrors = await openEditor(page, store)
    await openPanelByHand(page)
    await expect(field(page, 'heading')).toHaveValue('41.5')

    // A scan arrives, the editor redraws the world, and the panel starts reading the Place again. The network is slow.
    let release!: () => void
    store.placeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const asked = store.reads.place
    await events.send({ type: 'scan-added', filename: 'phone-scan.glb', size: 4096 })
    await expect.poll(() => store.reads.place, { message: 'the read of the Place has begun', timeout: 15_000 }).toBeGreaterThan(asked)

    // While it is on its way the person saves a new heading, and the world cannot be read again after the save, so nothing
    // else would read the Place after it.
    store.placeGate = null
    await field(page, 'heading').fill('50')
    store.worldFails = true
    await page.getByRole('button', { name: 'Save as approximate' }).click()
    await expect.poll(() => store.puts.length).toBe(1)
    await expect(page.locator('#georef-message')).toHaveText('Saved as approximate. Scans you have not moved by hand follow it.')

    // The slow answer arrives now, describing the Place as it was before the save.
    release()
    await page.waitForTimeout(500)
    await expect(field(page, 'heading'), 'the saved heading stays').toHaveValue('50')
    store.worldFails = false
    await page.getByRole('button', { name: 'Save as approximate' }).click()
    await expect.poll(() => store.puts.length).toBe(2)
    expect(store.puts[1]!.expectedVersion, 'the second save names the version the first one made').toBe(2)
    expect(pageErrors.filter((error) => !/Failed to load/.test(error))).toEqual([])
  })
})
