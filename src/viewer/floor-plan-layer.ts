/**
 * The editor's Floor plan section: what it reads and what it says (the floor-plan job, server/floor_plan.ts).
 *
 * The job lands three files beside the scan, on the gated artifact route:
 *
 *   /scans/<base>.floor-plan.manifest.json  run index: status, area, walls, rooms
 *   /scans/<base>.floor-plan.json           the plan: walls, room outline, area
 *   /scans/<base>.floor-plan.svg            the plan drawn, shown as the section's preview
 *
 * Not a scene layer. The plan is a 2D drawing, in the capture's AR session frame once the job has fitted the cloud to
 * the keyframes' AR poses (its manifest's `units` and `frame` say so), and nothing draws it in the 3D scene yet. So it
 * adds no row to the Scene layers list and no switch to the View menu: a `floor` row that drew nothing would be the
 * checkbox that switches nothing (F-19). It is shown the way the other job outputs in the Layers tab are, in its own
 * section (viewer.html, `#floor-plan-section`).
 *
 * Pure apart from the `fetcher` it is handed, so a Deno test drives it with canned responses.
 */
import type { FloorPlanManifest, FloorPlanUnits, ScanManifest } from '../world/types.ts'
import { artifactProblemText, readArtifact, type ArtifactRead } from './artifact-read.ts'
import { scanArtifactBase } from './splat-layer.ts'
import type { SplatJobRequest } from './splat-toolbox.ts'

/** URL of a scan's floor-plan manifest on the gated artifact route. */
export function floorPlanManifestUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.floor-plan.manifest.json`)}`
}

/**
 * URL of a scan's floor-plan drawing. `version` (the manifest's `createdAt`) goes in the query, so a plan drawn again
 * is not shown from the copy the browser kept: the route lets one be kept for five minutes.
 */
export function floorPlanSvgUrl(scan: ScanManifest, version?: string): string {
  const path = `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.floor-plan.svg`)}`
  return version ? `${path}?v=${encodeURIComponent(version)}` : path
}

/** URL of a scan's floor-plan JSON (walls, rooms, area). `version` as for the drawing. */
export function floorPlanJsonUrl(scan: ScanManifest, version?: string): string {
  const path = `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.floor-plan.json`)}`
  return version ? `${path}?v=${encodeURIComponent(version)}` : path
}

/** The name a download is saved under: the scan's name, else its id, and the file kind. */
export function floorPlanDownloadName(scan: ScanManifest, kind: 'svg' | 'json'): string {
  return `${scan.name || scan.scanId}.floor-plan.${kind}`
}

/** Body for the Generate floor plan button: a floor-plan job for the selected scan. */
export function buildFloorPlanJobRequest(scanId: string): SplatJobRequest {
  return {
    type: 'floor-plan',
    scanId,
    payload: { source: 'viewer-floor-plan', requestedAt: new Date().toISOString() },
  }
}

const STATUSES: ReadonlySet<string> = new Set(['ok', 'skipped', 'error'])

/**
 * Read a scan's floor-plan manifest, with the four answers of `readArtifact`. A file that is there but is not a
 * manifest (no status the job writes) is an `error`, not a plan.
 */
export async function readFloorPlanManifest(
  scan: ScanManifest,
  fetcher: (url: string) => Promise<Response>,
): Promise<ArtifactRead<FloorPlanManifest>> {
  const read = await readArtifact<FloorPlanManifest>(floorPlanManifestUrl(scan), fetcher)
  if (read.state !== 'found') return read
  const status = (read.value as { status?: unknown } | null)?.status
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    return { state: 'error', status: 200, message: 'the floor-plan manifest has no status' }
  }
  return read
}

/** What the section shows: its status line, its numbers line, and whether the drawing and the downloads are offered. */
export interface FloorPlanPanelView {
  status: string
  stats: string
  /** The manifest's `createdAt` when there is a plan to show, so the drawing is fetched fresh; null when there is none. */
  planVersion: string | null
}

/**
 * The status line of a plan that is there, by the units its manifest names. Says what the numbers are, and what they
 * are not. A plan with no `units` was drawn before the fit to the capture existed: its numbers are the cloud's.
 */
export function floorPlanReadyText(units: FloorPlanUnits | undefined): string {
  const fitted = 'Floor plan ready. Derived from the LingBot-Map points, fitted to the capture\'s AR poses for scale and up'
  switch (units) {
    case 'm':
      return `${fitted}, in metres. Not surveyed.`
    case 'm-estimated':
      return `${fitted}, in approximate metres: the AR runtime estimated its scale. Not surveyed.`
    case 'session':
      return `${fitted}, in that AR session's own units, which are not known to be metres. Not surveyed.`
    default:
      return 'Floor plan ready. Derived from the LingBot-Map points, not surveyed: its numbers are in that reconstruction\'s own units, which are metres only if it was metric.'
  }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** Numbers to the precision the worker rounds to. */
function measure(value: number, digits: number): string {
  return value.toFixed(digits)
}

/**
 * The numbers line of an `ok` manifest: walls, rooms, area and ceiling height, each only when it was measured, with
 * "m" and "m²" only when the plan is in metres.
 */
export function floorPlanStatsText(manifest: FloorPlanManifest): string {
  const metric = manifest.units === 'm' || manifest.units === 'm-estimated'
  const bits = [plural(manifest.wallCount ?? 0, 'wall', 'walls')]
  if (manifest.roomCount) bits.push(plural(manifest.roomCount, 'room', 'rooms'))
  if (typeof manifest.areaM2 === 'number' && manifest.roomCount) {
    bits.push(`area ${measure(manifest.areaM2, 1)}${metric ? ' m²' : ''}`)
  }
  if (typeof manifest.ceilingHeightM === 'number' && manifest.ceilingHeightM > 0) {
    bits.push(`ceiling ${measure(manifest.ceilingHeightM, 2)}${metric ? ' m' : ''}`)
  }
  const note = manifest.units === 'm'
    ? ''
    : manifest.units === 'm-estimated'
    ? ' (approximate metres)'
    : manifest.units === 'session'
    ? ' (AR session units)'
    : ' (point-cloud units)'
  return `${bits.join(' · ')}${note}`
}

/** The section for one scan, from what reading its manifest gave. */
export function floorPlanPanelView(read: ArtifactRead<FloorPlanManifest>): FloorPlanPanelView {
  if (read.state === 'not-run') {
    return {
      status: 'No floor plan for this scan yet. Generate one once the scan has a LingBot-Map reconstruction: the plan is drawn from its points.',
      stats: '',
      planVersion: null,
    }
  }
  if (read.state !== 'found') {
    return { status: artifactProblemText(read, 'this scan\'s floor plan') ?? '', stats: '', planVersion: null }
  }
  const manifest = read.value
  if (manifest.status === 'ok') {
    return {
      status: floorPlanReadyText(manifest.units),
      stats: floorPlanStatsText(manifest),
      planVersion: manifest.createdAt || 'ok',
    }
  }
  if (manifest.status === 'skipped') {
    const reason = manifest.skippedReason ?? 'no reason given'
    const fix = manifest.remediation && !reason.includes(manifest.remediation) ? ` ${manifest.remediation}` : ''
    return { status: `Floor plan skipped: ${reason}.${fix}`, stats: '', planVersion: null }
  }
  return { status: `Floor plan failed: ${manifest.error ?? 'no reason given'}`, stats: '', planVersion: null }
}
