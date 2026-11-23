/**
 * The PhysAg3D driver (server/physag3d/physag3d.ts) and the thing-interactive-asset wiring around it.
 *
 * PhysAg3D's run starts an agent worker on the operator's Codex login and sends GPU work to another host, so nothing
 * here runs it. The `_spawn` seam stands in for execute.py: it writes what each step writes (identity.json and
 * runtime.json on prepare, execution.json and delivery.json on run), from PhysAg3D's own execute.py and its worker
 * protocol (method/WORKER_PROMPT.md, "Artifact contract"). What is under test is this side: the skip contract, the
 * three argument vectors, the deadlines, reading delivery.json, never running a case twice, keeping every path the
 * agent wrote inside its case folder, and keeping the server's tokens out of the child's environment.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-run tests/unit/deno/physag3d.test.ts
 */
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'

import {
  buildPlanArgs,
  buildPrepareArgs,
  buildRunArgs,
  caseBudgetSeconds,
  caseDirFor,
  childEnv,
  cliProblem,
  DEFAULT_CASE_BUDGET_S,
  deliveryOutcome,
  deliveryResultText,
  inspectCase,
  interactiveAssetRequestProblem,
  keyframeImagePath,
  parseDelivery,
  type PhysAg3DReport,
  type PhysAg3DRunOptions,
  type PhysAg3DSpawn,
  type PhysAg3DSpawnResult,
  resolveCaseFile,
  resolveParams,
  RUN_MARGIN_MS,
  runDeadlineMs,
  runPhysAg3D,
  STEP_DEADLINE_MS,
} from '../../../server/physag3d/physag3d.ts'
import {
  INTERACTIVE_ASSET_DIR_SUFFIX,
  interactiveAssetFileMime,
  interactiveAssetFolderName,
  isAssetId,
} from '../../../server/physag3d/asset_files.ts'

const ASSET_ID = 'job-1732000000000-0a1b2c3d'
const SESSION_ID = 'sess-physag3d-test-0001'
const KEYFRAME = 'kf-00012.jpg'

/** The first bytes of a binary glTF file ('glTF', version 2, a length), and some body. */
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 24, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

/** PhysAg3D's contract example, as a worker that delivered everything would fill it in. */
const COMPLETE: Record<string, unknown> = {
  title: 'Kitchen cabinet with two doors',
  status: 'delivered',
  input: 'input/source.jpg',
  model: 'asset/refined.glb',
  blend: 'asset/refined.blend',
  simulator: 'physics/scene.xml',
  video: 'media/motion.mp4',
  native_render: 'renders/native.png',
  refined_render: 'renders/refined.png',
  page: 'presentation/index.html',
  motion_kind: 'simulated_replay',
  interaction_status: 'bound_motion_verified',
  physics_status: 'passed',
  physics_report: 'physics/report.json',
  repair_rounds: 1,
  acceptance_passes: 2,
  limitations: [],
}

interface Setup {
  root: string
  checkout: string
  config: string
  sessions: string
  imagePath: string
  assetDir: string
  caseDir: string
  /** A valid GLB outside every case folder, for the escape tests. */
  outsideGlb: string
}

async function withSetup(run: (s: Setup) => Promise<void>): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: 'physag3d-test-' }))
  try {
    const checkout = `${root}/PhysAg3D`
    await Deno.mkdir(checkout)
    await Deno.writeTextFile(`${checkout}/execute.py`, '# stands in for PhysAg3D; the seam runs instead\n')
    const config = `${root}/runtime.local.json`
    await Deno.writeTextFile(config, '{}')
    const sessions = `${root}/scans/sessions`
    await Deno.mkdir(`${sessions}/${SESSION_ID}`, { recursive: true })
    const imagePath = `${sessions}/${SESSION_ID}/${KEYFRAME}`
    await Deno.writeFile(imagePath, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    const assetDir = `${root}/scans/100_room${INTERACTIVE_ASSET_DIR_SUFFIX}`
    const outsideGlb = `${root}/outside.glb`
    await Deno.writeFile(outsideGlb, GLB)
    await run({ root, checkout, config, sessions, imagePath, assetDir, caseDir: `${assetDir}/${ASSET_ID}`, outsideGlb })
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }
}

function options(s: Setup, extra: Partial<PhysAg3DRunOptions> = {}): PhysAg3DRunOptions {
  return {
    imagePath: s.imagePath,
    assetDir: s.assetDir,
    assetId: ASSET_ID,
    maxGlbBytes: 1_000_000,
    checkoutDir: s.checkout,
    configPath: s.config,
    python: Deno.execPath(), // exists and is executable, so the interpreter guard passes
    env: () => undefined,
    log: () => undefined,
    ...extra,
  }
}

interface Call {
  bin: string
  args: string[]
  env: Record<string, string>
  deadlineMs: number
}

