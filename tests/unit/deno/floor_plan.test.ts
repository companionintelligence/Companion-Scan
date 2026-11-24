/**
 * The floor-plan driver (server/floor_plan.ts) and its worker (scripts/floor_plan_worker.py), ported from PR #273.
 *
 * Through the `_spawn` seam: the argument order, every skip (no cloud, a degenerate cloud, no interpreter, no worker,
 * no numpy) and every error (a crash, a timeout, no plan, a plan that is not JSON), and that a failed run leaves a plan
 * already beside the scan alone. Then the real worker, twice: once with numpy shadowed by a module that will not
 * import, which must come back as a skip and not a failure, and once on a synthetic 4 x 3 box room, which must come
 * back within 10% of the truth. The real runs need the interpreter the job would use (`floorPlanPython`); without one
 * they are ignored, and `deno test` lists them as ignored.
 *
 * Also the job's place in the rules table and the chain predicate (server/world/job_request.ts).
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'

import {
  buildFloorPlanArgs,
  isValidSessionDir,
  NO_NUMPY_REMEDIATION,
  resolveParams,
  runFloorPlan,
  summarizePlan,
} from '../../../server/floor_plan.ts'
import { numFromEnv } from '../../../server/run_with_deadline.ts'
import {
  floorPlanFollowsReconstruct,
  REQUEST_ONLY_JOB_TYPES,
  REQUESTABLE_JOB_TYPES,
  WORLD_JOB_RULES,
} from '../../../server/world/job_request.ts'
import { jobRequiresScan } from '../../../src/world/job-types.ts'
import { floorPlanPython, ROOM, TINY_PLY, writeBoxRoomPly } from './floor_plan_fixtures.ts'

const PYTHON = await floorPlanPython()
/** Any file that exists and is executable, to stand in for an interpreter the `_spawn` seam never runs. */
const RUNNABLE = Deno.execPath()
const NEVER = () => {
  throw new Error('spawn must not be reached')
}

/** A temp dir holding a server-shaped session dir (`sess-…`), with `ply` written as its LingBot-Map cloud. */
async function makeSession(ply?: Uint8Array, lingbotManifest?: unknown): Promise<{ tmp: string; session: string }> {
  const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-test-' })
  const session = `${tmp}/sess-floorplan-test`
  await Deno.mkdir(session, { recursive: true })
  if (ply) await Deno.writeFile(`${session}/lingbot-map.point-cloud.ply`, ply)
  if (lingbotManifest) await Deno.writeTextFile(`${session}/lingbot-map.manifest.json`, JSON.stringify(lingbotManifest))
  return { tmp, session }
}

function outputs(tmp: string) {
  return {
    outputJsonPath: `${tmp}/scan.floor-plan.json`,
    outputSvgPath: `${tmp}/scan.floor-plan.svg`,
  }
}

async function readManifest(tmp: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(`${tmp}/scan.floor-plan.manifest.json`))
}

const PLAN = {
  areaM2: 12.0,
  ceilingHeightM: 2.5,
  disclaimer: 'derived, not survey-grade; in the point cloud\'s own units',
  walls: [{}, {}, {}, {}],
  rooms: [{ polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], areaM2: 12.0 }],
}

// ── Params and arguments ────────────────────────────────────────────────────

Deno.test('resolveParams: an explicit worker and wall length win; a wall length that is not a number takes the default', () => {
  const p = resolveParams({ workerPath: '/opt/worker.py', minWallM: 0.8 })
  assertEquals(p.workerPath, '/opt/worker.py')
  assertEquals(p.minWallM, 0.8)
  assertEquals(resolveParams({ minWallM: Number.NaN }).minWallM, numFromEnv('FLOORPLAN_MIN_WALL_M', 0.5))
  assertEquals(resolveParams({ minWallM: -1 }).minWallM, numFromEnv('FLOORPLAN_MIN_WALL_M', 0.5))
  assert(resolveParams({}).workerPath.endsWith('floor_plan_worker.py'), 'the default is the worker this checkout ships')
})

