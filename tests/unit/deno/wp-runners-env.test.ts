/**
 * Wave 14-0002 (F-43): one rounding rule for the runners' env knobs.
 *
 * `intFromEnv` had five copies with two rules. Three tested `n > 0` before
 * flooring, so 0.5 passed and became 0; COLMAP's used `parseInt`, so `12abc`
 * read as 12. The rule now is person_4d's, the one that was tested: round down,
 * then keep a finite value of at least 1. `numFromEnv` admits zero and
 * fractions, for COLMAP's thresholds and `COLMAP_MIN_POINTS3D=0`.
 *
 * Run: deno test --allow-env tests/unit/deno/wp-runners-env.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { intFromEnv, isValidSessionDir, numFromEnv } from '../../../server/run_with_deadline.ts'
import { isValidSessionDir as viaTrain } from '../../../server/splat/splat_train.ts'
import { isValidSessionDir as viaLingbot } from '../../../server/lingbot-map/lingbot_map.ts'
import { isValidSessionDir as viaColmap } from '../../../server/colmap/colmap_poses.ts'
import { isValidSessionDir as viaAlign } from '../../../server/splat/splat_align.ts'
import { isValidSessionDir as viaDetect } from '../../../server/splat/splat_detect.ts'

const NAME = 'WP_RUNNERS_ENV_TEST_KNOB'

function withEnv(value: string | undefined, fn: () => void): void {
  if (value === undefined) Deno.env.delete(NAME)
  else Deno.env.set(NAME, value)
  try {
    fn()
  } finally {
    Deno.env.delete(NAME)
  }
}

Deno.test('intFromEnv: whole numbers are kept, and fractions are rounded down first', () => {
  withEnv('12', () => assertEquals(intFromEnv(NAME, 7), 12))
  withEnv('12.9', () => assertEquals(intFromEnv(NAME, 7), 12))
  withEnv(' 3 ', () => assertEquals(intFromEnv(NAME, 7), 3))
  withEnv('1e3', () => assertEquals(intFromEnv(NAME, 7), 1000))
})

Deno.test('intFromEnv: a value that rounds below one takes the default, never 0', () => {
  // 0.5 used to pass `> 0` in three runners and floor to 0 iterations.
  withEnv('0.5', () => assertEquals(intFromEnv(NAME, 7), 7))
  withEnv('0', () => assertEquals(intFromEnv(NAME, 7), 7))
  withEnv('-4', () => assertEquals(intFromEnv(NAME, 7), 7))
})

Deno.test('intFromEnv: text that is not a number takes the default', () => {
  // COLMAP's parseInt read this as 12.
  withEnv('12abc', () => assertEquals(intFromEnv(NAME, 7), 7))
  withEnv('Infinity', () => assertEquals(intFromEnv(NAME, 7), 7))
  withEnv('', () => assertEquals(intFromEnv(NAME, 7), 7))
  withEnv('   ', () => assertEquals(intFromEnv(NAME, 7), 7))
  withEnv(undefined, () => assertEquals(intFromEnv(NAME, 7), 7))
})

Deno.test('numFromEnv: zero and fractions are kept; negatives, text and blanks take the default', () => {
  withEnv('0', () => assertEquals(numFromEnv(NAME, 0.6), 0))
  withEnv('0.25', () => assertEquals(numFromEnv(NAME, 0.6), 0.25))
  withEnv('-1', () => assertEquals(numFromEnv(NAME, 0.6), 0.6))
  withEnv('0.6abc', () => assertEquals(numFromEnv(NAME, 0.6), 0.6))
  // Number(' ') is 0, which used to make a blank value a zero threshold.
  withEnv('  ', () => assertEquals(numFromEnv(NAME, 0.6), 0.6))
  withEnv(undefined, () => assertEquals(numFromEnv(NAME, 0.6), 0.6))
})

Deno.test('isValidSessionDir: one check, re-exported under every old name', () => {
  for (const check of [isValidSessionDir, viaTrain, viaLingbot, viaColmap, viaAlign, viaDetect]) {
    assertEquals(check('/scans/sessions/sess-video-20260101-000000-abcd1234'), true)
    assertEquals(check('/scans/sessions/session-old-client-shape'), false)
    assertEquals(check('/scans/sessions/../etc'), false)
  }
})
