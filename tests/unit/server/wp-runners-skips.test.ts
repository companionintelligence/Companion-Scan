/**
 * Wave 14-0002 (F-29, FN-136): a missing tool is a uniform skip.
 *
 * Before this, three runners failed the job when the program they spawn was not
 * there, while a missing model or CLI beside it was a green skip: LingBot-Map's
 * interpreter (lingbot_map.test.ts covers it), splat-finish's node, and a
 * SenseNova model path that names nothing. Each is now a skip carrying the
 * remediation the capability report prints, and a manifest.
 *
 * Run: node --test tests/unit/server/wp-runners-skips.test.ts
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from './assert.ts'
import { runnerToolLookup } from '../../../server/exec_probe.ts'
import { runSplatFinish } from '../../../server/splat/splat_finish.ts'
import { gpuPinEnv, resolveParams as resolveDetectParams } from '../../../server/splat/splat_detect.ts'
import { runSenseNovaVision } from '../../../server/sensenova_vision.ts'
import { buildDatasetWithAutoPoses } from '../../../server/splat/auto_poses.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'
import { makeTempDir } from '../../../server/fs_util.ts'

async function makeSplat(dir: string): Promise<string> {
  const path = `${dir}/scan.splat.ply`
  await fs.writeFile(path, 'ply\nformat binary_little_endian 1.0\nelement vertex 3\nend_header\n')
  return path
}

test('splat-finish: a node that is not there is a skip with the shared remediation, not a spawn error', async () => {
  const tmp = await makeTempDir({ prefix: 'wp-runners-finish-' })
  try {
    const cli = `${tmp}/cli.mjs`
    await fs.writeFile(cli, '')
    const result = await runSplatFinish({
      splatPlyPath: await makeSplat(tmp),
      outputSogPath: `${tmp}/scan.sog`,
      outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
      cliPath: cli,
      nodeBin: '/this/node/definitely/does/not/exist',
    })
    assertEquals(result.status, 'skipped')
    assertEquals(result.exitCode, 0)
    assertStringIncludes(result.manifest.skippedReason ?? '', '/this/node/definitely/does/not/exist')
    assertEquals(result.manifest.remediation, runnerToolLookup('splat-finish-node').remediation)
    const written = JSON.parse(await fs.readFile(`${tmp}/scan.splat-finish.manifest.json`, 'utf8'))
    assertEquals(written.status, 'skipped')
  } finally {
    await fs.rm(tmp, { recursive: true })
  }
})

test('splat-finish: a _spawn test is not at the mercy of the host node, unless it asks to be', async () => {
  const tmp = await makeTempDir({ prefix: 'wp-runners-finish-' })
  try {
    const cli = `${tmp}/cli.mjs`
    await fs.writeFile(cli, '')
    const calls: string[] = []
    const result = await runSplatFinish({
      splatPlyPath: await makeSplat(tmp),
      outputSogPath: `${tmp}/scan.sog`,
      outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
      cliPath: cli,
      nodeBin: 'no-such-node-anywhere',
      _nodeFound: () => Promise.resolve(false),
      _spawn: (bin) => {
        calls.push(bin)
        return Promise.resolve({ code: 0, stderr: '' })
      },
    })
    assertEquals(result.status, 'skipped')
    assertEquals(calls, [], 'a node the seam calls missing must not be spawned')
  } finally {
    await fs.rm(tmp, { recursive: true })
  }
})

test('SenseNova: a model path that names nothing is a skip that says so, before any launcher runs', async () => {
  const root = await makeTempDir({ prefix: 'wp-runners-sensenova-' })
  try {
    const repo = `${root}/repo`
    await fs.mkdir(`${repo}/scripts`, { recursive: true })
    await fs.writeFile(`${repo}/scripts/run_sensenova_vision.sh`, 'exit 99\n')
    const result = await runSenseNovaVision({
      sessionDir: `${root}/sess-x`,
      outputDir: `${root}/out`,
      task: 'recon3d',
      repoDir: repo,
      modelPath: `${root}/no-such-model`,
      bashBin: process.execPath,
    })
    assertEquals(result.status, 'skipped')
    assertStringIncludes(result.remediation ?? '', `${root}/no-such-model`)
    assertStringIncludes(result.remediation ?? '', 'SENSENOVA_MODEL_PATH')
  } finally {
    await fs.rm(root, { recursive: true })
  }
})

test('splat-detect: with HIP_VISIBLE_DEVICES unset there is no GPU pin, and the manifest records an empty one', () => {
  const previous = process.env.HIP_VISIBLE_DEVICES
  try {
    delete process.env.HIP_VISIBLE_DEVICES
    const params = resolveDetectParams({ outputInteractionsPath: '/x/a.interactions.json' })
    // '1' named the second GPU of one host, and a device that does not exist on a single-GPU box.
    assertEquals(params.hipVisibleDevices, '')
    assertEquals(gpuPinEnv(params.hipVisibleDevices), {})
    assertFalse('HIP_VISIBLE_DEVICES' in gpuPinEnv(params.hipVisibleDevices))
    // A host that needs a pin sets it, and it is passed through.
    process.env.HIP_VISIBLE_DEVICES = '1'
    assertEquals(gpuPinEnv(resolveDetectParams({ outputInteractionsPath: '/x/a.interactions.json' }).hipVisibleDevices), {
      HIP_VISIBLE_DEVICES: '1',
    })
  } finally {
    if (previous === undefined) delete process.env.HIP_VISIBLE_DEVICES
    else process.env.HIP_VISIBLE_DEVICES = previous
  }
})

// ── The shared auto-COLMAP block (F-43), driven through its seams ───────────

const fakeDataset = { frameCount: 3 } as unknown as Awaited<ReturnType<typeof import('../../../server/splat/splat_train_dataset.ts').buildBrushDataset>>

test('auto poses: a pose-less session is solved once and then built', async () => {
  let builds = 0
  let solves = 0
  const out = await buildDatasetWithAutoPoses({ sessionDir: '/s/sess-a' }, true, {
    build: () => {
      builds++
      return builds === 1 ? Promise.reject(new Error('no camera poses in this session')) : Promise.resolve(fakeDataset)
    },
    solve: () => {
      solves++
      return Promise.resolve({ status: 'ok', manifest: {}, log: '', exitCode: 0 } as never)
    },
  })
  assert(out.ok)
  assertEquals([builds, solves], [2, 1])
})

test('auto poses: a COLMAP skip is the trainer skip, with COLMAP\'s own reason and fix', async () => {
  const out = await buildDatasetWithAutoPoses({ sessionDir: '/s/sess-a' }, true, {
    build: () => Promise.reject(new Error('no camera poses in this session')),
    solve: () =>
      Promise.resolve({
        status: 'skipped',
        manifest: { skippedReason: 'COLMAP binary not found', remediation: 'Install COLMAP' },
        log: 'colmap missing',
        exitCode: 0,
      } as never),
  })
  assert(!out.ok)
  assertEquals(out.failure.manifest, { status: 'skipped', skippedReason: 'COLMAP binary not found', remediation: 'Install COLMAP' })
  assertEquals(out.failure.exitCode, 0)
})

test('auto poses: with auto-solve off, or for any other build failure, COLMAP is never run', async () => {
  let solves = 0
  const solve = () => {
    solves++
    return Promise.resolve({ status: 'ok', manifest: {}, log: '', exitCode: 0 } as never)
  }
  const off = await buildDatasetWithAutoPoses({ sessionDir: '/s/sess-a' }, false, {
    build: () => Promise.reject(new Error('no camera poses in this session')),
    solve,
  })
  assert(!off.ok)
  assertEquals(off.failure.manifest.status, 'error')
  const empty = await buildDatasetWithAutoPoses({ sessionDir: '/s/sess-a' }, true, {
    build: () => Promise.reject(new Error('no keyframes found')),
    solve,
  })
  assert(!empty.ok)
  assertEquals(empty.failure.manifest.status, 'skipped')
  assertEquals(solves, 0)
})
