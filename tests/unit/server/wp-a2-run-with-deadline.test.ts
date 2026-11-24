/**
 * WP-A2 (F12, F23, F29, F36): the deadline helper every WorldJob child runs
 * under. A child that never exits must be killed and reported as a timeout, and
 * a child that finishes must come back exactly as `output()` would return it.
 *
 * Run: node --test tests/unit/server/wp-a2-run-with-deadline.test.ts
 */
import { assert } from './assert.ts'
import { assertEquals } from './assert.ts'
import { assertRejects } from './assert.ts'
import { assertStringIncludes } from './assert.ts'
import {
  budgetFromEnv,
  describeBudget,
  runWithDeadline,
} from '../../../server/run_with_deadline.ts'
import { runCapture } from '../../../server/capabilities.ts'
import { whichPath } from '../../../server/exec_probe.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'
import { makeTempDir } from '../../../server/fs_util.ts'
import { runCommand } from '../../../server/subprocess.ts'

const SLEEP = await whichPath('sleep')
const ECHO = await whichPath('echo')
const SH = await whichPath('sh')
const isWindows = process.platform === 'win32'

test('runWithDeadline: a child that never exits is SIGKILLed and reports the timeout', { skip: isWindows || SLEEP === null }, async () => {
    const started = performance.now()
    const out = await runWithDeadline(SLEEP!, { args: ['60'], stdout: 'piped', stderr: 'piped' }, 300)
    const took = performance.now() - started
    assertEquals(out.timeoutReason, 'timed out after 300 ms')
    assertEquals(out.success, false)
    assertEquals(out.signal, 'SIGKILL')
    assert(took < 5_000, `returned after ${took}ms, so the child was not killed promptly`)
  })

test('runWithDeadline: a child that finishes in time keeps its output and status, with no timeout reason', { skip: isWindows || ECHO === null }, async () => {
    const out = await runWithDeadline(ECHO!, { args: ['hello'], stdout: 'piped', stderr: 'piped' }, 5_000)
    assertEquals(out.timeoutReason, null)
    assertEquals(out.success, true)
    assertEquals(out.code, 0)
    assertEquals(new TextDecoder().decode(out.stdout), 'hello\n')
  })

test('runWithDeadline: a child with a non-zero exit is still a plain failure, not a timeout', { skip: isWindows || SH === null }, async () => {
    const out = await runWithDeadline(SH!, { args: ['-c', 'exit 3'], stdout: 'piped', stderr: 'piped' }, 5_000)
    assertEquals(out.timeoutReason, null)
    assertEquals(out.code, 3)
    assertEquals(out.success, false)
  })

test('runWithDeadline: a killed launcher whose grandchild holds the pipe is returned after the grace period', { skip: isWindows || SH === null }, async () => {
    const dir = await makeTempDir({ prefix: 'wp-a2-deadline-' })
    const pidFile = `${dir}/grandchild.pid`
    try {
      const started = performance.now()
      const out = await runWithDeadline(
        SH!,
        { args: ['-c', `sleep 60 & echo $! > '${pidFile}'; wait`], stdout: 'piped', stderr: 'piped' },
        300,
        200,
      )
      const took = performance.now() - started
      assertEquals(out.timeoutReason, 'timed out after 300 ms')
      assertEquals(out.success, false)
      assert(took < 5_000, `returned after ${took}ms; the helper waited on a pipe it should have given up on`)
    } finally {
      // The grandchild is not ours to leave behind.
      try {
        const pid = (await fs.readFile(pidFile, 'utf8')).trim()
        await runCommand('kill', { args: ['-9', pid], stdout: 'null', stderr: 'null' })
      } catch {
        // Already gone, or never started.
      }
      await fs.rm(dir, { recursive: true })
    }
  })

test('runWithDeadline: a binary that cannot be spawned throws, as output() does', async () => {
    await assertRejects(
      () => runWithDeadline('/definitely/not/a/real/binary', { args: [], stdout: 'piped', stderr: 'piped' }, 1_000),
    )
  })

test('runCapture keeps its contract: a timed-out probe reports the timeout in stderr', { skip: isWindows || SLEEP === null }, async () => {
    const out = await runCapture(SLEEP!, ['60'], 200)
    assert(out !== null)
    assertEquals(out.stderr, 'timed out after 200 ms')
  })

test('runCapture: a binary that cannot be spawned is still null after the refactor', async () => {
  assertEquals(await runCapture('/definitely/not/a/real/binary', [], 1_000), null)
})

test('describeBudget: budgets read as hours, minutes, seconds or milliseconds', () => {
  assertEquals(describeBudget(10_800_000), '3 h')
  assertEquals(describeBudget(1_800_000), '30 min')
  assertEquals(describeBudget(90_000), '1.5 min')
  assertEquals(describeBudget(2_500), '2.5 s')
  assertEquals(describeBudget(200), '200 ms')
})

test('budgetFromEnv: an unset, unparseable or non-positive value takes the default', () => {
  const name = 'WP_A2_TEST_BUDGET_MS'
  const previous = process.env[name]
  try {
    delete process.env[name]
    assertEquals(budgetFromEnv(name, 777), 777)
    process.env[name] = 'not-a-number'
    assertEquals(budgetFromEnv(name, 777), 777)
    process.env[name] = '0'
    assertEquals(budgetFromEnv(name, 777), 777)
    process.env[name] = '-5'
    assertEquals(budgetFromEnv(name, 777), 777)
    process.env[name] = '1234.9'
    assertEquals(budgetFromEnv(name, 777), 1234)
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('budgetFromEnv: a budget past the longest timer is capped, not turned into an immediate kill', () => {
  const name = 'WP_A2_TEST_BUDGET_HUGE_MS'
  const previous = process.env[name]
  try {
    process.env[name] = '99999999999999'
    assertEquals(budgetFromEnv(name, 777), 2_147_483_647)
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('runWithDeadline: the timeout reason names the budget the stage was given', { skip: isWindows || SLEEP === null }, async () => {
    const out = await runWithDeadline(SLEEP!, { args: ['60'], stdout: 'piped', stderr: 'piped' }, 1_500)
    assertStringIncludes(out.timeoutReason ?? '', '1.5 s')
  })