interface Fake {
  /** delivery.json as the worker writes it: an object, raw text, or null for none. */
  delivery?: Record<string, unknown> | string | null
  /** The refined GLB's bytes at asset/refined.glb, or null for none. */
  glb?: Uint8Array | null
  /** runtime.json as prepare writes it. */
  runtime?: Record<string, unknown>
  /** What the run step returns. */
  run?: Partial<PhysAg3DSpawnResult>
  /** Whether run writes execution.json, which PhysAg3D does before it starts the worker. */
  writesExecution?: boolean
  /** Extra work for the run step, in the case folder (a link, a file elsewhere). */
  onRun?: (caseDir: string) => Promise<void>
  prepare?: Partial<PhysAg3DSpawnResult>
}

/** execute.py as far as this server can see it: what each step writes and prints. */
function fakePhysAg3D(fake: Fake = {}): { spawn: PhysAg3DSpawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: PhysAg3DSpawn = async (bin, args, env, deadlineMs) => {
    calls.push({ bin, args, env, deadlineMs })
    const step = args[1]
    if (step === 'prepare') {
      if (fake.prepare) return { code: 0, stdout: '', stderr: '', ...fake.prepare }
      const out = args[args.indexOf('--out') + 1]
      await Deno.mkdir(`${out}/input`, { recursive: true })
      await Deno.copyFile(args[args.indexOf('--image') + 1], `${out}/input/source.jpg`)
      await Deno.writeTextFile(`${out}/identity.json`, JSON.stringify({ generation_started: false }))
      await Deno.writeTextFile(`${out}/runtime.json`, JSON.stringify(fake.runtime ?? { max_case_active_seconds: 10800 }))
      return { code: 0, stdout: JSON.stringify({ prepared: out, generation_started: false }), stderr: '' }
    }
    if (step === 'plan') {
      return {
        code: 0,
        stdout: JSON.stringify({ command: ['codex', 'exec', '--image', `${args[2]}/input/source.jpg`, '-'], model_called: false }),
        stderr: '',
      }
    }
    if (step === 'run') {
      const caseDir = args[2]
      if (fake.writesExecution !== false) {
        await Deno.writeTextFile(`${caseDir}/execution.json`, JSON.stringify({ state: 'executor_completed', exit_code: 0, model_called: true }))
      }
      if (fake.glb !== null) {
        await Deno.mkdir(`${caseDir}/asset`, { recursive: true })
        await Deno.writeFile(`${caseDir}/asset/refined.glb`, fake.glb ?? GLB)
      }
      await fake.onRun?.(caseDir)
      const delivery = fake.delivery === undefined ? COMPLETE : fake.delivery
      if (delivery !== null) {
        await Deno.writeTextFile(`${caseDir}/delivery.json`, typeof delivery === 'string' ? delivery : JSON.stringify(delivery))
      }
      return { code: 0, stdout: JSON.stringify({ state: 'executor_completed' }), stderr: '', ...fake.run }
    }
    throw new Error(`unexpected execute.py step ${step}`)
  }
  return { spawn, calls }
}

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false)
}

async function namesIn(dir: string): Promise<string[]> {
  const names: string[] = []
  for await (const entry of Deno.readDir(dir)) names.push(entry.name)
  return names.sort()
}

async function report(s: Setup): Promise<PhysAg3DReport> {
  return JSON.parse(await Deno.readTextFile(`${s.assetDir}/${ASSET_ID}.delivery.json`)) as PhysAg3DReport
}

// ── Unconfigured ─────────────────────────────────────────────────────────────

Deno.test('an unconfigured install is skipped with a hint naming what to set, and spawns nothing', async () => {
  await withSetup(async (s) => {
    const cases: Array<[string, Partial<PhysAg3DRunOptions>, RegExp]> = [
      ['nothing set', { checkoutDir: undefined, configPath: undefined }, /PHYSAG3D_DIR is not set/],
      ['no config', { configPath: undefined }, /PHYSAG3D_CONFIG is not set/],
      ['a checkout without execute.py', { checkoutDir: s.root }, /PHYSAG3D_DIR does not hold execute\.py/],
      ['a config that is not there', { configPath: `${s.root}/missing.json` }, /PHYSAG3D_CONFIG names no file/],
      ['no interpreter at that path', { python: `${s.root}/no/python3` }, /PHYSAG3D_PYTHON .* is not a runnable interpreter/],
      ['no interpreter of that name on PATH', { python: 'no-such-python-physag3d-test' }, /not a runnable interpreter/],
    ]
    for (const [label, extra, reason] of cases) {
      const { spawn, calls } = fakePhysAg3D()
      const result = await runPhysAg3D(options(s, { ...extra, _spawn: spawn }))
      assertEquals(result.status, 'skipped', label)
      assertMatch(result.skippedReason ?? '', reason, label)
      assertStringIncludes(result.remediation ?? '', 'PHYSAG3D_DIR', label)
      assertStringIncludes(result.remediation ?? '', 'docs/pipelines/physag3d.md', label)
      assertFalse(result.error !== undefined, `${label}: a skip is not an error`)
      assertFalse(result.runAttempted, label)
      assertEquals(calls.length, 0, `${label}: nothing is spawned`)
      // No path in the reason: it lands in the world file, which a viewer may read.
      assertFalse((result.skippedReason ?? '').includes(s.root), `${label}: the reason names the variable, not the path`)
    }
    assertFalse(await exists(s.assetDir), 'a skip writes nothing')
  })
})

