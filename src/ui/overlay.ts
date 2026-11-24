/**
 * AR overlay — 3D-projected label pins + the capture button.
 *
 * Each detected object gets a pin that:
 *  - Builds a live Three.js PerspectiveCamera from the SLAM pose + camera intrinsics
 *    (since XR8.Threejs pipeline module is not loaded, we reconstruct the camera ourselves)
 *  - Projects world position → screen via frustum raycasting every render frame
 *  - Shows a coloured category dot + label + confidence + live distance
 *  - Scales with distance, hides when behind camera or more than 20 m away (MAX_PIN_DISTANCE_M)
 *  - Pulses briefly when newly added
 *
 * What draws a frame: on 8th Wall, a camera pipeline module, in step with the engine's render. On every
 * runtime, src/main.ts's frame loop (./frame-loop.ts) calls frame(), which draws whenever that module
 * has not drawn recently. So WebXR and native ARKit or ARCore sessions get pins too (F-13).
 *
 * The status line is not this class's. Every write to it goes through src/main.ts's
 * setupStatusOverlay(), and from there through ./status-line.ts.
 */
import * as THREE from 'three'
import type { ARProvider } from '../ar/provider'
import type { DetectionStore } from '../scene/store'
import { cameraViewRect, ndcToScreen } from './pin-geometry'
import { categoryColor, categoryTextColor } from './category-color.ts'
import { pipelineDrewRecently } from './frame-loop.ts'

declare const XR8: {
  addCameraPipelineModule(mod: object): void
}

export type CaptureButtonCallback = () => Promise<void>

/** A pin further than this from the camera is hidden. */
const MAX_PIN_DISTANCE_M = 20

export class AROverlay {
  private container: HTMLElement
  private captureBtn: HTMLButtonElement
  private pinMap = new Map<string, HTMLDivElement>()
  /** Reused Three.js camera — updated every frame from the SLAM pose */
  private _projCam: THREE.PerspectiveCamera | null = null
  /** performance.now() of the 8th Wall pipeline's last draw. Null until it has drawn, and on every other runtime. */
  private _lastPipelineMs: number | null = null

  constructor(
    private readonly store: DetectionStore,
    private readonly use8thWall: boolean,
    private readonly provider: ARProvider,
  ) {
    this.container = document.getElementById('ar-overlay')!
    this.captureBtn = document.getElementById('capture-btn') as HTMLButtonElement

    store.subscribe(() => this.syncPins())
  }

  mount(onCapture: CaptureButtonCallback): void {
    this.captureBtn.addEventListener('click', async () => {
      if (this.captureBtn.classList.contains('busy')) return
      try {
        await onCapture()
      } catch (error) {
        console.warn('[overlay] capture handler failed:', error)
      }
    })

    if (this.use8thWall) {
      // Hook into the 8th Wall pipeline instead of relying on XR8.Threejs.xrScene()
      // (the Threejs module is not loaded). We build the projection camera from
      // the SLAM pose captured in EighthWallProvider.
      const self = this
      XR8.addCameraPipelineModule({
        name: 'ci-scan-overlay-tick',
        onRender: () => {
          self._lastPipelineMs = performance.now()
          const cam = self._buildCameraFromProvider()
          if (cam) self.tickPins(cam)
        },
      })
    }
  }

  /**
   * One frame of src/main.ts's frame loop, on every runtime. Draws the pins from the provider's pose,
   * unless the 8th Wall pipeline drew them within the last PIPELINE_GRACE_MS (./frame-loop.ts). With no
   * pin to place, it does nothing, so an empty scan costs nothing per frame.
   */
  frame(nowMs: number = performance.now()): void {
    if (this.pinMap.size === 0 || pipelineDrewRecently(this._lastPipelineMs, nowMs)) return
    const cam = this._buildCameraFromProvider()
    if (cam) this.tickPins(cam)
  }

  /** Draw the pins through `camera`. frame() is the per-frame caller. This takes a camera a caller already has. */
  tick(camera: THREE.Camera): void {
    this.tickPins(camera)
  }

  /**
   * Builds (or updates) a Three.js PerspectiveCamera from the current SLAM pose.
   * Uses the camera intrinsics (FOV + aspect) read from processGpuResult.reality.
   */
  private _buildCameraFromProvider(): THREE.PerspectiveCamera | null {
    if (!this.provider.isTracking()) return null

    const pose   = this.provider.getPose()
    const fovY   = this.provider.getCameraFovY()
    const aspect = this.provider.getCameraAspect()

    if (!this._projCam) {
      this._projCam = new THREE.PerspectiveCamera(fovY, aspect, 0.01, 1000)
    } else {
      this._projCam.fov    = fovY
      this._projCam.aspect = aspect
      this._projCam.updateProjectionMatrix()
    }

    this._projCam.position.set(pose.position.x, pose.position.y, pose.position.z)
    this._projCam.quaternion.set(
      pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w,
    )
    this._projCam.updateMatrixWorld(true)
    return this._projCam
  }

