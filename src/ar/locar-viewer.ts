/**
 * Places around you: each saved Place with a pin, drawn over the camera at its GPS position (ADR 0012).
 *
 * In a browser and in the Android shell it runs on locar.js, with the one placement rule of ./locar-placement.ts
 * (exact ENU, declination turned into the compass frame). In the iOS shell it hands the pins to the native geo view
 * instead: ScanAR.openGeoView, ARKit-CoreLocation on SceneKit (docs/factory/13-ar-runtime-targets/0006-ios-geo-view.md).
 *
 * It reads GET /project-locations, the map's own pins route, and uses only each Place's id, name and pin. It writes
 * nothing. It is a viewer, not a capture path: GPS places content to metres, so it finds a Place but cannot align a
 * scan to one.
 *
 * A native shell's page is not on the server's origin, so there the page needs the Scan server's address first. It
 * uses the editor's server dialog (changeServer, src/viewer/shell-menu.ts), which tests an address with GET /health,
 * saves it on the device and reloads the page. A browser never shows it: its server is the page's own origin.
 *
 * Tapping a marker, or a row of the list, opens the Place's card: how far and which way it is from here, and what the
 * map's pin popup shows (address, pin, scans, last capture). A tap means the nearest marker on screen within a
 * fingertip, so a far marker a few pixels across can still be tapped.
 */
import * as THREE from 'three'
import * as LocAR from 'locar'
import type { GpsReceivedEvent, WebcamStartedEvent } from 'locar'
import { apiBase, apiUrl, isAndroidShell, isCapacitorShell, isNativeShell } from '../shared/api-base.ts'
import { compassReadingFromEvent } from '../geo/compass-heading.ts'
import { trueBearingDeg } from '../world/declination.ts'
import { openLegalNotices } from '../ui/legal-notices.ts'
import { openShellDialog } from '../ui/shell-dialog.ts'
import type { ProjectLocationEntry } from '../viewer/geomap.ts'
import { changeServer } from '../viewer/shell-menu.ts'
import { scanARPlugin } from './native-bridge.ts'
import {
  compassPoint,
  describePlace,
  nearestOnScreen,
  pinnedPlaces,
  scenePlacement,
  type PinnedPlace,
  type ScreenTarget,
} from './locar-placement.ts'

/** How many Places the list shows, nearest first. */
const LIST_LIMIT = 20

/** The marker cone, in metres. */
const MARKER_HEIGHT_M = 4
const MARKER_RADIUS_M = 1.5

/** How far from a marker's centre a tap still counts, in CSS pixels: about a fingertip, and at most a thumb's sweep. */
const TAP_RADIUS_PX = 48
const MAX_TAP_RADIUS_PX = 160

/** The places flag while a shell has no Scan server to read pins from. */
const NO_SERVER = 'no Scan server set'

/**
 * True in a native shell with no Scan server saved or built in. There a root-relative path reaches the app's own
 * bundle, which can answer 200 with a page, so the pins are not asked for at all.
 */
function serverMissing(): boolean {
  return isNativeShell() && !apiBase()
}

/** The host of a server origin, for the button. A build-time base that does not parse is shown as it is. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

interface ViewerFlags {
  camera: string
  gps: string
  places: string
  orientation: string
}

/** What the browser viewer test reads. A test hook, not a product interface. */
export interface LocarViewerHook {
  native: boolean
  flags: ViewerFlags
  places: PinnedPlace[]
  /** Each marker's scene position, as locar placed it. */
  markers: Array<{ projectId: string; name: string; x: number; z: number }>
  origin: { lat: number; lng: number } | null
  /** The declination turn in use, degrees east, or null before the first fix. */
  turnDeg: number | null
  declinationApplied: boolean
  heading: { magneticDeg: number; trueDeg: number | null } | null
  /** Where each marker is on the screen now, for the tap test. Set once locar runs. */
  screenTargets?: () => ScreenTarget[]
}

declare global {
  interface Window {
    __locarViewer?: LocarViewerHook
  }
}

const statusEl = document.getElementById('viewer-status')
const listEl = document.getElementById('viewer-places')
const flags: ViewerFlags = { camera: 'starting', gps: 'waiting for a fix', places: 'not loaded', orientation: 'waiting for a compass reading' }
const hook: LocarViewerHook = {
  native: false,
  flags,
  places: [],
  markers: [],
  origin: null,
  turnDeg: null,
  declinationApplied: false,
  heading: null,
}
window.__locarViewer = hook

document.getElementById('viewer-legal')?.addEventListener('click', () => {
  openLegalNotices()
})

function render(): void {
  if (!statusEl) return
  const heading = hook.heading
    ? `${hook.heading.magneticDeg.toFixed(0)} deg magnetic${hook.heading.trueDeg === null ? '' : `, ${hook.heading.trueDeg.toFixed(0)} deg true`}`
    : 'n/a'
  const turn = hook.turnDeg === null ? '' : hook.declinationApplied ? ` · declination ${hook.turnDeg.toFixed(1)} deg` : ' · declination unknown, not applied'
  statusEl.textContent = hook.native
    ? `Places around you (native geo view) · places: ${flags.places}`
    : `Places around you · camera: ${flags.camera} · gps: ${flags.gps} · places: ${flags.places} · heading ${heading}${turn}`
}

