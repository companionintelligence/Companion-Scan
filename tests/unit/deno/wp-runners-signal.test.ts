/**
 * Wave 14-0002, for server-core's F-27: every runner that spawns or fetches
 * takes an optional `signal`, and the job pump's abort stops its child or its
 * requests instead of leaving them running beside the next job.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-run tests/unit/deno/wp-runners-signal.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { abortReasonOf, runWithDeadline } from '../../../server/run_with_deadline.ts'
import { whichPath } from '../../../server/exec_probe.ts'
import { runPerson4D } from '../../../server/person4d/person_4d.ts'

const SLEEP = await whichPath('sleep')

Deno.test({
  name: 'runWithDeadline: the caller\'s abort kills the child well inside its deadline, and says why',
  ignore: Deno.build.os === 'windows' || SLEEP === null,
  fn: async () => {
    const controller = new AbortController()
    const started = performance.now()
    setTimeout(() => controller.abort(new Error('job deadline passed')), 100)
    const out = await runWithDeadline(SLEEP!, { args: ['30'], stdout: 'piped', stderr: 'piped' }, 60_000, 1_000, controller.signal)
    const took = performance.now() - started
    assert(took < 10_000, `took ${took} ms; the abort did not stop the child`)
    assertEquals(out.success, false)
    assertEquals(out.timeoutReason, 'aborted by its job (job deadline passed)')
  },
})

Deno.test('runWithDeadline: a signal that already fired spawns nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  // A binary that does not exist: spawning it would throw, so returning shows it was never spawned.
  const out = await runWithDeadline('/definitely/not/a/binary', { args: [] }, 1_000, 100, controller.signal)
  assertEquals(out.code, 137)
  assertStringIncludes(out.timeoutReason ?? '', 'aborted by its job')
})

Deno.test({
  name: 'runWithDeadline: without a signal, a run that finishes is untouched',
  ignore: Deno.build.os === 'windows' || SLEEP === null,
  fn: async () => {
    const out = await runWithDeadline(SLEEP!, { args: ['0'], stdout: 'piped', stderr: 'piped' }, 10_000)
    assertEquals([out.success, out.timeoutReason], [true, null])
  },
})

Deno.test('abortReasonOf: names a string or Error reason, and stays readable without one', () => {
  const a = new AbortController()
  a.abort('deadline')
  assertEquals(abortReasonOf(a.signal), 'aborted by its job (deadline)')
  const b = new AbortController()
  b.abort(new Error(''))
  assertEquals(abortReasonOf(b.signal), 'aborted by its job')
})

Deno.test('runPerson4D: the job\'s abort ends polling with an error that says the take may still run remotely', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-runners-signal-' })
  try {
    const controller = new AbortController()
    let polls = 0
    const fetchStub = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert(init?.signal instanceof AbortSignal, 'every request carries a signal')
      if (String(url).endsWith('/takes')) return Promise.resolve(Response.json({ attached: false }))
      polls++
      if (polls === 2) controller.abort(new Error('job deadline passed'))
      return Promise.resolve(Response.json({ status: 'running', stage: 'train', progress: 0.5 }))
    }
    const result = await runPerson4D({
      takeId: 'take-signal',
      clips: [{ clientId: null, url: 'http://h/c.mp4', mimeType: 'video/mp4', poseTrackUrl: null, sync: null }],
      sequenceDir: `${dir}/seq`,
      manifestPath: `${dir}/m.json`,
      host: 'http://gpu.invalid:9040',
      _fetch: fetchStub as unknown as typeof fetch,
      _sleep: () => Promise.resolve(),
      signal: controller.signal,
    })
    assertEquals(result.status, 'error')
    assertStringIncludes(result.manifest.error ?? '', 'aborted by its job')
    assertStringIncludes(result.manifest.error ?? '', 're-attaches')
    assertEquals(polls, 2)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('runPerson4D: an abort during submit is an error, not "subsystem unreachable"', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-runners-signal-' })
  try {
    const controller = new AbortController()
    controller.abort(new Error('job deadline passed'))
    const result = await runPerson4D({
      takeId: 'take-signal-2',
      clips: [{ clientId: null, url: 'http://h/c.mp4', mimeType: 'video/mp4', poseTrackUrl: null, sync: null }],
      sequenceDir: `${dir}/seq`,
      manifestPath: `${dir}/m.json`,
      host: 'http://gpu.invalid:9040',
      _fetch: ((_url: string, init?: RequestInit) => Promise.reject(init?.signal?.reason ?? new Error('aborted'))) as unknown as typeof fetch,
      _sleep: () => Promise.resolve(),
      signal: controller.signal,
    })
    assertEquals(result.status, 'error')
    assertStringIncludes(result.manifest.error ?? '', 'stopped')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a driver hands its signal to the spawn: LingBot-Map with an aborted job never starts its worker', async () => {
  const { runLingBotMapReconstruction } = await import('../../../server/lingbot-map/lingbot_map.ts')
  const tmp = await Deno.makeTempDir({ prefix: 'wp-runners-signal-' })
  try {
    const sessionDir = `${tmp}/sess-signal-abcd`
    await Deno.mkdir(sessionDir)
    const controller = new AbortController()
    controller.abort(new Error('job deadline passed'))
    const result = await runLingBotMapReconstruction({
      sessionDir,
      scriptPath: `${tmp}/never-run.py`,
      python: Deno.execPath(),
      signal: controller.signal,
    })
    assertEquals(result.status, 'error')
    assertStringIncludes(result.error ?? '', 'aborted by its job')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
