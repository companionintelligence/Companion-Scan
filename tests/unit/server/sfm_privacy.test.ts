/**
 * What the photo method of `place-register` makes from a person's camera frames, and what removes it (decision D15).
 *
 * Keyframes are photographs of the inside of a home. The photo method makes two things from them: a work directory for the length of a
 * run, and a reference model of the earlier scan's session that is kept between runs (server/register/sfm_workspace.ts is the design
 * and says why they live where they do). These tests do not look at that design; they run the REAL deletion and retention code of
 * the privacy package against REAL directories and ask whether anything made from a photograph is still on disk afterwards:
 *
 *  - deleting the scan the model was made from (`DELETE /scans/:filename`), clearing every scan, deleting one session
 *    (`DELETE /sessions/:id`) and the retention purge each take the model with the photographs, with no code of this package in the
 *    path: it is inside the session directory they remove;
 *  - deleting a Place takes the work directory a killed run left in the Place's folder, and clearing every scan sweeps it too;
 *  - COLMAP reads each photograph where its session keeps it, so the work directory holds no photograph and no link to one, at any
 *    moment of a run, and removing it, however it is removed, cannot touch a session;
 *  - nothing is left after a run however it ended, no photograph is copied anywhere, nothing is sent anywhere, and nothing logs a path.
 *
 * COLMAP is stood in for (sfm_fixtures.ts), so what is tested is what this repo owns.
 */
import { assert, assertEquals, assertFalse, assertMatch } from './assert.ts'

import { purgeExpiredKeyframeSessions } from '../../../server/keyframe_retention.ts'
import { removePlaceMedia } from '../../../server/place_deletion.ts'
import { type DeleteAllDeps, deleteAllScans, deleteScan, type ScanDeletionDeps } from '../../../server/scan_deletion.ts'
import { deleteStreamedSession } from '../../../server/session_deletion.ts'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { runSfmRegistration, type SfmHost, type SfmRequest } from '../../../server/register/place_register_sfm.ts'
import {
  discardStaleReferenceCache,
  lookupReferenceCache,
  publishReferenceCache,
  REFERENCE_CACHE_DIR,
  referenceCacheDir,
  removeReferenceCache,
  scrubPaths,
  sweepAllWorkDirs,
  sweepWorkDirs,
  WORK_ROOT_DIR,
  withWorkDir,
  workDirFor,
} from '../../../server/register/sfm_workspace.ts'
import {
  fakeColmap,
  ringSpec,
  ringViews,
  scanManifest,
  storedMatrix,
  type ToySessionSpec,
  worldOf,
  writeFakeSession,
  MIDDLE,
} from './sfm_fixtures.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { makeTempDir, readBytes } from '../../../server/fs_util.ts'
import { test } from 'node:test'

const PROJECT = 'proj-privacy'
const FRAME = 'frame-aaa'
const REF = 'sess-sfm-ref'
const NEW = 'sess-sfm-new'

interface Tree {
  root: string
  scans: string
  sessions: string
  /** The folder the Places' own data lives in (`PROJECT_MEDIA_DIR`): `scans/projects`. */
  media: string
  refSpec: ToySessionSpec
  newSpec: ToySessionSpec
  host: SfmHost
  request: SfmRequest
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

async function listDir(path: string): Promise<string[]> {
  const names: string[] = []
  try {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) names.push(entry.name)
  } catch { /* none */ }
  return names.sort()
}

/** Every path under `dir`, as written, without following a link. */
async function walk(dir: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const path = `${at}/${entry.name}`
      found.push(path)
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(dir)
  return found.sort()
}