Deno.test('buildFloorPlanArgs assembles the worker CLI in a stable order', () => {
  assertEquals(
    buildFloorPlanArgs('/repo/scripts/floor_plan_worker.py', '/sess/lingbot-map.point-cloud.ply', '/job/plan.json', '/job/plan.svg', { minWallM: 0.5 }),
    [
      '/repo/scripts/floor_plan_worker.py',
      '--ply', '/sess/lingbot-map.point-cloud.ply',
      '--out-json', '/job/plan.json',
      '--out-svg', '/job/plan.svg',
      '--min-wall-m', '0.5',
    ],
  )
})

Deno.test('isValidSessionDir is the shared check: a server session id, nothing else', () => {
  assert(isValidSessionDir('/data/sessions/sess-abc-123'))
  assertFalse(isValidSessionDir('/data/sessions/../../etc'))
  assertFalse(isValidSessionDir('/data/sessions/whatever'))
})

Deno.test('summarizePlan pulls the headline numbers and the disclaimer, and rejects what is not a plan', () => {
  const s = summarizePlan(JSON.stringify({ areaM2: 11.9, ceilingHeightM: 2.5, walls: [{}, {}, {}, {}], rooms: [{ polygon: [], areaM2: 11.9 }] }))
  assertEquals(s, { areaM2: 11.9, wallCount: 4, roomCount: 1, ceilingHeightM: 2.5 })
  assertEquals(summarizePlan(JSON.stringify(PLAN))?.disclaimer, PLAN.disclaimer)
  assertEquals(summarizePlan(JSON.stringify({ walls: [], rooms: [], areaM2: 'big' }))?.areaM2, 0, 'a number that is not one reads as 0')
  assertEquals(summarizePlan('not json'), null)
  assertEquals(summarizePlan('{"walls": 3}'), null)
  assertEquals(summarizePlan('[[], []]'), null)
  assertEquals(summarizePlan('null'), null)
})

// ── Skips: the worker is never started ──────────────────────────────────────