function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`
}

/** A capture time as the map's pin popup shows it (src/viewer/geomap.ts), or the text as given when it does not parse. */
function formatCaptured(capturedAt: string): string {
  const date = new Date(capturedAt)
  if (Number.isNaN(date.getTime())) return capturedAt
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Where the phone is now: the latest accepted fix, or null before the first. */
let lastFix: { lat: number; lng: number } | null = null

/**
 * A Place's card: how far and which way it is from here, then what the map's pin popup shows. Every value goes in
 * as text, so nothing the server sends is read as HTML.
 */
function openPlaceCard(place: PinnedPlace): void {
  const rows: HTMLElement[] = []
  const row = (label: string, value: string): void => {
    const line = document.createElement('p')
    line.className = 'viewer-card-row'
    const term = document.createElement('strong')
    term.textContent = `${label}: `
    line.append(term, value)
    rows.push(line)
  }
  if (lastFix) {
    const { distanceM, trueBearingDeg: bearing } = describePlace({ ...lastFix, altitudeM: 0 }, place)
    row('Distance', formatDistance(distanceM))
    row('Direction', `${bearing.toFixed(0)} deg true (${compassPoint(bearing)})`)
  }
  if (place.address) row('Address', place.address)
  row('Pin', `${place.lat.toFixed(5)}°, ${place.lng.toFixed(5)}°`)
  row('Scans', typeof place.scanCount === 'number' ? String(place.scanCount) : 'unknown')
  if (place.capturedAt) row('Last capture', formatCaptured(place.capturedAt))
  openShellDialog(place.name, rows)
}

/** The list, nearest first, from where the phone is now. Each row opens its Place's card. */
function renderList(lat: number, lng: number): void {
  if (!listEl) return
  const here = { lat, lng, altitudeM: 0 }
  const rows = hook.places
    .map((place) => ({ place, ...describePlace(here, place) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, LIST_LIMIT)
  listEl.replaceChildren(...rows.map(({ place, distanceM, trueBearingDeg: bearing }) => {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'viewer-place'
    button.textContent = `${place.name} · ${formatDistance(distanceM)} · ${bearing.toFixed(0)} deg`
    button.addEventListener('click', () => openPlaceCard(place))
    item.append(button)
    return item
  }))
}

async function loadPins(): Promise<PinnedPlace[]> {
  const response = await fetch(apiUrl('/project-locations'))
  if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}: this server asks for sign-in`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return pinnedPlaces(await response.json() as ProjectLocationEntry[])
}

/**
 * In a shell, the Scan server this page reads and the way to change it. Drawn only in a shell: a browser reads its own
 * origin and never the saved address.
 */
function mountServerButton(): void {
  const button = document.createElement('button')
  button.type = 'button'
  button.id = 'viewer-server'
  const origin = apiBase()
  button.textContent = `Scan server: ${origin ? hostOf(origin) : 'none set'}`
  button.addEventListener('click', () => {
    changeServer()
  })
  document.getElementById('viewer-actions')?.prepend(button)
}

function startNative(plugin: NonNullable<ReturnType<typeof scanARPlugin>>): void {
  hook.native = true
  render()
  // With no server there is nothing to hand over. The server dialog is open, and a save reloads the page.
  if (serverMissing()) return
  loadPins()
    .then((places) => {
      hook.places = places
      return plugin.openGeoView?.({ places: places.map(({ name, lat, lng }) => ({ name, lat, lng })) })
    })
    .then((result) => {
      flags.places = `${result?.shown ?? 0} shown in the native geo view`
      render()
    })
    .catch((error: unknown) => {
      flags.places = `could not open the native geo view (${error instanceof Error ? error.message : String(error)})`
      render()
    })
}

