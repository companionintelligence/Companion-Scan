/**
 * WP-J (J8): a PATH probe for `colmap -h` that runs out of time is reported as a
 * timeout, not as a missing binary, and the skip reason says so.
 *
 * Run: node --test tests/unit/server/wp-j-colmap-probe.test.ts
 */
import { assert } from './assert.ts'
import { assertEquals } from './assert.ts'
import { assertStringIncludes } from './assert.ts'
import { colmapNotFoundSkip, locateColmapBin } from '../../../server/colmap/colmap_poses.ts'
import { whichPath } from '../../../server/exec_probe.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'
import { makeTempDir } from '../../../server/fs_util.ts'

const SLEEP = await whichPath('sleep')
const SH = await whichPath('sh')
const isWindows = process.platform === 'win32'

test('colmap probe: a `colmap -h` that never answers is timed out, and is not reported as missing', { skip: isWindows || SLEEP === null }, async () => {
    const root = await makeTempDir({ prefix: 'wp-j-colmap-' })
    const previousPath = process.env.PATH ?? ''
    try {
      // A stand-in `colmap` that hangs. It is first on PATH for this test only.
      const bin = `${root}/colmap`
      await fs.writeFile(bin, `#!/bin/sh\nexec ${SLEEP} 30\n`)
      await fs.chmod(bin, 0o755)
      process.env.PATH = `${root}:${previousPath}`

      const started = performance.now()
      const located = await locateColmapBin('colmap', 100)
      const took = performance.now() - started

      assertEquals(located.pathProbe, 'timed-out')
      assert(took < 10_000, `took ${took}ms; the probe was not bounded`)
      const skip = colmapNotFoundSkip('colmap', located.pathProbe)
      assertStringIncludes(skip.skippedReason, 'probe timed out')
      assert(!skip.skippedReason.includes('not found'), 'a timed-out probe was reported as a missing binary')
    } finally {
      process.env.PATH = previousPath
      await fs.rm(root, { recursive: true })
    }
  })

test('colmap probe: a colmap on PATH that answers `-h` is found, and the probe does not throw', { skip: isWindows || SH === null }, async () => {
    // The probe discards the child's output (stdout and stderr are not piped). That used to
    // make the probe throw, so a colmap on PATH was never found.
    const root = await makeTempDir({ prefix: 'wp-j-colmap-' })
    const previousPath = process.env.PATH ?? ''
    try {
      const bin = `${root}/colmap`
      await fs.writeFile(bin, `#!${SH}\nexit 0\n`)
      await fs.chmod(bin, 0o755)
      process.env.PATH = `${root}:${previousPath}`

      const located = await locateColmapBin('colmap', 5_000)

      assertEquals(located.pathProbe, 'found')
      // The absolute path the shared resolver found on PATH, the same one GET /capabilities reports, rather than
      // the bare name (wave 14-0002).
      assertEquals(located.bin, bin)
    } finally {
      process.env.PATH = previousPath
      await fs.rm(root, { recursive: true })
    }
  })

test('colmap probe: a binary that is simply absent is still reported as not found', () => {
  const skip = colmapNotFoundSkip('colmap', 'missing')
  assertStringIncludes(skip.skippedReason, 'not found')
  assert(!skip.skippedReason.includes('timed out'))
  assertStringIncludes(skip.remediation, 'COLMAP_BIN')
})

test('colmap probe: an explicitly named binary that is not runnable keeps its plain not-found reason', () => {
  const skip = colmapNotFoundSkip('/opt/no-such/colmap', 'not-tried')
  assertEquals(skip.skippedReason, 'COLMAP binary not found: /opt/no-such/colmap')
})
