/**
 * Wave 19, 0002: the in-session panel's geometry and content (src/ar/xr-panel-layout.ts). Where the card goes, which
 * button a ray finds, and what the card says; the drawing and the page's controls are in tests/mock-webxr-session-panel.spec.ts.
 *
 *   node --experimental-strip-types --no-warnings --test tests/unit/node/wp-19-xr-session-panel.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buttonAt,
  PANEL_DISTANCE_M,
  PANEL_DROP_M,
  PANEL_PX,
  panelButtons,
  panelLines,
  panelPlacement,
  panelPointToWorld,
  rayPanelHit,
} from '../../../src/ar/xr-panel-layout.ts'
import type { PanelState } from '../../../src/ar/xr-panel-layout.ts'

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

const SCAN: PanelState = {
  mode: 'scan',
  streaming: false,
  sent: 0,
  captureBusy: false,
  status: 'Tracking',
  pose: 'pose: the eyes, no camera model set',
  consent: [],
  consentAllow: 'Allow',
  consentDecline: 'Not now',
}

test('the card goes ahead of the viewer, level, a little below the eyes, facing it', () => {
  const ahead = panelPlacement({ position: { x: 1, y: 1.6, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
  assert.ok(close(ahead.position.x, 1) && close(ahead.position.y, 1.6 - PANEL_DROP_M) && close(ahead.position.z, 2 - PANEL_DISTANCE_M))
  assert.ok(close(ahead.yaw, 0))
  // Looking down at 60°: the card still goes level ahead, not into the floor.
  const pitch = (-60 * Math.PI) / 360
  const down = panelPlacement({ position: { x: 0, y: 1.6, z: 0 }, rotation: { x: Math.sin(pitch), y: 0, z: 0, w: Math.cos(pitch) } })
  assert.ok(close(down.position.z, -PANEL_DISTANCE_M, 1e-6) && close(down.position.y, 1.6 - PANEL_DROP_M))
  // Turned to face +X: the card is at +X, and its normal points back at the viewer (-X).
  const s = Math.SQRT1_2
  const right = panelPlacement({ position: { x: 0, y: 1.6, z: 0 }, rotation: { x: 0, y: -s, z: 0, w: s } })
  assert.ok(close(right.position.x, PANEL_DISTANCE_M, 1e-6) && close(right.position.z, 0, 1e-6))
  assert.ok(close(Math.sin(right.yaw), -1, 1e-6))
})

test('a ray from the viewer at a button finds that button; a miss, a parallel ray and the back face find none', () => {
  const placement = panelPlacement({ position: { x: 0, y: 1.6, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
  const buttons = panelButtons(SCAN)
  for (const button of buttons) {
    const target = panelPointToWorld(button.x + button.w / 2, button.y + button.h / 2, placement)
    const origin = { x: 0.1, y: 1.3, z: 0 }
    const d = { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z }
    const len = Math.hypot(d.x, d.y, d.z)
    const hit = rayPanelHit(origin, { x: d.x / len, y: d.y / len, z: d.z / len }, placement)
    assert.ok(hit, `a ray at ${button.action} hits the card`)
    assert.equal(buttonAt(hit.u * PANEL_PX.width, hit.v * PANEL_PX.height, buttons)?.action, button.action)
    assert.ok(close(hit.distance, len, 1e-6))
  }
  assert.equal(rayPanelHit({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 1, z: 0 }, placement), null, 'straight up misses')
  assert.equal(rayPanelHit({ x: 0, y: 1.4, z: 0 }, { x: 1, y: 0, z: 0 }, placement), null, 'parallel to the card')
  assert.equal(rayPanelHit({ x: 0, y: 1.4, z: -2 }, { x: 0, y: 0, z: 1 }, placement), null, 'from behind the card')
  assert.equal(rayPanelHit({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: 1 }, placement), null, 'pointing away')
  // The card's middle, above the buttons, is the card but no button.
  const middle = rayPanelHit({ x: 0, y: placement.position.y, z: 0 }, { x: 0, y: 0, z: -1 }, placement)
  assert.ok(middle && close(middle.u, 0.5) && close(middle.v, 0.5))
  assert.equal(buttonAt(middle.u * PANEL_PX.width, middle.v * PANEL_PX.height, buttons), null)
})

test('the buttons are the scanner\'s controls, and say what a press will do', () => {
  assert.deepEqual(panelButtons(SCAN).map((b) => [b.action, b.label]), [['toggle-scan', 'Start scan'], ['capture', 'Capture']])
  assert.deepEqual(panelButtons({ ...SCAN, streaming: true, captureBusy: true }).map((b) => b.label), ['Stop scan', 'Capturing…'])
  const consent = { ...SCAN, mode: 'consent' as const, consent: ['Send camera frames?', 'While you scan, …'] }
  assert.deepEqual(panelButtons(consent).map((b) => [b.action, b.label]), [['consent-allow', 'Allow'], ['consent-decline', 'Not now']])
  // Side by side, inside the card, not overlapping.
  const [a, b] = panelButtons(SCAN)
  assert.ok(a!.x + a!.w < b!.x && b!.x + b!.w <= PANEL_PX.width && a!.y + a!.h <= PANEL_PX.height)
})

test('the card\'s words: the scan\'s state, the scanner\'s status and what a keyframe\'s pose is; or the whole consent question', () => {
  assert.deepEqual(panelLines(SCAN), ['Not scanning', 'Tracking', 'pose: the eyes, no camera model set'])
  assert.deepEqual(panelLines({ ...SCAN, streaming: true, sent: 1, status: '' }), ['Scanning: 1 frame sent', 'pose: the eyes, no camera model set'])
  assert.equal(panelLines({ ...SCAN, streaming: true, sent: 12 })[0], 'Scanning: 12 frames sent')
  const question = ['Send camera frames?', 'While you scan, …', 'Server: scan.example']
  assert.deepEqual(panelLines({ ...SCAN, mode: 'consent', consent: question }), question)
})
