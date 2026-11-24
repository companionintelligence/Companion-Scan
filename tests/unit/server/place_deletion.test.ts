/**
 * What deleting a Place has to look at besides its registry entry (server/place_deletion.ts), against real temporary
 * directories: the scans made from an upload that hold a Place, its reference photos, and its world with the export built
 * from it.
 *
 * What these hold: an upload scan with no GLB is counted as the Place's; the photos are removed as a folder and never
 * through a link or an id that is not a Place id; every world that says it is the Place's goes, with its export, and no
 * other (another Place's, the default world, a file that is not a world); the export goes before the world, so a failure
 * leaves a world that still names the Place; a removal waits for the world's lock; and a world that is not there is not an error.
 * For the world a merge leaves behind: only a world that says it is the merged-away Place's is looked at, one that still lists a
 * scan or has a job queued or running is held back and left as it is, one a scan's file is still behind is told from one nothing
 * moves, and a name in a world is never made into a path.
 *
 * tests/unit/server/keyframe_routes.test.ts runs the same functions through DELETE /projects/:id.
 */
import { assert, assertEquals, assertFalse, assertRejects } from './assert.ts'
import {
  placeWorldSlugs,
  removeLeftoverPlaceWorlds,
  removePlaceMedia,
  removePlaceWorlds,
  uploadScansOfPlace,
  worldHoldsScansOnDisk,
  worldIsInUse,
} from '../../../server/place_deletion.ts'
import { withWorldLock } from '../../../server/world/world_lock.ts'
import * as fs from 'node:fs/promises'
import { makeTempDir } from '../../../server/fs_util.ts'
import { test } from 'node:test'

const SESSION_A = 'sess-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'sess-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function withDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await makeTempDir({ prefix: 'place-deletion-' })
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true }).catch(() => undefined)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

async function names(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) found.push(entry.name)
  return found.sort()
}

async function writeWorld(worlds: string, slug: string, projectId: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(`${worlds}/${slug}.json`, JSON.stringify({ worldId: `world-${slug}`, shareSlug: slug, projectId, ...extra }))
}

// ── The scans made from an upload ───────────────────────────────────────────────

test('a scan made from an upload, with no GLB yet, is counted as its Place\'s, and one with a GLB is not counted here', async () => {
  await withDir(async (scans) => {
    await fs.writeFile(`${scans}/${SESSION_A}.json`, JSON.stringify({ sessionId: SESSION_A, projectId: 'proj-1' }))
    await fs.writeFile(`${scans}/${SESSION_B}.json`, JSON.stringify({ sessionId: SESSION_B, projectId: 'proj-2' }))
    // A scan that has its GLB is one of the Place's GLB scans, counted by the caller.
    await fs.writeFile(`${scans}/sess-cccccccc-cccc-4ccc-8ccc-cccccccccccc.json`, JSON.stringify({ projectId: 'proj-1' }))
    await fs.writeFile(`${scans}/sess-cccccccc-cccc-4ccc-8ccc-cccccccccccc.glb`, new Uint8Array(8))
    // Not a session id, not JSON, and not an object: none of them names a Place.
    await fs.writeFile(`${scans}/100_room.json`, JSON.stringify({ projectId: 'proj-1' }))
    await fs.writeFile(`${scans}/sess-dddddddd-dddd-4ddd-8ddd-dddddddddddd.json`, 'not json')
    await fs.writeFile(`${scans}/sess-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.json`, '[1,2]')
    assertEquals(await uploadScansOfPlace(scans, 'proj-1'), [`${SESSION_A}.glb`])
    assertEquals(await uploadScansOfPlace(scans, 'proj-2'), [`${SESSION_B}.glb`])
    assertEquals(await uploadScansOfPlace(scans, 'proj-3'), [])
  })
})

// ── Reference photos ────────────────────────────────────────────────────────────

