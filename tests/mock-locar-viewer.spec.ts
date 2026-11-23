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
 */
import { expect, test } from '@playwright/test'

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

    expect(requested).toContain('/project-locations')
    expect(requested.filter((path) => path === '/projects')).toEqual([])
    expect(problems).toEqual([])
  })
})
