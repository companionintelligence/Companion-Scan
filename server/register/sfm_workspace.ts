/**
 * Where the photo method keeps what it makes, and the one rule that decides every path here: **nothing made from a person's
 * camera frames may outlive the frames, and nothing may be copied to a place no deletion looks at.** Keyframes are photographs
 * of the inside of a home (docs/operations/PRIVACY.md); COLMAP's feature database and sparse model are those photographs in
 * another form (keypoints, descriptors, and a coloured point cloud of the room). Owner decision D15 made the deletion path a
 * condition of using frames at all, so this module is the deletion design of the photo method, and its tests
 * (tests/unit/server/sfm_privacy.test.ts) run the real deletion and retention code against real directories.
 *
 * ## Two kinds of thing
 *
 * **The work directory** holds one run: COLMAP's database for the run and its output. It is
 * `<Place data directory>/register-work/<jobId>/`, where the Place's data directory is the one that holds its reference photos
 * (`scans/projects/<id>/`, which `removePlaceMedia` removes whole with the Place). It exists only while the run does:
 * {@link withWorkDir} removes it when the run ends however it ends (success, failure, timeout, an exception), and
 * {@link sweepWorkDirs} removes every directory a crash left behind at the start of the next run and at boot. Nothing else is ever
 * written there.
 *
 * **The reference cache** is what saves the earlier scan's photographs from being solved again for every new scan: COLMAP's
 * database and sparse model of that scan's session, `<sessionDir>/sfm-reference/`. It is inside the session's own directory on
 * purpose, and not in the Place's: a session directory is removed whole, whatever a job wrote beside the frames, by every path that
 * removes frames (`DELETE /scans/:filename`, `DELETE /scans?confirm=delete-all`, `DELETE /sessions/:id`, the retention purge),
 * so the cache is deleted by the same call, at the same moment and by the same code as the photographs it was made from, with no
 * list of paths anywhere that someone has to remember to extend. A cache in the Place's directory would need a hook in each of
 * those four, and would survive any new way of removing a session. The cache holds one session's data, so the one session that
 * made it is the one whose deletion matters.
 *
 * Both are keyed to the Place's frame generation (`frameId`) and checked when used ({@link lookupReferenceCache}): a cache made
 * for another frame, other frames, or another epoch is removed, not reused.
 *
 * ## Why no frame is linked or copied anywhere
 *
 * COLMAP is given the sessions folder as its image root and a list of the frames to read (`<sessionId>/kf-NNNNN.jpg`), so it reads
 * each photograph where its session keeps it. A copy would be a second photograph; a hard link keeps a photograph alive after its
 * session is deleted (colmap_joint.ts says so in its own header). A symbolic link looks like the safe middle, and COLMAP 3.13 does
 * not take it: it stores an image under the path its link resolves to, relative to the image root (`../../sessions/sess-x/kf.jpg`),
 * so the pair list's names match nothing and the mapper finds "no images with matches" (measured with the real binary by
 * place_register_sfm_toy.test.ts). Reading in place needs none of them: no image byte is written anywhere by this package, and a
 * session that is deleted is simply not there for the next read.
 *
 * ## What is never written
 *
 * No image, thumbnail or derived picture leaves a session directory or the work directory, and nothing is sent anywhere: COLMAP is a
 * local process on the CPU (server/register/place_register_sfm.ts). Nothing here logs a path.
 */
import { basename, join } from 'node:path'
import { queueKeyframeWrite } from '../wp-a-keyframes.ts'
import * as fs from 'node:fs/promises'
import { errorKind, isNotFound } from '../fs_util.ts'
import type { Dirent } from 'node:fs'

/** The folder inside a session directory that holds the reference cache. */
export const REFERENCE_CACHE_DIR = 'sfm-reference'

/** The folder inside a Place's data directory that holds the work directories of runs. */
export const WORK_ROOT_DIR = 'register-work'

/** The shape of {@link ReferenceCacheManifest}. A cache of another version is not read. */
export const CACHE_SCHEMA_VERSION = 1

/** What the cache's manifest says about what it was made from, which {@link lookupReferenceCache} checks before anything is reused. */
export interface ReferenceCacheManifest {
  schemaVersion: typeof CACHE_SCHEMA_VERSION
  kind: 'place-register-sfm-reference'
  /** The Place the cache was made for. */
  projectId: string
  /** The Place's frame generation when the cache was made, or null when the Place recorded none. */
  frameId: string | null
  /** The scan whose session this is. */
  scanId: string
  sessionId: string
  /** The epoch whose poses the reference was solved from: the one the scan's calibration was made in. */
  epoch: number
  /** The frames offered to COLMAP, and how many it placed in the model. */
  frameCount: number
  registeredImages: number
  /** {@link frameFingerprint}-style digest of the offered frames' bytes: the cache is for exactly these pictures. */
  frameFingerprint: string
  createdAt: string
}