test('a Place\'s reference photos are removed as a folder, and an id that is not a Place id removes nothing', async () => {
  await withDir(async (root) => {
    const media = `${root}/projects`
    await fs.mkdir(`${media}/proj-1`, { recursive: true })
    await fs.writeFile(`${media}/proj-1/ref-landmark.jpg`, 'photo')
    await fs.mkdir(`${media}/proj-2`, { recursive: true })
    await fs.mkdir(`${root}/victim`, { recursive: true })
    await fs.writeFile(`${root}/victim/keep.txt`, 'keep')
    for (const id of ['../victim', '..', '.', 'proj-../victim', 'other', '', 'proj-']) {
      assertEquals(await removePlaceMedia(media, id), false, `${JSON.stringify(id)} is not a Place`)
    }
    assert(await exists(`${root}/victim/keep.txt`))
    assertEquals(await removePlaceMedia(media, 'proj-1'), true)
    assertFalse(await exists(`${media}/proj-1`))
    assert(await exists(`${media}/proj-2`), 'another Place\'s photos are not touched')
    assertEquals(await removePlaceMedia(media, 'proj-1'), false, 'a Place with no photos is not an error')
  })
})

test('a Place\'s media folder that is a link is left, and what it points at is not removed', async () => {
  await withDir(async (root) => {
    const media = `${root}/projects`
    await fs.mkdir(media, { recursive: true })
    await fs.mkdir(`${root}/outside`, { recursive: true })
    await fs.writeFile(`${root}/outside/precious.txt`, 'precious')
    await fs.symlink(`${root}/outside`, `${media}/proj-1`)
    assertEquals(await removePlaceMedia(media, 'proj-1'), false)
    assert(await exists(`${root}/outside/precious.txt`))
    assert((await fs.lstat(`${media}/proj-1`)).isSymbolicLink())
  })
})

// ── The Place's world ───────────────────────────────────────────────────────────

test('every world that says it is the Place\'s goes with its export, and no other', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1', { name: 'My Home', originGeoPose: { lat: 51.5014, lng: -0.1419, address: '12 Secret Lane' } })
    await fs.writeFile(`${worlds}/project-proj-1.world.glb`, 'a copy of every scan')
    // A world an earlier build's merge re-labelled as the target's (this build's merge hands the scans over and removes the
    // merged-away Place's world instead): it says it is the target's, so it goes with the target, with its own export.
    await writeWorld(worlds, 'project-proj-9', 'proj-1')
    await fs.writeFile(`${worlds}/project-proj-9.world.glb`, 'its export')
    await writeWorld(worlds, 'project-proj-2', 'proj-2')
    await fs.writeFile(`${worlds}/project-proj-2.world.glb`, 'another Place\'s export')
    await writeWorld(worlds, 'default', null)
    await fs.writeFile(`${worlds}/default.world.glb`, 'the default export')
    await fs.writeFile(`${worlds}/project-proj-1.json.1234.tmp`, 'a write in progress')
    await fs.writeFile(`${worlds}/broken.json`, 'not json')
    await fs.writeFile(`${worlds}/list.json`, '[]')
    await fs.writeFile(`${worlds}/notes.txt`, 'notes')

    assertEquals(await removePlaceWorlds(worlds, 'proj-1'), 2)
    assertEquals(await names(worlds), [
      'broken.json',
      'default.json',
      'default.world.glb',
      'list.json',
      'notes.txt',
      'project-proj-1.json.1234.tmp',
      'project-proj-2.json',
      'project-proj-2.world.glb',
    ], 'the Place\'s two worlds and their exports are gone; another Place\'s, the default world and what is not a world are not')
    assertEquals(await removePlaceWorlds(worlds, 'proj-1'), 0, 'a second call finds nothing')
  })
})

test('a Place with no world, and a worlds folder that is not there, are not errors', async () => {
  await withDir(async (root) => {
    await fs.mkdir(`${root}/worlds`)
    assertEquals(await removePlaceWorlds(`${root}/worlds`, 'proj-1'), 0)
    assertEquals(await removePlaceWorlds(`${root}/no-such-folder`, 'proj-1'), 0)
  })
})