Deno.test('resolveParams: an option wins over the environment, an empty value counts as unset, python defaults to python3', () => {
  const env = (name: string) =>
    ({ PHYSAG3D_DIR: '/env/PhysAg3D', PHYSAG3D_PYTHON: '  ', PHYSAG3D_CONFIG: '/env/runtime.json', PHYSAG3D_RUNS_DIR: '' })[name]
  assertEquals(resolveParams({}, env), {
    checkoutDir: '/env/PhysAg3D',
    python: 'python3',
    configPath: '/env/runtime.json',
    runsDir: null,
  })
  assertEquals(resolveParams({ checkoutDir: '/opt/p', python: '/opt/py', configPath: '/opt/c.json', runsDir: '/runs' }, env), {
    checkoutDir: '/opt/p',
    python: '/opt/py',
    configPath: '/opt/c.json',
    runsDir: '/runs',
  })
})

// ── The three steps ──────────────────────────────────────────────────────────

Deno.test('the argument vectors are execute.py prepare, plan and run, with their paths in order', () => {
  const script = '/opt/PhysAg3D/execute.py'
  assertEquals(buildPrepareArgs(script, '/data/kf.jpg', '/opt/runtime.json', '/data/case'), [
    script, 'prepare', '--image', '/data/kf.jpg', '--config', '/opt/runtime.json', '--out', '/data/case',
  ])
  assertEquals(buildPlanArgs(script, '/data/case'), [script, 'plan', '/data/case'])
  assertEquals(buildRunArgs(script, '/data/case'), [script, 'run', '/data/case'])
})

Deno.test('a job runs prepare, then plan, logged, then run, with absolute paths and each step under its deadline', async () => {
  await withSetup(async (s) => {
    const logged: string[] = []
    const progress: Array<[number, string]> = []
    const { spawn, calls } = fakePhysAg3D({ runtime: { max_case_active_seconds: 7200 } })
    const result = await runPhysAg3D(options(s, {
      _spawn: spawn,
      log: (line) => void logged.push(line),
      onProgress: (fraction, stage) => void progress.push([fraction, stage]),
    }))
    assertEquals(result.status, 'ok', result.error)
    const script = `${s.checkout}/execute.py`
    assertEquals(calls.map((c) => c.args), [
      [script, 'prepare', '--image', s.imagePath, '--config', s.config, '--out', s.caseDir],
      [script, 'plan', s.caseDir],
      [script, 'run', s.caseDir],
    ])
    for (const call of calls) assertEquals(call.bin, Deno.execPath(), 'every step runs on the resolved interpreter')
    assertEquals(calls.map((c) => c.deadlineMs), [STEP_DEADLINE_MS, STEP_DEADLINE_MS, 7200 * 1000 + RUN_MARGIN_MS])
    assert(logged.some((line) => line.includes('plan') && line.includes('"codex"')), 'the plan is logged')
    assert(logged.some((line) => line.includes('the image goes to the agent service')), 'the start of the run says the image leaves')
    assertEquals(progress.map(([, stage]) => stage), ['prepared', 'planned', 'running'])
  })
})

Deno.test('the run deadline is PhysAg3D\'s own budget plus the margin, held to the longest timer', () => {
  assertEquals(caseBudgetSeconds({ max_case_active_seconds: 600 }), 600)
  for (const bad of [null, {}, { max_case_active_seconds: 0 }, { max_case_active_seconds: -5 }, { max_case_active_seconds: 1.5 }, { max_case_active_seconds: '600' }]) {
    assertEquals(caseBudgetSeconds(bad), DEFAULT_CASE_BUDGET_S, `${JSON.stringify(bad)} takes PhysAg3D's default`)
  }
  assertEquals(DEFAULT_CASE_BUDGET_S, 10_800, 'three hours, as PhysAg3D defaults')
  assertEquals(runDeadlineMs(10_800), 10_800_000 + RUN_MARGIN_MS)
  assert(runDeadlineMs(10_800) > 10_800_000, 'PhysAg3D\'s own timeout fires before the server\'s')
  assertEquals(runDeadlineMs(10_000_000), 2_147_483_647, 'a timer longer than the longest fires at once, so it is capped')
})

// ── Reading delivery.json ────────────────────────────────────────────────────

Deno.test('parseDelivery reads the contract field by field, caps text, and gives wrong types as null', () => {
  const parsed = parseDelivery(JSON.stringify({
    ...COMPLETE,
    title: `  ${'x'.repeat(400)}\n`,
    repair_rounds: 'two',
    limitations: ['hinge torque is estimated', 42, '', 'no soft binding'],
    model: '../escape.glb',
    page: 7,
    extra: 'ignored',
  }))
  assert(parsed.ok)
  const d = parsed.delivery
  assertEquals(d.title?.length, 300, 'capped')
  assertEquals(d.repairRounds, null)
  assertEquals(d.acceptancePasses, 2)
  assertEquals(d.limitations, ['hinge torque is estimated', 'no soft binding'])
  assertEquals(d.paths.model, '../escape.glb', 'kept as written: resolveCaseFile judges it before any use')
  assertEquals(d.paths.page, undefined)
  assertEquals([d.status, d.motionKind, d.interactionStatus, d.physicsStatus], ['delivered', 'simulated_replay', 'bound_motion_verified', 'passed'])

  const many = parseDelivery(JSON.stringify({ status: 'delivered', limitations: Array.from({ length: 25 }, (_, i) => `limit ${i}`) }))
  assert(many.ok)
  assertEquals(many.delivery.limitations.length, 21)
  assertStringIncludes(many.delivery.limitations[20], '5 more')

  assertEquals(parseDelivery('{not json'), { ok: false, reason: 'delivery.json is not JSON' })
  assertEquals(parseDelivery('[1, 2]'), { ok: false, reason: 'delivery.json is not a JSON object' })
  assertEquals(parseDelivery('null'), { ok: false, reason: 'delivery.json is not a JSON object' })
})

