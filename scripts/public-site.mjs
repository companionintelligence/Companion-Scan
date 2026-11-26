#!/usr/bin/env node
/**
 * The public site's build. `npm run build:public-site` is `npm run build`, then this, which takes out of dist/ what
 * no published bundle carries, so that `wrangler pages deploy dist` (docs/operations/DEPLOY.md) puts up the site and
 * nothing else.
 *
 * `npm run build` itself keeps everything: a Scan server serves the same dist/ (`vite preview`, DEPLOY.md), and the
 * device tests that run against one fetch /test-fixtures/ from it (tests/ar-scan.spec.ts). The public site is a
 * published bundle like the apps, so it leaves out what they leave out, NATIVE_EXCLUDED in
 * scripts/native/build-web.mjs:
 * - the test fixtures;
 * - the device-test screenshots, which show a test machine's address bar;
 * - any model weights that download_models.py put in public/models, whose licence is unchecked.
 *
 * Until 2026-11-25 the deploy ran `npm run build` alone, so scan.ci.computer served /test-fixtures/ and
 * /real-camera-artifacts/.
 */
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NATIVE_EXCLUDED } from './native/build-web.mjs'

/** What the public site leaves out of dist/: the apps' list. Keys are paths in the bundle; values say why. */
export const PUBLIC_SITE_EXCLUDED = NATIVE_EXCLUDED

/** Takes PUBLIC_SITE_EXCLUDED out of `outDir`, and returns the names it removed. */
export function prunePublicSite(outDir) {
  const removed = []
  for (const name of Object.keys(PUBLIC_SITE_EXCLUDED)) {
    const path = join(outDir, name)
    if (!existsSync(path)) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outDir = resolve(process.argv[2] ?? 'dist')
  if (!existsSync(join(outDir, 'index.html'))) {
    console.error(`[public site] ${outDir} has no index.html: run npm run build first`)
    process.exit(1)
  }
  for (const name of prunePublicSite(outDir)) console.log(`[public site] left out ${name}/: ${PUBLIC_SITE_EXCLUDED[name]}`)
}