test('the export goes before the world, so a failure leaves a world that still names the Place, and a second try finishes', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1')
    // An export that is a folder with something in it cannot be removed as a file.
    await fs.mkdir(`${worlds}/project-proj-1.world.glb`)
    await fs.writeFile(`${worlds}/project-proj-1.world.glb/inside`, 'x')
    await assertRejects(() => removePlaceWorlds(worlds, 'proj-1'))
    assert(await exists(`${worlds}/project-proj-1.json`), 'the world is still here, so the Place can be found and deleted again')

    await fs.rm(`${worlds}/project-proj-1.world.glb`, { recursive: true })
    assertEquals(await removePlaceWorlds(worlds, 'proj-1'), 1)
    assertFalse(await exists(`${worlds}/project-proj-1.json`))
  })
})

test('a world is removed inside its lock, so a write to it cannot land after it has gone', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding!: () => void
    const entered = new Promise<void>((resolve) => {
      holding = resolve
    })
    // A world write in progress: the lock is held until the test lets go.
    const writing = withWorldLock('project-proj-1', async () => {
      holding()
      await held
    })
    await entered
    let removed = false
    const removing = removePlaceWorlds(worlds, 'proj-1').then((count) => {
      removed = true
      return count
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assertFalse(removed, 'the removal waits for the write in progress')
    assert(await exists(`${worlds}/project-proj-1.json`))
    release()
    await writing
    assertEquals(await removing, 1)
    assertFalse(await exists(`${worlds}/project-proj-1.json`))
  })
})

// ── The world a merge leaves behind ─────────────────────────────────────────────

test('the worlds that say they are a Place\'s are found by the id in the file, and no other file is looked at', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1')
    await writeWorld(worlds, 'old-name', 'proj-1')
    await writeWorld(worlds, 'project-proj-2', 'proj-2')
    await writeWorld(worlds, 'default', null)
    await fs.writeFile(`${worlds}/broken.json`, 'not json')
    await fs.writeFile(`${worlds}/list.json`, '[]')
    await fs.writeFile(`${worlds}/project-proj-1.world.glb`, 'an export is not a world')
    assertEquals((await placeWorldSlugs(worlds, 'proj-1')).sort(), ['old-name', 'project-proj-1'])
    assertEquals(await placeWorldSlugs(worlds, 'proj-2'), ['project-proj-2'])
    assertEquals(await placeWorldSlugs(worlds, '../worlds'), [], 'an id is compared with the id in a file, never made into a path')
    assertEquals(await placeWorldSlugs(`${worlds}/no-such-folder`, 'proj-1'), [])
  })
})

test('a world is in use while it lists a scan or has a job queued or running, and not for anything else it holds', () => {
  const finished = { status: 'completed' }
  assertEquals(worldIsInUse({ scans: [], jobs: [] }), false)
  assertEquals(worldIsInUse({}), false, 'a world file with neither list holds neither')
  assertEquals(worldIsInUse({ scans: [], jobs: [finished, { status: 'failed' }] }), false, 'a job that has finished is history')
  assertEquals(worldIsInUse({ scans: [{ filename: 'a.glb' }], jobs: [] }), true)
  assertEquals(worldIsInUse({ scans: [], jobs: [finished, { status: 'queued' }] }), true)
  assertEquals(worldIsInUse({ scans: [], jobs: [{ status: 'processing' }] }), true)
  assertEquals(worldIsInUse({ scans: [], things: [{ thingId: 't' }], members: [{ token: 'x' }], editPatches: [{ patchId: 'p' }], comments: [{ commentId: 'c' }], originGeoPose: { lat: 1, lng: 2 } }), false,
    'the Place\'s own things, tokens, placements, notes and location are what the removal is for')
  assertEquals(worldIsInUse({ scans: 'not a list', jobs: 'not a list' }), false)
})

