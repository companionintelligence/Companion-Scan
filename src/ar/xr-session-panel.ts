/**
 * The in-session panel (wave 19, 0002): the scanner's controls inside a headset's immersive session.
 *
 * Quest Browser, PICO and Chrome on Android XR draw no `dom-overlay`, so once a session starts the page's HUD is gone
 * and nothing can be pressed. This panel is drawn in the session itself, world-locked in front of where it began. It
 * shows the scanner's own status and offers its own controls, and a controller's trigger or a hand's pinch (WebXR's
 * `select`) on a button presses the matching control on the page: `#stream-btn` to start or stop the scan,
 * `#capture-btn` to capture, and the keyframe consent dialog's own answers when that question is open. So consent, busy
 * guards and streaming stay exactly the scanner's (ADR 0001); the panel adds no path of its own. It reads the consent
 * question's words from the open dialog itself, so it shows what the page would, and imports none of the consent
 * modules, which only `main.ts` may (tests/unit/node/wp-15b-keyframe-controller.test.ts). A squeeze brings the card
 * back in front.
 *
 * It shows when the session was granted no `dom-overlay`; `?xrpanel=on` or `?xrpanel=off` overrides that. Under `?mock=`
 * its state is on `window.__xrSessionPanel` for the Playwright spec (tests/mock-webxr-session-panel.spec.ts).
 */
import * as THREE from 'three'
import {
  buttonAt,
  PANEL_PX,
  PANEL_SIZE_M,
  panelButtons,
  panelLines,
  panelPlacement,
  panelPointToWorld,
  rayPanelHit,
} from './xr-panel-layout.ts'
import type { PanelAction, PanelButton, PanelPlacement, PanelState } from './xr-panel-layout.ts'
import { rotateVector } from './xr-camera-model.ts'

/** Whether a session gets the panel: no `dom-overlay`, unless the address says otherwise. */
export function shouldShowSessionPanel(session: Pick<XRSession, 'domOverlayState'>, search: string): boolean {
  const forced = new URLSearchParams(search).get('xrpanel')
  if (forced === 'on') return true
  if (forced === 'off') return false
  return !session.domOverlayState
}

/** The page element each action presses. */
const ACTION_TARGET: Record<PanelAction, string> = {
  'toggle-scan': 'stream-btn',
  capture: 'capture-btn',
  'consent-allow': 'keyframe-consent-allow',
  'consent-decline': 'keyframe-consent-decline',
}

/** How often the panel re-reads the page's state, in ms. Untuned: a status changes at most a few times a second. */
const READ_EVERY_MS = 200
/** How long a pointer ray is drawn when it misses the card, in metres. */
const RAY_LENGTH_M = 1.5

export interface SessionPanelOptions {
  /** The session's reference space, read each time: the provider sets it after the session starts. */
  refSpace: () => XRReferenceSpace | null
  /** What a keyframe's pose is, for the panel's last line. */
  describePose: () => string
  doc?: Document
}

/** What `window.__xrSessionPanel` holds under `?mock=`. */
export interface SessionPanelTestState {
  placed: boolean
  placement: PanelPlacement | null
  state: PanelState
  buttons: Array<PanelButton & { world: { x: number; y: number; z: number } | null }>
  pressed: PanelAction[]
}

declare global {
  interface Window {
    __xrSessionPanel?: SessionPanelTestState
  }
}

export class XrSessionPanel {
  private readonly scene: THREE.Scene
  private readonly session: XRSession
  private readonly opts: SessionPanelOptions
  private readonly doc: Document
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly texture: THREE.CanvasTexture
  private readonly mesh: THREE.Mesh
  private readonly rays = new Map<XRInputSource, THREE.Line>()
  private placement: PanelPlacement | null = null
  private recenter = false
  private state: PanelState
  private drawnKey = ''
  private hover: PanelAction | null = null
  private lastReadMs = -Infinity
  private readonly pressed: PanelAction[] = []
  private readonly removeListeners: Array<() => void> = []
  private readonly testHook: boolean

