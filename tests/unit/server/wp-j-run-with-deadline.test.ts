/**
 * WP-J (J9): runWithDeadline copies its result without throwing when a child's
 * stream was not piped, and the timeout reason is reported for a child killed
 * with its streams unpiped. The header's claim about output after the grace
 * period is checked too: a child whose pipes stay open returns empty output.
 *
 * Run: node --test tests/unit/server/wp-j-run-with-deadline.test.ts
 */
import { assertEquals } from './assert.ts'
import { assertStringIncludes } from './assert.ts'
import { runWithDeadline } from '../../../server/run_with_deadline.ts'
import { whichPath } from '../../../server/exec_probe.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'
import { makeTempDir } from '../../../server/fs_util.ts'
import { runCommand } from '../../../server/subprocess.ts'

const SH = await whichPath('sh')
const SLEEP = await whichPath('sleep')
const isWindows = process.platform === 'win32'

test('runWithDeadline: a child with unpiped streams returns its exit code, not a throw', { skip: isWindows || SH === null }, async () => {
    const out = await runWithDeadline(SH!, { args: ['-c', 'exit 3'], stdout: 'null', stderr: 'null' }, 5_000)
    assertEquals(out.code, 3)
    assertEquals(out.success, false)
    assertEquals(out.timeoutReason, null)
    assertEquals(out.stdout.length, 0)
    assertEquals(out.stderr.length, 0)
  })

test('runWithDeadline: a piped child keeps its output and its exit code', { skip: isWindows || SH === null }, async () => {
    const out = await runWithDeadline(SH!, { args: ['-c', 'echo out; echo err >&2; exit 4'], stdout: 'piped', stderr: 'piped' }, 5_000)
    assertEquals(out.code, 4)
    assertEquals(new TextDecoder().decode(out.stdout), 'out\n')
    assertEquals(new TextDecoder().decode(out.stderr), 'err\n')
    assertEquals(out.timeoutReason, null)
  })

test('runWithDeadline: a child killed at the deadline with unpiped streams reports the timeout, not a throw', { skip: isWindows || SLEEP === null }, async () => {
    const out = await runWithDeadline(SLEEP!, { args: ['30'], stdout: 'null', stderr: 'null' }, 100)
    assertStringIncludes(out.timeoutReason ?? '', 'timed out after 100 ms')
    assertEquals(out.success, false)
  })

test('runWithDeadline: a child whose pipes stay open past the grace period returns empty output with the reason', { skip: isWindows || SH === null }, async () => {
    const dir = await makeTempDir({ prefix: 'wp-j-deadline-' })
    const pidFile = `${dir}/grandchild.pid`
    try {
      // Output written before the kill is lost once the helper stops waiting (see its header).
      const out = await runWithDeadline(
        SH!,
        { args: ['-c', `echo before-kill; sleep 60 & echo $! > '${pidFile}'; wait`], stdout: 'piped', stderr: 'piped' },
        300,
        100,
      )
      assertStringIncludes(out.timeoutReason ?? '', 'timed out after 300 ms')
      assertEquals(out.code, 137)
      assertEquals(out.stdout.length, 0, 'output from before the kill was returned after the grace period')
    } finally {
      try {
        const pid = (await fs.readFile(pidFile, 'utf8')).trim()
        await runCommand('kill', { args: ['-9', pid], stdout: 'null', stderr: 'null' })
      } catch {
        // Already gone, or never started.
      }
      await fs.rm(dir, { recursive: true })
    }
  })
