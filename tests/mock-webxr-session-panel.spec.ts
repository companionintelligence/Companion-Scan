/**
 * Wave 19, 0002: the WebXR scanner inside a headset session, where the browser draws no `dom-overlay`.
 *
 * iwer's emulated Quest 3 offers no `dom-overlay`, as Quest Browser does not, so the session it starts is the headset
 * case. The in-session panel (src/ar/xr-session-panel.ts) must show, and a controller's trigger, or a hand's pinch, aimed
 * at one of its buttons must press the scanner's own control on the page: `#stream-btn` for Start scan, `#capture-btn`
 * for Capture. The panel's state is on `window.__xrSessionPanel` under `?mock=`.
 *
 * Run: npx playwright test --project=chromium-mock mock-webxr-session-panel
 */
import { test, expect, type Page } from '@playwright/test'
import { dismissPlacePicker } from './support/start-scan'

type Vec3 = { x: number; y: number; z: number }
interface PanelHook {
  placed: boolean
  state: { mode: string; streaming: boolean }
  buttons: Array<{ action: string; label: string; world: Vec3 | null }>
  pressed: string[]
}

/** The quaternion that turns -Z, the way a controller points, towards `d`. */
function aimAt(d: Vec3): { x: number; y: number; z: number; w: number } {
  const len = Math.hypot(d.x, d.y, d.z)
  const b = { x: d.x / len, y: d.y / len, z: d.z / len }
  // From a = (0, 0, -1): the axis is a × b and the angle's half-turn form w = 1 + a·b.
  const q = { x: b.y, y: -b.x, z: 0, w: 1 - b.z }
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

async function panel(page: Page): Promise<PanelHook | null> {
  return page.evaluate(() => (window as never as { __xrSessionPanel?: PanelHook }).__xrSessionPanel ?? null)
}

/** Points the given input from `origin` at the panel button for `action`, then presses and releases it. */
async function pressButton(page: Page, action: string, input: 'controller' | 'hand'): Promise<void> {
  const hook = await panel(page)
  const target = hook?.buttons.find((b) => b.action === action)?.world
  expect(target, `the panel has a ${action} button with a place in the room`).toBeTruthy()
  const origin = { x: 0.15, y: 1.3, z: 0 }
  const q = aimAt({ x: target!.x - origin.x, y: target!.y - origin.y, z: target!.z - origin.z })
  await page.evaluate(({ origin, q, input }) => {
    const device = (window as never as { __iwerDevice: any }).__iwerDevice
    device.primaryInputMode = input
    const source = input === 'hand' ? device.hands.right : device.controllers.right
    source.position.set(origin.x, origin.y, origin.z)
    source.quaternion.set(q.x, q.y, q.z, q.w)
    if (input === 'hand') source.updatePinchValue(1)
    else source.updateButtonValue('trigger', 1)
  }, { origin, q, input })
  // The press is applied at the next frame start, which fires `select`; then let it go.
  await page.waitForTimeout(300)
  await page.evaluate((input) => {
    const device = (window as never as { __iwerDevice: any }).__iwerDevice
    if (input === 'hand') device.hands.right.updatePinchValue(0)
    else device.controllers.right.updateButtonValue('trigger', 0)
  }, input)
  await page.waitForTimeout(300)
}

test.describe('WebXR scanner in a headset session (no dom-overlay)', () => {
  test.setTimeout(90_000)

  test('the panel shows, and a trigger or a pinch on its buttons presses the scanner\'s own controls', async ({ page }) => {
    await page.goto('/?ar=webxr&mock=webxr')
    await expect.poll(() => page.evaluate(() => !!(window as never as { __iwerDevice?: unknown }).__iwerDevice), {
      timeout: 15_000,
    }).toBeTruthy()
    // The emulated Quest 3 offers no dom-overlay, as Quest Browser does not.
    expect(await page.evaluate(() => (window as never as { __iwerDevice: any }).__iwerDevice.supportedFeatures.includes('dom-overlay'))).toBe(false)

    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.click('#start-ar-btn')
    await dismissPlacePicker(page)

    // The panel is placed in front of the viewer once the session gives a pose.
    await expect.poll(async () => (await panel(page))?.placed ?? false, {
      timeout: 30_000,
      message: 'the in-session panel is placed: the session had no dom-overlay',
    }).toBe(true)
    const first = await panel(page)
    expect(first!.buttons.map((b) => b.action)).toEqual(['toggle-scan', 'capture'])
    // A headset with no camera model: its keyframes carry the eyes' pose, and the panel says so.
    expect((first as never as { state: { pose: string } }).state.pose).toBe('pose: the eyes, no camera model set')

    // Count presses of the scanner's own controls, whatever they then do.
    await page.evaluate(() => {
      const w = window as never as { __clicks: Record<string, number> }
      w.__clicks = { 'stream-btn': 0, 'capture-btn': 0 }
      for (const id of ['stream-btn', 'capture-btn']) {
        document.getElementById(id)?.addEventListener('click', () => { w.__clicks[id] = (w.__clicks[id] ?? 0) + 1 })
      }
    })
    const clicks = () => page.evaluate(() => (window as never as { __clicks: Record<string, number> }).__clicks)

    await pressButton(page, 'toggle-scan', 'controller')
    await expect.poll(async () => (await clicks())['stream-btn'], { timeout: 5_000 }).toBe(1)
    expect((await panel(page))!.pressed).toContain('toggle-scan')

    // This browser has never agreed to send camera frames, so Start scan opens the scanner's "Send camera frames?"
    // question, which the headset cannot show: the panel asks it instead. Answer "Not now", so nothing is sent.
    await expect.poll(async () => (await panel(page))?.state.mode, { timeout: 5_000 }).toBe('consent')
    expect((await panel(page))!.buttons.map((b) => b.action)).toEqual(['consent-allow', 'consent-decline'])
    await expect(page.locator('#keyframe-consent-allow')).toHaveCount(1)
    await pressButton(page, 'consent-decline', 'controller')
    await expect.poll(async () => (await panel(page))?.state.mode, { timeout: 5_000 }).toBe('scan')
    await expect(page.locator('#keyframe-consent-allow')).toHaveCount(0)
    expect((await panel(page))!.pressed).toEqual(['toggle-scan', 'consent-decline'])

    // A pinch is a select too.
    await pressButton(page, 'capture', 'hand')
    await expect.poll(async () => (await clicks())['capture-btn'], { timeout: 5_000 }).toBe(1)

    // A trigger pressed with the ray off the card presses nothing: here it points to the right, away from the card.
    const sideways = aimAt({ x: 1, y: 0, z: 0 })
    await page.evaluate((q) => {
      const device = (window as never as { __iwerDevice: any }).__iwerDevice
      device.primaryInputMode = 'controller'
      device.controllers.right.position.set(0.15, 1.3, 0)
      device.controllers.right.quaternion.set(q.x, q.y, q.z, q.w)
      device.controllers.right.updateButtonValue('trigger', 1)
    }, sideways)
    await page.waitForTimeout(300)
    await page.evaluate(() => (window as never as { __iwerDevice: any }).__iwerDevice.controllers.right.updateButtonValue('trigger', 0))
    await page.waitForTimeout(300)
    const after = await clicks()
    expect(after['stream-btn']).toBe(1)
    expect(after['capture-btn']).toBe(1)
  })

  test('a headset session with a camera model in the address reports the camera\'s pose, and the device keeps the model', async ({ page }) => {
    await page.goto('/?ar=webxr&mock=webxr&camoffset=0,-0.02,-0.05&camfov=60')
    await expect.poll(() => page.evaluate(() => !!(window as never as { __iwerDevice?: unknown }).__iwerDevice), {
      timeout: 15_000,
    }).toBeTruthy()
    // The emulated Quest 3 reports two views, as a headset does (with stereo off, iwer only narrows the right eye's
    // viewport to nothing), so the camera model applies.
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.click('#start-ar-btn')
    await dismissPlacePicker(page)
    await expect.poll(async () => (await panel(page) as never as { state?: { pose?: string } } | null)?.state?.pose ?? '', {
      timeout: 30_000,
    }).toBe('pose: the camera (offset 0, -0.02, -0.05 m, fov 60°; from the address)')
    expect(await page.evaluate(() => localStorage.getItem('scan-xr-camera-model'))).toContain('"fovYDeg":60')
  })
})
