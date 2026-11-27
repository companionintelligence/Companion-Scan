/**
 * Conformance of the hand-over model (module handOverModel in spec/quint/worldHandOver.qnt) with
 * server/world/world_hand_over.ts and server/world/scan_carry.ts.
 *
 * Each trace is a `quint run --mbt` run of the model. The replay drives one real `createWorldHandOver` through it,
 * step by step, with everything it is handed stood in for as world_hand_over.test.ts does: House A's and House B's
 * world files (two WorldProjects), whether House B's world is busy or broken, whether House A's can be read or
 * saved, whether the Places registry can be read, `sleep` (resolved when the trace wakes the route) and `later`
 * (fired when the trace fires the timer). A restart is a new `createWorldHandOver` over the same files.
 *
 * After every step it compares the files (which scans' rows, notes and hand-set placements each world holds, and no
 * patch twice), each route's state (not started, sleeping for the milliseconds the model says, or answered with the
 * model's `pending` and `placementsKept`), and the timer (set or not, and for how long).
 *
 * The stand-in `readWorld` does what server/main.ts does around the hand-over: it evicts the rows of House A's world
 * whose record files them under another Place, calls `handOver`, puts back what it returns and saves House A's
 * world only when it evicted something. That glue is the model's assumption; the decisions are the code's.
 *
 * Traces: spec/quint/traces/handOver/*.itf.json (committed), and the directory in HANDOVER_ITF_DIR when the spec gate
 * (npm run spec:world) has written seeded ones. No trace is a failure.
 */
import { assert, assertEquals } from './assert.ts'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { itfAction, itfPicks, parseItfTrace, type ItfState, type ItfValue } from '../../../spec/quint/itf.ts'
import { createWorldHandOver, type WorldHandOver, type WorldHandOverDeps } from '../../../server/world/world_hand_over.ts'
import type { EvictedScan } from '../../../server/world/scan_carry.ts'
import type { HandOverReport } from '../../../src/world/frame-generations.ts'
import type { EditPatch, ScanManifest, WorldProject } from '../../../src/world/types.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FIXTURES = join(ROOT, 'spec', 'quint', 'traces', 'handOver')

// ── The worlds, as world_hand_over.test.ts builds them ────────────────────────────────────────────

const EMPTY_GEO = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const MOVED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 0, -1, 1]
const AT = '2026-11-16T09:00:00.000Z'
const SOURCE = 'project-proj-a'

/** Scan n of the model is this file. */
const FILENAME: Record<number, string> = { 1: '1700000000001_kitchen.glb', 2: '1700000000002_hall.glb' }
const SCAN_OF = new Map(Object.entries(FILENAME).map(([n, file]) => [file, Number(n)]))

function scanRow(n: number): ScanManifest {
  const filename = FILENAME[n]!
  return {
    scanId: `scan-${filename.replace(/\.glb$/, '')}`,
    projectId: 'proj-a',
    sessionId: null,
    filename,
    name: filename,
    glbUrl: `/scans/${filename}`,
    geoPose: EMPTY_GEO,
    localToWorld: IDENTITY,
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: null,
    pointCount: null,
    detectionCount: null,
    layerIndex: [],
    status: 'ready',
  }
}

