/**
 * WP-J3 (J3-3): a stage budget read from the environment is never zero. A value
 * between 0 and 1 used to floor to 0, and a zero-length timer fires at once, which
 * killed the stage before it started.
 *
 * Run: node --test tests/unit/server/wp-j3-budget.test.ts
 */
import { assertEquals } from './assert.ts'
import { budgetFromEnv } from '../../../server/run_with_deadline.ts'
import { test } from 'node:test'

const NAME = 'WP_J3_TEST_BUDGET_MS'

function withEnv(value: string, fn: () => void): void {
  const previous = process.env[NAME]
  try {
    process.env[NAME] = value
    fn()
  } finally {
    if (previous === undefined) delete process.env[NAME]
    else process.env[NAME] = previous
  }
}

test('budgetFromEnv: a value that rounds down to zero takes the default, not a zero timer', () => {
  for (const raw of ['0.5', '0.999', '0.0001']) {
    withEnv(raw, () => assertEquals(budgetFromEnv(NAME, 777), 777, `raw ${raw}`))
  }
})

test('budgetFromEnv: a value of at least one millisecond is kept, rounded down', () => {
  withEnv('1', () => assertEquals(budgetFromEnv(NAME, 777), 1))
  withEnv('1.9', () => assertEquals(budgetFromEnv(NAME, 777), 1))
  withEnv('1500.7', () => assertEquals(budgetFromEnv(NAME, 777), 1500))
})

test('budgetFromEnv: infinite, negative, zero and unparseable values take the default', () => {
  for (const raw of ['Infinity', '-Infinity', 'NaN', '-0.5', '-5', '0', 'abc', '']) {
    withEnv(raw, () => assertEquals(budgetFromEnv(NAME, 777), 777, `raw ${JSON.stringify(raw)}`))
  }
})
