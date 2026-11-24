#!/usr/bin/env node
/**
 * The web build a native shell ships: `node scripts/native/build-web.mjs desktop|mobile [--ar-runtime=8thwall|webxr]`.
 *
 * Both shells bundle the Scan web app rather than loading a page from a server. This is that
 * build, run by desktop/src-tauri/tauri.conf.json (beforeBuildCommand) and mobile/package.json
 * (build:web), the same way on Windows, macOS and Linux:
 *
 *   1. VITE_API_BASE may be unset: the app then asks for the person's Scan server. When it is
 *      set it must be an https origin (mobile/scripts/check-api-base.mjs).
 *   2. No .env file may set a VITE_ variable. Vite would bake it into the bundle, and a native
 *      build must carry no developer's address, key or secret.
 *   3. tsc --noEmit, then vite build with VITE_DISABLE_PWA=1 (no service worker and no manifest,
 *      see pwaSwitch() in vite.config.ts) into desktop/dist or mobile/www.
 *   4. The desktop app is the editor and viewer, with no AR capture, so its bundle leaves out the
 *      8th Wall engine: xr.js, xr-slam.js, xr-face.js and resources/.
 *   5. No app bundles what NATIVE_EXCLUDED lists. public/ is copied whole, and a developer's
 *      public/models (the on-device model weights, whose licence is unchecked) would otherwise
 *      ride along into an installer or an APK. Nor the DEV_PAGES: device-test pages that no page of
 *      the app links to, served by the dev server for a phone's browser.
 *   5a. `--ar-runtime=8thwall` builds the Android app's 8th Wall variant: VITE_AR_RUNTIME=8thwall for
 *      the vite step (src/ar/runtime-select.ts, buildForcedRuntime), so the scanner starts on the 8th
 *      Wall engine and never on the native runtime. Mobile only: the desktop app has no AR. The
 *      variable may also come from the environment, as before; the build says which runtime it bakes.
 *   5b. `--ar-runtime=webxr` builds the Android app for XREAL Aura (docs/targets/xreal-aura.md):
 *      VITE_AR_RUNTIME=webxr, so the scanner starts on WebXR alone and never on the native runtime or
 *      the engine. Like the desktop bundle, it leaves the 8th Wall engine out, and its notices with it
 *      (bundlesEngine): no page of that build loads it (index.html reads the forced runtime from the
 *      meta tag vite.config.ts writes).
 *   6. The bundle gets THIRD-PARTY-NOTICES.txt, generated from the lockfiles for exactly what it
 *      contains (scripts/native/third-party-notices.mjs), and LICENSE.txt. The app's Legal notices
 *      view shows both. The same notices go to <shell>/build/third-party-notices.json, which the
 *      release workflow merges into the release asset.
 *   7. The bundle is checked for what must not be in it. The mobile bundle must also carry the XR
 *      Engine exactly as Niantic publishes it (scripts/native/check-xr-engine.mjs): a Windows clone
 *      made before .gitattributes holds converted copies in public/, which the build would ship.
 *      Then its contents are listed.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apiBaseProblem } from '../../mobile/scripts/check-api-base.mjs'
import { ENGINE_PACKAGE, engineProblems } from './check-xr-engine.mjs'
import { bundleNotices, renderNotices, rustTargets } from './third-party-notices.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where each shell's bundle goes. */
export const OUT_DIRS = { desktop: 'desktop/dist', mobile: 'mobile/www' }

/** Where each shell's notices JSON and module list go: git-ignored build/ folders, never inside the bundle. */
export const BUILD_DIRS = { desktop: 'desktop/build', mobile: 'mobile/build' }

/** The licence files every bundle carries at its root. The Legal notices view reads them. */
export const NOTICE_FILES = ['THIRD-PARTY-NOTICES.txt', 'LICENSE.txt']

/** The AR engine. The desktop bundle leaves it out: the editor and viewer never load it. So does a build that forces WebXR. */
export const ENGINE_FILES = ['xr.js', 'xr-slam.js', 'xr-face.js', 'resources']

/** The PWA files pwaSwitch() removes when VITE_DISABLE_PWA is set. A shell cannot use them. */
export const PWA_FILES = ['sw.js', 'manifest.json']

/**
 * What no app bundle carries, though the web build copies it out of public/ when it is there.
 * Keys are paths in the bundle; values say why.
 */
export const NATIVE_EXCLUDED = {
  'models': 'the LFM2.5-VL-1.6B-ONNX weights download_models.py fetches into public/models (git-ignored, about '
    + '2.2 GB). Their licence (LiquidAI lfm1.0) has not been checked for redistribution, so no app ships them.',
  'real-camera-artifacts': 'screenshots from device test runs, kept for the test docs. They are not app assets, '
    + 'and they show a test machine\'s own address bar.',
  'test-fixtures': 'the XR8 mock and a synthetic test image, used only by automated tests.',
}