/** What a caller expects a cache to have been made from. Every field is compared. */
export type ReferenceCacheExpectation = Pick<
  ReferenceCacheManifest,
  'projectId' | 'frameId' | 'scanId' | 'sessionId' | 'epoch' | 'frameFingerprint'
>

export type ReferenceCacheLookup =
  | { state: 'valid'; dir: string; dbPath: string; modelDir: string; manifest: ReferenceCacheManifest }
  | { state: 'absent' }
  /** A cache was there and was not for this: it has been removed. `why` names the field, never a value. */
  | { state: 'invalid'; why: string }

/** Where a session's reference cache is. */
export function referenceCacheDir(sessionDir: string): string {
  return `${sessionDir}/${REFERENCE_CACHE_DIR}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true })
  } catch (error) {
    if (!(isNotFound(error))) throw error
  }
}

function isManifest(value: unknown): value is ReferenceCacheManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return m['schemaVersion'] === CACHE_SCHEMA_VERSION && m['kind'] === 'place-register-sfm-reference' &&
    typeof m['projectId'] === 'string' && (m['frameId'] === null || typeof m['frameId'] === 'string') &&
    typeof m['scanId'] === 'string' && typeof m['sessionId'] === 'string' &&
    typeof m['epoch'] === 'number' && typeof m['frameFingerprint'] === 'string' &&
    typeof m['frameCount'] === 'number' && typeof m['registeredImages'] === 'number'
}

/**
 * The reference cache of `sessionDir`, if there is one and it is for exactly what `expect` says. A cache that is not (another Place
 * frame, other pictures, another epoch, another scan, a manifest that is missing or unreadable, a half-published one) is
 * removed on the spot and reported as `'invalid'`, because it was made from photographs and keeping it serves nobody.
 *
 * Runs behind the session's keyframe write queue, so a deletion of the session cannot run between the check and the removal.
 */
export function lookupReferenceCache(sessionDir: string, expect: ReferenceCacheExpectation): Promise<ReferenceCacheLookup> {
  return queueKeyframeWrite(sessionDir, async (): Promise<ReferenceCacheLookup> => {
    const dir = referenceCacheDir(sessionDir)
    if (!(await exists(dir))) return { state: 'absent' }
    const discard = async (why: string): Promise<ReferenceCacheLookup> => {
      await removeIfPresent(dir)
      return { state: 'invalid', why }
    }
    let manifest: unknown
    try {
      manifest = JSON.parse(await fs.readFile(`${dir}/reference.json`, 'utf8'))
    } catch {
      return await discard('manifest')
    }
    if (!isManifest(manifest)) return await discard('manifest')
    for (const field of ['projectId', 'frameId', 'scanId', 'sessionId', 'epoch', 'frameFingerprint'] as const) {
      if (manifest[field] !== expect[field]) return await discard(field)
    }
    if (basename(sessionDir) !== manifest.sessionId) return await discard('sessionId')
    const dbPath = `${dir}/db.db`
    const modelDir = `${dir}/sparse`
    if (!(await exists(dbPath)) || !(await exists(`${modelDir}/images.bin`)) || !(await exists(`${modelDir}/cameras.bin`))) {
      return await discard('files')
    }
    return { state: 'valid', dir, dbPath, modelDir, manifest }
  })
}

/**
 * Removes the reference cache of `sessionDir` unless it was made for exactly this Place and this frame generation. This is how
 * "invalidated when the frame id changes" is kept for a reference the new run will not use: a scan calibrated against an earlier
 * generation is left out of the comparison, so nothing would look at its cache again, and a model of those photographs for a reference
 * that is no longer the Place's would sit there until the session was deleted. A cache for this Place and frame, and a session with
 * none, are left alone. Resolves true when a cache was removed. Behind the session's write queue, like every removal here.
 */
export function discardStaleReferenceCache(
  sessionDir: string,
  current: { projectId: string; frameId: string | null },
): Promise<boolean> {
  return queueKeyframeWrite(sessionDir, async () => {
    const dir = referenceCacheDir(sessionDir)
    if (!(await exists(dir))) return false
    let manifest: unknown = null
    try {
      manifest = JSON.parse(await fs.readFile(`${dir}/reference.json`, 'utf8'))
    } catch { /* an unreadable manifest is a cache nobody can vouch for */ }
    if (isManifest(manifest) && manifest.projectId === current.projectId && manifest.frameId === current.frameId) return false
    await removeIfPresent(dir)
    return true
  })
}

/** Copies every file directly inside `from` into `to` (created). A model is a handful of flat files; no sub-directory is followed. */
export async function copyFlatDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.isFile()) await fs.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`)
  }
}

