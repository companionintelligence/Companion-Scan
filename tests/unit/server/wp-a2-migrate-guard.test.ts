/**
 * WP-A2 (F25): migrate_scan_ids must not clear session links on a guess. A
 * missing sessions directory, or a run that would clear more links than the
 * limit, is refused before the first write. A changed world is backed up first.
 *
 * Run: node --test tests/unit/server/wp-a2-migrate-guard.test.ts
 */
import { assert } from './assert.ts'
import { assertEquals } from './assert.ts'
import { assertRejects } from './assert.ts'
import {
  migrateScanIds,
  SESSION_CLEAR_LIMIT,
} from '../../../server/migrations/migrate_scan_ids.ts'
import type { ScanManifest, WorldProject } from '../../../src/world/types.ts'
import * as fs from 'node:fs/promises'
import { makeTempDir } from '../../../server/fs_util.ts'
import { test } from 'node:test'

const FIXTURE_URL = new URL('tests/fixtures/world-scan-id-collision.json', new URL('../../../', import.meta.url))

async function fixtureText(): Promise<string> {
  return await fs.readFile(FIXTURE_URL, 'utf8')
}

/**
 * A world of `count` scans, each holding its own phantom session link. Built
 * from the fixture world so every other field has its real shape.
 */
async function phantomWorld(count: number): Promise<WorldProject> {
  const base = JSON.parse(await fixtureText()) as WorldProject
  const template: ScanManifest = base.scans[0]
  const scans = Array.from({ length: count }, (_, i): ScanManifest => ({
    ...template,
    filename: `${1_787_000_000_000 + i}_phantom-${i}.glb`,
    scanId: `scan-phantom-${i}`,
    sessionId: `sess-phantom-${i}`,
    frameSetUrl: undefined,
  }))
  return { ...base, worldId: 'world-phantoms', shareSlug: 'phantoms', scans, editPatches: [], jobs: [] }
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir({ prefix: 'wp-a2-migrate-' })
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true })
  }
}

async function backupDirsIn(worldsDir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(worldsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('.pre-migrate-')) found.push(entry.name)
  }
  return found
}

test('migrateScanIds guard: a missing sessions directory is refused, and nothing is written', async () => {
  await withDir(async (dir) => {
    const worldPath = `${dir}/default.json`
    const original = await fixtureText()
    await fs.writeFile(worldPath, original)

    await assertRejects(
      () => migrateScanIds({ worldsDir: dir, sessionsDir: `${dir}/no-such-sessions`, log: () => {} }),
      Error,
      'does not exist',
    )

    assertEquals(await fs.readFile(worldPath, 'utf8'), original, 'the world file was rewritten')
    assertEquals(await backupDirsIn(dir), [], 'a backup was made for a run that was refused')
  })
})

test('migrateScanIds guard: a missing sessions directory is fine when no world holds a session link', async () => {
  await withDir(async (dir) => {
    const world = JSON.parse(await fixtureText()) as WorldProject
    for (const scan of world.scans) scan.sessionId = null
    await fs.writeFile(`${dir}/default.json`, JSON.stringify(world, null, 2))

    const summary = await migrateScanIds({ worldsDir: dir, sessionsDir: `${dir}/no-such-sessions`, log: () => {} })

    assertEquals(summary.worlds.length, 1)
    assertEquals(summary.worlds[0].sessionsCleared.length, 0)
  })
})

test('migrateScanIds guard: clearing more links than the limit is refused without forceClear', async () => {
  await withDir(async (dir) => {
    const worldPath = `${dir}/phantoms.json`
    const original = JSON.stringify(await phantomWorld(SESSION_CLEAR_LIMIT + 2), null, 2)
    await fs.writeFile(worldPath, original)
    const sessionsDir = `${dir}/sessions`
    await fs.mkdir(sessionsDir)

    await assertRejects(
      () => migrateScanIds({ worldsDir: dir, sessionsDir, log: () => {} }),
      Error,
      '--force-clear',
    )

    assertEquals(await fs.readFile(worldPath, 'utf8'), original, 'the world file was rewritten')
    assertEquals(await backupDirsIn(dir), [], 'a backup was made for a run that was refused')
  })
})

test('migrateScanIds guard: forceClear allows the run, and the backup holds the bytes from before it', async () => {
  await withDir(async (dir) => {
    const worldPath = `${dir}/phantoms.json`
    const original = JSON.stringify(await phantomWorld(SESSION_CLEAR_LIMIT + 2), null, 2)
    await fs.writeFile(worldPath, original)
    const sessionsDir = `${dir}/sessions`
    await fs.mkdir(sessionsDir)

    const summary = await migrateScanIds({ worldsDir: dir, sessionsDir, forceClear: true, log: () => {} })

    assertEquals(summary.filesWritten, 1)
    const migrated = JSON.parse(await fs.readFile(worldPath, 'utf8')) as WorldProject
    for (const scan of migrated.scans) assertEquals(scan.sessionId, null)

    const backups = await backupDirsIn(dir)
    assertEquals(backups.length, 1)
    assertEquals(
      await fs.readFile(`${dir}/${backups[0]}/phantoms.json`, 'utf8'),
      original,
      'the backup does not hold the world as it was before the run',
    )
  })
})

test('migrateScanIds guard: a backup is written only by a run that changes something', async () => {
  await withDir(async (dir) => {
    const fixture = await fixtureText()
    await fs.writeFile(`${dir}/default.json`, fixture)

    const first = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(first.filesWritten, 1)
    assertEquals((await backupDirsIn(dir)).length, 1)

    const second = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(second.filesWritten, 0)
    assertEquals((await backupDirsIn(dir)).length, 1, 'a no-op run made a second backup')
  })
})

test('migrateScanIds guard: the backup directory is not read as a world', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(`${dir}/default.json`, await fixtureText())
    await migrateScanIds({ worldsDir: dir, log: () => {} })
    assert((await backupDirsIn(dir)).length === 1)

    const again = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(again.worlds.map((w) => w.slug), ['default'])
  })
})