Deno.test('the outcome is PhysAg3D\'s own status: delivered is complete, two are partial, the rest failed', () => {
  assertEquals(deliveryOutcome('delivered'), 'complete')
  assertEquals(deliveryOutcome('delivered_with_limitations'), 'partial')
  assertEquals(deliveryOutcome('native_only'), 'partial')
  for (const status of ['blocked', 'failed', 'Delivered', 'done', null]) assertEquals(deliveryOutcome(status), 'failed', String(status))
})

Deno.test('a complete delivery lands the GLB and the report under the job id, and nothing else', async () => {
  await withSetup(async (s) => {
    const { spawn } = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'ok', result.error)
    assertEquals(result.outcome, 'complete')
    assert(result.runAttempted)
    assertEquals(result.glbPath, `${s.assetDir}/${ASSET_ID}.glb`)
    assertEquals(result.glbBytes, GLB.length)
    assertEquals(await Deno.readFile(result.glbPath!), GLB)
    assertEquals(await namesIn(s.assetDir), [ASSET_ID, `${ASSET_ID}.delivery.json`, `${ASSET_ID}.glb`], 'the case folder and the two landed files')
    const written = await report(s)
    assertEquals(written.outcome, 'complete')
    assertEquals(written.glb, { landed: true, bytes: GLB.length })
    assertEquals(written.execution, { state: 'executor_completed', exitCode: 0 })
    assertEquals(written.delivery?.physicsStatus, 'passed')
    assertEquals(written.caseOutputs.model, 'present')
    assertEquals(written.caseOutputs.video, 'absent', 'listed, and not in the case folder')
    const text = await Deno.readTextFile(result.reportPath!)
    assertFalse(text.includes(s.root), 'the served report names no path on this machine')
    assertEquals(
      deliveryResultText(result.delivery!, 'complete'),
      'PhysAg3D delivered "Kitchen cabinet with two doors" (motion simulated_replay, interaction bound_motion_verified, physics passed).',
    )
  })
})

Deno.test('a partial delivery is ok, says which status, and carries its verdicts and limitations verbatim', async () => {
  for (const status of ['delivered_with_limitations', 'native_only']) {
    await withSetup(async (s) => {
      const { spawn } = fakePhysAg3D({
        delivery: {
          ...COMPLETE,
          status,
          motion_kind: 'kinematic_parameter_animation',
          interaction_status: 'partial',
          physics_status: 'not_tested',
          limitations: ['drawer travel is a guess', 'no physics replay'],
        },
      })
      const result = await runPhysAg3D(options(s, { _spawn: spawn }))
      assertEquals(result.status, 'ok', `${status}: ${result.error}`)
      assertEquals(result.outcome, 'partial')
      assert(await exists(`${s.assetDir}/${ASSET_ID}.glb`))
      const sentence = deliveryResultText(result.delivery!, 'partial')
      assertStringIncludes(sentence, `as ${status}`)
      assertStringIncludes(sentence, 'motion kinematic_parameter_animation, interaction partial, physics not_tested')
      assertStringIncludes(sentence, '2 limitation(s)')
      assertEquals((await report(s)).delivery?.limitations, ['drawer travel is a guess', 'no physics replay'])
    })
  }
})

Deno.test('a failed delivery is an error with its blocker, lands no GLB, and still writes the report', async () => {
  const failures: Array<Record<string, unknown>> = [
    { ...COMPLETE, status: 'blocked', blocker: 'the generation host had 12 GiB free', model: null },
    { ...COMPLETE, status: 'failed' },
    { ...COMPLETE, status: 'all good' },
    { ...COMPLETE, status: undefined },
  ]
  for (const delivery of failures) {
    await withSetup(async (s) => {
      const { spawn } = fakePhysAg3D({ delivery })
      const result = await runPhysAg3D(options(s, { _spawn: spawn }))
      assertEquals(result.status, 'error', JSON.stringify(delivery.status))
      assertEquals(result.outcome, 'failed')
      assert(result.runAttempted, 'the worker ran, so the image left: the report says so')
      assertFalse(await exists(`${s.assetDir}/${ASSET_ID}.glb`), 'a failed delivery lands no GLB')
      assertEquals((await report(s)).outcome, 'failed')
      assertStringIncludes(result.error ?? '', 'did not deliver')
      if (delivery.blocker) assertStringIncludes(result.error ?? '', 'the generation host had 12 GiB free')
    })
  }
})