/**
 * Publishes a reference cache into the session's directory: the database (moved, or copied when the work directory is on another
 * device) and the model (copied), then the manifest last, so a cache that was cut short has no manifest and is discarded by the
 * next {@link lookupReferenceCache}. Replaces any cache already there.
 *
 * Resolves false and writes nothing when the session directory no longer has its `session.json`: the session was deleted while the
 * reference was being built, and recreating its directory to put a cache in it would leave derived camera data in a folder no
 * scan names. Runs behind the session's keyframe write queue, the queue the removal of a session runs behind, so the check and the
 * write cannot interleave with it.
 */
export function publishReferenceCache(
  sessionDir: string,
  staging: { dbPath: string; modelDir: string },
  manifest: ReferenceCacheManifest,
): Promise<boolean> {
  return queueKeyframeWrite(sessionDir, async () => {
    if (!(await exists(`${sessionDir}/session.json`))) return false
    const dir = referenceCacheDir(sessionDir)
    await removeIfPresent(dir)
    try {
      await fs.mkdir(dir, { recursive: true })
      try {
        await fs.rename(staging.dbPath, `${dir}/db.db`)
      } catch {
        await fs.copyFile(staging.dbPath, `${dir}/db.db`)
      }
      await copyFlatDir(staging.modelDir, `${dir}/sparse`)
      await fs.writeFile(`${dir}/reference.json`, JSON.stringify(manifest, null, 2))
      return true
    } catch (error) {
      // A cache that could not be completed is not left half-made beside the photographs.
      await removeIfPresent(dir)
      throw error
    }
  })
}

/** Removes a session's reference cache, behind the session's write queue. A session with none is done. */
export function removeReferenceCache(sessionDir: string): Promise<void> {
  return queueKeyframeWrite(sessionDir, () => removeIfPresent(referenceCacheDir(sessionDir)))
}

// ─── Work directories ────────────────────────────────────────────────────────

/**
 * What every work directory's name starts with, and the only names a sweep ever removes. A sweep removes whatever it finds, so what it
 * may find has to be nothing but this package's own directories: a `register-work` folder that is a link or a mount pointing at some
 * other folder (a mis-made link, a restore from a backup, a bind mount) has nothing named like this in it, and so loses nothing.
 */
export const WORK_DIR_PREFIX = 'run-'

/** Every work directory this process is using right now, by path. A sweep never removes one: it is another run's, still at work. */
const activeWorkDirs = new Set<string>()

/** A job id as a folder name: letters, digits, dot, dash and underscore, and nothing that can climb out of the folder it goes in. */
function folderName(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '')
  return safe === '' ? 'run' : safe.slice(0, 96)
}

/**
 * The work directory a run of `jobId` uses under `workRoot` (a Place's `register-work` folder): `run-<job>-<unique>`. The name is
 * different for every run, so a run that is started again under the same job id (a job a restart requeued) never shares a directory
 * with the earlier attempt, whose COLMAP can outlive the server that started it and would otherwise write into the new run's files.
 */
export function workDirFor(workRoot: string, jobId: string, unique: string = crypto.randomUUID().slice(0, 8)): string {
  return join(workRoot, `${WORK_DIR_PREFIX}${folderName(jobId)}-${unique}`)
}

/**
 * Removes every work directory under `workRoot` that no run in this process is using, and resolves how many it removed: what a run
 * that was killed (a crash, a restart, a deadline the process did not outlive) left behind. Only entries named like a work directory
 * ({@link WORK_DIR_PREFIX}) are touched, an entry that is a link is removed as a link and never followed, and a directory that a run
 * of this process is working in is left alone (the pump moves on after its own deadline and a run can still be going, so one run's
 * start must not take another's files from under it).
 */
export async function sweepWorkDirs(workRoot: string): Promise<number> {
  let removed = 0
  const found: Dirent[] = []
  try {
    for (const entry of await fs.readdir(workRoot, { withFileTypes: true })) found.push(entry)
  } catch (error) {
    if (isNotFound(error)) return 0
    throw error
  }
  for (const entry of found) {
    if (!entry.name.startsWith(WORK_DIR_PREFIX)) continue
    const path = join(workRoot, entry.name)
    if (activeWorkDirs.has(path)) continue
    try {
      // A link is unlinked: a recursive fs.rm on one could follow it.
      if (entry.isSymbolicLink()) await fs.rm(path)
      else await removeIfPresent(path)
      removed += 1
    } catch (error) {
      if (!(isNotFound(error))) throw error
    }
  }
  return removed
}

/**
 * {@link sweepWorkDirs} for every Place under the folder that holds the Places' data directories (`PROJECT_MEDIA_DIR`), run once at
 * boot: a run killed with the server leaves its directory behind, and nothing may be left to find a person's frames in. Only
 * `<root>/<Place>/register-work` is looked at, and a Place that is itself a link is not entered. Never throws: a Place whose leftovers
 * could not all be removed is counted in `failed`, which a caller that has promised the data is gone must not ignore, and the next
 * run sweeps again.
 */