function startLocar(): void {
  const placement = scenePlacement({ applyDeclination: true, now: () => new Date() })
  const app = new LocAR.App({
    cameraOptions: { hFov: 60, near: 0.5, far: 20000 },
    videoConstraints: { video: { facingMode: 'environment' } },
    deviceOrientationOptions: { enabled: true, enablePermissionDialog: true, smoothingFactor: 0.2 },
  })

  // App starts the camera in its constructor, so listen to the webcam before any of its events can fire.
  app.webcam.on('webcamstarted', (event: WebcamStartedEvent) => {
    flags.camera = `running ${event.videoWidth}x${event.videoHeight}`
    render()
  })
  app.webcam.on('webcamerror', (error: { code: string; message: string }) => {
    flags.camera = `error ${error.code}: ${error.message}`
    render()
  })

  /** Each Place's marker, for taps. */
  const markerMeshes: Array<{ mesh: THREE.Mesh; place: PinnedPlace }> = []

  /**
   * Where each marker is on the screen now: its centre, how far a tap may land from it, and whether the camera sees
   * it. A marker level with the camera plane, as every marker is while the phone lies flat, projects to enormous
   * coordinates, so only one past the near plane counts, and no radius grows past a thumb's sweep.
   */
  function screenTargets(): ScreenTarget[] {
    const rect = app.renderer.domElement.getBoundingClientRect()
    const camera = app.camera
    camera.updateMatrixWorld()
    const toScreen = (point: THREE.Vector3): { x: number; y: number } => {
      const ndc = point.clone().project(camera)
      return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height }
    }
    return markerMeshes.map(({ mesh, place }) => {
      const centre = mesh.getWorldPosition(new THREE.Vector3())
      const depth = -centre.clone().applyMatrix4(camera.matrixWorldInverse).z
      const middle = toScreen(centre)
      const top = toScreen(centre.clone().add(new THREE.Vector3(0, MARKER_HEIGHT_M / 2, 0)))
      const inFront = depth > camera.near && Number.isFinite(middle.x) && Number.isFinite(middle.y)
      const radiusPx = Math.min(MAX_TAP_RADIUS_PX, Math.max(TAP_RADIUS_PX, Math.abs(middle.y - top.y) * 1.25))
      return { id: place.projectId, x: middle.x, y: middle.y, radiusPx: Number.isFinite(radiusPx) ? radiusPx : TAP_RADIUS_PX, inFront }
    })
  }
  hook.screenTargets = screenTargets

  // A tap on the camera view opens the card of the marker it means. The page's own controls sit above the canvas.
  app.renderer.domElement.addEventListener('click', (event: MouseEvent) => {
    const id = nearestOnScreen(screenTargets(), event.clientX, event.clientY)
    const tapped = markerMeshes.find(({ place }) => place.projectId === id)
    if (tapped) openPlaceCard(tapped.place)
  })

  function onOrientation(event: Event): void {
    const reading = compassReadingFromEvent(event as DeviceOrientationEvent)
    if (!reading) return
    hook.heading = { magneticDeg: reading.headingDeg, trueDeg: trueBearingDeg(reading.headingDeg, placement.correction?.declination) }
    flags.orientation = `compass (${reading.source})`
    render()
  }
  window.addEventListener('deviceorientationabsolute', onOrientation)
  window.addEventListener('deviceorientation', onOrientation)

  async function addPlaces(locar: LocAR.LocAR): Promise<void> {
    // The places flag already says so, and a save in the server dialog reloads the page.
    if (serverMissing()) return
    try {
      const places = await loadPins()
      hook.places = places
      for (const place of places) {
        const marker = new THREE.Mesh(
          new THREE.ConeGeometry(MARKER_RADIUS_M, MARKER_HEIGHT_M, 16),
          new THREE.MeshBasicMaterial({ color: 0xffb020 }),
        )
        marker.name = `place-${place.projectId}`
        locar.add(marker, place.lng, place.lat, 0, { name: place.name })
        markerMeshes.push({ mesh: marker, place })
        hook.markers.push({ projectId: place.projectId, name: place.name, x: marker.position.x, z: marker.position.z })
      }
      flags.places = `${places.length} with a pin`
    } catch (error: unknown) {
      flags.places = `could not load (${error instanceof Error ? error.message : String(error)})`
    }
    render()
  }

  app
    .start()
    .then((locar: LocAR.LocAR) => {
      // The one placement rule, for the camera's fixes and for every Place alike.
      locar.lonLatToWorldCoords = (lon: number, lat: number) => placement.toScene(lon, lat)
      let placesAdded = false
      locar.on('gpserror', (error: { code: string | number; message: string }) => {
        flags.gps = `error ${error.code}: ${error.message}`
        render()
      })
      locar.on('gpsupdate', (event: GpsReceivedEvent) => {
        const { latitude, longitude, accuracy } = event.position.coords
        lastFix = { lat: latitude, lng: longitude }
        flags.gps = `±${accuracy.toFixed(0)} m`
        hook.origin = placement.origin ? { lat: placement.origin.lat, lng: placement.origin.lng } : null
        hook.turnDeg = placement.correction?.turnDeg ?? null
        hook.declinationApplied = placement.correction?.applied ?? false
        if (!placesAdded) {
          placesAdded = true
          void addPlaces(locar).then(() => renderList(latitude, longitude))
        }
        renderList(latitude, longitude)
        render()
      })
      locar.startGps().then((started: boolean) => {
        if (!started) flags.gps = 'not started'
        render()
      })
    })
    .catch((error: unknown) => {
      flags.orientation = `failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`
      render()
    })
}

if (serverMissing()) flags.places = NO_SERVER
const plugin = scanARPlugin()
if (isCapacitorShell() && !isAndroidShell() && plugin && typeof plugin.openGeoView === 'function') {
  startNative(plugin)
} else {
  startLocar()
}
if (isNativeShell()) {
  mountServerButton()
  // This page can show no Place without a server, so a shell asks for one straight away, as the editor does.
  if (serverMissing()) changeServer()
}
render()
