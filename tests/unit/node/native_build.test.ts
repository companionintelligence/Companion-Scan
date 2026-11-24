/**
 * The web build the native shells ship (scripts/native/build-web.mjs): what it refuses to
 * build with, and what it checks the finished bundle for. The build itself runs in the shells'
 * own builds; these cases run on a scratch folder.
 *
 * Run: npm run test:native-build
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AR_RUNTIMES,
  DEV_PAGES,
  ENGINE_FILES,
  NATIVE_EXCLUDED,
  OUT_DIRS,
  PWA_FILES,
  ROOT,
  engineProblemsInBundle,
  forbiddenInBundle,
  parseBuildArgs,
  viteVariablesInEnvFiles,
} from '../../../scripts/native/build-web.mjs'
import { ENGINE_SHA256 } from '../../../scripts/native/check-xr-engine.mjs'

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-build-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

test('each shell builds into its own folder, never the web build in dist/', () => {
  assert.deepEqual(OUT_DIRS, { desktop: 'desktop/dist', mobile: 'mobile/www' })
})

test('a .env file that sets a VITE_ variable is found, so a native build can refuse it', () => {
  const dir = scratch({
    '.env': '# VITE_HOSTNAME=commented.example\nOLLAMA_HOST=http://localhost:11434\nVITE_HOSTNAME=machine.tailnet.ts.net\n',
    '.env.production.local': 'export VITE_API_BASE=https://scan.example.ts.net\n',
    '.env.example': 'VITE_PORT=5173\n',
  })
  try {
    assert.deepEqual(viteVariablesInEnvFiles(dir), [['.env', 'VITE_HOSTNAME'], ['.env.production.local', 'VITE_API_BASE']])
    assert.deepEqual(viteVariablesInEnvFiles(scratch({ '.env': 'SESSION_SECRET=x\n' })), [], 'only VITE_ variables reach a bundle')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no app bundle may hold the on-device model weights, whose licence is unchecked, or the test-only files', () => {
  assert.deepEqual(Object.keys(NATIVE_EXCLUDED), ['models', 'real-camera-artifacts', 'test-fixtures'])
  assert.match(NATIVE_EXCLUDED.models, /LFM2\.5-VL/)
  const dir = scratch({ 'index.html': '', 'models/LFM2.5-VL-1.6B-ONNX/onnx/model.onnx': '', 'test-fixtures/room.jpg': '' })
  try {
    for (const shell of ['desktop', 'mobile'] as const) {
      assert.deepEqual(forbiddenInBundle(dir, shell), ['models', 'test-fixtures'], shell)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the desktop bundle may not hold the AR engine; neither bundle may hold the PWA files', () => {
  const dir = scratch({
    'index.html': '', 'viewer.html': '', 'xr.js': '', 'xr-slam.js': '', 'resources/media-worker.js': '', 'sw.js': '',
  })
  try {
    assert.deepEqual(ENGINE_FILES, ['xr.js', 'xr-slam.js', 'xr-face.js', 'resources'])
    assert.deepEqual(PWA_FILES, ['sw.js', 'manifest.json'])
    assert.deepEqual(forbiddenInBundle(dir, 'desktop'), ['sw.js', 'xr.js', 'xr-slam.js', 'resources'])
    assert.deepEqual(forbiddenInBundle(dir, 'mobile'), ['sw.js'], 'the Android app ships the engine, which it runs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the mobile build stops on an XR Engine that is not Niantic's bytes, as a converted Windows checkout would ship", () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-build-'))
  try {
    for (const file of Object.keys(ENGINE_SHA256)) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      copyFileSync(join(ROOT, 'public', file), join(dir, file))
    }
    assert.deepEqual(engineProblemsInBundle(dir, 'mobile'), [], 'the engine as published')
    writeFileSync(join(dir, 'xr-slam.js'), readFileSync(join(dir, 'xr-slam.js'), 'utf8').replace(/\n/g, '\r\n'))
    assert.deepEqual(engineProblemsInBundle(dir, 'mobile').map(([file]) => file), ['xr-slam.js'])
    assert.deepEqual(engineProblemsInBundle(dir, 'desktop'), [], 'the desktop bundle carries no engine to check')
    // buildShellWeb fails on any of them, once the bundle is built and before its notices are written.
    const build = readFileSync(join(ROOT, 'scripts/native/build-web.mjs'), 'utf8').replace(/\r\n/g, '\n')
    const body = build.slice(build.indexOf('export function buildShellWeb'))
    assert.match(body, /const engine = engineProblemsInBundle\(outDir, shell\)\n {2}if \(engine\.length\) \{\n {4}fail\(/)
    assert.ok(body.indexOf('engineProblemsInBundle(outDir, shell)') < body.indexOf('bundleNotices('))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no shell bundle carries the dev pages, which no page of the app links to (FN-164)', () => {
  assert.deepEqual(Object.keys(DEV_PAGES).sort(), ['404.html', 'ar-ground-anchor.html', 'ar-hittest-sphere.html', 'camera-check.html', 'compass-bench.html', 'smoke.html'])
  // Each is a page of the tree the web build can copy or make: a root page (a Vite input) or a file of public/.
  for (const page of Object.keys(DEV_PAGES)) {
    assert.ok(existsSync(join(ROOT, page)) || existsSync(join(ROOT, 'public', page)), `${page} is neither a root page nor a file of public/`)
  }
  // And no page the app ships links to one.
  for (const entry of ['index.html', 'scanner.html', 'viewer.html', 'webxr.html', 'xr-world.html']) {
    const html = readFileSync(join(ROOT, entry), 'utf8')
    for (const page of Object.keys(DEV_PAGES)) assert.ok(!html.includes(`href="/${page}"`) && !html.includes(`href="${page}"`), `${entry} links to ${page}`)
  }
  const dir = scratch({ 'index.html': '', 'smoke.html': '', 'ar-hittest-sphere.html': '', '404.html': '' })
  try {
    for (const shell of ['desktop', 'mobile'] as const) {
      assert.deepEqual(forbiddenInBundle(dir, shell), ['ar-hittest-sphere.html', 'smoke.html', '404.html'], shell)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the 8th Wall variant is a mobile build with --ar-runtime=8thwall, and a misspelt option stops the build (FN-163)', () => {
  assert.deepEqual(AR_RUNTIMES, ['8thwall'], 'the one value buildForcedRuntime (src/ar/runtime-select.ts) acts on')
  assert.deepEqual(parseBuildArgs(['mobile']), { shell: 'mobile', arRuntime: null })
  assert.deepEqual(parseBuildArgs(['mobile', '--ar-runtime=8thwall']), { shell: 'mobile', arRuntime: '8thwall' })
  assert.throws(() => parseBuildArgs(['mobile', '--ar-runtime=webxr']), /runtimes a build can force are 8thwall/)
  assert.throws(() => parseBuildArgs(['mobile', '--ar=8thwall']), /unknown argument/)
  assert.throws(() => parseBuildArgs(['desktop', '--ar-runtime=8thwall']), /mobile shell only/)
  // The mobile shell's scripts build it, and the mobile workflow builds its APK.
  const scripts = JSON.parse(readFileSync(join(ROOT, 'mobile/package.json'), 'utf8')).scripts
  assert.equal(scripts['build:web:8thwall'], 'node ../scripts/native/build-web.mjs mobile --ar-runtime=8thwall')
  assert.equal(scripts['build:8thwall'], 'npm run build:web:8thwall && npm run sync')
  assert.match(readFileSync(join(ROOT, '.github/workflows/mobile-build.yml'), 'utf8'), /npm run build:web:8thwall --prefix mobile/)
})
