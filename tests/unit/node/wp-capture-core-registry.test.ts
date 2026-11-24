/**
 * Wave 14, ticket 0004 (FN-044): the storage-key registry, src/shared/storage-keys.ts, declares the keys it was missing.
 *
 *  - 'ci-xr-projects', the Places database, which src/project/project-store.ts now imports instead of typing.
 *  - The three keys a native shell keeps its sign-in in. src/shared/api-base.ts (another session's file) declares them
 *    too, so this test holds the two equal until api-base imports them from the registry.
 *  - The geocoder's consent key, new in this ticket (F-08).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-registry.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as registry from '../../../src/shared/storage-keys.ts'
import * as apiBase from '../../../src/shared/api-base.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

test('the Places database is declared once, with its value unchanged, and the store reads it from the registry', () => {
  assert.equal(registry.PROJECTS_DB_NAME, 'ci-xr-projects')
  const store = read('src/project/project-store.ts')
  assert.match(store, /import \{ PROJECTS_DB_NAME \} from '\.\.\/shared\/storage-keys\.ts'/)
  assert.match(store, /const DB_NAME = PROJECTS_DB_NAME\b/)
  assert.doesNotMatch(store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /'ci-xr-projects'/, 'no second literal in code')
})

test('the shell keys are declared in the registry with exactly api-base\'s values', () => {
  assert.equal(registry.SHELL_SESSION_KEY, apiBase.SHELL_SESSION_KEY)
  assert.equal(registry.SHELL_SIGN_IN_PENDING_KEY, apiBase.SHELL_SIGN_IN_PENDING_KEY)
  assert.equal(registry.SHELL_SIGN_IN_CODES_KEY, apiBase.SHELL_SIGN_IN_CODES_KEY)
  assert.deepEqual(
    [registry.SHELL_SESSION_KEY, registry.SHELL_SIGN_IN_PENDING_KEY, registry.SHELL_SIGN_IN_CODES_KEY],
    ['companion-scan-shell-session', 'companion-scan-shell-sign-in', 'companion-scan-shell-sign-in-codes'],
  )
})

test('every value in the registry is distinct, and the frozen ones keep their values', () => {
  const values = Object.values(registry).filter((v): v is string => typeof v === 'string')
  assert.equal(new Set(values).size, values.length, 'two names for one key would be two owners of one store')
  assert.equal(registry.SCAN_DB_NAME, 'ci-xr-scan')
  assert.equal(registry.GEO_FIX_SESSION_KEY, 'ci-xr-geo-fix')
  assert.equal(registry.ONBOARDING_KEY, 'companion-scan-onboarded')
  assert.equal(registry.BASEMAP_CONSENT_KEY, 'companion-scan-basemap-consent')
  assert.equal(registry.GEOCODE_CONSENT_KEY, 'companion-scan-geocode-consent')
})

test('the registry imports nothing, so anything can import it without a cycle', () => {
  assert.doesNotMatch(read('src/shared/storage-keys.ts'), /^import /m)
})