function world(projectId: string, scans: ScanManifest[], editPatches: EditPatch[]): WorldProject {
  return {
    worldId: `world-project-${projectId}`,
    name: projectId,
    shareSlug: `project-${projectId}`,
    projectId,
    originGeoPose: EMPTY_GEO,
    localFrame: { type: 'ENU_Y_UP', origin: EMPTY_GEO, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans,
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    jobs: [],
    editPatches,
    createdAt: AT,
    updatedAt: AT,
  }
}

/** Scan n's note (travels always) and its hand-set placement (a matrix: travels with a scan placed by its record). */
const note = (n: number): EditPatch => ({ patchId: `n-${n}`, worldId: 'w', scanId: scanRow(n).scanId, targetId: FILENAME[n]!, scope: 'scan', notes: `note ${n}`, createdAt: AT })
const placement = (n: number): EditPatch => ({ patchId: `m-${n}`, worldId: 'w', scanId: scanRow(n).scanId, targetId: FILENAME[n]!, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT })

const clone = <T>(value: T): T => structuredClone(value)

// ── Reading the model ─────────────────────────────────────────────────────────────────────────────

type Rec = { [field: string]: ItfValue }
const rec = (value: ItfValue | undefined): Rec => value as Rec
const tag = (value: ItfValue | undefined): string => String(rec(value).tag)
const num = (value: ItfValue | undefined): number => Number(value as bigint)
const ints = (value: ItfValue | undefined): number[] => [...(value as Set<ItfValue>)].map((v) => Number(v)).sort()

function vars(state: ItfState): Record<string, ItfValue> {
  const out: Record<string, ItfValue> = {}
  for (const [name, value] of Object.entries(state)) out[name.startsWith('mbt::') ? name : name.slice(name.lastIndexOf('::') + 2)] = value
  return out
}

interface Files { rows: number[]; notes: number[]; placements: number[] }

const modelFiles = (value: ItfValue | undefined): Files => {
  const f = rec(value)
  return { rows: ints(f.rows), notes: ints(f.notes), placements: ints(f.placements) }
}

/** What a world file holds of the model's scans, read back from the WorldProject. */
function filesOf(w: WorldProject): Files {
  const ids = w.editPatches.map((patch) => patch.patchId)
  assertEquals(new Set(ids).size, ids.length, `no patch twice in ${w.shareSlug}: ${ids.join(', ')}`)
  const numbered = (prefix: string) => ids.filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length))).sort()
  return { rows: w.scans.map((row) => SCAN_OF.get(row.filename)!).sort(), notes: numbered('n-'), placements: numbered('m-') }
}

// ── The harness ───────────────────────────────────────────────────────────────────────────────────

interface RouteRun {
  report?: HandOverReport
  sleep?: { ms: number; wake: () => void }
}

interface Harness {
  deps: WorldHandOverDeps
  instance: WorldHandOver
  disk: { a: WorldProject; b: WorldProject }
  filedUnder: Map<string, string>
  placedByRecord: Map<number, boolean>
  env: Record<string, boolean>
  routes: Map<number, RouteRun>
  /** The route whose settle is running in this step: deps.sleep is its. */
  current: number | null
  timers: { ms: number; run: () => void | Promise<void>; fired: boolean }[]
}

function harness(placedByRecord: Map<number, boolean>): Harness {
  const h = {} as Harness
  h.disk = {
    a: world('proj-a', [scanRow(1), scanRow(2)], [note(1), placement(1), note(2), placement(2)]),
    b: world('proj-b', [], []),
  }
  h.filedUnder = new Map([[FILENAME[1]!, 'proj-a'], [FILENAME[2]!, 'proj-a']])
  h.placedByRecord = placedByRecord
  h.env = { busyB: false, brokenB: false, unreadableA: false, failSaveA: false, registryDown: false }
  h.routes = new Map()
  h.current = null
  h.timers = []
  h.deps = {
    places: () => (h.env.registryDown ? Promise.reject(new Error('the registry cannot be read')) : Promise.resolve(new Set(['proj-a', 'proj-b']))),
    editIfFree: (projectId, edit) => {
      assertEquals(projectId, 'proj-b', 'the scans are filed under House B')
      if (h.env.brokenB) return Promise.reject(new Error('House B cannot be read or saved'))
      if (h.env.busyB) return Promise.resolve(false)
      const target = clone(h.disk.b)
      edit(target)
      h.disk.b = target
      return Promise.resolve(true)
    },
    // What server/main.ts's readWorld and refreshWorldScans do around the hand-over.
    readWorld: async (slug) => {
      assertEquals(slug, SOURCE)
      if (h.env.unreadableA) throw new Error('House A cannot be read')
      const source = clone(h.disk.a)
      const evicted: EvictedScan[] = source.scans
        .filter((row) => h.filedUnder.get(row.filename) !== 'proj-a')
        .map((row) => ({ scan: row, toProjectId: h.filedUnder.get(row.filename) ?? null, placedByRecord: h.placedByRecord.get(SCAN_OF.get(row.filename)!)! }))
      source.scans = source.scans.filter((row) => !evicted.some((entry) => entry.scan === row))
      source.scans.push(...await h.instance.handOver(source, evicted))
      if (evicted.length > 0) {
        if (h.env.failSaveA) throw new Error('House A cannot be saved')
        h.disk.a = source
      }
    },
    sleep: (ms) => new Promise<void>((resolve) => {
      assert(h.current !== null, 'only a route sleeps')
      const run = h.routes.get(h.current)!
      run.sleep = { ms, wake: resolve }
    }),
    later: (run, ms) => {
      h.timers.push({ ms, run, fired: false })
    },
    warn: () => {},
  }
  h.instance = createWorldHandOver(h.deps)
  return h
}

