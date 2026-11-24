/**
 * F-27 on the merge of server-core (0001) and server-runners (0002), held in the source: every runner whose driver
 * takes `signal` is handed the pump's, and RUNNERS_WITHOUT_SIGNAL names only the three that compute in this process.
 * wp-runners-signal-pump.test.ts shows one of them stopping for real.
 *
 * Run: deno test --allow-read tests/unit/deno/wp-runners-signal-callsites.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'

const MAIN = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))

/** The body of `async function <name>(…)` up to the next top-level function. */
function bodyOf(name: string): string {
  const start = MAIN.indexOf(`async function ${name}(`)
  assert(start >= 0, `${name} is gone from main.ts`)
  const next = MAIN.indexOf('\nasync function ', start + 1)
  return MAIN.slice(start, next < 0 ? undefined : next)
}

const RUNNERS: Array<[string, string]> = [
  ['_runLingBotMapJob', 'runLingBotMapReconstruction({'],
  ['_runColmapPosesJob', 'runColmapPoses({'],
  ['_runSplatTrainJob', 'const trainOpts = {'],
  ['_runSplatDetectJob', 'runSplatDetect({'],
  ['_runSplatFinishJob', 'runSplatFinish({'],
  ['_runSenseNovaVisionJob', 'runSenseNovaVision({'],
  ['_runPanopticScanJob', 'runPanopticScan({'],
  ['_runPerson4DJob', 'runPerson4D({'],
  ['_runThingInteractiveAssetJob', 'runPhysAg3D({'],
]

Deno.test('the dispatch hands the pump\'s signal to every runner whose driver takes one', () => {
  for (const [runner] of RUNNERS) {
    assert(MAIN.includes(`await ${runner}(slug, jobId, signal)`), `${runner} is not passed the signal`)
    assert(MAIN.includes(`async function ${runner}(slug: string, jobId: string, signal?: AbortSignal)`), `${runner} takes no signal`)
  }
})

Deno.test('each of those runners passes the signal on to its driver', () => {
  for (const [runner, call] of RUNNERS) {
    const body = bodyOf(runner)
    const at = body.indexOf(call)
    assert(at >= 0, `${runner} no longer calls ${call}`)
    const options = body.slice(at, body.indexOf('\n    }', at) + 6)
    assert(/\bsignal\b/.test(options), `${runner} calls its driver without the signal: ${options}`)
  }
})

Deno.test('RUNNERS_WITHOUT_SIGNAL names only the runners that compute in this process', () => {
  // From the `= [` of the declaration (past its `readonly WorldJobType[]` annotation) to the list's closing bracket.
  const open = MAIN.indexOf('= [', MAIN.indexOf('const RUNNERS_WITHOUT_SIGNAL'))
  const list = MAIN.slice(open, MAIN.indexOf('\n]', open))
  const types = [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])
  assertEquals(types, ['splat-align', 'panoptic-lift', 'place-register'])
})
