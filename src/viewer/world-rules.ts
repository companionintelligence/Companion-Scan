/**
 * The rules the desktop world editor (./viewer.ts) and the headset editor (./xr-world.ts) share (F-41, FN-083).
 *
 * Each editor used to keep its own copy of three of them: which world a page opens, how a scan is placed in the
 * scene, and which GLB is a scan's. A copy that drifts opens a different world, puts a scan somewhere else, or
 * loads a different file in one editor than in the other, so each rule lives here once and both import it.
 *
 * Every request goes through a URL builder the caller passes, so the access token rides on it the way the caller's
 * other requests carry it (src/shared/access-token.ts).
 */
import * as THREE from 'three'

/**
 * The world a page opens: `?world=` if given, else the Place's own world for `?project=`, else `default`.
 *
 * `?project=` has to pick the world, not just filter within one. The `default` world carries projectId null, and a
 * scan captured with a Place selected is never in it, so landing on `default` and filtering would always show
 * nothing. A Place's world slug is `project-<projectId>` (`GET /projects/:id/world`).
 */
export function worldSlugFrom(search: string): string {
  const query = new URLSearchParams(search)
  const project = query.get('project')
  return query.get('world') || (project ? `project-${project}` : 'default')
}

/**
 * Place a scan root by its `localToWorld`: a column-major 4x4, written into the object's position, rotation and
 * scale. Anything that is not 16 numbers leaves the object where it is.
 */
export function applyLocalToWorld(obj: THREE.Object3D, localToWorld: readonly number[] | null | undefined): void {
  if (!localToWorld || localToWorld.length !== 16) return
  new THREE.Matrix4().fromArray(localToWorld as number[]).decompose(obj.position, obj.quaternion, obj.scale)
  obj.updateMatrixWorld(true)
}

/** The optimization manifest the server's optimize-scan job writes beside a scan (`GET /scans/:filename/manifest`). */
export interface OptimizationManifest {
  artifacts: {
    optimized: { filename: string; bytes: number; draco: boolean; quantized: boolean }
    /** Coarsest first: lods[0] is the instant preview. */
    lods: Array<{ filename: string; bytes: number; points: number; voxelM: number }>
  }
}

/** The served path of a scan's optimization manifest. */
export function optimizationManifestPath(filename: string): string {
  return `/scans/${encodeURIComponent(filename)}/manifest`
}

/**
 * A scan's optimization manifest, or null when there is none to use: no manifest, an unreadable one, or one with
 * no optimized artifact. `request` fetches a served path (the caller's, so it carries the caller's token).
 */
export async function fetchOptimizationManifest(
  filename: string,
  request: (path: string) => Promise<Response>,
): Promise<OptimizationManifest | null> {
  try {
    const response = await request(optimizationManifestPath(filename))
    if (!response.ok) return null
    const manifest = await response.json() as Partial<OptimizationManifest> | null
    return manifest?.artifacts?.optimized ? manifest as OptimizationManifest : null
  } catch {
    return null
  }
}

/** The GLB a scan is shown with: its optimized artifact when the manifest has one, else the scan's own GLB. */
export function fullScanGlbPath(scan: { glbUrl: string }, manifest: OptimizationManifest | null): string {
  const optimized = manifest?.artifacts.optimized
  return optimized ? `/scans/${encodeURIComponent(optimized.filename)}` : scan.glbUrl
}

/** The coarsest level of detail, shown while the full GLB loads, or null when the manifest has none. */
export function previewScanGlb(manifest: OptimizationManifest | null): { path: string; bytes: number } | null {
  const preview = manifest?.artifacts.lods?.[0]
  return preview ? { path: `/scans/${encodeURIComponent(preview.filename)}`, bytes: preview.bytes } : null
}