Deno.test('a delivery.json that is not JSON, or none at all, is an error that says so', async () => {
  for (const [delivery, says] of [['{"status": "deliv', 'not JSON'], [null, 'without writing delivery.json']] as const) {
    await withSetup(async (s) => {
      const { spawn } = fakePhysAg3D({ delivery })
      const result = await runPhysAg3D(options(s, { _spawn: spawn }))
      assertEquals(result.status, 'error')
      assertStringIncludes(result.error ?? '', says)
      const written = await report(s)
      assertEquals(written.delivery, null)
      assertStringIncludes(written.deliveryError ?? '', says)
    })
  }
})

Deno.test('a run that fails after its worker started says so, with PhysAg3D\'s message, and counts as sent', async () => {
  await withSetup(async (s) => {
    const { spawn } = fakePhysAg3D({
      delivery: null,
      glb: null,
      run: { code: 2, stdout: '', stderr: '{"error": "TimeoutExpired", "message": "the worker did not stop within 30 seconds"}' },
    })
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'error')
    assertEquals(
      result.error,
      "PhysAg3D's worker started, and then run failed: TimeoutExpired: the worker did not stop within 30 seconds; " +
        'it left no delivery.json.',
    )
    assert(result.runAttempted)
    assertEquals((await report(s)).execution.state, 'executor_completed')
  })
})

// ── Deadlines ────────────────────────────────────────────────────────────────

Deno.test('a run the deadline stopped is reported as a timeout, and says its worker may still be running', async () => {
  await withSetup(async (s) => {
    const { spawn } = fakePhysAg3D({ delivery: null, glb: null, run: { code: 137, stdout: '', timeoutReason: 'timed out after 3.3 h' } })
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'error')
    assertStringIncludes(result.error ?? '', 'timed out after 3.3 h and was stopped')
    assertStringIncludes(result.error ?? '', 'may still be running')
    assert(result.runAttempted)
  })
})

Deno.test('a delivery the worker finished before the deadline fired is still landed', async () => {
  await withSetup(async (s) => {
    const { spawn } = fakePhysAg3D({ run: { code: 137, stdout: '', timeoutReason: 'timed out after 3.3 h' } })
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'ok', result.error)
    assert(await exists(`${s.assetDir}/${ASSET_ID}.glb`))
  })
})

Deno.test('a prepare or plan the deadline stopped ends the job there, and the run never starts', async () => {
  await withSetup(async (s) => {
    const { spawn, calls } = fakePhysAg3D({ prepare: { code: 137, timeoutReason: 'timed out after 10 min' } })
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'error')
    assertEquals(result.error, 'PhysAg3D prepare timed out after 10 min and was stopped')
    assertEquals(calls.map((c) => c.args[1]), ['prepare'])
    assertFalse(result.runAttempted)
  })
})

// ── Nothing escapes ──────────────────────────────────────────────────────────

Deno.test('a model path that leaves the case folder is refused: .., an absolute path, a link out', async () => {
  const escapes: Array<[string, Fake]> = [
    ['..', { delivery: { ...COMPLETE, model: '../../../outside.glb' } }],
    ['absolute', { delivery: { ...COMPLETE, model: '__OUTSIDE__' } }],
    ['link', {
      glb: null,
      onRun: async (caseDir) => {
        await Deno.mkdir(`${caseDir}/asset`, { recursive: true })
        await Deno.symlink(`${caseDir}/../../../outside.glb`, `${caseDir}/asset/refined.glb`)
      },
    }],
  ]
  for (const [label, fake] of escapes) {
    await withSetup(async (s) => {
      const delivery = fake.delivery as Record<string, unknown> | undefined
      const { spawn } = fakePhysAg3D(delivery?.model === '__OUTSIDE__' ? { delivery: { ...COMPLETE, model: s.outsideGlb } } : fake)
      const result = await runPhysAg3D(options(s, { _spawn: spawn }))
      assertEquals(result.status, 'error', label)
      assertStringIncludes(result.error ?? '', 'outside the case folder', label)
      assertFalse(await exists(`${s.assetDir}/${ASSET_ID}.glb`), `${label}: nothing landed`)
      assertEquals((await report(s)).glb, { landed: false, reason: 'its model is outside the case folder' }, label)
      assertEquals(await Deno.readFile(s.outsideGlb), GLB, `${label}: the file outside is untouched`)
    })
  }
})

Deno.test('resolveCaseFile keeps to the case folder: not the folder itself, not a missing or dangling file', async () => {
  await withSetup(async (s) => {
    await Deno.mkdir(`${s.caseDir}/asset`, { recursive: true })
    await Deno.writeFile(`${s.caseDir}/asset/refined.glb`, GLB)
    await Deno.symlink(`${s.caseDir}/asset/gone.glb`, `${s.caseDir}/asset/dangling.glb`)
    assertEquals(await resolveCaseFile(s.caseDir, 'asset/refined.glb'), { ok: true, path: `${s.caseDir}/asset/refined.glb` })
    assertEquals(await resolveCaseFile(s.caseDir, `${s.caseDir}/asset/refined.glb`), { ok: true, path: `${s.caseDir}/asset/refined.glb` })
    assertEquals(await resolveCaseFile(s.caseDir, '.'), { ok: false, problem: 'outside the case folder' })
    assertEquals(await resolveCaseFile(s.caseDir, 'asset'), { ok: false, problem: 'not a file' })
    assertEquals(await resolveCaseFile(s.caseDir, 'asset/missing.glb'), { ok: false, problem: 'absent' })
    assertEquals(await resolveCaseFile(s.caseDir, 'asset/dangling.glb'), { ok: false, problem: 'absent' })
    assertEquals(await resolveCaseFile(s.caseDir, undefined), { ok: false, problem: 'not listed' })
    assertEquals(await resolveCaseFile(s.caseDir, 'asset/re\u0000fined.glb'), { ok: false, problem: 'outside the case folder' })
  })
})

