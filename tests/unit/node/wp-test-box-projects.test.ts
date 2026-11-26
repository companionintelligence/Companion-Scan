/**
 * `npm run test:box` runs the `api` and `chromium-mock` projects unless TEST_BOX_PROJECTS names others
 * (scripts/lib/test-box-projects.mjs). The two WebKit profiles, the iPhone 15 one and desktop Safari, had no way into
 * the box loop: a `--project` passed after `--` adds to the default pair rather than replacing it.
 *
 * Runs with `npm run test:wave` (the wp- prefix), or alone:
 *   node --experimental-strip-types --no-warnings --test tests/unit/node/wp-test-box-projects.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BOX_PROJECTS, boxProjects } from '../../../scripts/lib/test-box-projects.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('without TEST_BOX_PROJECTS the box runs the api and chromium-mock pair, as it always did', () => {
  assert.deepEqual(boxProjects({}), ['api', 'chromium-mock'])
  assert.deepEqual(boxProjects({ TEST_BOX_PROJECTS: ' , ' }), ['api', 'chromium-mock'])
  assert.deepEqual([...DEFAULT_BOX_PROJECTS], ['api', 'chromium-mock'])
})

test('TEST_BOX_PROJECTS replaces the pair, in its own order, without repeats', () => {
  assert.deepEqual(boxProjects({ TEST_BOX_PROJECTS: 'webkit-iphone15, webkit-desktop' }), ['webkit-iphone15', 'webkit-desktop'])
  assert.deepEqual(boxProjects({ TEST_BOX_PROJECTS: 'api,api,chromium-mock' }), ['api', 'chromium-mock'])
})

test('every project the box can be asked for is one playwright.config.ts defines', () => {
  const config = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8')
  const defined = new Set([...config.matchAll(/name:\s*'([\w-]+)'/g)].map((match) => match[1]))
  for (const name of [...DEFAULT_BOX_PROJECTS, 'webkit-iphone15', 'webkit-desktop']) {
    assert.ok(defined.has(name), `playwright.config.ts has no project named ${name}`)
  }
})

test('test-box.mjs takes its project list from boxProjects, not from a fixed pair', () => {
  const source = readFileSync(join(ROOT, 'scripts/test-box.mjs'), 'utf8')
  assert.match(source, /boxProjects\(process\.env\)/)
  assert.doesNotMatch(source, /'--project=api', '--project=chromium-mock'/)
})