  // Plain fields, not parameter properties: Node runs this file by stripping its types, in the unit tests that load the
  // provider, and stripping cannot express a parameter property.
  constructor(scene: THREE.Scene, session: XRSession, opts: SessionPanelOptions) {
    this.scene = scene
    this.session = session
    this.opts = opts
    this.doc = opts.doc ?? document
    this.canvas = this.doc.createElement('canvas')
    this.canvas.width = PANEL_PX.width
    this.canvas.height = PANEL_PX.height
    // Null where there is no 2-D canvas (a stand-in document in a unit test): the card is then blank, and the buttons work.
    this.ctx = typeof this.canvas.getContext === 'function' ? this.canvas.getContext('2d') : null
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      // Always readable over the passthrough and anything else the scene draws.
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_SIZE_M.width, PANEL_SIZE_M.height), material)
    this.mesh.name = 'xr session panel'
    this.mesh.renderOrder = 1000
    this.mesh.visible = false
    this.scene.add(this.mesh)
    this.state = this.readState()
    this.testHook = new URLSearchParams(globalThis.location?.search ?? '').has('mock')

    const onSelect = (event: Event) => this.onSelect(event as XRInputSourceEvent)
    const onSqueeze = () => { this.recenter = true }
    session.addEventListener('select', onSelect)
    session.addEventListener('squeeze', onSqueeze)
    this.removeListeners.push(
      () => session.removeEventListener('select', onSelect),
      () => session.removeEventListener('squeeze', onSqueeze),
    )
    this.publish()
  }

  /** Once per XR frame, before the scene is rendered. */
  onFrame(frame: XRFrame, viewerPose: XRViewerPose | null | undefined, timeMs: number): void {
    const refSpace = this.opts.refSpace()
    if (viewerPose && (!this.placement || this.recenter)) {
      const { position: p, orientation: q } = viewerPose.transform
      this.placement = panelPlacement({ position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } })
      this.recenter = false
      this.mesh.position.set(this.placement.position.x, this.placement.position.y, this.placement.position.z)
      this.mesh.rotation.set(0, this.placement.yaw, 0)
      this.mesh.visible = true
    }
    if (timeMs - this.lastReadMs >= READ_EVERY_MS) {
      this.lastReadMs = timeMs
      this.state = this.readState()
    }
    this.hover = refSpace ? this.updateRays(frame, refSpace) : null
    this.draw()
    this.publish()
  }

  dispose(): void {
    for (const remove of this.removeListeners.splice(0)) remove()
    for (const line of this.rays.values()) {
      this.scene.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    this.rays.clear()
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.texture.dispose()
    if (this.testHook && typeof window !== 'undefined') delete window.__xrSessionPanel
  }

  /** The scanner's state, read from its page: the HUD that the headset cannot show. */
  private readState(): PanelState {
    const doc = this.doc
    const stream = doc.getElementById('stream-btn')
    const capture = doc.getElementById('capture-btn') as HTMLButtonElement | null
    const allow = doc.getElementById(ACTION_TARGET['consent-allow'])
    const decline = doc.getElementById(ACTION_TARGET['consent-decline'])
    // The consent question as its dialog shows it: the heading, then every paragraph (src/ui/shell-dialog.ts).
    const dialog = allow?.isConnected ? allow.closest('dialog') : null
    const question = dialog
      ? [dialog.querySelector('h2'), ...dialog.querySelectorAll('p')]
        .map((el) => el?.textContent?.trim() ?? '')
        .filter((text) => text !== '')
      : []
    const status = (doc.getElementById('status-text')?.textContent ?? '').split('\n')[0]!.replace(/^[•\s]+/, '').trim()
    const sent = Number.parseInt(doc.getElementById('stream-count')?.textContent ?? '', 10)
    return {
      mode: dialog ? 'consent' : 'scan',
      streaming: stream?.classList.contains('active') ?? false,
      sent: Number.isFinite(sent) ? sent : 0,
      captureBusy: capture?.disabled ?? false,
      status,
      pose: this.opts.describePose(),
      consent: question,
      consentAllow: allow?.textContent?.trim() || 'Allow',
      consentDecline: decline?.textContent?.trim() || 'Not now',
    }
  }

  /** The ray of an input source in the reference space, or null. */
  private rayOf(frame: XRFrame, source: XRInputSource, refSpace: XRReferenceSpace): { origin: THREE.Vector3; direction: THREE.Vector3 } | null {
    const pose = frame.getPose(source.targetRaySpace, refSpace)
    if (!pose) return null
    const { position: p, orientation: q } = pose.transform
    const d = rotateVector({ x: q.x, y: q.y, z: q.z, w: q.w }, { x: 0, y: 0, z: -1 })
    return { origin: new THREE.Vector3(p.x, p.y, p.z), direction: new THREE.Vector3(d.x, d.y, d.z) }
  }

  /** The button an input points at, or null. */
  private buttonHit(origin: THREE.Vector3, direction: THREE.Vector3): { button: PanelButton | null; distance: number } | null {
    if (!this.placement || !this.mesh.visible) return null
    const hit = rayPanelHit(origin, direction, this.placement)
    if (!hit) return null
    return { button: buttonAt(hit.u * PANEL_PX.width, hit.v * PANEL_PX.height, panelButtons(this.state)), distance: hit.distance }
  }

  /** Draws a pointer ray per input and returns the button one of them is on. */
  private updateRays(frame: XRFrame, refSpace: XRReferenceSpace): PanelAction | null {
    let hovered: PanelAction | null = null
    const seen = new Set<XRInputSource>()
    for (const source of this.session.inputSources) {
      if (source.targetRayMode !== 'tracked-pointer') continue
      seen.add(source)
      const ray = this.rayOf(frame, source, refSpace)
      let line = this.rays.get(source)
      if (!line) {
        line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -RAY_LENGTH_M)]),
          new THREE.LineBasicMaterial({ color: 0xc5e8dc, transparent: true, opacity: 0.8, depthTest: false }),
        )
        line.renderOrder = 1001
        this.rays.set(source, line)
        this.scene.add(line)
      }
      line.visible = ray !== null && this.mesh.visible
      if (!ray) continue
      const hit = this.buttonHit(ray.origin, ray.direction)
      if (hit?.button) hovered = hit.button.action
      // The line's two points, moved in place: nothing is allocated for it per frame.
      const length = hit ? hit.distance : RAY_LENGTH_M
      const points = line.geometry.getAttribute('position') as THREE.BufferAttribute
      points.setXYZ(0, ray.origin.x, ray.origin.y, ray.origin.z)
      points.setXYZ(1, ray.origin.x + ray.direction.x * length, ray.origin.y + ray.direction.y * length, ray.origin.z + ray.direction.z * length)
      points.needsUpdate = true
    }
    for (const [source, line] of this.rays) {
      if (seen.has(source)) continue
      this.scene.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
      this.rays.delete(source)
    }
    return hovered
  }

  /** A trigger or a pinch: press the page control under the ray. One `select` is one press, wherever it fires. */
  private onSelect(event: XRInputSourceEvent): void {
    const refSpace = this.opts.refSpace()
    if (!refSpace) return
    let ray
    try {
      ray = this.rayOf(event.frame, event.inputSource, refSpace)
    } catch {
      // A frame no longer active cannot be asked for a pose: there is nothing to aim with.
      return
    }
    if (!ray) return
    // Read the page now, not at the last tick: the buttons a press finds are the ones on screen.
    this.state = this.readState()
    const action = this.buttonHit(ray.origin, ray.direction)?.button?.action
    if (!action) return
    const target = this.doc.getElementById(ACTION_TARGET[action]) as HTMLButtonElement | null
    if (!target || target.disabled) return
    this.pressed.push(action)
    target.click()
    console.log(`[webxr] panel: ${action}`)
  }

  private draw(): void {
    const ctx = this.ctx
    if (!ctx) return
    const buttons = panelButtons(this.state)
    const lines = panelLines(this.state)
    const key = JSON.stringify([lines, buttons.map((b) => b.label), this.hover])
    if (key === this.drawnKey) return
    this.drawnKey = key
    const { width: W, height: H } = PANEL_PX
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(4, 22, 32, 0.88)'
    roundRect(ctx, 0, 0, W, H, 36)
    ctx.fill()
    ctx.fillStyle = '#c5e8dc'
    ctx.font = '600 40px Manrope, system-ui, sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillText(this.state.mode === 'consent' ? lines[0] ?? '' : 'Companion Scan', 40, 32)
    ctx.fillStyle = '#ffffff'
    ctx.font = '400 28px Manrope, system-ui, sans-serif'
    let y = 96
    const body = this.state.mode === 'consent' ? lines.slice(1) : lines
    for (const line of body) {
      for (const wrapped of wrap(ctx, line, W - 80)) {
        if (y > PANEL_PX.height - 190) break
        ctx.fillText(wrapped, 40, y)
        y += 36
      }
    }
    for (const button of buttons) {
      const hot = this.hover === button.action
      ctx.fillStyle = hot ? '#0e8a7b' : '#0a6358'
      roundRect(ctx, button.x, button.y, button.w, button.h, 24)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = '600 38px Manrope, system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(button.label, button.x + button.w / 2, button.y + button.h / 2)
      ctx.textAlign = 'start'
      ctx.textBaseline = 'top'
    }
    this.texture.needsUpdate = true
  }

  private publish(): void {
    if (!this.testHook || typeof window === 'undefined') return
    const placement = this.placement
    window.__xrSessionPanel = {
      placed: placement !== null,
      placement,
      state: this.state,
      buttons: panelButtons(this.state).map((b) => ({
        ...b,
        world: placement ? panelPointToWorld(b.x + b.w / 2, b.y + b.h / 2, placement) : null,
      })),
      pressed: [...this.pressed],
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxWidth) {
      out.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) out.push(line)
  return out
}