Deno.test('a model that is not a binary glTF, not a .glb, or over the cap is not landed', async () => {
  const cases: Array<[string, Fake, Partial<PhysAg3DRunOptions>, string]> = [
    ['wrong bytes', { glb: new TextEncoder().encode('not a gltf at all') }, {}, 'not a binary glTF file'],
    ['wrong name', {
      glb: null,
      delivery: { ...COMPLETE, model: 'asset/refined.obj' },
      onRun: async (caseDir) => {
        await Deno.mkdir(`${caseDir}/asset`, { recursive: true })
        await Deno.writeFile(`${caseDir}/asset/refined.obj`, GLB)
      },
    }, {}, 'not a .glb file'],
    ['too big', {}, { maxGlbBytes: 8 }, 'over the 8-byte cap'],
  ]
  for (const [label, fake, extra, says] of cases) {
    await withSetup(async (s) => {
      const { spawn } = fakePhysAg3D(fake)
      const result = await runPhysAg3D(options(s, { ...extra, _spawn: spawn }))
      assertEquals(result.status, 'error', label)
      assertStringIncludes(result.error ?? '', says, label)
      assertEquals(await namesIn(s.assetDir), [ASSET_ID, `${ASSET_ID}.delivery.json`], `${label}: no GLB and no partial copy`)
    })
  }
})

Deno.test('a job id that is not one is refused before anything is written', async () => {
  await withSetup(async (s) => {
    const { spawn, calls } = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { assetId: '../../../escape', _spawn: spawn }))
    assertEquals(result.status, 'error')
    assertEquals(calls.length, 0)
    assertFalse(await exists(`${s.root}/escape`))
    assertFalse(await exists(s.assetDir))
  })
})

Deno.test('the keyframe input, the served names and the case folder cannot name a path outside their folders', () => {
  assertEquals(keyframeImagePath('/srv/sessions', SESSION_ID, KEYFRAME), `/srv/sessions/${SESSION_ID}/${KEYFRAME}`)
  for (const [sessionId, keyframe] of [
    ['../etc', KEYFRAME],
    ['sess-ok/../../etc', KEYFRAME],
    [SESSION_ID, '../../../../etc/passwd'],
    [SESSION_ID, 'kf-00012.jpg/../x'],
    [SESSION_ID, 'kf-1.jpg'],
    [SESSION_ID, 42],
    [null, KEYFRAME],
  ] as const) {
    assertEquals(keyframeImagePath('/srv/sessions', sessionId, keyframe), null, `${sessionId} ${keyframe}`)
  }

  assertEquals(interactiveAssetFileMime(`${ASSET_ID}.glb`), 'model/gltf-binary')
  assertEquals(interactiveAssetFileMime(`${ASSET_ID}.delivery.json`), 'application/json')
  for (const name of [`../${ASSET_ID}.glb`, `${ASSET_ID}`, `${ASSET_ID}/input/source.jpg`, `${ASSET_ID}.json`, 'job-1-ABCDEF01.glb', 'x.glb']) {
    assertEquals(interactiveAssetFileMime(name), null, name)
  }
  assert(isAssetId(ASSET_ID))
  assertFalse(isAssetId('job-1-0a1b2c3d/..'))

  assertEquals(interactiveAssetFolderName('100_room.glb'), '100_room.interactive')
  const params = resolveParams({}, () => undefined)
  assertEquals(caseDirFor(params, '/srv/scans/100_room.interactive', ASSET_ID), `/srv/scans/100_room.interactive/${ASSET_ID}`)
  assertEquals(caseDirFor({ ...params, runsDir: '/srv/runs' }, '/srv/scans/100_room.interactive', ASSET_ID), `/srv/runs/${ASSET_ID}`)
})

