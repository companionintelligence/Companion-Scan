/**
 * The georeference's figures that are copies of another file's, held equal.
 *
 * `src/world/georef.ts` is browser- and server-safe and so cannot import `src/geo/compass-heading.ts` (that file reads DOM
 * types, ADR 0002), which owns the compass's own sigma floor for an iPhone. The two figures are one decision, adopted
 * and not measured (ADR 0005 rule 5): DX3 replaces both, and a person who changes one has to see that the other
 * moved. Node can import both, so this is where they are compared.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/georef_floors.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BEARING_SIGMA_FLOOR_SEED_DEG, BEARING_SIGMA_FLOOR_SEED_IOS_DEG, PLACEMENT_MAX_BEARING_SPREAD_DEG } from '../../../src/world/georef.ts'
import { IOS_COMPASS_SIGMA_FLOOR_DEG } from '../../../src/geo/compass-heading.ts'

test("an iPhone's seed sigma floor is the compass module's, so DX3 changes one number in two places or fails here", () => {
  assert.equal(BEARING_SIGMA_FLOOR_SEED_IOS_DEG, IOS_COMPASS_SIGMA_FLOOR_DEG)
  assert.ok(BEARING_SIGMA_FLOOR_SEED_IOS_DEG > BEARING_SIGMA_FLOOR_SEED_DEG, 'an iPhone is held to more than any other compass')
})

test('a scan whose compass spread is over the placement gate is wider than any seed is held to by the floors alone', () => {
  // The gate (30 degrees) is above both floors: a seed at the floor is placeable, a scattered one is not.
  assert.ok(PLACEMENT_MAX_BEARING_SPREAD_DEG > BEARING_SIGMA_FLOOR_SEED_IOS_DEG)
})

test('georef.ts imports nothing that is not browser-safe (ADR 0002): no Deno, Node or DOM reference', () => {
  const source = readFileSync(new URL('../../../src/world/georef.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bDeno\b/)
  assert.doesNotMatch(code, /\b(document|window|navigator|localStorage)\b/)
  assert.doesNotMatch(code, /from '(node:|fs|path|crypto)/)
  // Only the import statements: a message that says "from '${source}'" is not one.
  const imports = [...code.matchAll(/^(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+'([^']+)'/gm)].map((m) => m[1]!)
  assert.ok(imports.length >= 4, 'the imports were found')
  for (const path of imports) assert.match(path, /^\.\/[a-z0-9-]+\.ts$/, `${path} is another file of src/world`)
})