test('a world that lists a scan whose GLB is on disk is told from one whose rows nothing moves, and a name in a world is never made into a path', async () => {
  await withDir(async (root) => {
    const scans = `${root}/scans`
    await fs.mkdir(scans)
    await fs.writeFile(`${scans}/100_room.glb`, new Uint8Array(8))
    // A file outside the scans folder that a name with a separator in it would reach.
    await fs.writeFile(`${root}/outside.glb`, new Uint8Array(8))
    assertEquals(await worldHoldsScansOnDisk({ scans: [{ filename: '100_room.glb' }] }, scans), true)
    assertEquals(await worldHoldsScansOnDisk({ scans: [{ filename: 'gone.glb' }, { filename: '100_room.glb' }] }, scans), true, 'one is enough')
    assertEquals(await worldHoldsScansOnDisk({ scans: [{ filename: 'gone.glb' }] }, scans), false, 'an upload with no GLB yet is not waiting for anything')
    assertEquals(await worldHoldsScansOnDisk({ scans: [] }, scans), false)
    assertEquals(await worldHoldsScansOnDisk({}, scans), false)
    for (const name of ['../outside.glb', '..\\outside.glb', '/etc/hostname', '.hidden.glb', 'a\u0000.glb', 'outside.json', '', 7, null]) {
      assertEquals(await worldHoldsScansOnDisk({ scans: [{ filename: name }] }, scans), false, `${JSON.stringify(name)} is not a scan name`)
    }
  })
})

test('a merged-away Place\'s world goes with its export unless it is held back, and what is held back is left as it was, and counted', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1', { name: 'My Home', scans: [], jobs: [] })
    await fs.writeFile(`${worlds}/project-proj-1.world.glb`, 'a copy of every scan')
    await writeWorld(worlds, 'old-name', 'proj-1', { scans: [{ filename: '100_room.glb' }], jobs: [] })
    await fs.writeFile(`${worlds}/old-name.world.glb`, 'its export')
    await writeWorld(worlds, 'project-proj-2', 'proj-2', { scans: [], jobs: [] })
    await fs.writeFile(`${worlds}/project-proj-2.world.glb`, 'another Place\'s export')
    await writeWorld(worlds, 'default', null, { scans: [], jobs: [] })
    const before = await fs.readFile(`${worlds}/old-name.json`, 'utf8')

    assertEquals(await removeLeftoverPlaceWorlds(worlds, 'proj-1', worldIsInUse), { removed: 1, kept: 1, placementsRemoved: 0 })
    assertEquals(await names(worlds), [
      'default.json',
      'old-name.json',
      'old-name.world.glb',
      'project-proj-2.json',
      'project-proj-2.world.glb',
    ], 'the empty world and its export are gone; the one that lists a scan is as it was, with its export; another Place\'s and the default world are not touched')
    assertEquals(await fs.readFile(`${worlds}/old-name.json`, 'utf8'), before)
    assertEquals(await removeLeftoverPlaceWorlds(worlds, 'proj-1', worldIsInUse), { removed: 0, kept: 1, placementsRemoved: 0 }, 'asked again, it is still held back')
    assertEquals(await removeLeftoverPlaceWorlds(worlds, 'proj-1', () => false), { removed: 1, kept: 0, placementsRemoved: 0 }, 'and goes when nothing holds it back')
    assertEquals(await removeLeftoverPlaceWorlds(`${worlds}/no-such-folder`, 'proj-1', worldIsInUse), { removed: 0, kept: 0, placementsRemoved: 0 })
  })
})

/** A placement set by hand over a whole scan, as the editor writes one: moved 2.5 m east and 1 m south. */
const placement = (patchId: string, name: string): Record<string, unknown> => ({
  patchId,
  scanId: `scan-${name}`,
  targetId: `${name}.glb`,
  scope: 'scan',
  transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 0, -1, 1] },
})