Deno.test('the child gets only the allowlisted environment, so no token of the server reaches the worker', async () => {
  const server: Record<string, string> = {
    PATH: '/usr/bin',
    HOME: '/var/lib/scan-server',
    LANG: 'C.UTF-8',
    SSH_AUTH_SOCK: '/run/agent.sock',
    CI_SERVER_TOKEN: 'secret-1',
    FDANYONE_TOKEN: 'secret-2',
    ANDROID_MCP_TOKEN_BEAM_PRO: 'secret-3',
    OPENAI_API_KEY: 'secret-4',
    PORTAL_OIDC_CLIENT_SECRET: 'secret-5',
    PHYSAG3D_DIR: '/opt/PhysAg3D',
  }
  assertEquals(childEnv((name) => server[name]), { PATH: '/usr/bin', HOME: '/var/lib/scan-server', LANG: 'C.UTF-8', SSH_AUTH_SOCK: '/run/agent.sock' })
  await withSetup(async (s) => {
    const { spawn, calls } = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { env: (name) => server[name], _spawn: spawn }))
    assertEquals(result.status, 'ok', result.error)
    for (const call of calls) {
      assertEquals(call.env, { PATH: '/usr/bin', HOME: '/var/lib/scan-server', LANG: 'C.UTF-8', SSH_AUTH_SOCK: '/run/agent.sock' }, call.args[1])
      assertFalse(JSON.stringify(call.env).includes('secret'), call.args[1])
    }
  })
})

Deno.test({
  name: 'the real spawn clears the environment: a token on the server process does not reach the child',
  // A shell script stands in for the interpreter, so this is POSIX only. It is not PhysAg3D: it writes the environment
  // it was given beside the config and refuses the way execute.py refuses.
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    await withSetup(async (s) => {
      const fakePython = `${s.root}/stand-in-python`
      await Deno.writeTextFile(
        fakePython,
        '#!/bin/sh\n' +
          '# $6 is the --config path: write the environment beside it, then refuse as execute.py does.\n' +
          'env > "$(dirname "$6")/child-env.txt"\n' +
          'echo \'{"error": "ValueError", "message": "stand-in stops here"}\' >&2\n' +
          'exit 2\n',
      )
      await Deno.chmod(fakePython, 0o755)
      const name = 'PHYSAG3D_TEST_SERVER_TOKEN'
      Deno.env.set(name, 'server-secret-value')
      try {
        // No `env` and no `_spawn`: the process environment and the real spawn, run_with_deadline.ts.
        const result = await runPhysAg3D({
          ...options(s, { python: fakePython, runsDir: s.assetDir }),
          env: undefined,
          _spawn: undefined,
        })
        assertEquals(result.status, 'error')
        assertEquals(result.error, 'PhysAg3D prepare failed: ValueError: stand-in stops here')
      } finally {
        Deno.env.delete(name)
      }
      const seen = await Deno.readTextFile(`${s.root}/child-env.txt`)
      assertFalse(seen.includes('server-secret-value'), 'the token stayed with the server')
      assertMatch(seen, /^PATH=/m, 'PATH is on the allowlist')
    })
  },
})

// ── Never twice ──────────────────────────────────────────────────────────────

Deno.test('a case whose run was attempted is never run again: its delivery is read, or the job fails saying why', async () => {
  // As a restart leaves it: the same job id, so the same case folder, already holding execution.json.
  await withSetup(async (s) => {
    const first = fakePhysAg3D()
    assertEquals((await runPhysAg3D(options(s, { _spawn: first.spawn }))).status, 'ok')
    await Deno.remove(`${s.assetDir}/${ASSET_ID}.glb`)
    assertEquals(await inspectCase(s.caseDir), 'attempted')
    const again = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { _spawn: again.spawn }))
    assertEquals(again.calls.length, 0, 'not prepare, not plan, not run')
    assertEquals(result.status, 'ok', result.error)
    assert(await exists(`${s.assetDir}/${ASSET_ID}.glb`), 'the delivery the first attempt left is landed')
  })
  await withSetup(async (s) => {
    await Deno.mkdir(s.caseDir, { recursive: true })
    await Deno.writeTextFile(`${s.caseDir}/identity.json`, '{}')
    await Deno.writeTextFile(`${s.caseDir}/execution.json`, JSON.stringify({ state: 'running' }))
    const { spawn, calls } = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(calls.length, 0)
    assertEquals(result.status, 'error')
    assertStringIncludes(result.error ?? '', 'does not resume or retry a case')
    assert(result.runAttempted, 'the first attempt may have sent the image')
  })
})

Deno.test('a prepared case is not prepared again: plan and run continue it', async () => {
  await withSetup(async (s) => {
    await Deno.mkdir(s.caseDir, { recursive: true })
    await Deno.writeTextFile(`${s.caseDir}/identity.json`, '{}')
    await Deno.writeTextFile(`${s.caseDir}/runtime.json`, JSON.stringify({ max_case_active_seconds: 60 }))
    assertEquals(await inspectCase(s.caseDir), 'prepared')
    const { spawn, calls } = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'ok', result.error)
    assertEquals(calls.map((c) => c.args[1]), ['plan', 'run'])
    assertEquals(calls[1].deadlineMs, 60_000 + RUN_MARGIN_MS)
  })
})

Deno.test('a case folder holding something else is not run, and is not touched', async () => {
  await withSetup(async (s) => {
    await Deno.mkdir(s.caseDir, { recursive: true })
    await Deno.writeTextFile(`${s.caseDir}/notes.txt`, 'mine')
    assertEquals(await inspectCase(s.caseDir), 'unknown')
    const { spawn, calls } = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'error')
    assertEquals(calls.length, 0)
    assertEquals(await Deno.readTextFile(`${s.caseDir}/notes.txt`), 'mine')
  })
})

