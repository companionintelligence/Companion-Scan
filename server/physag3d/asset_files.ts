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
 *   <jobId>.source.json     which session's keyframe the case copies (never served)
 *   <jobId>/                the PhysAg3D case folder, unless PHYSAG3D_RUNS_DIR puts it elsewhere (never served)
 * ```
 *
 * The case folder and its source record sit side by side in the same folder, which is `<runsDir>` when
 * PHYSAG3D_RUNS_DIR is set. A case folder never outlives the session whose keyframe it copied: every deletion of a
 * session's frames removes it first (`removeSessionCaseCopies`).
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

// ── The copies of a session's keyframes ─────────────────────────────────────

/**
 * The record of which keyframe a case folder copies, `<jobId>.source.json` beside the folder. Written before PhysAg3D's
 * prepare copies the image: prepare wants an empty case folder, so the record cannot go inside it. A deletion of the
 * session's frames finds the case folders through it.
 */
export const CASE_SOURCE_SUFFIX = '.source.json'

export interface CaseSource {
  schemaVersion: 1
  sessionId: string
  keyframe: string
  writtenAt: string
}

/** Writes the source record for the case `assetId` in `caseParent`, the folder the case folder is in. */
export async function writeCaseSource(
  caseParent: string,
  assetId: string,
  source: { sessionId: string; keyframe: string },
): Promise<void> {
  const record: CaseSource = { schemaVersion: 1, ...source, writtenAt: new Date().toISOString() }
  const path = `${caseParent}/${assetId}${CASE_SOURCE_SUFFIX}`
  await Deno.mkdir(caseParent, { recursive: true })
  await Deno.writeTextFile(`${path}.part`, JSON.stringify(record, null, 2))
  await Deno.rename(`${path}.part`, path)
}

/** The sessions whose keyframes a run in this process is copying, sending or reading back now, with how many runs each. */
const sessionsInUse = new Map<string, number>()

/** Marks `sessionId`'s frames as in use by a run until the returned function is called. */
export function holdSessionFrames(sessionId: string): () => void {
  sessionsInUse.set(sessionId, (sessionsInUse.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (sessionsInUse.get(sessionId) ?? 1) - 1
    if (left > 0) sessionsInUse.set(sessionId, left)
    else sessionsInUse.delete(sessionId)
  }
}

export function sessionFramesInUse(sessionId: string): boolean {
  return sessionsInUse.has(sessionId)
}

/**
 * A run is using the session's frames, so they are not removed now: removing the case folder under a running worker
 * would not stop the worker, which can write into it again with no record left to find it by. The caller keeps the
 * session and says to try again (a phone retries; a purge takes it on its next pass).
 */
export class SessionFramesInUseError extends Error {
  override name = 'SessionFramesInUseError'
  constructor() {
    super('a thing-interactive-asset run is using this session\'s frames')
  }
}

/** Every folder a case folder can be in: each `<scan>.interactive/` directly under `scansDir`, and `runsDir` when one is set. */
export async function caseFolderParents(scansDir: string, runsDir: string | null): Promise<string[]> {
  const parents: string[] = []
  try {
    for await (const entry of Deno.readDir(scansDir)) {
      if (entry.isDirectory && entry.name.endsWith(INTERACTIVE_ASSET_DIR_SUFFIX)) parents.push(`${scansDir}/${entry.name}`)
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  if (runsDir) parents.push(runsDir)
  return parents
}

/**
 * Removes every PhysAg3D case folder that holds a copy of a keyframe of `sessionId`, with its source record, and resolves
 * how many went. The whole case folder goes, not only `input/`: the agent's work in it (its renders, the comparisons, the
 * generation host's condition image) holds more copies of the photograph under names nobody chose in advance, so taking
 * the input alone would leave them. The landed GLB and the delivery report stay, as a splat made from the same frames
 * does; deleting the scan removes them. Throws `SessionFramesInUseError`, having removed nothing, while a run in this
 * process is using the session's frames. Any other error is a removal that failed, and the caller keeps the session.
 */
export async function removeSessionCaseCopies(parents: readonly string[], sessionId: string): Promise<number> {
  if (sessionFramesInUse(sessionId)) throw new SessionFramesInUseError()
  let removed = 0
  for (const parent of parents) {
    const records: string[] = []
    try {
      for await (const entry of Deno.readDir(parent)) {
        if (entry.isFile && entry.name.endsWith(CASE_SOURCE_SUFFIX)) records.push(entry.name)
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue
      throw error
    }
    for (const name of records) {
      const assetId = name.slice(0, -CASE_SOURCE_SUFFIX.length)
      if (!isAssetId(assetId) || (await readCaseSource(`${parent}/${name}`))?.sessionId !== sessionId) continue
      // The folder first: a record left behind by a failure here still finds it next time.
      await removeIfPresent(`${parent}/${assetId}`)
      await removeIfPresent(`${parent}/${name}`)
      removed += 1
    }
  }
  return removed
}

async function readCaseSource(path: string): Promise<Partial<CaseSource> | null> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<CaseSource> : null
  } catch {
    return null
  }
}

/** Removes `path`, a folder with its contents or a file, and a link as a link. A path that is already gone is done. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true })
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
}
