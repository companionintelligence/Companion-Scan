/**
 * The Gimbal control page's wiring, checked as text, because its two clients (web/app.mjs and
 * web/backend-client.mjs) touch `document` as they load and no Node test can import them.
 *
 * - Every element id a client looks up exists in index.html. A missing one is a null that throws
 *   the first time it is used, which is how a renamed button breaks a page with no test noticing.
 * - Every relative import resolves, and stays inside web/ or protocol/. Those are the only
 *   directories web/server.mjs serves, so an import from anywhere else would 404 in the browser.
 * - The service worker precaches every module the page imports, so the offline shell starts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/gimbal_page_wiring.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../subsystems/osmo-ble/', import.meta.url))
const WEB = path.join(ROOT, 'web')
const read = (file: string) => readFileSync(file, 'utf8')
const html = read(path.join(WEB, 'index.html'))
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

for (const client of ['app.mjs', 'backend-client.mjs', 'ui.mjs']) {
  test(`every getElementById in web/${client} names an element in index.html`, () => {
    const looked = [...read(path.join(WEB, client)).matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
    assert.ok(looked.length > 0)
    const missing = looked.filter((id) => !ids.has(id))
    assert.deepEqual(missing, [], `missing from index.html: ${missing.join(', ')}`)
  })
}

test('the controls this wave added are in the page: Stop, the token field, the test-routes note', () => {
  for (const id of ['be-btn-stop', 'be-token', 'be-test-routes-note']) assert.ok(ids.has(id), id)
  assert.match(html, /<input type="password" id="be-token"/)
})

/** The page's module graph, from its <script type="module"> tags, as paths relative to ROOT. */
function moduleGraph(): Set<string> {
  const entry = [...html.matchAll(/<script type="module" src="\.\/([^"]+)"/g)].map((m) => path.join(WEB, m[1]))
  const seen = new Set<string>()
  const queue = [...entry]
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of read(file).matchAll(/^\s*import\s[^'"]*from\s+'(\.{1,2}\/[^']+)'/gm)) {
      queue.push(path.resolve(path.dirname(file), m[1]))
    }
  }
  return new Set([...seen].map((f) => path.relative(ROOT, f)))
}

test('every module the page loads resolves, inside web/ or protocol/, the only directories served', () => {
  const graph = moduleGraph()
  assert.ok(graph.has(path.join('web', 'page-state.mjs')) && graph.has(path.join('web', 'controls.mjs')))
  for (const rel of graph) {
    assert.ok(existsSync(path.join(ROOT, rel)), `${rel} exists`)
    assert.ok(rel.startsWith(`web${path.sep}`) || rel.startsWith(`protocol${path.sep}`), `${rel} is served by web/server.mjs`)
    assert.ok(!/from 'node:/.test(read(path.join(ROOT, rel))), `${rel} imports no Node built-in, so it runs in the browser`)
  }
})

test('the service worker precaches every module the page loads', () => {
  const sw = read(path.join(WEB, 'sw.js'))
  const assets = new Set([...sw.matchAll(/'(\.{1,2}\/[^']+)'/g)].map((m) => path.relative(ROOT, path.resolve(WEB, m[1]))))
  const missing = [...moduleGraph()].filter((rel) => !assets.has(rel))
  assert.deepEqual(missing, [], `not in sw.js ASSETS: ${missing.join(', ')}`)
})

test('the page no longer carries copies of what it shares: one wrap, one scanner threshold', () => {
  const orientation = read(path.join(WEB, 'orientation.mjs'))
  assert.match(orientation, /import \{ wrapDeg \} from '\.\.\/protocol\/stall\.mjs'/)
  assert.doesNotMatch(read(path.join(WEB, 'backend-client.mjs')), /SCANNER_MIN_ROTATION_DEG = /)
  assert.doesNotMatch(read(path.join(ROOT, 'server', 'backend.mjs')), /^function wrapDeg/m)
  for (const client of ['app.mjs', 'backend-client.mjs']) {
    const src = read(path.join(WEB, client))
    assert.doesNotMatch(src, /^function log\(/m, `${client} uses the shared log`)
    assert.doesNotMatch(src, /^function stopOnPageExit/m, `${client} uses the shared joystick guard`)
    assert.match(src, /from '\.\/controls\.mjs'/)
  }
})
