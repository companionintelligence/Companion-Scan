/**
 * locar.js spike, in Chromium with mocks: a fake camera, a GPS fix (setGeolocation) and orientation events.
 *
 * What it proves, and how each check could fail:
 *   - the camera starts: it waits for the webcam's own `webcamstarted` signal and a video with a size, not for
 *     App.start(), which resolves on the orientation grant;
 *   - placement is relative to the first fix, in metres: the fix is in Paris, and the marker placed 20 m north of it
 *     must sit at z = -20. locar's stock Web Mercator (the control) puts it at -20 / cos(lat), about -30.4 there;
 *   - the heading is a compass reading: an absolute event for a phone held upright and turned to face west reads
 *     270, and a relative event afterwards does not move it;
 *   - locar's three.js and the app's are one copy (no "Multiple instances of Three.js" warning).
 *
 * This is not a device test. Camera, GPS and compass on a phone are checked by hand.
 */
import { expect, test } from '@playwright/test'

/** The first fix: Paris, well away from any origin the spike could have built in. */
const FIX = { latitude: 48.8566, longitude: 2.3522 }

interface SpikeState {
  marker: { name: string; position: { x: number; y: number; z: number } } | null
  flags: { camera: string; gps: string; orientation: string }
  heading: number | null
  video: { width: number; height: number } | null
}

type SpikeWindow = { __locarSpike?: SpikeState }

test.describe('locar.js spike', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['camera', 'geolocation'])
    await context.setGeolocation({ ...FIX, accuracy: 5 })
  })

  test('the camera starts, the marker sits 20 m north of the first fix, and the heading is a compass reading', async ({ page }) => {
    const problems: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

    await page.goto('/locar.html')
    await page.waitForFunction(() => Boolean((window as unknown as SpikeWindow).__locarSpike?.video), undefined, { timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as unknown as SpikeWindow).__locarSpike?.marker), undefined, { timeout: 30_000 })

    // A phone held upright (beta 90) and turned so its back camera faces west (alpha 90).
    await page.evaluate(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 90, beta: 90, gamma: 0, absolute: true }))
    })
    await page.waitForFunction(() => {
      const heading = (window as unknown as SpikeWindow).__locarSpike?.heading
      return typeof heading === 'number' && Math.abs(heading - 270) < 2
    }, undefined, { timeout: 5_000 })
    // A relative event says nothing about north, so the heading must not move.
    await page.evaluate(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: false }))
    })

    const state = await page.evaluate(() => {
      const s = (window as unknown as SpikeWindow).__locarSpike
      const video = document.querySelector('video')
      return { ...s, videoWidth: video?.videoWidth ?? 0 }
    })

    expect(state.flags?.camera).toMatch(/^running \d+x\d+$/)
    expect(state.videoWidth).toBeGreaterThan(0)
    expect(state.flags?.gps).toContain('48.85660')
    expect(Math.abs((state.heading ?? Number.NaN) - 270)).toBeLessThan(2)
    expect(state.marker).not.toBeNull()
    const marker = state.marker as NonNullable<SpikeState['marker']>
    expect(marker.name).toBe('spike-marker-20m-north')
    // locar's scene: east is +x and north is -z. 20 m north of the first fix is z = -20, in metres.
    expect(Math.abs(marker.position.z + 20)).toBeLessThan(0.5)
    expect(Math.abs(marker.position.x)).toBeLessThan(0.5)

    console.log('locar spike console (errors and warnings):', problems)
    expect(problems.filter((line) => line.includes('Multiple instances of Three.js'))).toEqual([])
    expect(problems.filter((line) => line.startsWith('pageerror'))).toEqual([])
  })

  test('with the Web Mercator control the same marker sits about 30.4 m away, so the placement rule matters', async ({ page }) => {
    await page.goto('/locar.html?projection=mercator')
    await page.waitForFunction(() => Boolean((window as unknown as SpikeWindow).__locarSpike?.marker), undefined, { timeout: 30_000 })
    const marker = await page.evaluate(() => (window as unknown as SpikeWindow).__locarSpike?.marker ?? null)
    expect(marker).not.toBeNull()
    const north = marker as NonNullable<SpikeState['marker']>
    // Mercator stretches north by 1 / cos(lat): 20 m becomes about 30.4 m at Paris.
    const expected = -20 / Math.cos((FIX.latitude * Math.PI) / 180)
    expect(Math.abs(north.position.z - expected)).toBeLessThan(0.5)
  })
})
