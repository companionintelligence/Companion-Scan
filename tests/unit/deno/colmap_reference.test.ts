/**
 * The spawn the photo method gives COLMAP (server/colmap/colmap_reference.ts `deadlineSpawn`), against a REAL child process. The
 * method's own tests (place_register_sfm.test.ts) replace the spawn, which is right for what they test and leaves two promises of this one
 * unchecked: the GPU is hidden from the child, and a child still running at the wall clock is killed. A COLMAP built with CUDA would use
 * a card other services hold for any step that did not say `use_gpu 0`, and a step that outlived the limit would hold the pump's one slot.
 *
 * The child is `/bin/sh`, so these do not run on Windows (the server's tests do not either: they spawn the real server on a port).
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import { deadlineSpawn, startWallClock } from '../../../server/colmap/colmap_reference.ts'

const ignore = Deno.build.os === 'windows'

Deno.test({
  name: 'a real child is started with no GPU visible: CUDA_VISIBLE_DEVICES is set, and empty',
  ignore,
  fn: async () => {
    const spawn = deadlineSpawn(startWallClock(60_000), 60_000)
    const set = await spawn('/bin/sh', ['-c', '[ "${CUDA_VISIBLE_DEVICES+set}" = set ] && [ -z "$CUDA_VISIBLE_DEVICES" ]'])
    assertEquals(set.code, 0, 'the variable is there and empty')
    // A child that checks for any other value fails, so the answer above is not "always zero".
    const wrong = await spawn('/bin/sh', ['-c', '[ "$CUDA_VISIBLE_DEVICES" = "0" ]'])
    assertEquals(wrong.code, 1)
  },
})

Deno.test({
  name: 'a real child still running at the wall clock is killed, and the answer says it timed out',
  ignore,
  fn: async () => {
    const started = Date.now()
    const spawn = deadlineSpawn(startWallClock(300), 60_000)
    const out = await spawn('/bin/sh', ['-c', 'exec sleep 30'])
    assert(Date.now() - started < 10_000, `the child was waited for ${Date.now() - started} ms`)
    assert(/timed out/.test(out.timeoutReason ?? ''), `timeoutReason: ${out.timeoutReason}`)
  },
})

Deno.test({
  name: 'a step has a budget of its own, and the smaller of it and the wall clock applies',
  ignore,
  fn: async () => {
    const started = Date.now()
    const spawn = deadlineSpawn(startWallClock(60_000), 300)
    const out = await spawn('/bin/sh', ['-c', 'exec sleep 30'])
    assert(Date.now() - started < 10_000)
    assert(/timed out/.test(out.timeoutReason ?? ''), `timeoutReason: ${out.timeoutReason}`)
  },
})

Deno.test('no command starts after the wall clock has passed, and nothing is run', async () => {
  let now = 1_000
  const clock = startWallClock(500, () => now)
  now = 2_000
  let ran = false
  const spawn = deadlineSpawn(clock, 60_000, () => {
    ran = true
    return Promise.resolve({ code: 0, stderr: '' })
  })
  const out = await spawn('colmap', ['mapper'])
  assertEquals(ran, false)
  assert(/timed out/.test(out.timeoutReason ?? ''), `timeoutReason: ${out.timeoutReason}`)
  assertEquals(out.code, 1)
})

Deno.test('a replaced spawn that never answers is waited for no longer than the limit', async () => {
  const spawn = deadlineSpawn(startWallClock(150), 60_000, () => new Promise(() => {}))
  const started = Date.now()
  const out = await spawn('colmap', ['mapper'])
  assert(Date.now() - started < 5_000)
  assert(/timed out/.test(out.timeoutReason ?? ''), `timeoutReason: ${out.timeoutReason}`)
})

Deno.test('a replaced spawn that answers in time is passed through whole', async () => {
  const spawn = deadlineSpawn(startWallClock(60_000), 60_000, () => Promise.resolve({ code: 3, stderr: 'E no model' }))
  assertEquals(await spawn('colmap', ['mapper']), { code: 3, stderr: 'E no model' })
})