/**
 * Pages of the web build that no app bundles: device-test and dev-server pages no page of the app links
 * to (FN-164). Keys are paths in the bundle; values say why. The two AR pages are Vite inputs
 * (vite.config.ts); their script chunks stay in assets/, unreferenced, until the config leaves them out
 * of a native build.
 */
export const DEV_PAGES = {
  'ar-hittest-sphere.html': 'an 8th Wall hit-test diagnostic. It loads the engine and three.js from jsDelivr, which the desktop CSP refuses and the shells never load.',
  'ar-ground-anchor.html': 'an 8th Wall ground-anchor diagnostic, loading from jsDelivr like ar-hittest-sphere.html.',
  'camera-check.html': 'a camera check for a phone browser, opened from the dev server.',
  'compass-bench.html': "the compass survey page of docs/testing/DEVICE_TESTING.md, opened in a phone's browser.",
  'smoke.html': "the dev server's triage page. It calls server routes on its own origin, which in a shell is the app, and posts a fixture the shell bundle leaves out.",
  '404.html': "the static site's not-found page. A shell serves its own bundle and never shows it.",
}

/** The AR runtimes a native build may force, as VITE_AR_RUNTIME (src/ar/runtime-select.ts, buildForcedRuntime). */
export const AR_RUNTIMES = ['8thwall', 'webxr']

/**
 * Whether a shell's bundle carries the 8th Wall engine, for the runtime the build forces (or null). Only the
 * mobile app runs it, and not when it is built to run WebXR alone: the desktop app and the XREAL Aura build
 * leave it out. src/ar/engine-state.ts (engineInBundle) is the same rule as the app's Legal notices see it.
 */
export function bundlesEngine(shell, arRuntime = null) {
  return shell === 'mobile' && arRuntime !== 'webxr'
}

/**
 * The shell and options from the command line: `desktop|mobile [--ar-runtime=<name>]`. Throws on an
 * argument it does not know, so a misspelt option never builds the default variant under the wrong name.
 */
export function parseBuildArgs(argv) {
  const [shell, ...rest] = argv
  const options = { shell, arRuntime: null }
  for (const arg of rest) {
    const match = /^--ar-runtime=(.*)$/.exec(arg)
    if (!match) throw new Error(`unknown argument "${arg}": the only option is --ar-runtime=<${AR_RUNTIMES.join('|')}>`)
    if (!AR_RUNTIMES.includes(match[1])) throw new Error(`--ar-runtime=${match[1]}: the runtimes a build can force are ${AR_RUNTIMES.join(', ')}`)
    if (shell !== 'mobile') throw new Error('--ar-runtime is for the mobile shell only: the desktop app has no AR')
    options.arRuntime = match[1]
  }
  return options
}

/** The .env files `vite build` reads (mode production). */
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local']

/** The VITE_ variables a .env file in `dir` would put into a build: `[file, name]` pairs. */
export function viteVariablesInEnvFiles(dir = ROOT) {
  const found = []
  for (const file of ENV_FILES) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    for (const match of readFileSync(path, 'utf8').matchAll(/^\s*(?:export\s+)?(VITE_[A-Za-z0-9_]+)\s*=/gm)) {
      found.push([file, match[1]])
    }
  }
  return found
}

/** What a finished bundle must not contain, as relative paths that exist in it. */
export function forbiddenInBundle(outDir, shell, arRuntime = null) {
  const names = [...PWA_FILES, ...Object.keys(NATIVE_EXCLUDED), ...Object.keys(DEV_PAGES), ...(bundlesEngine(shell, arRuntime) ? [] : ENGINE_FILES)]
  return names.filter((name) => existsSync(join(outDir, name)))
}

/**
 * The XR Engine files in a finished bundle that are missing or not Niantic's published bytes, as
 * `[file, problem]` pairs. Only the mobile app carries the engine; the desktop bundle and the WebXR-only
 * build have none.
 */
export function engineProblemsInBundle(outDir, shell, arRuntime = null) {
  return bundlesEngine(shell, arRuntime) ? engineProblems(outDir) : []
}

function sizeOf(path) {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((total, entry) => total + sizeOf(join(path, entry)), 0)
}

function fail(message) {
  console.error(`[native web build] ${message}`)
  process.exit(1)
}

function node(script, args, env) {
  const run = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (run.status !== 0) fail(`${script} ${args.join(' ')} exited with ${run.status}`)
}

