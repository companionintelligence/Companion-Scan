/**
 * FN-118: text that reaches a client names no server path (server/wp-a-log.ts withoutServerPaths).
 *
 * A file error's message names the path it failed on. The error replies are generic now (app.onError and the routes'
 * own 500s), and the text that is still worth sending (an ingest script's stderr, a job's error) has its paths cut to
 * file names. The whole message stays in the server log.
 *
 *   node --test tests/unit/server/server_core_paths.test.ts
 */
import { assert, assertEquals, assertFalse } from './assert.ts'
import { withoutServerPaths } from '../../../server/wp-a-log.ts'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('paths: a file error keeps its words and loses its folders', () => {
  assertEquals(
    withoutServerPaths("No such file or directory (os error 2): readfile '/srv/scan/scans/a.glb'"),
    "No such file or directory (os error 2): readfile 'a.glb'",
  )
  assertEquals(withoutServerPaths('spawn /usr/bin/python3 ENOENT'), 'spawn python3 ENOENT')
  assertEquals(withoutServerPaths('ffprobe failed on /tmp/x/scans/tmp/ingest-1.mp4: Invalid data'), 'ffprobe failed on ingest-1.mp4: Invalid data')
  assertEquals(withoutServerPaths('open C:\\Users\\someone\\scans\\a.glb failed'), 'open a.glb failed')
  assertEquals(withoutServerPaths('path=/var/lib/scan/worlds/default.json'), 'path=default.json')
})

test('paths: what is not a server path is left alone', () => {
  for (const text of [
    'Gaussian splat trained with Brush.',
    'see https://example.com/docs/setup for the fix',
    'relative/name.glb was not found',
    'exit 1 after 3s',
    'set BRUSH_BIN, then retry',
    '/tmp alone',
  ]) {
    assertEquals(withoutServerPaths(text), text, text)
  }
})

test('paths: main.ts cuts paths from job errors and ingest details, and its 500s are generic', async () => {
  const main = await fs.readFile(fileURLToPath(new URL('server/main.ts', REPO_ROOT)), 'utf8')
  assert(main.includes('return withoutServerPaths(err instanceof Error ? err.message : String(err))'), 'errorMessage')
  assert(main.includes("if (job.error) job.error = withoutServerPaths(job.error)"), 'commitWorldJob')
  assertEquals((main.match(/detail: withoutServerPaths\(stderr/g) ?? []).length, 2, 'both ingest scripts')
  assertFalse(/error: String\(err\)/.test(main), 'no reply echoes an error')
  assertFalse(/error: err\.message/.test(main), 'no reply echoes an error message')
})
