/**
 * Wave 14-0002 (F-29): one resolver for every runner and for GET /capabilities.
 *
 * The report used to look on PATH for Brush and Spirula while their runners did
 * not, so a trainer the report called "ok" made its job skip. Both now call
 * `locateTool` with the same table, and these tests hold the convention:
 * explicit option or env var, then PATH, then the documented fallback.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-run tests/unit/deno/wp-runners-tool-resolve.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import {
  locateTool,
  runnerToolLookup,
  runnerToolLookups,
  type RunnerToolId,
  toolSkip,
} from '../../../server/exec_probe.ts'
import { probeCapabilities, toolSpecs } from '../../../server/capabilities.ts'
import { resolveSpirulaBin } from '../../../server/splat/spirula_train.ts'
import { runSplatTrain } from '../../../server/splat/splat_train.ts'

const isWindows = Deno.build.os === 'windows'

/** A fake filesystem: `present` paths are runnable files, `dirs` are directories. */
function fakes(present: string[], dirs: string[] = [], pathDirs: string[] = []) {
  const files = new Set(present)
  const folders = new Set(dirs)
  return {
    platform: 'linux' as const,
    isRunnable: (p: string) => Promise.resolve(files.has(p)),
    isFile: (p: string) => Promise.resolve(files.has(p)),
    isDir: (p: string) => Promise.resolve(folders.has(p)),
    which: (bin: string) => {
      for (const d of pathDirs) if (files.has(`${d}/${bin}`)) return Promise.resolve(`${d}/${bin}`)
      return Promise.resolve(null)
    },
  }
}

Deno.test('locateTool: an env var wins over PATH and the fallback, and is only probed', async () => {
  const brush = runnerToolLookup('brush', '/home/t')
  const located = await locateTool(brush, {
    ...fakes(['/opt/brush-cli', '/usr/bin/brush-cli', '/home/t/brush/target/release/brush-cli'], [], ['/usr/bin']),
    env: (n) => (n === 'BRUSH_BIN' ? '/opt/brush-cli' : undefined),
  })
  assertEquals(located, { found: true, path: '/opt/brush-cli', via: 'env', searched: ['/opt/brush-cli'] })
})

Deno.test('locateTool: PATH comes before the documented fallback', async () => {
  const brush = runnerToolLookup('brush', '/home/t')
  const located = await locateTool(brush, {
    ...fakes(['/usr/bin/brush-cli', '/home/t/brush/target/release/brush-cli'], [], ['/usr/bin']),
    env: () => undefined,
  })
  assertEquals(located.via, 'path')
  assertEquals(located.path, '/usr/bin/brush-cli')
})

Deno.test('locateTool: the fallback is found when PATH has nothing', async () => {
  const brush = runnerToolLookup('brush', '/home/t')
  const located = await locateTool(brush, { ...fakes(['/home/t/brush/target/release/brush-cli']), env: () => undefined })
  assertEquals(located.via, 'fallback')
  assertEquals(located.searched, ['PATH:brush-cli', '/home/t/brush/target/release/brush-cli'])
})

Deno.test('locateTool: an env var that names nothing is missing, never replaced by the fallback', async () => {
  const brush = runnerToolLookup('brush', '/home/t')
  const located = await locateTool(brush, {
    ...fakes(['/home/t/brush/target/release/brush-cli']),
    env: (n) => (n === 'BRUSH_BIN' ? '/typo/brush-cli' : undefined),
  })
  assertEquals(located.found, false)
  assertEquals(located.path, '/typo/brush-cli')
  const skip = toolSkip(brush, located, 'Brush binary')
  assertStringIncludes(skip.skippedReason, 'Brush binary not found')
  assertStringIncludes(skip.skippedReason, '/typo/brush-cli')
  assertStringIncludes(skip.remediation, 'BRUSH_BIN')
})

Deno.test('locateTool: an explicit bare interpreter name is looked up on PATH, as the spawn would', async () => {
  // LINGBOT_MAP_PYTHON=python3.11 used to be probed as a file in the server's cwd and reported missing.
  const lookup = runnerToolLookup('lingbot-map-python', '/home/t')
  const located = await locateTool(lookup, {
    ...fakes(['/usr/bin/python3.11'], [], ['/usr/bin']),
    env: (n) => (n === 'LINGBOT_MAP_PYTHON' ? 'python3.11' : undefined),
  })
  assertEquals(located, { found: true, path: '/usr/bin/python3.11', via: 'env', searched: ['PATH:python3.11'] })
})

