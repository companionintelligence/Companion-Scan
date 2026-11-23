/**
 * Places around you: each saved Place with a pin, drawn over the camera at its GPS position (ADR 0012).
 *
 * In a browser and in the Android shell it runs on locar.js, with the one placement rule of ./locar-placement.ts
 * (exact ENU, declination turned into the compass frame). In the iOS shell it hands the pins to the native geo view
 * instead: ScanAR.openGeoView, ARKit-CoreLocation on SceneKit (docs/factory/13-ar-runtime-targets/0006-ios-geo-view.md).
 *
 * It reads only GET /project-locations, the map's own pins route, uses only each Place's id, name and pin, and sends
 * nothing anywhere. It is a viewer, not a capture path: GPS places content to metres, so it finds a Place but cannot
 * align a scan to one.
 */
import * as THREE from 'three'
import * as LocAR from 'locar'
import type { GpsReceivedEvent, WebcamStartedEvent } from 'locar'
import { apiUrl, isAndroidShell, isCapacitorShell } from '../shared/api-base.ts'
import { compassReadingFromEvent } from '../geo/compass-heading.ts'
import { trueBearingDeg } from '../world/declination.ts'
import { openLegalNotices } from '../ui/legal-notices.ts'
import { scanARPlugin } from './native-bridge.ts'
import { describePlace, pinnedPlaces, scenePlacement, type PinnedPlace, type PlaceLocation } from './locar-placement.ts'

/** How many Places the list shows, nearest first. */
const LIST_LIMIT = 20

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

/** The list, nearest first, from where the phone is now. */
function renderList(lat: number, lng: number): void {
  if (!listEl) return
  const here = { lat, lng, altitudeM: 0 }
  const rows = hook.places
    .map((place) => ({ place, ...describePlace(here, place) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, LIST_LIMIT)
  listEl.replaceChildren(...rows.map(({ place, distanceM, trueBearingDeg: bearing }) => {
    const item = document.createElement('li')
    item.textContent = `${place.name} · ${formatDistance(distanceM)} · ${bearing.toFixed(0)} deg`
    return item
  }))
}

async function loadPins(): Promise<PinnedPlace[]> {
  const response = await fetch(apiUrl('/project-locations'))
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return pinnedPlaces(await response.json() as PlaceLocation[])
}

function startNative(plugin: NonNullable<ReturnType<typeof scanARPlugin>>): void {
  hook.native = true
  render()
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
    try {
      const places = await loadPins()
      hook.places = places
      for (const place of places) {
        const marker = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4, 16), new THREE.MeshBasicMaterial({ color: 0xffb020 }))
        marker.name = `place-${place.projectId}`
        locar.add(marker, place.lng, place.lat, 0, { name: place.name })
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

const plugin = scanARPlugin()
if (isCapacitorShell() && !isAndroidShell() && plugin && typeof plugin.openGeoView === 'function') {
  startNative(plugin)
} else {
  startLocar()
}
render()