  private syncPins(): void {
    // A pin is drawn from a position in the live frame. An object an earlier run saved has a position in
    // that run's frame, so it gets no pin (see DetectionStore.currentRunDetections).
    const dets = this.store.currentRunDetections()

    for (const [key, el] of this.pinMap) {
      if (!dets.has(key)) {
        el.remove()
        this.pinMap.delete(key)
      }
    }

    for (const [key, det] of dets) {
      if (this.pinMap.has(key)) continue

      const color = categoryColor(det.label)
      const textColor = categoryTextColor(det.label)

      const wrap = document.createElement('div')
      wrap.className = 'ar-pin-wrap'
      wrap.dataset['key'] = key
      wrap.style.cssText = 'position:absolute;pointer-events:none;display:none;transform-origin:bottom center;'

      // Pill label
      const pill = document.createElement('div')
      pill.style.cssText = `
        background:rgba(0,0,0,0.82);
        backdrop-filter:blur(10px);
        border:1.5px solid ${color};
        border-radius:20px;
        padding:6px 11px 6px 8px;
        display:flex;align-items:center;gap:6px;
        font-size:13px;white-space:nowrap;
        box-shadow:0 2px 16px rgba(0,0,0,0.55);
        transform:translateX(-50%) translateY(-100%);
        position:relative;
      `

      const dot = document.createElement('span')
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;box-shadow:0 0 8px ${color};`

      const labelSpan = document.createElement('span')
      labelSpan.style.cssText = 'color:#fff;font-weight:700;letter-spacing:0.01em;'
      labelSpan.textContent = det.label

      const confSpan = document.createElement('span')
      confSpan.style.cssText = 'color:rgba(255,255,255,0.45);font-size:11px;'
      confSpan.textContent = `${Math.round(det.confidence * 100)}%`

      const distSpan = document.createElement('span')
      distSpan.className = 'ar-pin-dist'
      distSpan.style.cssText = `color:${textColor};font-size:11px;margin-left:1px;`

      pill.append(dot, labelSpan, confSpan, distSpan)

      // Anchor dot at the world-point location on screen
      const anchor = document.createElement('div')
      anchor.style.cssText = `
        position:absolute;
        top:0;left:0;
        width:10px;height:10px;border-radius:50%;
        background:${color};
        box-shadow:0 0 10px ${color};
        transform:translate(-50%,-50%);
      `

      // Connector line between anchor and pill
      const line = document.createElement('div')
      line.className = 'ar-pin-line'
      line.style.cssText = `
        position:absolute;
        top:0;left:0;
        width:1px;
        transform-origin:top left;
        background:linear-gradient(to bottom,${color},rgba(0,0,0,0));
        opacity:0.7;
        pointer-events:none;
      `

      wrap.append(anchor, line, pill)
      wrap.classList.add('entering')
      this.container.appendChild(wrap)
      this.pinMap.set(key, wrap)
      // Remove entrance class after animation completes
      setTimeout(() => wrap.classList.remove('entering'), 400)
    }
  }

  private tickPins(camera: THREE.Camera): void {
    const w = window.innerWidth
    const h = window.innerHeight
    // The camera canvas can be smaller than the viewport (contain fit). Pins map through its rect.
    const canvas = document.getElementById('camerafeed')
    const view = cameraViewRect(canvas ? canvas.getBoundingClientRect() : null, { width: w, height: h })
    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)
    const proj = new THREE.Vector3()
    // Read once a frame, from the live frame's detections only: a pin that outlived its detection's run
    // (the run changed between two store notifications) hides instead of moving to a wrong place.
    const dets = this.store.currentRunDetections()

    for (const [key, wrap] of this.pinMap) {
      const det = dets.get(key)
      if (!det) { wrap.style.display = 'none'; continue }

      const { x, y, z } = det.worldPos
      proj.set(x, y, z).project(camera)

      // Behind camera (NDC z > 1)
      if (proj.z > 1) { wrap.style.display = 'none'; continue }

      const screen = ndcToScreen(proj.x, proj.y, view)
      const sx = screen.x
      const sy = screen.y
      const dist = camPos.distanceTo(new THREE.Vector3(x, y, z))

      if (sx < -100 || sx > w + 100 || sy < -100 || sy > h + 100 || dist > MAX_PIN_DISTANCE_M) {
        wrap.style.display = 'none'
        continue
      }

      // Scale: full size at 1m, smallest at 8m
      const scale = Math.max(0.45, Math.min(1, 1.2 - dist / 10))
      const PILL_H = 32 // approximate pill height in px

      wrap.style.display = 'block'
      wrap.style.left = `${sx}px`
      wrap.style.top  = `${sy}px`
      wrap.style.transform = `scale(${scale.toFixed(2)})`

      // Connector line from anchor (0,0) up to pill bottom
      const lineEl = wrap.querySelector<HTMLElement>('.ar-pin-line')
      if (lineEl) {
        const lineH = PILL_H * scale + 8
        lineEl.style.height = `${lineH}px`
        lineEl.style.transform = `translateX(-0.5px) translateY(-${lineH}px)`
      }

      // Live distance in pill
      const distEl = wrap.querySelector<HTMLElement>('.ar-pin-dist')
      if (distEl) {
        distEl.textContent = dist < 1
          ? `${Math.round(dist * 100)} cm`
          : `${dist.toFixed(1)} m`
      }
    }
  }
}
