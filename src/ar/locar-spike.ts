/**
 * locar.js spike: the camera feed, the GPS fix, the compass heading, and one marker 20 m north of the first fix.
 *
 * Placement goes through the repo's exact ENU (./locar-placement.ts), installed as this instance's
 * `lonLatToWorldCoords`, so the camera and the marker share one origin: locar's first accepted fix.
 * `?projection=mercator` is the control. It leaves locar's stock Web Mercator in place, so the browser test can show
 * the difference.
 *
 * This is a viewer check, not a capture runtime (ADR 0014). locar gives a 3-DoF orientation and a GPS position, with
 * no visual tracking, hit test, anchor or depth.
 */
import * as THREE from 'three'
import * as LocAR from 'locar'
import type { GpsReceivedEvent, WebcamStartedEvent } from 'locar'
import { compassReadingFromEvent } from '../geo/compass-heading.ts'
import { latLngAt, scenePlacement } from './locar-placement.ts'

/** How far north of the first fix the test marker sits, in metres. */
const MARKER_NORTH_M = 20

interface SpikeFlags {
  camera: string
  gps: string
  orientation: string
}

/** What the browser spike test reads. A test hook, not a product interface. */
export interface LocarSpikeHook {
  app: LocAR.App
  locar: LocAR.LocAR | null
  marker: THREE.Object3D | null
  flags: SpikeFlags
  /** Magnetic compass heading, degrees, or null until a compass reading arrives. */
  heading: number | null
  /** The camera feed's size, from the webcam's own `webcamstarted` event. */
  video: { width: number; height: number } | null
  /** True for the `?projection=mercator` control. */
  stock: boolean
}

declare global {
  interface Window {
    __locarSpike?: LocarSpikeHook
  }
}

const statusEl = document.getElementById('locar-status')
const flags: SpikeFlags = { camera: 'starting', gps: 'waiting for a fix', orientation: 'waiting for a compass reading' }
const stock = new URLSearchParams(window.location.search).get('projection') === 'mercator'
const placement = scenePlacement({ applyDeclination: false, now: () => new Date() })

function render(hook: LocarSpikeHook): void {
  if (!statusEl) return
  const heading = hook.heading === null ? 'n/a' : `${hook.heading.toFixed(0)} deg magnetic`
  statusEl.textContent =
    `locar.js spike${hook.stock ? ' (Web Mercator control)' : ''} · camera: ${flags.camera} · gps: ${flags.gps} · heading ${heading} · orientation: ${flags.orientation}`
}

const app = new LocAR.App({
  cameraOptions: { hFov: 60, near: 0.1, far: 5000 },
  videoConstraints: { video: { facingMode: 'environment' } },
  // locar asks for orientation permission, with a tap, only where the browser requires it (iOS and iPadOS).
  deviceOrientationOptions: { enabled: true, enablePermissionDialog: true, smoothingFactor: 0.2 },
})

const hook: LocarSpikeHook = { app, locar: null, marker: null, flags, heading: null, video: null, stock }
window.__locarSpike = hook
render(hook)

// App starts the camera in its constructor, so listen to the webcam now, before any of its events can fire.
app.webcam.on('webcamstarted', (event: WebcamStartedEvent) => {
  hook.video = { width: event.videoWidth, height: event.videoHeight }
  flags.camera = `running ${event.videoWidth}x${event.videoHeight}`
  render(hook)
})
app.webcam.on('webcamerror', (error: { code: string; message: string }) => {
  flags.camera = `error ${error.code}: ${error.message}`
  render(hook)
})

// A compass reading only, as the scanner reads one: iOS's webkitCompassHeading, or an absolute event elsewhere. A
// relative event counts from wherever the phone faced at page load, so it says nothing about north.
function onOrientation(event: Event): void {
  const reading = compassReadingFromEvent(event as DeviceOrientationEvent)
  if (!reading) return
  hook.heading = reading.headingDeg
  flags.orientation = `compass (${reading.source})`
  render(hook)
}
window.addEventListener('deviceorientationabsolute', onOrientation)
window.addEventListener('deviceorientation', onOrientation)

function addMarker(locar: LocAR.LocAR, fix: { lat: number; lng: number }): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0xff3b30 }))
  mesh.name = 'spike-marker-20m-north'
  const target = latLngAt({ lat: fix.lat, lng: fix.lng, altitudeM: 0 }, 0, MARKER_NORTH_M)
  locar.add(mesh, target.lng, target.lat, 0, { label: 'spike marker, 20 m north of the first fix' })
  return mesh
}

app
  .start()
  .then((locar: LocAR.LocAR) => {
    hook.locar = locar
    // The one placement rule, for the camera's fixes and for the marker alike. The control keeps locar's own.
    if (!stock) locar.lonLatToWorldCoords = (lon: number, lat: number) => placement.toScene(lon, lat)

    app.deviceOrientationControls?.on('deviceorientationerror', (error: { code: string; message: string }) => {
      flags.orientation = `error ${error.code}: ${error.message}`
      render(hook)
    })
    locar.on('gpserror', (error: { code: string | number; message: string }) => {
      flags.gps = `error ${error.code}: ${error.message}`
      render(hook)
    })
    locar.on('gpsupdate', (event: GpsReceivedEvent) => {
      const { latitude, longitude, accuracy } = event.position.coords
      flags.gps = `${latitude.toFixed(5)}, ${longitude.toFixed(5)} ±${accuracy.toFixed(0)} m`
      if (hook.marker === null) hook.marker = addMarker(locar, { lat: latitude, lng: longitude })
      render(hook)
    })
    // App.start() does not start GPS (only LocAR.startGps() does), so start it after the handlers.
    locar.startGps().then((started: boolean) => {
      if (!started) flags.gps = 'not started'
      render(hook)
    })
  })
  .catch((error: unknown) => {
    // start() rejects with { code, message } when orientation is refused or unavailable.
    const message = error instanceof Error ? error.message : JSON.stringify(error)
    flags.orientation = `failed: ${message}`
    render(hook)
  })
