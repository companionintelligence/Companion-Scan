/**
 * The locar.js viewer ("Places around you"), in Chromium with mocks: a fake camera, a GPS fix in Seattle, where
 * declination is about +15 deg, and a mocked GET /project-locations.
 *
 * The fixtures are placed with metres per degree worked out separately from the WGS-84 radii at 47.6062 N
 * (111182.6575 m north, 75191.5006 m east), not with the code under test.
 *
 * It checks that only usable pins are drawn, that each sits where the declination turn puts it (a Place due true
 * east lands at (100 cos D, -100 sin D) in the compass frame), that the list is nearest first with true distances
 * and bearings, that Legal notices opens, and that the page reads the pins route and never the full Places list.
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
}

type ViewerWindow = { __locarViewer?: ViewerState }

interface GeoViewCall {
  places: Array<{ name: string; lat: number; lng: number }>
}

type ShellWindow = { __geoViewCalls: GeoViewCall[] }

/** A Scan server on another origin than the page, as a shell sees its server. */
const SERVER = 'https://scan.example.test'
/** SCAN_SERVER_KEY, src/shared/storage-keys.ts. */
const SERVER_KEY = 'companion-scan-server'

/**
 * Makes the page believe it runs in the Capacitor shell, before any page script, as the shell's bridge does. On iOS
 * the ScanAR plugin has openGeoView, which records what it is handed.
 */
async function emulateShell(page: Page, platform: 'android' | 'ios'): Promise<void> {
  await page.addInitScript((os) => {
    const calls: GeoViewCall[] = []
    const win = window as unknown as ShellWindow & { Capacitor: unknown }
    win.__geoViewCalls = calls
    const openGeoView = async (options: GeoViewCall) => {
      calls.push(options)
      return { shown: options.places.length }
    }
    win.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => os,
      Plugins: os === 'ios' ? { ScanAR: { openGeoView } } : {},
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
    expect(requested.filter((url) => new URL(url).pathname === '/project-locations')).toEqual([`${SERVER}/project-locations`])
    expect(problems).toEqual([])
  })
})