export function buildShellWeb(shell, { arRuntime = null } = {}) {
  const outRel = OUT_DIRS[shell]
  if (!outRel) fail(`unknown shell "${shell}": use one of ${Object.keys(OUT_DIRS).join(', ')}`)
  const outDir = join(ROOT, outRel)
  const runtime = arRuntime ?? process.env.VITE_AR_RUNTIME ?? null
  console.log(`[native web build] ${shell}: AR runtime ${runtime ? `forced to ${runtime} (VITE_AR_RUNTIME)` : 'chosen at run time (native first in the shell)'}`)

  const problem = apiBaseProblem(process.env.VITE_API_BASE)
  if (problem) fail(problem)
  const baked = viteVariablesInEnvFiles()
  if (baked.length) {
    fail(`refusing to build: ${baked.map(([file, name]) => `${file} sets ${name}`).join(', ')}. `
      + 'A native build must not carry local settings. Move them out of the .env file, or set them in the environment for this build.')
  }

  if (shell === 'mobile' && !existsSync(join(ROOT, 'mobile', 'node_modules', '@capacitor', 'android'))) {
    fail('mobile/node_modules is missing: run npm ci --prefix mobile first. The notices list its Android runtime.')
  }
  const buildDir = join(ROOT, BUILD_DIRS[shell])
  mkdirSync(buildDir, { recursive: true })
  const report = join(buildDir, 'bundle-modules.json')
  rmSync(report, { force: true })

  node('node_modules/typescript/bin/tsc', ['--noEmit'])
  node('node_modules/vite/bin/vite.js', ['build', '--outDir', outRel, '--emptyOutDir'], {
    VITE_DISABLE_PWA: '1',
    NATIVE_BUNDLE_REPORT: report,
    ...(arRuntime ? { VITE_AR_RUNTIME: arRuntime } : {}),
  })

  for (const [name, why] of Object.entries(NATIVE_EXCLUDED)) {
    if (!existsSync(join(outDir, name))) continue
    rmSync(join(outDir, name), { recursive: true, force: true })
    console.warn(`[native web build] left out ${name}/: ${why}`)
  }
  for (const name of Object.keys(DEV_PAGES)) rmSync(join(outDir, name), { force: true })
  if (!bundlesEngine(shell, runtime)) {
    for (const name of ENGINE_FILES) rmSync(join(outDir, name), { recursive: true, force: true })
    if (shell === 'mobile') console.log(`[native web build] left out the 8th Wall engine: a build forced to ${runtime} never loads it`)
  }
  const left = forbiddenInBundle(outDir, shell, runtime)
  if (left.length) fail(`${outRel} still contains ${left.join(', ')}`)
  const engine = engineProblemsInBundle(outDir, shell, runtime)
  if (engine.length) {
    fail(`${outRel} does not carry ${ENGINE_PACKAGE} as Niantic publishes it, and its licence allows no other form: `
      + `${engine.map(([file, problem]) => `${file} (${problem})`).join('; ')}. A checkout that converted line endings `
      + 'is the usual cause: delete public/xr*.js and run `git checkout -- public` (.gitattributes keeps them unconverted).')
  }

  if (!existsSync(report)) fail(`the build wrote no module list to ${report}, so its notices cannot be made`)
  const modules = JSON.parse(readFileSync(report, 'utf8')).modules
  const notices = bundleNotices({
    shell,
    bundledModules: modules,
    targets: shell === 'desktop' ? rustTargets() : [],
    engineBundled: bundlesEngine(shell, runtime),
  })
  const version = JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8')).version
  writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.txt'), renderNotices(notices, version))
  copyFileSync(join(ROOT, 'LICENSE'), join(outDir, 'LICENSE.txt'))
  writeFileSync(join(buildDir, 'third-party-notices.json'), JSON.stringify(notices))
  console.log(`[native web build] notices: ${notices.components.length} components (${notices.titles.join('; ')})`)

  const entries = readdirSync(outDir).sort()
  const total = entries.reduce((sum, entry) => sum + sizeOf(join(outDir, entry)), 0)
  console.log(`[native web build] ${shell}: ${relative(ROOT, outDir)} holds ${entries.length} entries, ${(total / 1e6).toFixed(1)} MB`)
  for (const entry of entries) console.log(`  ${entry}${statSync(join(outDir, entry)).isDirectory() ? '/' : ''} ${(sizeOf(join(outDir, entry)) / 1e3).toFixed(0)} kB`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options
  try {
    options = parseBuildArgs(process.argv.slice(2))
  } catch (err) {
    fail(err.message)
  }
  buildShellWeb(options.shell, { arRuntime: options.arRuntime })
}
