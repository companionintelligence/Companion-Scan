/**
 * Where a thing-interactive-asset job's files live beside its scan, and which of them the server serves.
 *
 * Its own module so that the route in main.ts and scan deletion (server/scan_deletion.ts) can name the folder without
 * importing the PhysAg3D driver (server/physag3d/physag3d.ts) and everything it imports.
 *
 * ```
 * scans/<base>.interactive/
 *   <jobId>.glb             the refined GLB, landed from the case (served)
 *   <jobId>.delivery.json   the server's delivery report (served)
 *   <jobId>/                the PhysAg3D case folder, unless PHYSAG3D_RUNS_DIR puts it elsewhere (never served)
 * ```
 */

/**
 * The folder beside a scan that holds its interactive assets, `<base>.interactive/`, as `<base>.4d/` holds a person
 * sequence. A folder, not files beside the scan: a `.glb` at the top of the scans directory is listed as a scan, and a
 * `.json` there is read as a scan's sidecar. Deleting the scan removes the folder.
 */
export const INTERACTIVE_ASSET_DIR_SUFFIX = '.interactive'

/** The asset folder's name for a scan file: `room.glb` gives `room.interactive`. */
export function interactiveAssetFolderName(scanFilename: string): string {
  return `${scanFilename.replace(/\.glb$/, '')}${INTERACTIVE_ASSET_DIR_SUFFIX}`
}

/** A job id as createWorldJob mints it, `job-<ms>-<8 hex>`. A job's landed files and its case folder are named by it. */
const ASSET_ID_RE = /^job-\d{1,16}-[0-9a-f]{8}$/

export function isAssetId(value: string): boolean {
  return ASSET_ID_RE.test(value)
}

/** The two files a job lands in the asset folder, by suffix, and the type each is served as. */
const LANDED_FILES = [
  { suffix: '.glb', mime: 'model/gltf-binary' },
  { suffix: '.delivery.json', mime: 'application/json' },
] as const

/**
 * The type `name` is served as when it is one of the files a job lands (`<jobId>.glb`, `<jobId>.delivery.json`), or
 * null. GET /scans/:base/:frame serves nothing else from an asset folder, so a case folder inside it is never served.
 */
export function interactiveAssetFileMime(name: string): string | null {
  for (const { suffix, mime } of LANDED_FILES) {
    if (name.endsWith(suffix) && isAssetId(name.slice(0, -suffix.length))) return mime
  }
  return null
}
