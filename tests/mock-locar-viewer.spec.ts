/**
 * The locar.js viewer ("Places around you"), in Chromium with mocks: a fake camera, a GPS fix in Seattle, where
 * declination is about +15 deg, and a mocked GET /project-locations.
 *
 * The fixtures are placed with metres per degree worked out separately from the WGS-84 radii at 47.6062 N
 * (111182.6575 m north, 75191.5006 m east), not with the code under test.
 *
 * It checks that only usable pins are drawn, that each sits where the declination turn puts it (a Place due true
 * east lands at (100 cos D, -100 sin D) in the compass frame), that the list is nearest first with true distances
 * and bearings, that a list row and a tap on a marker each open the Place's card, that Legal notices opens, and
 * that the page reads the pins route and never the full Places list.
 *
 * Two more tests stand in for the native shells with a stand-in Capacitor bridge: the page is not on the server's
 * origin there, so it asks for the Scan server first. It must not read pins from its own origin, must refuse an
 * address the shared form refuses, and must read the pins from the saved server after the dialog's reload. On
 * Android it draws them on locar. On iOS it hands them to the native geo view.
 */
import { expect, test, type Page } from '@playwright/test'

const FIX = { latitude: 47.6062, longitude: -122.3321 }
const NORTH_M_PER_DEG = 111182.6575
const EAST_M_PER_DEG = 75191.5006

const LOCATIONS = [
  { projectId: 'east', name: 'East test place', address: null, lat: FIX.latitude, lng: FIX.longitude + 100 / EAST_M_PER_DEG, scanCount: 0, capturedAt: null },
  { projectId: 'south', name: 'South test place', address: null, lat: FIX.latitude - 50 / NORTH_M_PER_DEG, lng: FIX.longitude, scanCount: 0, capturedAt: null },
  { projectId: 'nopin', name: 'No pin', address: null, lat: null, lng: null, scanCount: 0, capturedAt: null },
  { projectId: 'offglobe', name: 'Off the globe', address: null, lat: 95, lng: 0, scanCount: 0, capturedAt: null },
]

interface ViewerState {
  markers: Array<{ projectId: string; name: string; x: number; z: number }>
  turnDeg: number | null
  declinationApplied: boolean
  flags: { camera: string; gps: string; places: string; orientation: string }
  screenTargets?: () => Array<{ id: string; x: number; y: number; radiusPx: number; inFront: boolean }>
}

type ViewerWindow = { __locarViewer?: ViewerState }

interface GeoViewCall {
  places: Array<{ name: string; lat: number; lng: number }>
}

type ShellWindow = { __geoViewCalls: GeoViewCall[]; __closeGeoView: () => void }

/** A Scan server on another origin than the page, as a shell sees its server. */
const SERVER = 'https://scan.example.test'
/** SCAN_SERVER_KEY, src/shared/storage-keys.ts. */
const SERVER_KEY = 'companion-scan-server'

/**
 * Makes the page believe it runs in the Capacitor shell, before any page script, as the shell's bridge does. On iOS
 * the ScanAR plugin has openGeoView, which records what it is handed, and the geoViewClosed event, which
 * `__closeGeoView` sends as the view's Close button does.
 */
async function emulateShell(page: Page, platform: 'android' | 'ios'): Promise<void> {
  await page.addInitScript((os) => {
    const calls: GeoViewCall[] = []
    const closed: Array<() => void> = []
    const win = window as unknown as ShellWindow & { Capacitor: unknown }
    win.__geoViewCalls = calls
    win.__closeGeoView = () => closed.forEach((listener) => listener())
    const openGeoView = async (options: GeoViewCall) => {
      calls.push(options)
      return { shown: options.places.length }
    }
    const addListener = async (event: string, listener: () => void) => {
      if (event === 'geoViewClosed') closed.push(listener)
      return { remove: async () => undefined }
    }
    win.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => os,
      Plugins: os === 'ios' ? { ScanAR: { openGeoView, addListener } } : {},
    }
  }, platform)
}

/** The Scan server at SERVER: /health answers as a Scan server does, /project-locations with the pins. */
async function serveScanServer(page: Page): Promise<void> {
  await page.route(`${SERVER}/**`, (route) => {
    // The page is on another origin, so the answers need CORS, as the real server sends for an allowed origin.
    const headers = { 'access-control-allow-origin': '*' }
    const path = new URL(route.request().url()).pathname
    if (path === '/health') return route.fulfill({ json: { status: 'ok', model: 'test' }, headers })
    if (path === '/project-locations') return route.fulfill({ json: LOCATIONS, headers })
    return route.fulfill({ status: 404, headers })
  })
}

