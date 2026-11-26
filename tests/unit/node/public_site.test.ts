/**
 * The static build on Cloudflare Pages (docs/operations/DEPLOY.md). Pages falls
 * back to index.html with a 200 for every unknown path unless the build has a
 * 404.html. With one, a link to a path that only the server knows opens the
 * 404 page, so every link the pages ship has to resolve without that server.
 *
 * Run: npm run test:public-site
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_SITE_EXCLUDED, prunePublicSite } from '../../../scripts/public-site.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** Source path, Pages path: `_redirects` lines, skipping comments. */
function rewrites(): Map<string, string> {
  const lines = read('public/_redirects').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  return new Map(lines.map((l) => {
    const [from, to, status] = l.trim().split(/\s+/)
    assert.equal(status, '200', `${l}: a rewrite keeps the address, so the page can read its own URL`)
    return [from!, to!]
  }))
}

test('the build has a top-level 404 page, which is what turns the Pages fallback off', () => {
  assert.ok(existsSync(join(ROOT, 'public/404.html')))
})

test('/editor is rewritten to a page the build produces', () => {
  const target = rewrites().get('/editor')
  assert.ok(target, '/editor must be in public/_redirects')
  assert.match(read('vite.config.ts'), new RegExp(`'${target!.slice(1)}\\.html'`), `${target} is not a Vite entry`)
})

test('every same-origin link in the shipped pages resolves without the server', () => {
  const known = rewrites()
  for (const page of ['index.html', 'viewer.html', 'webxr.html', 'public/smoke.html']) {
    for (const [, path] of read(page).matchAll(/href="(\/[^"?#]*)/g)) {
      // viewer.ts removes the one sign-in link when the server has no such route.
      if (path!.startsWith('/authenticate/')) continue
      const pruned = Object.keys(PUBLIC_SITE_EXCLUDED).some((name) => path!.startsWith(`/${name}/`))
      const resolves = !pruned && (path === '/' || known.has(path!) || existsSync(join(ROOT, 'public', path!)) || existsSync(join(ROOT, path!)))
      assert.ok(resolves, `${page} links to ${path}, which Pages would answer with the 404 page`)
    }
  }
})

// ── What the public site leaves out (scripts/public-site.mjs) ─────────────────

test('the public build leaves out what the apps leave out, and keeps the site', () => {
  const out = mkdtempSync(join(tmpdir(), 'public-site-'))
  try {
    for (const dir of ['assets', 'test-fixtures', 'real-camera-artifacts', 'models/LiquidAI']) mkdirSync(join(out, dir), { recursive: true })
    for (const file of ['index.html', '404.html', 'sw.js', 'assets/main.js', 'test-fixtures/xr8-mock.js', 'real-camera-artifacts/s8-ultra-scan-camera.png']) {
      writeFileSync(join(out, file), 'x')
    }
    assert.deepEqual(prunePublicSite(out).sort(), ['models', 'real-camera-artifacts', 'test-fixtures'])
    for (const kept of ['index.html', '404.html', 'sw.js', 'assets/main.js']) assert.ok(existsSync(join(out, kept)), `${kept} was removed`)
    for (const gone of ['test-fixtures', 'real-camera-artifacts', 'models']) assert.ok(!existsSync(join(out, gone)), `${gone}/ is still there`)
    assert.deepEqual(prunePublicSite(out), [], 'a second run finds nothing to remove')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('the public site is built by build:public-site, and DEPLOY.md deploys that build', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
  assert.match(scripts['build:public-site'] ?? '', /^npm run build && node scripts\/public-site\.mjs dist$/)
  const deploy = read('docs/operations/DEPLOY.md')
  const section = deploy.slice(deploy.indexOf('## The public site'))
  assert.match(section, /npm run build:public-site\s*\nnpx wrangler pages deploy dist --project-name=ci-spatial-scan/)
})