/** Let every promise the step started settle. Everything the stand-ins return is already resolved. */
async function quiesce(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

function startSettle(h: Harness, route: number, held: ReadonlyMap<string, ReadonlySet<string>>): void {
  const run: RouteRun = {}
  h.routes.set(route, run)
  h.current = route
  void h.instance.settle(held).then((report) => {
    run.report = report
    run.sleep = undefined
  })
}

async function applyStep(h: Harness, action: string, picks: Record<string, ItfValue | undefined>, pre: Record<string, ItfValue>, post: Record<string, ItfValue>): Promise<void> {
  switch (action) {
    case 'routeStart': {
      const route = num(picks.r)
      h.filedUnder.set(FILENAME[route]!, 'proj-b')
      // The route settles the worlds that held a row of its scan, and no other.
      const held = ints(rec(pre.worldA).rows).includes(route) ? new Map([[SOURCE, new Set([FILENAME[route]!])]]) : new Map()
      startSettle(h, route, held)
      break
    }
    case 'routeWake': {
      const route = num(picks.r)
      const run = h.routes.get(route)
      assert(run?.sleep, `route ${route} is sleeping`)
      h.current = route
      const { wake } = run.sleep
      run.sleep = undefined
      wake()
      break
    }
    case 'timerFires': {
      const pending = h.timers.filter((timer) => !timer.fired)
      assertEquals(pending.length, 1, 'one timer is set')
      pending[0]!.fired = true
      h.current = null
      void pending[0]!.run()
      break
    }
    case 'otherRead':
      h.current = null
      await h.deps.readWorld(SOURCE).catch(() => {})
      break
    case 'restart':
      // The files and the records stay; the hand-over's memory, its timers and the sleeping routes do not.
      for (const timer of h.timers) timer.fired = true
      for (const run of h.routes.values()) if (!run.report) run.sleep = undefined
      h.instance = createWorldHandOver(h.deps)
      break
    case 'envChanges':
      break
    default:
      throw new Error(`the replay does not know the action ${action}`)
  }
  await quiesce()
  h.current = null
  // The environment the model has after the step is the one the next step runs in.
  for (const [key, value] of Object.entries(rec(post.env))) h.env[key] = value === true
}

function compare(h: Harness, post: Record<string, ItfValue>, at: string): void {
  assertEquals(filesOf(h.disk.a), modelFiles(post.worldA), `${at}: House A's world`)
  assertEquals(filesOf(h.disk.b), modelFiles(post.worldB), `${at}: House B's world`)
  const routes = post.routes as Map<ItfValue, ItfValue>
  for (const [key, value] of routes) {
    const n = Number(key)
    const model = rec(value)
    const run = h.routes.get(n)
    switch (tag(model.phase)) {
      case 'NotStarted':
        assertEquals(run, undefined, `${at}: route ${n} has not started`)
        break
      case 'Sleeping':
        assertEquals(run?.report, undefined, `${at}: route ${n} has not answered`)
        assertEquals(run?.sleep?.ms, num(model.sleepMs), `${at}: route ${n} sleeps for what the model says`)
        break
      case 'Answered':
        assert(run?.report !== undefined, `${at}: route ${n} answered`)
        assertEquals({ pending: run.report.pending ?? 0, placementsKept: run.report.placementsKept ?? 0 }, { pending: num(model.pending), placementsKept: num(model.placementsKept) }, `${at}: route ${n}'s answer`)
        break
      case 'Abandoned':
        assertEquals(run?.report, undefined, `${at}: route ${n} never answers`)
        assertEquals(run?.sleep, undefined, `${at}: route ${n} is not sleeping`)
        break
      default:
        throw new Error(`unknown route phase ${tag(model.phase)}`)
    }
  }
  const timer = rec(post.timer)
  const pending = h.timers.filter((t) => !t.fired)
  if (timer.armed === true) {
    assertEquals(pending.length, 1, `${at}: one timer is set`)
    assertEquals(pending[0]!.ms, num(timer.ms), `${at}: the timer is set for what the model says`)
  } else {
    assertEquals(pending.length, 0, `${at}: no timer is set`)
  }
}

function traceFiles(): string[] {
  const dirs = [FIXTURES, ...(process.env.HANDOVER_ITF_DIR ? [process.env.HANDOVER_ITF_DIR] : [])]
  return dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.itf.json')).sort().map((name) => join(dir, name)) : []))
}

/** What the model's state after a step shows was tested, beyond the action names. */
function cases(post: Record<string, ItfValue>, action: string): string[] {
  const out: string[] = []
  for (const value of (post.routes as Map<ItfValue, ItfValue>).values()) {
    const route = rec(value)
    if (tag(route.phase) === 'Sleeping' && num(route.attempt) >= 1) out.push('a route slept a second time')
    if (tag(route.phase) === 'Answered' && num(route.pending) > 0) out.push('a route answered pending')
    if (tag(route.phase) === 'Answered' && num(route.placementsKept) > 0) out.push('a route answered with a kept placement')
  }
  const timer = rec(post.timer)
  if (timer.armed === true && num(timer.attempt) >= 1) out.push('the timer doubled')
  const event = rec(post.event)
  if (tag(event) === 'Read') {
    const read = rec(event.value)
    if ((read.again as Set<ItfValue>).size > 0) out.push('a scan was handed over again')
    if ((read.handed as Set<ItfValue>).size > 0 && action === 'timerFires') out.push('the timer handed a scan over')
  }
  return out
}

const CASES = [
  'a route slept a second time', 'a route answered pending', 'a route answered with a kept placement',
  'the timer doubled', 'a scan was handed over again', 'the timer handed a scan over',
]

test('world_hand_over.ts does what the hand-over model does, on every step of every trace', async () => {
  const files = traceFiles()
  assert(files.length > 0, `no traces in ${FIXTURES}${process.env.HANDOVER_ITF_DIR ? ` or ${process.env.HANDOVER_ITF_DIR}` : ''}`)
  const seen = new Map<string, number>()
  const perTrace: { file: string; firstSeen: Record<string, number> }[] = []
  let steps = 0
  // scan_carry.ts warns when the registry cannot be read: expected here, and counted rather than printed.
  const warn = console.warn
  let warnings = 0
  console.warn = () => { warnings += 1 }
  try {
  for (const file of files) {
    const trace = parseItfTrace(readFileSync(file, 'utf8'))
    const states = trace.states.map(vars)
    const placed = states[0]!.byRecord as Map<ItfValue, ItfValue>
    const h = harness(new Map([...placed].map(([k, v]) => [Number(k), v === true])))
    for (const [key, value] of Object.entries(rec(states[0]!.env))) h.env[key] = value === true
    const name = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file
    const firstSeen: Record<string, number> = {}
    perTrace.push({ file, firstSeen })
    compare(h, states[0]!, `${name} state 0`)
    for (let i = 1; i < states.length; i++) {
      const action = itfAction(trace.states[i]!)
      assert(action, `${name} step ${i} names its action`)
      await applyStep(h, action, itfPicks(trace.states[i]!), states[i - 1]!, states[i]!)
      compare(h, states[i]!, `${name} step ${i} (${action})`)
      for (const key of [action, ...cases(states[i]!, action)]) {
        seen.set(key, (seen.get(key) ?? 0) + 1)
        if (!(key in firstSeen)) firstSeen[key] = i
      }
      steps += 1
    }
  }
  } finally {
    console.warn = warn
  }
  // A replay that never woke a route or fired a timer has not tested the clock.
  const coverage = ['routeStart', 'routeWake', 'timerFires', 'otherRead', 'restart', 'envChanges', ...CASES]
  // The spec gate picks the committed fixtures from this: the fewest prefixes that still check every case.
  if (process.env.ITF_TALLY) writeFileSync(process.env.ITF_TALLY, `${JSON.stringify({ coverage, perTrace })}\n`)
  for (const key of coverage) {
    assert((seen.get(key) ?? 0) > 0, `no step checked "${key}" (${files.length} traces, ${steps} steps): ${JSON.stringify(Object.fromEntries(seen))}`)
  }
  if (process.env.HANDOVER_ITF_VERBOSE) console.log(JSON.stringify({ files: files.length, steps, warnings, seen: Object.fromEntries(seen) }))
})
