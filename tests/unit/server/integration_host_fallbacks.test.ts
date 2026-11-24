/**
 * F-01, the rest: no file that resolves a host name falls back to one developer machine's tailnet name.
 *
 * server-core (0001, #284) made server/origin.ts and vite.config.ts fall back to localhost. Three more copies of the
 * same fallback were outside its files: playwright.config.ts's resolveHostname(), the e2e suite's default URL, and the
 * tablet user suite's. They fall back to localhost too. This pins every one of them: no quoted full tailnet name
 * (`name.tailnet.ts.net`) may appear in them, so the next fallback added cannot be a real machine's either.
 *
 *   node --test tests/unit/server/integration_host_fallbacks.test.ts
 */
import { assert } from './assert.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

const read = (path: string) => fs.readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')

/** A quoted literal naming one machine on one tailnet: `'host.tailnet.ts.net'`, with or without a scheme or port. */
const QUOTED_TAILNET_NAME = /['"`](?:https?:\/\/)?[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i

const RESOLVERS = [
  'server/origin.ts',
  'vite.config.ts',
  'playwright.config.ts',
  'tests/e2e-suite.spec.ts',
  'scripts/tablet-user-suite.mjs',
]

for (const path of RESOLVERS) {
  test(`${path}: no hard-coded tailnet name to fall back to (F-01)`, async () => {
    const source = await read(path)
    const hit = source.match(QUOTED_TAILNET_NAME)
    assert(!hit, `${path} names a machine on a tailnet at offset ${hit?.index}`)
  })
}

// Plain asserts with short messages: a failing match must not print the whole file into a public CI log.
test('the three fallbacks outside the server and Vite are localhost', async () => {
  assert(/return 'localhost'\n\}/.test(await read('playwright.config.ts')), 'playwright.config.ts falls back to localhost')
  assert(
    /process\.env\['VITE_URL'\] \?\? 'https:\/\/localhost:5173'/.test(await read('tests/e2e-suite.spec.ts')),
    'the e2e suite defaults to https://localhost:5173',
  )
  assert(
    /cert \? cert\.replace\(\/\\\.crt\$\/, ''\) : 'localhost'/.test(await read('scripts/tablet-user-suite.mjs')),
    'the tablet suite falls back to localhost',
  )
})
