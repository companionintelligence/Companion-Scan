/**
 * CLI-contract tests for the pose solve that `splat-train` auto-chains.
 *
 * `runSplatTrain` calls `runColmapPoses` whenever a session's keyframes carry
 * no pose (photo/video ingest), so COLMAP's argument list is part of the splat
 * path, not a separate concern — and it is the part no other test could see:
 * every existing COLMAP test either injects `_spawn` without inspecting the
 * arguments or stops before the binary is reached. Two argument names were
 * wrong against COLMAP 3.13.0 (the build docs/pipelines/splat-train.md § Setup
 * installs), and both aborted the step with exit 1 rather than degrading:
 *
 *   Failed to parse options - unrecognised option '--FeatureExtraction.max_image_size'.
 *   Failed to parse options - Unknown string value: SIFT_BRUTEFORCE for enum: FeatureMatcherType.
 *
 * These are string-for-string assertions on purpose. COLMAP validates option
 * names and enum members strictly, so "close enough" is indistinguishable from
 * "not installed" once it reaches the manifest — which is exactly how both bugs
 * survived: the manifest recorded `feature_extractor failed (exit 1)` and threw
 * COLMAP's own explanation away.
 */
import { assertEquals } from './assert.ts'
import { assert } from './assert.ts'
import { assertStringIncludes } from './assert.ts'

import { resolveColmapBin, resolveParams, runColmapPoses } from '../../../server/colmap/colmap_poses.ts'
import * as fs from 'node:fs/promises'
import { makeTempDir } from '../../../server/fs_util.ts'
import { test } from 'node:test'

/** A session with the 3 keyframes COLMAP's own floor requires. */
async function makeSession(): Promise<string> {
  const dir = await makeTempDir({ prefix: 'colmap-args-' })
  const sessionDir = `${dir}/sess-args-test`
  await fs.mkdir(sessionDir)
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(`${sessionDir}/kf-0000${i}.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
  }
  return sessionDir
}

/** Run the solver with a recording spawn that fails the first step. */
async function captureArgs() {
  const sessionDir = await makeSession()
  const calls: string[][] = []
  const result = await runColmapPoses({
    sessionDir,
    // A real path so the runnable probe passes without touching a real COLMAP.
    colmapBin: process.execPath,
    _spawn: (_bin, args) => {
      calls.push(args)
      return Promise.resolve({ code: 1, stderr: 'E20260828 option_manager.cc:976] Failed to parse options - test' })
    },
  })
  return { calls, result, sessionDir }
}

test('feature_extractor asks for max_image_size under SiftExtraction, not FeatureExtraction', async () => {
  const { calls } = await captureArgs()
  const args = calls[0]
  assertEquals(args[0], 'feature_extractor')
  // The generic options DID move to FeatureExtraction.* in COLMAP 3.12 …
  assert(args.includes('--FeatureExtraction.type'), 'type stays on the new prefix')
  assert(args.includes('--FeatureExtraction.use_gpu'), 'use_gpu stays on the new prefix')
  // … but the SIFT-specific ones did not, and COLMAP aborts on the wrong one.
  assert(args.includes('--SiftExtraction.max_image_size'), `missing SiftExtraction.max_image_size: ${args.join(' ')}`)
  assert(
    !args.includes('--FeatureExtraction.max_image_size'),
    'COLMAP 3.13 rejects --FeatureExtraction.max_image_size outright (exit 1)',
  )
})

test('the default matcher type is an enum member COLMAP accepts', () => {
  // FeatureMatcherType is an enum: an unknown member is a parse abort, not a
  // fallback. SIFT is the only value the 3.13.0 build accepts (SIFT_BRUTEFORCE,
  // BRUTE_FORCE, ALIKED, LIGHTGLUE and ALIKED_LIGHTGLUE were all probed and
  // rejected). Brute force is what SIFT matching does by default anyway.
  const prev = process.env.COLMAP_MATCHER_TYPE
  try {
    delete process.env.COLMAP_MATCHER_TYPE
    assertEquals(resolveParams({ sessionDir: '/x' }).matcherType, 'SIFT')
  } finally {
    if (prev !== undefined) process.env.COLMAP_MATCHER_TYPE = prev
  }
})

test('a failed COLMAP step puts COLMAP\'s own message on the manifest', async () => {
  // The manifest is the durable record; the log is returned once and dropped.
  // "feature_extractor failed (exit 1)" alone is where the trail used to end.
  const { result, sessionDir } = await captureArgs()
  assertEquals(result.status, 'error')
  assertStringIncludes(result.manifest.error ?? '', 'feature_extractor failed (exit 1)')
  assertStringIncludes(result.manifest.error ?? '', 'Failed to parse options')
  const written = JSON.parse(await fs.readFile(`${sessionDir}/colmap-poses.manifest.json`, 'utf8'))
  assertStringIncludes(written.error, 'Failed to parse options')
})

test('resolveColmapBin probes the documented user-local install before giving up', async () => {
  // An explicit binary is taken at its word …
  assertEquals(await resolveColmapBin(process.execPath), process.execPath)
  assertEquals(await resolveColmapBin('/definitely/not/a/colmap'), null)
  // … while the bare default means "find one": PATH first, then the sudo-less
  // micromamba env our own setup docs tell the operator to create, which is not
  // on PATH unless activated. Whichever this box has, the answer must be a
  // runnable path or null — never the unprobed literal 'colmap'.
  const found = await resolveColmapBin('colmap')
  assert(found === null || found === 'colmap' || found.endsWith('/colmap'), `unexpected resolution: ${found}`)
})