export async function sweepAllWorkDirs(mediaRoot: string): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  try {
    for (const place of await fs.readdir(mediaRoot, { withFileTypes: true })) {
      if (!place.isDirectory()) continue
      try {
        removed += await sweepWorkDirs(`${mediaRoot}/${place.name}/${WORK_ROOT_DIR}`)
      } catch {
        failed += 1
      }
    }
  } catch (error) {
    if (!(isNotFound(error))) failed += 1
  }
  return { removed, failed }
}

/**
 * Runs `work` in a fresh work directory under `workRoot` and removes the directory afterwards, whatever `work` does: it returns, it
 * throws, or the caller's deadline made it give up. Leftovers of earlier runs are swept first (not the directory of a run that is
 * still going). The folder is {@link workDirFor}'s, new for every run; `workRoot` is created if it is missing and is left in place (an
 * empty folder holds nothing of anyone's).
 */
export async function withWorkDir<T>(workRoot: string, jobId: string, work: (dir: string) => Promise<T>): Promise<T> {
  try {
    await sweepWorkDirs(workRoot)
  } catch (error) {
    // An earlier run's leftovers that cannot be removed are for the boot sweep and the clear-everything route to report; this run's own
    // directory is a different one.
    console.error(`[place-register-sfm] could not remove an earlier run's work directory (${errorKind(error)})`)
  }
  await fs.mkdir(workRoot, { recursive: true })
  const dir = workDirFor(workRoot, jobId)
  // Not recursive: a directory that is already there is never shared.
  await fs.mkdir(dir)
  activeWorkDirs.add(dir)
  try {
    return await work(dir)
  } finally {
    activeWorkDirs.delete(dir)
    try {
      await removeIfPresent(dir)
    } catch (error) {
      // The run's own outcome stands; the sweep at the next start and at boot is what removes what could not be removed now.
      console.error(`[place-register-sfm] could not remove a work directory (${errorKind(error)})`)
    }
  }
}

/**
 * `text` with every path and every frame name removed. COLMAP's last words go into a job's result and a log, and they can name the
 * directory a run worked in and the pictures it was reading, which say where the person lives and what was photographed; the words
 * stay and the names go.
 *
 * Three layers. The folders this run was given (`roots`: the sessions folder, the Place's work folder, the COLMAP binary) are known
 * exactly, so they are removed whole whatever characters they hold: a space in a person's name is ordinary on a desktop, and no
 * pattern can tell where such a path ends. After them, a quoted string that holds a path separator is a path. And what is left is
 * found by shape: absolute paths (POSIX and Windows), `file://` addresses, and `~/`, `./` and `../` ones, whose folders may hold spaces
 * and whose last name does not, and `<folder>/kf-NNNNN.jpg` image names. A path with a space in its last name, outside every folder
 * this run was given and unquoted, is cut at the space: nothing can find where it ends, and what is left of it is a file name.
 */
export function scrubPaths(text: string, roots: readonly string[] = []): string {
  let out = text
  // A root that is not a path (a bare `colmap`, a command looked up on PATH) is not removed from a sentence that uses the word.
  for (const root of [...new Set(roots)].filter((root) => root.length >= 3 && /[\\/]/.test(root)).sort((a, b) => b.length - a.length)) {
    for (const form of [`file://${root}`, root, root.replaceAll('/', '\\')]) out = out.split(form).join('<path>')
  }
  return out
    // What is under a known folder is part of the one path.
    .replace(UNDER_A_PATH, '<path>')
    .replace(/(['"])([^'"\n]*[\\/][^'"\n]*)\1/g, '$1<path>$1')
    .replace(PATH_PATTERN, '$1<path>')
    .replace(/\b[\w.-]+\/kf-\d+\.jpg\b/g, '<path>')
    .replace(/\bkf-\d+\.jpg\b/g, '<path>')
    .replace(UNDER_A_PATH, '<path>')
}

/** A removed path followed by the names under it: what is left of a path that was cut in pieces. */
const UNDER_A_PATH = /<path>(?:[\\/][^\s'",;)]*)+/g

/** Where a path can start, the folders under it (which can hold spaces), and its last name (which cannot). A path ends at a space, a quote, a comma, a semicolon or a bracket, and not at the colon or full stop that ends a sentence about it. */
const PATH_START = String.raw`(?:file:\/\/\/?|[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)`
const PATH_FOLDER = String.raw`[^\\/'",;)\n]+[\\/]`
const PATH_LAST = String.raw`(?:[^\s\\/'",;)]*[^\s\\/'",;):.])?`
const PATH_PATTERN = new RegExp(String.raw`(^|[\s'"(=:])${PATH_START}(?:${PATH_FOLDER})*${PATH_LAST}`, 'g')