Deno.test('a refusal before the worker starts reports PhysAg3D\'s own message, and that the image never left', async () => {
  await withSetup(async (s) => {
    const { spawn } = fakePhysAg3D({
      writesExecution: false,
      delivery: null,
      glb: null,
      run: {
        code: 2,
        stdout: '',
        stderr: '{"error": "ValueError", "message": "Preflight failed. Do not remove flags or bypass permissions to continue."}\n',
      },
    })
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'error')
    assertEquals(
      result.error,
      'PhysAg3D run failed: ValueError: Preflight failed. Do not remove flags or bypass permissions to continue.',
    )
    assertFalse(result.runAttempted)
    assertFalse(await exists(`${s.assetDir}/${ASSET_ID}.delivery.json`), 'no report: nothing was sent')
  })
})

Deno.test('a keyframe that is gone since the request is an error, not a skip, and nothing runs', async () => {
  await withSetup(async (s) => {
    await Deno.remove(s.imagePath)
    const { spawn, calls } = fakePhysAg3D()
    const result = await runPhysAg3D(options(s, { _spawn: spawn }))
    assertEquals(result.status, 'error')
    assertStringIncludes(result.error ?? '', 'not on the server any more')
    assertEquals(calls.length, 0)
  })
})

Deno.test('cliProblem reads execute.py\'s {"error", "message"} line, and otherwise the tail of a traceback', () => {
  assertEquals(
    cliProblem({ code: 2, stdout: '', stderr: '{"error": "ValueError", "message": "Use a new empty output directory; no resume or overwrite"}' }),
    'failed: ValueError: Use a new empty output directory; no resume or overwrite',
  )
  const traceback = 'Traceback (most recent call last):\n  File "execute.py", line 17, in sha\nAttributeError: module \'hashlib\' has no attribute \'file_digest\'\n'
  assertStringIncludes(cliProblem({ code: 1, stdout: '', stderr: traceback }), "exited 1: ")
  assertStringIncludes(cliProblem({ code: 1, stdout: '', stderr: traceback }), "has no attribute 'file_digest'")
  assertEquals(cliProblem({ code: 3, stdout: '', stderr: '' }), 'exited 3')
})

// ── The request ──────────────────────────────────────────────────────────────

Deno.test('interactiveAssetRequestProblem names what the request is missing, and passes a good one', () => {
  const things = new Set(['thing-cabinet'])
  assertStringIncludes(interactiveAssetRequestProblem({ keyframe: KEYFRAME }, null, things) ?? '', 'no capture session')
  assertStringIncludes(interactiveAssetRequestProblem({ keyframe: KEYFRAME }, 'session-old-shape', things) ?? '', 'no capture session')
  assertStringIncludes(interactiveAssetRequestProblem(undefined, SESSION_ID, things) ?? '', 'payload.keyframe')
  assertStringIncludes(interactiveAssetRequestProblem({ keyframe: '../kf-00012.jpg' }, SESSION_ID, things) ?? '', 'payload.keyframe')
  assertEquals(interactiveAssetRequestProblem({ keyframe: KEYFRAME, thingId: 'thing-lamp' }, SESSION_ID, things), 'payload.thingId names no Thing in this Place.')
  assertEquals(interactiveAssetRequestProblem({ keyframe: KEYFRAME, thingId: 7 }, SESSION_ID, things), 'payload.thingId names no Thing in this Place.')
  assertEquals(interactiveAssetRequestProblem({ keyframe: KEYFRAME }, SESSION_ID, things), null)
  assertEquals(interactiveAssetRequestProblem({ keyframe: KEYFRAME, thingId: 'thing-cabinet' }, SESSION_ID, things), null)
})

// ── The wiring in main.ts, read from its source (main.ts serves at import and cannot be imported) ─────────────────

const MAIN = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))

Deno.test('main.ts accepts thing-interactive-asset on the job route and dispatches it to its runner', () => {
  assertMatch(MAIN, /const WORLD_JOB_TYPES = new Set<WorldJobType>\(\[[\s\S]*?'thing-interactive-asset',[\s\S]*?\]\)/)
  assertMatch(MAIN, /if \(job\.type === 'thing-interactive-asset'\) \{\s*await _runThingInteractiveAssetJob\(slug, jobId\)/)
  assertMatch(MAIN, /job\.type === 'thing-interactive-asset'\s*\?\s*'physag3d'/)
  assertMatch(MAIN, /'person-4d-reconstruct', 'thing-interactive-asset', 'place-register'\]\.includes\(job\.type\) && !scan/)
})

Deno.test('nothing in the server queues thing-interactive-asset on its own: only a request does', async () => {
  const offenders: string[] = []
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const url = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir)
      if (entry.isDirectory) await walk(url)
      else if (entry.name.endsWith('.ts')) {
        const source = await Deno.readTextFile(url)
        for (const call of source.matchAll(/createWorldJob\(([^)]*)\)/g)) {
          if (call[1].includes('thing-interactive-asset')) offenders.push(`${url.pathname}: ${call[0]}`)
        }
      }
    }
  }
  await walk(new URL('../../../server/', import.meta.url))
  assertEquals(offenders, [], 'a run can take hours and sends the image off the box, so only POST /worlds/:slug/jobs creates one')
})
