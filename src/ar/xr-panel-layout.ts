/**
 * The in-session panel's geometry and content (wave 19, 0002), with no DOM and no Three.js, so it is tested in Node.
 *
 * The panel is a flat card fixed in the room in front of where the session began: world-locked, so it stays put while
 * the wearer walks and turns, and a squeeze brings it back in front. It shows the scanner's own status and buttons that
 * press the scanner's own controls (./xr-session-panel.ts). Its canvas is PANEL_PX pixels and its card PANEL_SIZE_M
 * metres; a button is a rectangle in canvas pixels, and a ray finds one through the card's (u, v).
 */
import type { Pose } from './provider.ts'
import { rotateVector } from './xr-camera-model.ts'

/** The card's size in metres: readable at arm's length without filling the view. */
export const PANEL_SIZE_M = { width: 0.44, height: 0.3 } as const
/** The canvas it is drawn on, in pixels, in the card's proportions. */
export const PANEL_PX = { width: 880, height: 600 } as const
/** Where the card goes: this far in front of the viewer, and this far below the eyes. */
export const PANEL_DISTANCE_M = 0.75
export const PANEL_DROP_M = 0.2

export type PanelAction = 'toggle-scan' | 'capture' | 'consent-allow' | 'consent-decline'

export interface PanelButton {
  action: PanelAction
  label: string
  /** The rectangle in canvas pixels, from the top left. */
  x: number
  y: number
  w: number
  h: number
}

/** What the panel shows, read from the scanner's page by ./xr-session-panel.ts. */
export interface PanelState {
  /** `consent` while the scanner's "Send camera frames?" question is open; `scan` otherwise. */
  mode: 'scan' | 'consent'
  /** Whether keyframes are being sent. */
  streaming: boolean
  /** Keyframes sent in this session, as the scanner counts them. */
  sent: number
  /** Whether a capture is in flight (its button is disabled). */
  captureBusy: boolean
  /** The scanner's own status line, as its HUD shows it. */
  status: string
  /** What a keyframe's pose is (./xr-camera-model.ts describeCameraModel). */
  pose: string
  /** The consent question's paragraphs, in `consent` mode. */
  consent: string[]
  /** The consent question's two answers, as the scanner words them. */
  consentAllow: string
  consentDecline: string
}

const MARGIN = 40
const BUTTON_H = 120

/** The buttons for a state, laid out along the bottom of the card. */
export function panelButtons(state: PanelState): PanelButton[] {
  const y = PANEL_PX.height - MARGIN - BUTTON_H
  const w = (PANEL_PX.width - MARGIN * 3) / 2
  if (state.mode === 'consent') {
    return [
      { action: 'consent-allow', label: state.consentAllow, x: MARGIN, y, w, h: BUTTON_H },
      { action: 'consent-decline', label: state.consentDecline, x: MARGIN * 2 + w, y, w, h: BUTTON_H },
    ]
  }
  return [
    { action: 'toggle-scan', label: state.streaming ? 'Stop scan' : 'Start scan', x: MARGIN, y, w, h: BUTTON_H },
    { action: 'capture', label: state.captureBusy ? 'Capturing…' : 'Capture', x: MARGIN * 2 + w, y, w, h: BUTTON_H },
  ]
}

/** The button under a canvas point, or null. */
export function buttonAt(px: number, py: number, buttons: readonly PanelButton[]): PanelButton | null {
  return buttons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) ?? null
}

/** The lines of text above the buttons. */
export function panelLines(state: PanelState): string[] {
  if (state.mode === 'consent') return state.consent
  return [
    state.streaming ? `Scanning: ${state.sent} frame${state.sent === 1 ? '' : 's'} sent` : 'Not scanning',
    ...(state.status ? [state.status] : []),
    state.pose,
  ]
}

/** Where the card sits: its centre, and its turn about the vertical (the card's normal is (sin yaw, 0, cos yaw)). */
export interface PanelPlacement {
  position: { x: number; y: number; z: number }
  yaw: number
}

/**
 * In front of the viewer along its level forward direction, a little below the eyes, facing back at it. A viewer
 * looking straight up or down has no level forward, so the card goes where -Z is.
 */
export function panelPlacement(viewer: Pose, distanceM = PANEL_DISTANCE_M, dropM = PANEL_DROP_M): PanelPlacement {
  const forward = rotateVector(viewer.rotation, { x: 0, y: 0, z: -1 })
  let fx = forward.x
  let fz = forward.z
  const level = Math.hypot(fx, fz)
  if (level < 1e-3) {
    fx = 0
    fz = -1
  } else {
    fx /= level
    fz /= level
  }
  return {
    position: {
      x: viewer.position.x + fx * distanceM,
      y: viewer.position.y - dropM,
      z: viewer.position.z + fz * distanceM,
    },
    // The normal points back along -forward.
    yaw: Math.atan2(-fx, -fz),
  }
}

/** The card's right and normal directions in the world. Up is +Y. */
function axes(yaw: number): { right: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } {
  return {
    right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
    normal: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) },
  }
}

/**
 * Where a ray meets the card, as (u, v) from its top left in 0..1, and how far along the ray; null when it misses, runs
 * parallel or points away. Only the front face counts: a ray from behind the card does not press it.
 */
export function rayPanelHit(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  placement: PanelPlacement,
): { u: number; v: number; distance: number } | null {
  const { right, normal } = axes(placement.yaw)
  const denom = direction.x * normal.x + direction.y * normal.y + direction.z * normal.z
  // The ray must travel against the normal, into the card's front face.
  if (denom > -1e-6) return null
  const c = placement.position
  const t = ((c.x - origin.x) * normal.x + (c.y - origin.y) * normal.y + (c.z - origin.z) * normal.z) / denom
  if (t < 0) return null
  const hit = { x: origin.x + direction.x * t - c.x, y: origin.y + direction.y * t - c.y, z: origin.z + direction.z * t - c.z }
  const u = (hit.x * right.x + hit.y * right.y + hit.z * right.z) / PANEL_SIZE_M.width + 0.5
  const v = 0.5 - hit.y / PANEL_SIZE_M.height
  if (u < 0 || u > 1 || v < 0 || v > 1) return null
  return { u, v, distance: t }
}

/** A canvas point on the card, in the world: for a test aiming a controller at a button. */
export function panelPointToWorld(px: number, py: number, placement: PanelPlacement): { x: number; y: number; z: number } {
  const { right } = axes(placement.yaw)
  const across = (px / PANEL_PX.width - 0.5) * PANEL_SIZE_M.width
  const up = (0.5 - py / PANEL_PX.height) * PANEL_SIZE_M.height
  return {
    x: placement.position.x + right.x * across,
    y: placement.position.y + up,
    z: placement.position.z + right.z * across,
  }
}