Deno.test('locateTool: a runner option wins over the env var', async () => {
  const lookup = runnerToolLookup('spirula', '/home/t')
  const located = await locateTool(lookup, {
    ...fakes(['/a/spirula', '/b/spirula']),
    env: (n) => (n === 'SPIRULA_BIN' ? '/b/spirula' : undefined),
    explicit: '/a/spirula',
  })
  assertEquals(located.path, '/a/spirula')
})

Deno.test('locateTool: a PATH hit the caller rejects moves on to the fallback', async () => {
  const lookup = runnerToolLookup('colmap', '/home/t')
  const fallback = '/home/t/.local/micromamba/envs/colmap/bin/colmap'
  const located = await locateTool(lookup, {
    ...fakes(['/usr/bin/colmap', fallback], [], ['/usr/bin']),
    env: () => undefined,
    acceptPathHit: () => Promise.resolve(false),
  })
  assertEquals(located.path, fallback)
  assertEquals(located.via, 'fallback')
})

Deno.test('locateTool: a path kind accepts a directory or a file', async () => {
  const lookup = runnerToolLookup('sensenova-model', '/home/t')
  const asDir = await locateTool(lookup, { ...fakes([], ['/models/m']), env: (n) => (n === 'SENSENOVA_MODEL_PATH' ? '/models/m' : undefined) })
  const asFile = await locateTool(lookup, { ...fakes(['/models/m.bin']), env: (n) => (n === 'SENSENOVA_MODEL_PATH' ? '/models/m.bin' : undefined) })
  assert(asDir.found && asFile.found)
})

Deno.test('the report and the runners read one table: every report row with a lookup has the same paths', () => {
  const lookups = runnerToolLookups('/home/t')
  for (const spec of toolSpecs('/home/t')) {
    const lookup = lookups[spec.id as RunnerToolId]
    assert(lookup, `${spec.id} has no row in the shared table`)
    assertEquals(spec.envVar, lookup.envVar, spec.id)
    assertEquals(spec.pathName, lookup.pathName, spec.id)
    assertEquals(spec.fallbacks, lookup.fallbacks, spec.id)
    assertEquals(spec.remediation, lookup.remediation, spec.id)
  }
})

Deno.test({
  name: 'Brush found only on PATH: the report says found via PATH, and the job trains instead of skipping',
  ignore: isWindows,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-runners-path-' })
    const previousPath = Deno.env.get('PATH') ?? ''
    const previousBin = Deno.env.get('BRUSH_BIN')
    try {
      const bin = `${root}/brush-cli`
      await Deno.writeTextFile(bin, '#!/bin/sh\nexit 0\n')
      await Deno.chmod(bin, 0o755)
      Deno.env.set('PATH', `${root}:${previousPath}`)
      Deno.env.delete('BRUSH_BIN')

      const report = await probeCapabilities({ versions: false })
      const brush = report.tools.find((t) => t.id === 'brush')!
      assertEquals(brush.found, true)
      assertEquals(brush.via, 'path')
      assertEquals(brush.path, bin)

      // The job resolves the same binary: it gets as far as the dataset (an empty
      // session has no keyframes, which is a different skip), not "Brush not found".
      const sessionDir = `${root}/sess-path-abcd`
      await Deno.mkdir(sessionDir)
      const result = await runSplatTrain({ sessionDir, outputPlyPath: `${root}/x.splat.ply`, autoSolvePoses: false })
      assert(!(result.manifest.skippedReason ?? '').includes('Brush binary not found'), result.manifest.skippedReason)
      assertEquals(result.manifest.params.brushBin, bin)
    } finally {
      Deno.env.set('PATH', previousPath)
      if (previousBin !== undefined) Deno.env.set('BRUSH_BIN', previousBin)
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'Spirula found only on PATH resolves to that path, the one the report shows',
  ignore: isWindows,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-runners-spirula-' })
    const previousPath = Deno.env.get('PATH') ?? ''
    const previousBin = Deno.env.get('SPIRULA_BIN')
    try {
      const bin = `${root}/spirula`
      await Deno.writeTextFile(bin, '#!/bin/sh\nexit 0\n')
      await Deno.chmod(bin, 0o755)
      Deno.env.set('PATH', `${root}:${previousPath}`)
      Deno.env.delete('SPIRULA_BIN')
      assertEquals(await resolveSpirulaBin({ sessionDir: '/x', outputPlyPath: '/x/a.splat.ply' }), bin)
    } finally {
      Deno.env.set('PATH', previousPath)
      if (previousBin !== undefined) Deno.env.set('SPIRULA_BIN', previousBin)
      await Deno.remove(root, { recursive: true })
    }
  },
})