test('the placements set by hand over a scan that a removed world held are counted, from the world as its file held it, and nothing else is', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1', {
      scans: [],
      editPatches: [
        placement('p-hall', '100_hall'),
        placement('p-kitchen', '100_kitchen'),
        // Not placements: a note on a scan, a Thing's relabel, a note on the whole world, a scan patch with no matrix.
        { patchId: 'p-note', scanId: 'scan-100_hall', targetId: '100_hall.glb', scope: 'scan', notes: 'dark corner' },
        { patchId: 'p-vase', targetId: 'thing-1', scope: 'thing', label: 'a vase' },
        { patchId: 'p-world', scope: 'world', notes: 'the whole Place' },
        { patchId: 'p-bare', scanId: 'scan-100_hall', targetId: '100_hall.glb', scope: 'scan', transform: {} },
        // Entries that are not patches at all are not read as one, and do not stop the count.
        null,
        'junk',
        4,
      ],
    })
    await fs.writeFile(`${worlds}/project-proj-1.world.glb`, 'its export')
    await writeWorld(worlds, 'project-proj-2', 'proj-2', { scans: [], editPatches: [placement('p-other', '200_a')] })
    await writeWorld(worlds, 'default', null, { scans: [], editPatches: [placement('p-default', '300_b')] })
    assertEquals(
      await removeLeftoverPlaceWorlds(worlds, 'proj-1', worldIsInUse),
      { removed: 1, kept: 0, placementsRemoved: 2 },
      'the hall\'s and the kitchen\'s placements: what the world kept for scans that were moved out of it',
    )
    assertEquals(await names(worlds), ['default.json', 'project-proj-2.json'], 'another Place\'s world and the default world are not touched, so their placements are not counted')
  })
})

test('the placements of a world that is held back are not counted: it is as it was and still holds them, and a world that is removed later counts them', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1', {
      scans: [{ filename: '100_hall.glb' }],
      editPatches: [placement('p-hall', '100_hall')],
    })
    assertEquals(await removeLeftoverPlaceWorlds(worlds, 'proj-1', worldIsInUse), { removed: 0, kept: 1, placementsRemoved: 0 })
    assertEquals(JSON.parse(await fs.readFile(`${worlds}/project-proj-1.json`, 'utf8')).editPatches.length, 1, 'the placement is still there')
    // The scan is handed over later, and the world, which is not in use now, goes with what it still holds.
    await writeWorld(worlds, 'project-proj-1', 'proj-1', { scans: [], editPatches: [placement('p-hall', '100_hall')] })
    assertEquals(await removeLeftoverPlaceWorlds(worlds, 'proj-1', worldIsInUse), { removed: 1, kept: 0, placementsRemoved: 1 })
  })
})

test('what holds a world back is asked of the world as its file holds it, inside the world\'s lock', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1', { scans: [] })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding!: () => void
    const entered = new Promise<void>((resolve) => {
      holding = resolve
    })
    const writing = withWorldLock('project-proj-1', async () => {
      holding()
      await held
      // A write that lands before the removal looks: a scan the hand-over has put back.
      await writeWorld(worlds, 'project-proj-1', 'proj-1', { scans: [{ filename: '100_room.glb' }] })
    })
    await entered
    const asked: unknown[] = []
    const removing = removeLeftoverPlaceWorlds(worlds, 'proj-1', (world) => {
      asked.push(world['scans'])
      return worldIsInUse(world)
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assertEquals(asked, [], 'nothing is asked while the world is being written')
    release()
    await writing
    assertEquals(await removing, { removed: 0, kept: 1, placementsRemoved: 0 }, 'the world that was written is the one that was judged')
    assertEquals(asked, [[{ filename: '100_room.glb' }]])
    assert(await exists(`${worlds}/project-proj-1.json`))
  })
})

test('a merged-away Place\'s world whose export cannot be removed is thrown, and the world stays to be found again', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1', { scans: [], jobs: [] })
    await fs.mkdir(`${worlds}/project-proj-1.world.glb`)
    await fs.writeFile(`${worlds}/project-proj-1.world.glb/inside`, 'x')
    await assertRejects(() => removeLeftoverPlaceWorlds(worlds, 'proj-1', worldIsInUse))
    assert(await exists(`${worlds}/project-proj-1.json`), 'the world still names the Place')
    await fs.rm(`${worlds}/project-proj-1.world.glb`, { recursive: true })
    assertEquals(await removeLeftoverPlaceWorlds(worlds, 'proj-1', worldIsInUse), { removed: 1, kept: 0, placementsRemoved: 0 })
  })
})