Deno.test('runFloorPlan skips a scan whose session has no point cloud, and names the job that makes one', async () => {
  const { tmp, session } = await makeSession()
  try {
    const result = await runFloorPlan({ sessionDir: session, ...outputs(tmp), python: RUNNABLE, _spawn: NEVER })
    assertEquals(result.status, 'skipped')
    assertEquals(result.exitCode, 0)
    assertStringIncludes(result.manifest.skippedReason ?? '', 'no point cloud')
    assertStringIncludes(result.manifest.remediation ?? '', 'lingbot-map-reconstruct')
    const written = await readManifest(tmp)
    assertEquals(written.status, 'skipped')
    assertEquals(written.tool, 'floor-plan-worker')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan skips a scan with no session, and a directory that is not a server session', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-test-' })
  try {
    const none = await runFloorPlan({ ...outputs(tmp), python: RUNNABLE, _spawn: NEVER })
    assertEquals(none.status, 'skipped')
    assertStringIncludes(none.manifest.skippedReason ?? '', 'no point cloud')
    // A cloud is there, but not in a session dir: it is not read.
    await Deno.mkdir(`${tmp}/not-a-session`)
    await Deno.writeFile(`${tmp}/not-a-session/lingbot-map.point-cloud.ply`, TINY_PLY)
    const stray = await runFloorPlan({ sessionDir: `${tmp}/not-a-session`, ...outputs(tmp), python: RUNNABLE, _spawn: NEVER })
    assertEquals(stray.status, 'skipped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan skips a cloud its own LingBot run judged degenerate, as splat-detect does', async () => {
  const { tmp, session } = await makeSession(TINY_PLY, { status: 'error', quality: { degenerate: true } })
  try {
    const result = await runFloorPlan({ sessionDir: session, ...outputs(tmp), python: RUNNABLE, _spawn: NEVER })
    assertEquals(result.status, 'skipped')
    assertStringIncludes(result.manifest.skippedReason ?? '', 'degenerate')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan skips when the interpreter is not found, with the remediation GET /capabilities prints', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    const result = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: `${tmp}/no/such/python`,
      _spawn: NEVER,
    })
    assertEquals(result.status, 'skipped')
    assertEquals(result.exitCode, 0)
    assertStringIncludes(result.manifest.skippedReason ?? '', 'not found')
    assertStringIncludes(result.manifest.remediation ?? '', 'LINGBOT_MAP_PYTHON')
    assertEquals((await readManifest(tmp)).status, 'skipped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan skips when the worker script is missing, and says how to point at one', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    const result = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      workerPath: `${tmp}/no/floor_plan_worker.py`,
      _spawn: NEVER,
    })
    assertEquals(result.status, 'skipped')
    assertStringIncludes(result.manifest.skippedReason ?? '', 'floor_plan_worker.py not found')
    assertStringIncludes(result.manifest.remediation ?? '', 'FLOORPLAN_WORKER')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

// ── Through the seam: ok, skip and error ────────────────────────────────────

Deno.test('runFloorPlan lands the plan JSON and SVG and writes an ok manifest with the disclaimer', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    const spawns: Array<{ bin: string; args: string[] }> = []
    const result = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      minWallM: 0.7,
      provenance: { sessionId: 'sess-floorplan-test', scanId: 'scan-3' },
      _spawn: async (bin, args) => {
        spawns.push({ bin, args })
        await Deno.writeTextFile(args[args.indexOf('--out-json') + 1]!, JSON.stringify(PLAN))
        await Deno.writeTextFile(args[args.indexOf('--out-svg') + 1]!, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        return { code: 0, stderr: '' }
      },
    })

    assertEquals(result.status, 'ok')
    assertEquals(spawns.length, 1)
    assertEquals(spawns[0]!.bin, RUNNABLE, 'the interpreter it was given')
    const args = spawns[0]!.args
    assertEquals(args[args.indexOf('--ply') + 1], `${session}/lingbot-map.point-cloud.ply`)
    assertEquals(args[args.indexOf('--min-wall-m') + 1], '0.7')
    assertFalse(args[args.indexOf('--out-json') + 1]!.startsWith(tmp), 'the worker writes into its own temp dir')
    assertEquals(result.areaM2, 12)
    assertEquals(result.wallCount, 4)
    assertEquals(await Deno.readTextFile(`${tmp}/scan.floor-plan.json`), JSON.stringify(PLAN))
    assertStringIncludes(await Deno.readTextFile(`${tmp}/scan.floor-plan.svg`), '<svg')

    const manifest = await readManifest(tmp)
    assertEquals(manifest.status, 'ok')
    assertEquals(manifest.planPath, 'scan.floor-plan.json')
    assertEquals(manifest.svgPath, 'scan.floor-plan.svg')
    assertEquals(manifest.areaM2, 12)
    assertEquals(manifest.wallCount, 4)
    assertEquals(manifest.roomCount, 1)
    assertEquals(manifest.ceilingHeightM, 2.5)
    assertEquals(manifest.disclaimer, PLAN.disclaimer)
    assertEquals(manifest.sessionId, 'sess-floorplan-test')
    assertEquals(manifest.scanId, 'scan-3')
    assertEquals((manifest.params as { minWallM: number }).minWallM, 0.7)
    assert(typeof (manifest.timing as { elapsedMs?: number } | undefined)?.elapsedMs === 'number')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan reads the worker\'s exit 3 as numpy missing: a skip with the fix, not a failure', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    const result = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      _spawn: () => Promise.resolve({ code: 3, stderr: 'floor-plan: numpy is not installed for this interpreter' }),
    })
    assertEquals(result.status, 'skipped')
    assertEquals(result.exitCode, 0)
    assertStringIncludes(result.manifest.skippedReason ?? '', 'numpy is not installed')
    assertEquals(result.manifest.remediation, NO_NUMPY_REMEDIATION)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan surfaces a worker crash as an error manifest with the stderr tail', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    const result = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      _spawn: () => Promise.resolve({ code: 2, stderr: 'floor-plan: too few points (3)' }),
    })
    assertEquals(result.status, 'error')
    assertEquals(result.exitCode, 2)
    assertStringIncludes(result.log, 'too few points')
    const manifest = await readManifest(tmp)
    assertEquals(manifest.status, 'error')
    assertStringIncludes(String(manifest.error), 'exited 2')
    assertStringIncludes(String(manifest.error), 'too few points')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan reports a run its deadline stopped as stopped, even when the kill left code 3', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    const result = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      _spawn: () => Promise.resolve({ code: 3, stderr: '', timeoutReason: 'timed out after 10 min' }),
    })
    assertEquals(result.status, 'error')
    assertStringIncludes(result.manifest.error ?? '', 'timed out after 10 min and was stopped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('runFloorPlan errors when the worker exits 0 but wrote no plan, or a plan that is not one', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    const silent = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      _spawn: () => Promise.resolve({ code: 0, stderr: '' }),
    })
    assertEquals(silent.status, 'error')
    assertStringIncludes(silent.manifest.error ?? '', 'produced no plan')

    const garbled = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      _spawn: async (_bin, args) => {
        await Deno.writeTextFile(args[args.indexOf('--out-json') + 1]!, '{"walls": "four"}')
        await Deno.writeTextFile(args[args.indexOf('--out-svg') + 1]!, '<svg/>')
        return { code: 0, stderr: '' }
      },
    })
    assertEquals(garbled.status, 'error')
    assertStringIncludes(garbled.manifest.error ?? '', 'unparseable')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('a failed run leaves the plan already beside the scan as it was', async () => {
  const { tmp, session } = await makeSession(TINY_PLY)
  try {
    await Deno.writeTextFile(`${tmp}/scan.floor-plan.json`, JSON.stringify(PLAN))
    await Deno.writeTextFile(`${tmp}/scan.floor-plan.svg`, '<svg>earlier</svg>')
    const result = await runFloorPlan({
      sessionDir: session,
      ...outputs(tmp),
      python: RUNNABLE,
      _spawn: async (_bin, args) => {
        // Half a run: the worker wrote its JSON and died before the SVG.
        await Deno.writeTextFile(args[args.indexOf('--out-json') + 1]!, '{"partial": true}')
        return { code: 1, stderr: 'Traceback (most recent call last): MemoryError' }
      },
    })
    assertEquals(result.status, 'error')
    assertEquals(await Deno.readTextFile(`${tmp}/scan.floor-plan.json`), JSON.stringify(PLAN))
    assertEquals(await Deno.readTextFile(`${tmp}/scan.floor-plan.svg`), '<svg>earlier</svg>')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

// ── The real worker ─────────────────────────────────────────────────────────

Deno.test({
  name: 'the real worker without numpy exits 3, and the job reads that as a skip',
  ignore: PYTHON === null,
  fn: async () => {
    const { tmp, session } = await makeSession(TINY_PLY)
    // A `numpy` package that refuses to import, ahead of the real one on the path.
    const shadow = `${tmp}/shadow`
    await Deno.mkdir(`${shadow}/numpy`, { recursive: true })
    await Deno.writeTextFile(`${shadow}/numpy/__init__.py`, 'raise ImportError("numpy hidden by the floor-plan test")\n')
    try {
      const result = await runFloorPlan({
        sessionDir: session,
        ...outputs(tmp),
        python: PYTHON!.path,
        _spawn: async (bin, args) => {
          const out = await new Deno.Command(bin, { args, env: { PYTHONPATH: shadow }, stdout: 'piped', stderr: 'piped' }).output()
          return { code: out.code, stderr: new TextDecoder().decode(out.stderr) }
        },
      })
      assertEquals(result.status, 'skipped', `worker said: ${result.log}`)
      assertStringIncludes(result.log, 'numpy is not installed')
      assertEquals(result.manifest.remediation, NO_NUMPY_REMEDIATION)
    } finally {
      await Deno.remove(tmp, { recursive: true })
    }
  },
})

Deno.test({
  name: 'the real worker draws a 4 x 3 box room within 10% of the truth, and says what its numbers are',
  ignore: !PYTHON?.numpy,
  fn: async () => {
    const { tmp, session } = await makeSession()
    try {
      const count = await writeBoxRoomPly(`${session}/lingbot-map.point-cloud.ply`)
      assert(count >= 49000, `fixture should be ~50k points, got ${count}`)

      const result = await runFloorPlan({
        sessionDir: session,
        ...outputs(tmp),
        python: PYTHON!.path,
        provenance: { sessionId: 'sess-floorplan-test', scanId: 'scan-room' },
      })
      assertEquals(result.status, 'ok', `worker failed: ${result.manifest.error ?? result.log}`)

      const plan = JSON.parse(await Deno.readTextFile(`${tmp}/scan.floor-plan.json`))
      // Four dominant walls (RANSAC may split a wall across gaps, so up to two more).
      assert(plan.wallCount >= 4 && plan.wallCount <= 6, `expected ~4 walls, got ${plan.wallCount}`)
      const truth = ROOM.width * ROOM.depth
      assert(Math.abs(plan.areaM2 - truth) <= truth * 0.1, `areaM2 ${plan.areaM2} not within 10% of ${truth}`)
      assert(Math.abs(plan.ceilingHeightM - ROOM.height) <= 0.1, `ceilingHeightM ${plan.ceilingHeightM}`)
      assertEquals(plan.upAxis, 'z')
      assertEquals(plan.disclaimer, 'derived, not survey-grade; in the point cloud\'s own units')
      assertEquals(plan.rooms[0]?.method, 'rectilinear', 'a box room closes as a rectangle')

      // A standalone SVG, with dimension labels that carry no unit, a one-unit scale bar and the disclaimer.
      const svg = await Deno.readTextFile(`${tmp}/scan.floor-plan.svg`)
      assertStringIncludes(svg, '<svg xmlns="http://www.w3.org/2000/svg"')
      assertStringIncludes(svg, '</svg>')
      assert(/<text class="dimension"[^>]*>\d+\.\d\d<\/text>/.test(svg), 'a dimension label is a bare number')
      assertFalse(/ m<\/text>/.test(svg), 'no label claims metres')
      assertStringIncludes(svg, '>1 unit</text>')
      assertStringIncludes(svg, plan.disclaimer)
      assertFalse(/<script|on[a-z]+=/i.test(svg), 'the drawing runs nothing')

      const manifest = await readManifest(tmp)
      assertEquals(manifest.status, 'ok')
      assertEquals(manifest.wallCount, plan.wallCount)
      assertEquals(manifest.areaM2, plan.areaM2)
      assertEquals(manifest.disclaimer, plan.disclaimer)
      assertEquals((manifest.params as { python: string }).python, PYTHON!.path)

      // Deterministic: a second run over the same cloud writes the same plan.
      const again = await runFloorPlan({
        sessionDir: session,
        outputJsonPath: `${tmp}/again.floor-plan.json`,
        outputSvgPath: `${tmp}/again.floor-plan.svg`,
        python: PYTHON!.path,
      })
      assertEquals(again.status, 'ok')
      assertEquals(await Deno.readTextFile(`${tmp}/again.floor-plan.json`), await Deno.readTextFile(`${tmp}/scan.floor-plan.json`))
    } finally {
      await Deno.remove(tmp, { recursive: true })
    }
  },
})

Deno.test({
  name: 'the real worker refuses a cloud that is not a PLY with exit 2, which the job reports as an error',
  ignore: !PYTHON?.numpy,
  fn: async () => {
    const { tmp, session } = await makeSession(new TextEncoder().encode('not a ply at all'))
    try {
      const result = await runFloorPlan({ sessionDir: session, ...outputs(tmp), python: PYTHON!.path })
      assertEquals(result.status, 'error')
      assertEquals(result.exitCode, 2)
      assertStringIncludes(result.manifest.error ?? '', 'cannot read the point cloud')
    } finally {
      await Deno.remove(tmp, { recursive: true })
    }
  },
})

// ── The job's rules ─────────────────────────────────────────────────────────

Deno.test('floor-plan reads a scan, is queued by request and by a reconstruction, and is deduped per scan', () => {
  assertEquals(WORLD_JOB_RULES['floor-plan'], { needsScan: true, startedBy: ['jobs-api', 'chain'], dedupe: 'target' })
  assert(REQUESTABLE_JOB_TYPES.has('floor-plan'))
  assertFalse(REQUEST_ONLY_JOB_TYPES.includes('floor-plan'), 'a reconstruction queues it too')
  assert(jobRequiresScan('floor-plan'), 'the editor asks for a selected scan before it sends one')
})

Deno.test('a reconstruction that succeeded queues a floor plan, unless FLOORPLAN_AUTO turned that off', () => {
  assert(floorPlanFollowsReconstruct({ status: 'ok' }, true))
  assertFalse(floorPlanFollowsReconstruct({ status: 'ok' }, false))
  assertFalse(floorPlanFollowsReconstruct({ status: 'skipped' }, true), 'a skipped run wrote no cloud')
  assertFalse(floorPlanFollowsReconstruct({ status: 'error' }, true), 'a degenerate cloud is reported as an error')
})