test.describe('locar.js viewer', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['camera', 'geolocation'])
    await context.setGeolocation({ ...FIX, accuracy: 5 })
  })

  test('draws only usable pins, turned by the declination, and lists them nearest first', async ({ page }) => {
    const problems: string[] = []
    const requested: string[] = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('request', (request) => requested.push(new URL(request.url()).pathname))
    await page.route('**/project-locations', (route) => route.fulfill({ json: LOCATIONS }))

    await page.goto('/locar-viewer.html')
    await page.waitForFunction(() => ((window as unknown as ViewerWindow).__locarViewer?.markers.length ?? 0) >= 2, undefined, { timeout: 30_000 })

    const state = await page.evaluate(() => (window as unknown as ViewerWindow).__locarViewer as ViewerState)
    expect(state.markers.map((marker) => marker.projectId).sort()).toEqual(['east', 'south'])
    expect(state.declinationApplied).toBe(true)
    const turn = state.turnDeg as number
    expect(turn).toBeGreaterThan(13)
    expect(turn).toBeLessThan(17)

    const rad = (turn * Math.PI) / 180
    const east = state.markers.find((marker) => marker.projectId === 'east')!
    const south = state.markers.find((marker) => marker.projectId === 'south')!
    expect(Math.abs(east.x - 100 * Math.cos(rad))).toBeLessThan(0.5)
    expect(Math.abs(east.z + 100 * Math.sin(rad))).toBeLessThan(0.5)
    expect(Math.abs(south.x - 50 * Math.sin(rad))).toBeLessThan(0.5)
    expect(Math.abs(south.z - 50 * Math.cos(rad))).toBeLessThan(0.5)

    const items = page.locator('#viewer-places li')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveText('South test place · 50 m · 180 deg')
    await expect(items.nth(1)).toHaveText('East test place · 100 m · 90 deg')

    // A row opens its Place's card: how far and which way from here, then what the map's pin popup shows.
    const card = page.locator('dialog[open]')
    await items.nth(0).getByRole('button').click()
    await expect(card.getByRole('heading', { name: 'South test place' })).toBeVisible()
    await expect(card).toContainText('Distance: 50 m')
    await expect(card).toContainText('Direction: 180 deg true (S)')
    await expect(card).toContainText('Scans: 0')
    await card.getByRole('button', { name: 'Close' }).click()
    await expect(card).toHaveCount(0)

    // Lying flat (beta 0), the camera looks straight down and every marker is level with the camera plane, where its
    // projection blows up. A tap then opens nothing.
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
    await page.evaluate(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 0, beta: 0, gamma: 0, absolute: true }))
    })
    await page.waitForFunction(
      () => (window as unknown as ViewerWindow).__locarViewer?.screenTargets?.().every((target) => !target.inFront) === true,
      undefined,
      { timeout: 10_000 },
    )
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await expect(card).toHaveCount(0)

    // A tap on the camera view opens the marker it means. One absolute orientation event, upright (beta 90), turns
    // locar's camera to the east marker's magnetic bearing, 90 - D.
    const eastMagneticDeg = 90 - turn
    await page.evaluate((alpha) => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta: 90, gamma: 0, absolute: true }))
    }, (360 - eastMagneticDeg) % 360)
    // locar eases the camera into a new orientation over a few frames, so wait until the marker has settled where
    // the camera now faces: the middle of the screen.
    const onScreen = await page.waitForFunction(() => {
      const east = (window as unknown as ViewerWindow).__locarViewer?.screenTargets?.().find((target) => target.id === 'east')
      const settled = east && east.inFront && Math.abs(east.x - window.innerWidth / 2) < 2 && east.y > 0 && east.y < window.innerHeight
      return settled ? { x: east.x, y: east.y } : null
    }, undefined, { timeout: 10_000 })
    const point = await onScreen.jsonValue() as { x: number; y: number }
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point)).toBe('CANVAS')
    // A fingertip's width off the marker's centre still counts.
    await page.mouse.click(point.x + 20, point.y + 10)
    await expect(card.getByRole('heading', { name: 'East test place' })).toBeVisible()
    await expect(card).toContainText('Direction: 90 deg true (E)')
    await card.getByRole('button', { name: 'Close' }).click()
    await expect(card).toHaveCount(0)
    // A tap on empty sky opens nothing.
    await page.mouse.click(point.x, Math.max(5, point.y - 200))
    await expect(card).toHaveCount(0)

    await page.getByRole('button', { name: 'Legal notices' }).click()
    await expect(page.locator('dialog[open]')).toHaveCount(1)

    // A browser reads its own origin, so it has no server setting.
    await expect(page.locator('#viewer-server')).toHaveCount(0)
    expect(requested).toContain('/project-locations')
    expect(requested.filter((path) => path === '/projects')).toEqual([])
    expect(problems).toEqual([])
  })

  test('in the Android shell, asks for the Scan server first, then reads the pins from it', async ({ page }) => {
    const problems: string[] = []
    const requested: string[] = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('request', (request) => requested.push(request.url()))
    await emulateShell(page, 'android')
    await serveScanServer(page)

    await page.goto('/locar-viewer.html')
    const dialog = page.locator('dialog[open]')
    await expect(dialog.getByRole('heading', { name: 'Scan server' })).toBeVisible()
    await expect(page.locator('#viewer-server')).toHaveText('Scan server: none set')

    // A fix arrives while the dialog is open. With no server the page asks nobody for pins.
    await page.waitForFunction(() => (window as unknown as ViewerWindow).__locarViewer?.flags.gps.startsWith('±') === true, undefined, { timeout: 30_000 })
    expect(await page.evaluate(() => (window as unknown as ViewerWindow).__locarViewer?.flags.places)).toBe('no Scan server set')

    // The shared form refuses plain http, and nothing is saved.
    const field = dialog.getByLabel('Scan server address')
    await field.fill('http://scan.example.test')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByRole('status')).toContainText('Use an https:// address')
    expect(await page.evaluate((key) => localStorage.getItem(key), SERVER_KEY)).toBeNull()
    expect(requested.filter((url) => new URL(url).pathname === '/project-locations')).toEqual([])

    // A good address is saved and tested. The server answers, so the dialog closes itself and the page reloads.
    const reloaded = page.waitForEvent('load')
    await field.fill('scan.example.test')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await reloaded
    await page.waitForFunction(() => ((window as unknown as ViewerWindow).__locarViewer?.markers.length ?? 0) >= 2, undefined, { timeout: 30_000 })

    expect(await page.evaluate((key) => localStorage.getItem(key), SERVER_KEY)).toBe(SERVER)
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(page.locator('#viewer-places li')).toHaveCount(2)
    await expect(page.locator('#viewer-server')).toHaveText('Scan server: scan.example.test')
    expect(requested).toContain(`${SERVER}/health`)
    expect(requested).toContain(`${SERVER}/project-locations`)
    // The pins came from the saved server only, never from the app's own origin.
    expect(requested.filter((url) => new URL(url).pathname === '/project-locations' && !url.startsWith(`${SERVER}/`))).toEqual([])

    // The button opens the same dialog with the saved address. Closing it without a save changes nothing.
    await page.locator('#viewer-server').click()
    await expect(dialog.getByLabel('Scan server address')).toHaveValue(SERVER)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    expect(problems).toEqual([])
  })

  test('in the iOS shell, asks for the Scan server first, then hands the pins to the native geo view', async ({ page }) => {
    const problems: string[] = []
    const requested: string[] = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('request', (request) => requested.push(request.url()))
    await emulateShell(page, 'ios')
    await serveScanServer(page)

    await page.goto('/locar-viewer.html')
    const dialog = page.locator('dialog[open]')
    await expect(dialog.getByRole('heading', { name: 'Scan server' })).toBeVisible()
    await expect(page.locator('#viewer-status')).toContainText('places: no Scan server set')
    expect(await page.evaluate(() => (window as unknown as ShellWindow).__geoViewCalls.length)).toBe(0)
    expect(requested.filter((url) => new URL(url).pathname === '/project-locations')).toEqual([])

    const reloaded = page.waitForEvent('load')
    await dialog.getByLabel('Scan server address').fill(SERVER)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await reloaded
    await page.waitForFunction(() => (window as unknown as ShellWindow).__geoViewCalls.length > 0, undefined, { timeout: 30_000 })

    const calls = await page.evaluate(() => (window as unknown as ShellWindow).__geoViewCalls)
    expect(calls).toHaveLength(1)
    expect(calls[0].places.map((place) => place.name).sort()).toEqual(['East test place', 'South test place'])
    await expect(page.locator('#viewer-status')).toContainText('places: 2 shown in the native geo view')
    const reopen = page.getByRole('button', { name: 'Show Places again' })
    await expect(reopen).toHaveCount(0)

    // The view's Close comes back to the page, which says so and shows the same pins again without reading them twice.
    await page.evaluate(() => (window as unknown as ShellWindow).__closeGeoView())
    await expect(page.locator('#viewer-status')).toContainText('places: 2 with a pin · the native geo view is closed')
    await reopen.click()
    await page.waitForFunction(() => (window as unknown as ShellWindow).__geoViewCalls.length > 1)
    const again = await page.evaluate(() => (window as unknown as ShellWindow).__geoViewCalls)
    expect(again).toHaveLength(2)
    expect(again[1].places).toEqual(again[0].places)
    await expect(page.locator('#viewer-status')).toContainText('places: 2 shown in the native geo view')
    await expect(reopen).toHaveCount(0)

    expect(requested.filter((url) => new URL(url).pathname === '/project-locations')).toEqual([`${SERVER}/project-locations`])
    expect(problems).toEqual([])
  })
})