/** `from` copied to `to`, folders and files, the way `cp -r` would (kept by hand, though fs.cp could do it). */
async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(`${from}/${entry.name}`, `${to}/${entry.name}`)
    else await fs.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`)
  }
}

/** A tree the way the server lays it out: scans, scans/sessions, scans/projects, a reference scan with its sidecar and its photographs. */
async function withTree(run: (tree: Tree) => Promise<void>): Promise<void> {
  const root = await makeTempDir({ prefix: 'sfm-privacy-' })
  const scans = `${root}/scans`
  const sessions = `${scans}/sessions`
  const media = `${scans}/projects`
  await fs.mkdir(sessions, { recursive: true })
  const refSpec = ringSpec(REF)
  const newSpec = ringSpec(NEW, { yawDeg: 25, origin: [1.2, 0, -0.7], views: ringViews(MIDDLE, [1.0, 1.2], 14, 10, 1.35, 12), seed: 102 })
  try {
    await writeFakeSession(sessions, refSpec, { glbFilename: 'scan-ref.glb' })
    await writeFakeSession(sessions, newSpec, { glbFilename: 'scan-new.glb' })
    await fs.writeFile(`${scans}/scan-ref.glb`, 'glb')
    await fs.writeFile(`${scans}/scan-ref.json`, JSON.stringify({ sessionId: REF }))
    await fs.writeFile(`${scans}/scan-new.glb`, 'glb')
    await fs.writeFile(`${scans}/scan-new.json`, JSON.stringify({ sessionId: NEW }))
    const ref = scanManifest('scan-ref', REF, storedMatrix(refSpec, { yawDeg: 0, shift: [0, 0, 0] }), { calibrationFrameId: FRAME, projectId: PROJECT })
    const moving = scanManifest('scan-new', NEW, storedMatrix(newSpec, { yawDeg: 4, shift: [0.35, 0, -0.25] }), { calibrationFrameId: FRAME, projectId: PROJECT })
    const fake = fakeColmap({ world: worldOf([refSpec, newSpec]) })
    const host: SfmHost = {
      enabled: true,
      sessionsDir: sessions,
      workRoot: (projectId) => `${media}/${projectId}/${WORK_ROOT_DIR}`,
      readScanMeta: async () => ({ frameEpochs: { calibrationEpoch: 0 } }),
      jobId: 'job-privacy-1',
      colmapBin: process.execPath,
      _spawn: fake.spawn,
    }
    await run({
      root,
      scans,
      sessions,
      media,
      refSpec,
      newSpec,
      host,
      request: { place: { projectId: PROJECT, frameId: FRAME }, moving, references: [ref] },
    })
  } finally {
    await fs.rm(root, { recursive: true }).catch(() => undefined)
  }
}

/** A run that has made its reference model: the earlier scan's session now holds `sfm-reference/`. */
async function withBuiltCache(run: (tree: Tree) => Promise<void>): Promise<void> {
  await withTree(async (tree) => {
    const { result } = await runSfmRegistration(tree.host, tree.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assertEquals(result.referenceModel, 'built')
    assertEquals(await listDir(referenceCacheDir(`${tree.sessions}/${REF}`)), ['db.db', 'reference.json', 'sparse'])
    await run(tree)
  })
}

function scanDeps(tree: Tree): ScanDeletionDeps {
  return {
    scansDir: tree.scans,
    sessionsDir: tree.sessions,
    splatSuffixes: [],
    claimJobs: async () => ({ running: [], senseNovaJobIds: [] }),
    dropWorldExports: async () => 0,
    removeFromWorlds: async () => 0,
  }
}

/** Nothing anywhere under `root` is a trace of the photo method: no cache folder, no database, no manifest, no work folder. */
async function assertNoTraceOfTheMethod(root: string): Promise<void> {
  const traces = (await walk(root)).filter((path) =>
    path.includes(`/${REFERENCE_CACHE_DIR}`) || path.endsWith('/db.db') || path.endsWith('/reference.json') || path.includes(`/${WORK_ROOT_DIR}/`)
  )
  assertEquals(traces, [])
}

// ─── What deleting the scan, the session, everything and the purge take ─────

test('privacy: deleting the scan the reference model was made from takes the model with its photographs, and nothing else of the Place', async () => {
  await withBuiltCache(async (tree) => {
    const reply = await deleteScan('scan-ref.glb', scanDeps(tree))
    assertEquals(reply.status, 200, JSON.stringify(reply.body))
    assertFalse(await exists(`${tree.sessions}/${REF}`), 'the session is gone')
    assertFalse(await exists(referenceCacheDir(`${tree.sessions}/${REF}`)), 'and the model with it')
    await assertNoTraceOfTheMethod(tree.root)
    // The other scan's photographs are not the reference's, and are not touched.
    assertEquals((await listDir(`${tree.sessions}/${NEW}`)).filter((name) => name.endsWith('.jpg')).length, 14)
  })
})

test('privacy: deleting the scan that was registered leaves nothing made by the run in its folder, and the reference\'s model stays with the reference', async () => {
  await withBuiltCache(async (tree) => {
    assertEquals(await listDir(`${tree.sessions}/${NEW}`), await listDir(`${tree.sessions}/${NEW}`).then((names) => names.filter((name) => name === 'session.json' || name === 'keyframes.jsonl' || name.endsWith('.jpg'))), 'the registration wrote nothing into the new scan\'s session')
    const reply = await deleteScan('scan-new.glb', scanDeps(tree))
    assertEquals(reply.status, 200)
    assertFalse(await exists(`${tree.sessions}/${NEW}`))
    // The model belongs to the scan it was made from, which is still there.
    assert(await exists(referenceCacheDir(`${tree.sessions}/${REF}`)))
    assertEquals(await listDir(`${tree.media}/${PROJECT}/${WORK_ROOT_DIR}`), [], 'and no run is left in the Place\'s folder')
  })
})

test('privacy: deleting one session (the phone\'s "delete frames I sent") takes its model too', async () => {
  await withBuiltCache(async (tree) => {
    const reply = await deleteStreamedSession(tree.sessions, REF)
    assertEquals(reply.status, 200, JSON.stringify(reply.body))
    assertFalse(await exists(`${tree.sessions}/${REF}`))
    await assertNoTraceOfTheMethod(tree.root)
  })
})

test('privacy: clearing every scan takes every session and the model with it, and sweeps a run that was killed', async () => {
  await withBuiltCache(async (tree) => {
    // A run that was killed with the server: a database and a model of a private room, in the Place's folder.
    const leftover = workDirFor(`${tree.media}/${PROJECT}/${WORK_ROOT_DIR}`, 'job-killed')
    await fs.mkdir(`${leftover}/sparse/0`, { recursive: true })
    await fs.writeFile(`${leftover}/sparse/0/images.bin`, 'a coloured point cloud of a private room')
    await fs.writeFile(`${leftover}/db.db`, 'features of a private room')
    const deps: DeleteAllDeps = {
      scansDir: tree.scans,
      sessionsDir: tree.sessions,
      splatSuffixes: [],
      runningJobs: async () => [],
      dropAllWorldExports: async () => 0,
      removeAllFromWorlds: async () => undefined,
      dropDerivedWork: () => sweepAllWorkDirs(tree.media),
    }
    const reply = await deleteAllScans(deps)
    assertEquals(reply.status, 200, JSON.stringify(reply.body))
    assertEquals(await listDir(tree.sessions), [], 'every session is gone')
    await assertNoTraceOfTheMethod(tree.root)
  })
})

test('privacy: the retention purge takes an expired session with its model, and a fresh model does not keep an old session alive', async () => {
  await withBuiltCache(async (tree) => {
    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    const old = new Date(now - 90 * DAY)
    // The reference session is 90 days old by every sign the purge reads. Its model was written a moment ago, by the run above.
    for (const name of ['session.json', 'keyframes.jsonl']) await fs.utimes(`${tree.sessions}/${REF}/${name}`, old, old)
    const record = JSON.parse(await fs.readFile(`${tree.sessions}/${REF}/session.json`, 'utf8'))
    await fs.writeFile(`${tree.sessions}/${REF}/session.json`, JSON.stringify({ ...record, startedAt: old.toISOString() }))
    await fs.utimes(`${tree.sessions}/${REF}/session.json`, old, old)
    const fresh = (await fs.stat(`${referenceCacheDir(`${tree.sessions}/${REF}`)}/reference.json`)).mtime!
    assert(now - fresh.getTime() < DAY, 'the model is new')

    // A dry run counts it and removes nothing.
    const dry = await purgeExpiredKeyframeSessions({ sessionsDir: tree.sessions, scansDir: tree.scans, retentionDays: 30, dryRun: true, now })
    assertEquals([dry.expired, dry.deleted], [1, 0])
    assert(await exists(referenceCacheDir(`${tree.sessions}/${REF}`)))

    const real = await purgeExpiredKeyframeSessions({ sessionsDir: tree.sessions, scansDir: tree.scans, retentionDays: 30, dryRun: false, now })
    assertEquals([real.expired, real.deleted, real.failed], [1, 1, 0])
    assertFalse(await exists(`${tree.sessions}/${REF}`))
    assertFalse(await exists(referenceCacheDir(`${tree.sessions}/${REF}`)))
    // The young session is kept, whole.
    assertEquals((await listDir(`${tree.sessions}/${NEW}`)).filter((name) => name.endsWith('.jpg')).length, 14)
    await assertNoTraceOfTheMethod(tree.root)
  })
})

test('privacy: deleting a Place takes the work a killed run left in its folder, and a link in it that names a session is removed as a link', async () => {
  await withTree(async (tree) => {
    const placeDir = `${tree.media}/${PROJECT}`
    const leftover = workDirFor(`${placeDir}/${WORK_ROOT_DIR}`, 'job-killed')
    await fs.mkdir(leftover, { recursive: true })
    await fs.writeFile(`${leftover}/db.db`, 'features of a private room')
    // A link to a whole session, as a mistake or an attack might leave in the folder: removing the Place unlinks it and never follows it.
    await fs.symlink(await fs.realpath(`${tree.sessions}/${REF}`), `${leftover}/session-link`)
    await fs.writeFile(`${placeDir}/reference-photos.json`, '{}')
    const before = await readBytes(`${tree.sessions}/${REF}/kf-00001.jpg`)

    assertEquals(await removePlaceMedia(tree.media, PROJECT), true)
    assertFalse(await exists(placeDir), 'the Place\'s folder is gone, with the run in it')
    assertEquals(await readBytes(`${tree.sessions}/${REF}/kf-00001.jpg`), before, 'removing a link never touches what it names')
    assertEquals((await listDir(`${tree.sessions}/${REF}`)).filter((name) => name.endsWith('.jpg')).length, 14)
  })
})

// ─── The work directory ──────────────────────────────────────────────────────

test('privacy: the work directory is removed with the run however the run ends, and no session is touched', async () => {
  await withTree(async (tree) => {
    const workRoot = `${tree.media}/${PROJECT}/${WORK_ROOT_DIR}`
    // Ends by returning.
    await withWorkDir(workRoot, 'job-a', async (dir) => {
      await fs.mkdir(`${dir}/sparse`, { recursive: true })
      await fs.writeFile(`${dir}/db.db`, 'features')
    })
    assertEquals(await listDir(workRoot), [])
    // Ends by throwing.
    let thrown = false
    try {
      await withWorkDir(workRoot, 'job-b', async (dir) => {
        await fs.writeFile(`${dir}/db.db`, 'x')
        throw new Error('the run failed')
      })
    } catch {
      thrown = true
    }
    assert(thrown, 'the run\'s own error is not swallowed')
    assertEquals(await listDir(workRoot), [])
    assertEquals((await listDir(`${tree.sessions}/${REF}`)).filter((name) => name.endsWith('.jpg')).length, 14, 'no photograph was removed')
  })
})

test('privacy: a run that starts sweeps what an earlier run that was killed left, and a link to a session is removed as a link', async () => {
  await withTree(async (tree) => {
    const workRoot = `${tree.media}/${PROJECT}/${WORK_ROOT_DIR}`
    const killed = workDirFor(workRoot, 'job-killed')
    await fs.mkdir(`${killed}/images`, { recursive: true })
    await fs.writeFile(`${killed}/db.db`, 'features')
    // Something named like a work directory that is a link to a whole session, as a mistake or an attack might leave: removed as a link,
    // never followed.
    const link = workDirFor(workRoot, 'job-link')
    await fs.symlink(await fs.realpath(`${tree.sessions}/${REF}`), link)
    let ran = ''
    let sawLeftover = true
    await withWorkDir(workRoot, 'job-now', async (dir) => {
      ran = dir
      sawLeftover = (await listDir(workRoot)).some((name) => `${workRoot}/${name}` !== dir)
    })
    assertFalse(sawLeftover, 'the leftovers were swept before the run began')
    assertEquals(await listDir(workRoot), [])
    assertMatch(ran, /\/run-job-now-[0-9a-f]{8}$/)
    assertEquals((await listDir(`${tree.sessions}/${REF}`)).filter((name) => name.endsWith('.jpg')).length, 14, 'the session the link named is whole')
  })
})

test('privacy: every run has a work directory of its own, so a run started again under the same job id never shares one with the attempt before it', async () => {
  await withTree(async (tree) => {
    const workRoot = `${tree.media}/${PROJECT}/${WORK_ROOT_DIR}`
    const seen: string[] = []
    // The earlier attempt is still going (COLMAP outlives a server that was killed), and the job is requeued under its id.
    await withWorkDir(workRoot, 'job-same', async (first) => {
      await fs.writeFile(`${first}/db.db`, 'the earlier attempt\'s features')
      seen.push(first)
      await withWorkDir(workRoot, 'job-same', async (second) => {
        seen.push(second)
        assertEquals(await listDir(second), [], 'the new attempt starts in an empty directory')
      })
      assertEquals(await fs.readFile(`${first}/db.db`, 'utf8'), 'the earlier attempt\'s features', 'and does not take the earlier one\'s files')
    })
    assertEquals(new Set(seen).size, 2)
    assertEquals(await listDir(workRoot), [])
    // A hostile job id is a folder name and nothing else: it cannot name a place outside the Place's work folder.
    for (const id of ['../../x', '/etc/cron.d/x', '..', '', 'a/b/../../../../tmp/y', 'job\u0000x', '....//job']) {
      const dir = workDirFor(workRoot, id)
      assert(dir.startsWith(`${workRoot}/run-`), `${JSON.stringify(id)} gave ${dir}`)
      assertFalse(dir.slice(workRoot.length + 1).includes('/'), `${JSON.stringify(id)} gave ${dir}: one folder, directly under the work folder`)
      assert(!['.', '..'].includes(dir.slice(workRoot.length + 1)), `${JSON.stringify(id)} gave ${dir}`)
    }
  })
})

test('privacy: a sweep removes only what is named like a work directory, and does not follow a work folder that is a link', async () => {
  await withTree(async (tree) => {
    // The Place's register-work folder is a link to the sessions folder: a mis-made link, a bind mount, a restore from a backup.
    const placeDir = `${tree.media}/${PROJECT}`
    await fs.mkdir(placeDir, { recursive: true })
    await fs.symlink(await fs.realpath(tree.sessions), `${placeDir}/${WORK_ROOT_DIR}`)
    const before = await listDir(tree.sessions)
    assert(before.length > 0)
    assertEquals(await sweepAllWorkDirs(tree.media), { removed: 0, failed: 0 })
    assertEquals(await listDir(tree.sessions), before, 'every session is where it was')
    assertEquals((await listDir(`${tree.sessions}/${REF}`)).filter((name) => name.endsWith('.jpg')).length, 14)
    // A run that starts on such a folder sweeps nothing of the sessions either.
    await withWorkDir(`${placeDir}/${WORK_ROOT_DIR}`, 'job-x', async () => {})
    assertEquals(await listDir(tree.sessions), before)

    // And in a work folder of its own, what is not named like a work directory is left alone, a link is unlinked, and what is is removed.
    const root = `${tree.root}/own-work`
    await fs.mkdir(`${root}/run-job-a-1111`, { recursive: true })
    await fs.mkdir(`${root}/someone-elses-notes`, { recursive: true })
    await fs.writeFile(`${root}/readme.txt`, 'mine')
    await fs.symlink(await fs.realpath(`${tree.sessions}/${REF}`), `${root}/run-job-link-2222`)
    assertEquals(await sweepWorkDirs(root), 2)
    assertEquals(await listDir(root), ['readme.txt', 'someone-elses-notes'])
    assertEquals((await listDir(`${tree.sessions}/${REF}`)).filter((name) => name.endsWith('.jpg')).length, 14)
  })
})

test('privacy: a run that starts does not sweep the work directory of a run that is still going', async () => {
  await withTree(async (tree) => {
    const workRoot = `${tree.media}/${PROJECT}/${WORK_ROOT_DIR}`
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    let still = false
    // The pump moves on after its own deadline, and a run can still be at work when the next one starts.
    const first = withWorkDir(workRoot, 'job-a', async (dir) => {
      await fs.writeFile(`${dir}/db.db`, 'features of a private room')
      await hold
      still = await exists(`${dir}/db.db`)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await withWorkDir(workRoot, 'job-b', async (dir) => {
      assertEquals((await listDir(workRoot)).length, 2, 'both are there while both run')
      assert(await exists(dir))
    })
    release()
    await first
    assert(still, 'the first run still had its own files after the second began and ended')
    assertEquals(await listDir(workRoot), [], 'and both are gone when both have ended')
    // At boot nothing is running, and whatever is left is removed.
    const left = workDirFor(workRoot, 'job-killed')
    await fs.mkdir(left, { recursive: true })
    assertEquals(await sweepAllWorkDirs(tree.media), { removed: 1, failed: 0 })
  })
})

test('privacy: clearing every scan does not say it is done while a leftover of the photo method could not be removed', async () => {
  await withBuiltCache(async (tree) => {
    const leftover = workDirFor(`${tree.media}/${PROJECT}/${WORK_ROOT_DIR}`, 'job-killed')
    await fs.mkdir(`${leftover}/sparse`, { recursive: true })
    await fs.writeFile(`${leftover}/db.db`, 'COLMAP features of a private room')
    const deps = (dropDerivedWork: DeleteAllDeps['dropDerivedWork']): DeleteAllDeps => ({
      scansDir: tree.scans,
      sessionsDir: tree.sessions,
      splatSuffixes: [],
      runningJobs: async () => [],
      dropAllWorldExports: async () => 0,
      removeAllFromWorlds: async () => { removedFromWorlds = true },
      dropDerivedWork,
    })
    let removedFromWorlds = false
    // A folder nobody may remove from, as one a killed run left under another account would be. (A superuser can write there all the
    // same: then the sweep cannot fail, and the same refusal is checked with a sweep that reports its failure.)
    await fs.chmod(`${leftover}/sparse`, 0o555)
    await fs.chmod(leftover, 0o555)
    const canFail = await fs.writeFile(`${leftover}/probe`, 'x').then(() => false, () => true)
    if (!canFail) {
      await fs.chmod(`${leftover}/sparse`, 0o755)
      await fs.chmod(leftover, 0o755)
      await fs.rm(`${leftover}/probe`)
    }
    try {
      const reply = await deleteAllScans(deps(canFail ? () => sweepAllWorkDirs(tree.media) : async () => ({ failed: 1 })))
      assertEquals(reply.status, 500, JSON.stringify(reply.body))
      assertEquals((reply.body as { derivedWork?: { failed: number } }).derivedWork?.failed, 1)
      assertEquals(removedFromWorlds, false, 'the worlds were left as they were')
      assert(!(reply.body as { ok?: boolean }).ok)
    } finally {
      if (canFail) {
        await fs.chmod(`${leftover}/sparse`, 0o755).catch(() => undefined)
        await fs.chmod(leftover, 0o755).catch(() => undefined)
      }
    }
    // When it can be removed, the same call says so.
    const reply = await deleteAllScans(deps(() => sweepAllWorkDirs(tree.media)))
    assertEquals(reply.status, 200, JSON.stringify(reply.body))
    assertEquals(removedFromWorlds, true)
    // A caller with no such step is as it was.
    const bare = await deleteAllScans(deps(undefined))
    assertEquals(bare.status, 200)
  })
})

test('privacy: the boot sweep clears every Place\'s work folder, skips what is not one, and reports what it did', async () => {
  await withTree(async (tree) => {
    for (const place of ['proj-a', 'proj-b']) {
      const killed = workDirFor(`${tree.media}/${place}/${WORK_ROOT_DIR}`, 'job-killed')
      await fs.mkdir(killed, { recursive: true })
      await fs.writeFile(`${killed}/db.db`, 'x')
    }
    await fs.mkdir(`${tree.media}/proj-c`, { recursive: true })
    await fs.writeFile(`${tree.media}/proj-c/ref-landmark.jpg`, 'a Place\'s own reference photo')
    await fs.writeFile(`${tree.media}/not-a-place.txt`, 'x')
    const swept = await sweepAllWorkDirs(tree.media)
    assertEquals(swept, { removed: 2, failed: 0 })
    assertEquals(await listDir(`${tree.media}/proj-a/${WORK_ROOT_DIR}`), [])
    assertEquals(await listDir(`${tree.media}/proj-c`), ['ref-landmark.jpg'], 'a Place\'s own files are not the sweep\'s')
    // No media folder at all is nothing to sweep, not an error.
    assertEquals(await sweepAllWorkDirs(`${tree.root}/nowhere`), { removed: 0, failed: 0 })
    assertEquals(await sweepWorkDirs(`${tree.root}/nowhere`), 0)
  })
})

// ─── The reference model's own rules ─────────────────────────────────────────

test('privacy: a model is never made inside a session that no longer exists, and a model copied to another session is not believed there', async () => {
  await withBuiltCache(async (tree) => {
    const refDir = `${tree.sessions}/${REF}`
    const cache = referenceCacheDir(refDir)
    // Publishing into a directory with no session.json writes nothing and makes no directory.
    const gone = `${tree.sessions}/sess-gone`
    const staging = `${tree.root}/staging`
    await fs.mkdir(`${staging}/model`, { recursive: true })
    await fs.writeFile(`${staging}/db.db`, 'x')
    await fs.writeFile(`${staging}/model/images.bin`, 'x')
    const manifest = JSON.parse(await fs.readFile(`${cache}/reference.json`, 'utf8'))
    assertEquals(await publishReferenceCache(gone, { dbPath: `${staging}/db.db`, modelDir: `${staging}/model` }, manifest), false)
    assertFalse(await exists(gone), 'no folder was made for a deleted session')

    // The same model copied beside another session's photographs: its manifest names the session it was made for.
    await fs.mkdir(`${tree.sessions}/sess-other`, { recursive: true })
    await fs.writeFile(`${tree.sessions}/sess-other/session.json`, '{}')
    await copyTree(cache, referenceCacheDir(`${tree.sessions}/sess-other`))
    const lookup = await lookupReferenceCache(`${tree.sessions}/sess-other`, {
      projectId: PROJECT, frameId: FRAME, scanId: 'scan-ref', sessionId: 'sess-other', epoch: 0, frameFingerprint: manifest.frameFingerprint,
    })
    assertEquals(lookup, { state: 'invalid', why: 'sessionId' })
    assertFalse(await exists(referenceCacheDir(`${tree.sessions}/sess-other`)), 'and it was removed')

    // Stale for another frame: removed by the sweep that runs before every comparison.
    assertEquals(await discardStaleReferenceCache(refDir, { projectId: PROJECT, frameId: FRAME }), false)
    assertEquals(await discardStaleReferenceCache(refDir, { projectId: PROJECT, frameId: 'frame-bbb' }), true)
    assertFalse(await exists(cache))
    await removeReferenceCache(refDir) // a session with none is done
  })
})

test('privacy: a kept model is believed only for exactly what it was made for, field by field, and one that is not is removed', async () => {
  await withBuiltCache(async (tree) => {
    const refDir = `${tree.sessions}/${REF}`
    const cache = referenceCacheDir(refDir)
    const manifest = JSON.parse(await fs.readFile(`${cache}/reference.json`, 'utf8'))
    const expected = {
      projectId: manifest.projectId,
      frameId: manifest.frameId,
      scanId: manifest.scanId,
      sessionId: manifest.sessionId,
      epoch: manifest.epoch,
      frameFingerprint: manifest.frameFingerprint,
    }
    assertEquals((await lookupReferenceCache(refDir, expected)).state, 'valid', 'what it was made for finds it')
    const kept = `${tree.root}/kept-model`
    await copyTree(cache, kept)
    const other: Record<string, unknown> = { projectId: 'proj-other', frameId: 'frame-other', scanId: 'scan-other', sessionId: 'sess-other', epoch: 1, frameFingerprint: 'other' }
    for (const [field, value] of Object.entries(other)) {
      assertEquals(await lookupReferenceCache(refDir, { ...expected, [field]: value }), { state: 'invalid', why: field }, `a different ${field}`)
      assertFalse(await exists(cache), `the model for a different ${field} was removed`)
      await copyTree(kept, cache)
    }
    // Damage is not believed either: a manifest that is not a manifest, and a model with a file missing.
    await fs.writeFile(`${cache}/reference.json`, '{"schemaVersion":1}')
    assertEquals(await lookupReferenceCache(refDir, expected), { state: 'invalid', why: 'manifest' })
    await copyTree(kept, cache)
    await fs.rm(`${cache}/sparse/images.bin`)
    assertEquals((await lookupReferenceCache(refDir, expected)).state, 'invalid')
    assertFalse(await exists(cache), 'and a model with a file missing is removed')
  })
})

// ─── Nothing leaves, nothing is copied, nothing logs a path ──────────────────

/** Every picture (a file that starts like a JPEG) under `dir`, and every link, by path. */
async function picturesAndLinks(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const path of await walk(dir)) {
    const info = await fs.lstat(path)
    if (info.isSymbolicLink()) {
      found.push(path)
      continue
    }
    if (!info.isFile()) continue
    const file = await fs.open(path, 'r')
    const head = new Uint8Array(3)
    await file.read(head, 0, head.length)
    await file.close()
    if (head[0] === 0xff && head[1] === 0xd8) found.push(path)
  }
  return found
}

test('privacy: at every moment of a run COLMAP is reading the sessions\' own files: no picture and no link to one is anywhere else', async () => {
  await withTree(async (tree) => {
    const snapshots: string[][] = []
    const roots = new Set<string>()
    const watching = fakeColmap({
      world: worldOf([tree.refSpec, tree.newSpec]),
      onCall: async (args) => {
        if (args.includes('--image_path')) roots.add(args[args.indexOf('--image_path') + 1]!)
        snapshots.push((await picturesAndLinks(tree.root)).filter((path) => !path.startsWith(`${tree.sessions}/sess-`) || path.includes('/sfm-reference/')))
      },
    })
    const { result } = await runSfmRegistration({ ...tree.host, _spawn: watching.spawn }, tree.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assert(snapshots.length >= 7, `looked at ${snapshots.length} moments of the run`)
    assertEquals(snapshots.flat(), [], 'no picture or link outside the sessions\' own frames while COLMAP was working')
    assertEquals([...roots], [await fs.realpath(tree.sessions)], 'and every command was given the sessions folder to read from')
  })
})

test('privacy: after a run no photograph or picture is anywhere but in the sessions, and the model holds none', async () => {
  await withBuiltCache(async (tree) => {
    const jpegs: string[] = []
    for (const path of await walk(tree.root)) {
      const info = await fs.lstat(path)
      if (!info.isFile()) continue
      const head = await fs.open(path, 'r').then(async (file) => {
        const bytes = new Uint8Array(3)
        await file.read(bytes, 0, bytes.length)
        await file.close()
        return bytes
      })
      if (head[0] === 0xff && head[1] === 0xd8) jpegs.push(path)
    }
    assertEquals(jpegs.filter((path) => !path.startsWith(`${tree.sessions}/`)), [], 'no picture outside the sessions')
    assertEquals(jpegs.filter((path) => path.includes(`/${REFERENCE_CACHE_DIR}/`)), [], 'none in the model')
    assertEquals(jpegs.length, 28, 'and the sessions still hold all of theirs')
  })
})

test('privacy: nothing the run logs holds a path or a frame name, whether it succeeds, fails, runs out of time or breaks', async () => {
  const logged: string[] = []
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  const record = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  console.log = record
  console.warn = record
  console.error = record
  console.info = record
  try {
    await withTree(async (tree) => {
      // Succeeds.
      await runSfmRegistration(tree.host, tree.request)
      // A COLMAP that fails and says where.
      const failing = fakeColmap({
        world: worldOf([tree.refSpec, tree.newSpec]),
        failOn: { step: 'mapper(register)', stderr: `E could not read ${tree.sessions}/${NEW}/kf-00002.jpg` },
      })
      const failed = await runSfmRegistration({ ...tree.host, _spawn: failing.spawn, jobId: 'job-2' }, tree.request)
      assertEquals(failed.result.reason, 'colmap-failed')
      // Runs out of time.
      const hanging = fakeColmap({ world: worldOf([tree.refSpec, tree.newSpec]), hangOn: 'matches_importer' })
      const slow = await runSfmRegistration({ ...tree.host, _spawn: hanging.spawn, jobId: 'job-3', wallClockMs: 150 }, tree.request)
      assertEquals(slow.result.reason, 'timed-out')
      // Breaks outright, with a message that names a photograph.
      const broken = await runSfmRegistration({
        ...tree.host,
        jobId: 'job-4',
        _spawn: () => {
          throw new Error(`cannot open ${tree.sessions}/${NEW}/kf-00001.jpg`)
        },
      }, tree.request)
      assertEquals(broken.result.reason, 'colmap-failed')
      for (const outcome of [failed, slow, broken]) {
        const text = JSON.stringify(outcome.result)
        assertFalse(text.includes(tree.root), 'no path in the stored result')
        assertFalse(/kf-\d{5}/.test(text), 'no frame name in the stored result')
      }
      assertFalse(logged.some((line) => line.includes(tree.root)), `a path was logged: ${logged.find((line) => line.includes(tree.root))}`)
      assertFalse(logged.some((line) => /kf-\d{5}/.test(line)), 'a frame name was logged')
    })
  } finally {
    Object.assign(console, saved)
  }
})

test('privacy: the photo method\'s modules open no connection and call no service: nothing that leaves the machine is in them', async () => {
  const modules = [
    'server/register/place_register_sfm.ts',
    'server/register/sfm_workspace.ts',
    'server/colmap/colmap_reference.ts',
  ]
  for (const path of modules) {
    const source = await fs.readFile(fileURLToPath(new URL(path, REPO_ROOT)), 'utf8')
    for (const forbidden of [/\bfetch\s*\(/, /node:(net|http|https|http2|dgram|tls)\b/, /\bcreateServer\(/, /\bserve\(/, /WebSocket/, /XMLHttpRequest/, /sendBeacon/, /https?:\/\//]) {
      assertFalse(forbidden.test(source), `${path} has ${forbidden}`)
    }
  }
})

test('scrubPaths: takes out every path and frame name and leaves the words', () => {
  const cases: Array<[string, string]> = [
    ['E1 could not read /home/someone/scans/sessions/sess-abc/kf-00003.jpg: bad file', 'E1 could not read <path>: bad file'],
    ['failed (exit 1): mapper | no model in "/var/lib/scan/projects/proj-1/register-work/job-9/sparse"', 'failed (exit 1): mapper | no model in "<path>"'],
    ['image sess-abc/kf-00012.jpg has no features', 'image <path> has no features'],
    ['kf-00001.jpg and kf-00002.jpg', '<path> and <path>'],
    ['C:\\Users\\someone\\scans\\kf-00001.jpg could not be read', '<path> could not be read'],
    ['--database_path=/data/scans/projects/proj-1/db.db was locked', '--database_path=<path> was locked'],
    ['12 of 14 photographs were placed (86%)', '12 of 14 photographs were placed (86%)'],
    ['COLMAP placed 12 of 14 reference photographs in one model.', 'COLMAP placed 12 of 14 reference photographs in one model.'],
    ['The earlier scan\'s camera positions changed while the new photographs were added.', 'The earlier scan\'s camera positions changed while the new photographs were added.'],
    ['', ''],
  ]
  for (const [text, expected] of cases) {
    assertEquals(scrubPaths(text), expected, text)
    assertEquals(scrubPaths(scrubPaths(text)), expected, 'scrubbing twice changes nothing')
  }
  assertMatch(scrubPaths('x /a/b/c y'), /^x <path> y$/)
})

test('scrubPaths: a folder with a space in it, a relative path, a home path and a file address are paths too, and no part of any is left', () => {
  // A space in a person's name is ordinary on a desktop (`/Users/Jane Doe`, `C:\Users\Jane Doe`): no pattern can tell where such a path
  // ends, so what the run was given is removed whole, and what it was not is cut by its shape.
  const cases: string[] = [
    'E could not open /srv/Jane Doe Home/scans/sessions/sess-abc/kf-00003.jpg: No such file',
    'failed (exit 1): mapper | cannot write "/srv/Jane Doe Home/scans/projects/proj-1/register-work/job-9/sparse"',
    'E database error: unable to open database file (C:\\Users\\Jane Doe\\scans\\projects\\proj-1\\db.db)',
    'E file:///srv/Jane Doe Home/scans/projects/proj-1/register-work/job-1/db.db could not be locked',
    'E could not read ./scans/sessions/sess-abc/kf-00003.jpg',
    'E could not read ~/scans/sessions/sess-abc/kf-00003.jpg',
    'E could not read ../../sessions/sess-abc/kf-00003.jpg',
    'E loading /srv/scans/projects/proj-1/register-work/job-9/db.db:42 failed',
    'E can\'t read \'/srv/My House/db.db\'',
    'E could not open "/srv/data/Jane Doe photo.jpg"',
    'E ERROR: img sess-abc/kf-00012.jpg (living room) has no features',
  ]
  const never = [/Jane/, /Doe/, /Home/, /My House/, /House/, /photo\.jpg/, /\bdata\b/, /sess-abc/, /kf-0000/, /kf-0001/, /scans/, /sessions/, /register-work/, /proj-1/, /\bsrv\b/, /Users/, /job-9/]
  for (const text of cases) {
    const scrubbed = scrubPaths(text)
    for (const pattern of never) assertFalse(pattern.test(scrubbed), `${pattern} is left in ${JSON.stringify(scrubbed)} (from ${JSON.stringify(text)})`)
  }
  // The words around a path stay.
  assertEquals(scrubPaths('E could not open /srv/Jane Doe Home/scans/sessions/sess-abc/kf-00003.jpg: No such file'), 'E could not open <path>: No such file')
  assertEquals(scrubPaths('E can\'t read \'/srv/My House/db.db\''), 'E can\'t read \'<path>\'')
  // A quoted path says where it ends, so a space in its last name is inside it.
  assertEquals(scrubPaths('E could not open "/srv/data/Jane Doe photo.jpg"'), 'E could not open "<path>"')
  assertEquals(scrubPaths('E ERROR: img sess-abc/kf-00012.jpg (living room) has no features'), 'E ERROR: img <path> (living room) has no features')

  // The folders a run was given are known, so they go whole, spaces and all, in any of the forms COLMAP writes them.
  const roots = ['/srv/Jane Doe Home/scans/sessions', 'C:\\Users\\Jane Doe\\scans']
  assertEquals(scrubPaths('open /srv/Jane Doe Home/scans/sessions/sess-abc/x.bin failed', roots), 'open <path> failed')
  assertEquals(scrubPaths('open file:///srv/Jane Doe Home/scans/sessions/sess-abc/x.bin failed', roots), 'open <path> failed')
  assertEquals(scrubPaths('open C:\\Users\\Jane Doe\\scans\\projects\\db.db failed', roots), 'open <path> failed')
  assertEquals(scrubPaths('the folder "/srv/Jane Doe Home/scans/sessions" is not there', roots), 'the folder "<path>" is not there')
  // A bare command name is not a folder: `colmap` in a sentence about colmap stays.
  assertEquals(scrubPaths('install colmap or set COLMAP_BIN', ['colmap']), 'install colmap or set COLMAP_BIN')
})
