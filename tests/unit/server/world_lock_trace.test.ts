/**
 * Conformance of the lock model (module worldLockModel in spec/quint/worldHandOver.qnt) with
 * server/world/world_lock.ts.
 *
 * Each trace is a `quint run --mbt` run of the model. The replay runs the real `withWorldLock` and
 * `tryWithWorldLock` over two slugs, with a critical section per cycle that does what server/main.ts's cycles do to
 * a world file: read it, write a temp file, rename it over the file (updateWorld, mutateWorldFiles), and for a
 * refresh that hands scans over, try the other world's lock between its read and its own save, and read, write and
 * rename that world inside it (editIfFree). Every await in those sections waits at a gate the trace opens, so the
 * code runs exactly the interleaving the model chose.
 *
 * After every step it compares where each cycle is waiting (or that it is queued, or done), what
 * `tryWithWorldLock` answered, each world file's generation, and `heldWorldLocks()`. A crash loads a fresh copy of
 * the module, which is what a restart is to its in-process locks; the files stay.
 *
 * What it does not reach: the temp file and the rename are main.ts's (writeWorldUnlocked), so the files here are a
 * stand-in that renames whole generations. That a reader never finds a half-written file is the model's property,
 * and its planted variant shows what writing in place would do.
 *
 * Traces: spec/quint/traces/worldLock/*.itf.json (committed), and the directory in LOCK_ITF_DIR when the spec gate
 * (npm run spec:world) has written seeded ones. No trace is a failure.
 */
import { assert, assertEquals } from './assert.ts'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { itfAction, itfPicks, parseItfTrace, type ItfState, type ItfValue } from '../../../spec/quint/itf.ts'
import type * as WorldLock from '../../../server/world/world_lock.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FIXTURES = join(ROOT, 'spec', 'quint', 'traces', 'worldLock')
const LOCK_MODULE = pathToFileURL(join(ROOT, 'server', 'world', 'world_lock.ts')).href

const slug = (w: number) => `project-w${w}`
const HANDOVERS = new Set([3, 4])
const other = (w: number) => 3 - w

type Rec = { [field: string]: ItfValue }
const rec = (value: ItfValue | undefined): Rec => value as Rec
const tag = (value: ItfValue | undefined): string => String(rec(value).tag)
const num = (value: ItfValue | undefined): number => Number(value as bigint)

function vars(state: ItfState): Record<string, ItfValue> {
  const out: Record<string, ItfValue> = {}
  for (const [name, value] of Object.entries(state)) out[name.startsWith('mbt::') ? name : name.slice(name.lastIndexOf('::') + 2)] = value
  return out
}

/** Where the model's phase says a cycle is: a gate it waits at, queued behind another, or not running. */
const WHERE: Record<string, string> = {
  Idle: 'idle',
  Queued: 'queued',
  AtRead: 'read',
  AtWriteTmp: 'writeTmp',
  AtRename: 'rename',
  AtReadOther: 'readOther',
  AtWriteTmpOther: 'writeTmpOther',
  AtRenameOther: 'renameOther',
}

interface Flow {
  /** The gate it is waiting at, and how to open it. */
  at?: { gate: string; open: () => void }
  done: boolean
  tried?: 'Ran' | 'Busy'
}

/** Every copy of world_lock.ts this file loads is a new process life: the counter spans traces. */
let lives = 0

class Harness {
  lock!: typeof WorldLock
  files = new Map<number, number>([[1, 1], [2, 1]])
  flows = new Map<number, Flow>()
  async restart(): Promise<void> {
    lives += 1
    this.lock = await import(`${LOCK_MODULE}?life=${lives}`) as typeof WorldLock
    this.flows.clear()
  }

  private gate(flow: Flow, gate: string): Promise<void> {
    return new Promise((resolve) => {
      flow.at = { gate, open: resolve }
    })
  }

  /** One cycle, as main.ts runs it: the critical section of updateWorld, or of a refresh that hands scans over. */
  start(c: number, w: number): void {
    const flow: Flow = { done: false }
    this.flows.set(c, flow)
    const files = this.files
    const lock = this.lock
    void lock.withWorldLock(slug(w), async () => {
      await this.gate(flow, 'read')
      flow.at = undefined
      const base = files.get(w)!
      if (HANDOVERS.has(c)) {
        const o = other(w)
        const tried = await lock.tryWithWorldLock(slug(o), async () => {
          await this.gate(flow, 'readOther')
          const baseOther = files.get(o)!
          await this.gate(flow, 'writeTmpOther')
          await this.gate(flow, 'renameOther')
          files.set(o, baseOther + 1)
        })
        flow.tried = tried.ran ? 'Ran' : 'Busy'
      }
      await this.gate(flow, 'writeTmp')
      await this.gate(flow, 'rename')
      files.set(w, base + 1)
    }).then(() => {
      flow.done = true
      flow.at = undefined
    })
  }

  open(c: number, gate: string): void {
    const flow = this.flows.get(c)
    assert(flow?.at?.gate === gate, `cycle ${c} waits at ${gate}, not at ${flow?.at?.gate ?? (flow ? 'nothing' : 'no cycle')}`)
    const { open } = flow.at
    flow.at = undefined
    open()
  }

  where(c: number): string {
    const flow = this.flows.get(c)
    if (!flow || flow.done) return 'idle'
    return flow.at?.gate ?? 'queued'
  }
}

async function quiesce(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

const OPENS: Record<string, string> = {
  read: 'read',
  readOther: 'readOther',
  writeTmpOther: 'writeTmpOther',
  renameOther: 'renameOther',
  writeTmp: 'writeTmp',
  rename: 'rename',
}

function compare(h: Harness, post: Record<string, ItfValue>, at: string, action: string, cycle: number | undefined): void {
  for (const [key, value] of post.cycles as Map<ItfValue, ItfValue>) {
    const c = Number(key)
    assertEquals(h.where(c), WHERE[tag(rec(value).phase)], `${at}: cycle ${c}`)
  }
  for (const [key, value] of post.files as Map<ItfValue, ItfValue>) {
    const w = Number(key)
    const file = rec(value)
    assertEquals(file.partial, false, `${at}: the model's files are written whole`)
    assertEquals(h.files.get(w), num(file.version), `${at}: world ${w}'s generation`)
  }
  const held = [...(post.chains as Map<ItfValue, ItfValue>)].filter(([, chain]) => (chain as ItfValue[]).length > 0).map(([w]) => slug(Number(w))).sort()
  assertEquals([...h.lock.heldWorldLocks()].sort(), held, `${at}: heldWorldLocks()`)
  if (action === 'read' && cycle !== undefined && HANDOVERS.has(cycle)) {
    const tried = tag(post.lastTry)
    if (tried === 'Busy') assertEquals(h.flows.get(cycle)?.tried, 'Busy', `${at}: tryWithWorldLock answered ran: false`)
    else assertEquals(tried, 'Ran', `${at}: the model tried`)
  }
}

function traceFiles(): string[] {
  const dirs = [FIXTURES, ...(process.env.LOCK_ITF_DIR ? [process.env.LOCK_ITF_DIR] : [])]
  return dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.itf.json')).sort().map((name) => join(dir, name)) : []))
}

test('world_lock.ts queues, tries and hands over its lock as the lock model does, on every step of every trace', async () => {
  const files = traceFiles()
  assert(files.length > 0, `no traces in ${FIXTURES}${process.env.LOCK_ITF_DIR ? ` or ${process.env.LOCK_ITF_DIR}` : ''}`)
  const seen = new Map<string, number>()
  const perTrace: { file: string; firstSeen: Record<string, number> }[] = []
  let steps = 0
  for (const file of files) {
    const trace = parseItfTrace(readFileSync(file, 'utf8'))
    const states = trace.states.map(vars)
    const name = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file
    const firstSeen: Record<string, number> = {}
    perTrace.push({ file, firstSeen })
    const h = new Harness()
    await h.restart()
    compare(h, states[0]!, `${name} state 0`, 'init', undefined)
    for (let i = 1; i < states.length; i++) {
      const action = itfAction(trace.states[i]!)
      assert(action, `${name} step ${i} names its action`)
      const picks = itfPicks(trace.states[i]!)
      const c = picks.c === undefined ? undefined : num(picks.c)
      switch (action) {
        case 'start':
          h.start(c!, num(picks.w))
          break
        case 'list':
        case 'step':
          break
        case 'crash':
          await h.restart()
          break
        default:
          assert(action in OPENS, `the replay does not know the action ${action}`)
          h.open(c!, OPENS[action]!)
      }
      await quiesce()
      compare(h, states[i]!, `${name} step ${i} (${action}${c === undefined ? '' : ` ${c}`})`, action, c)
      const busy = action === 'read' && c !== undefined && tag(states[i]!.lastTry) === 'Busy'
      const keys = [action, ...(busy ? ['try:busy'] : []), ...(action === 'read' && tag(states[i]!.lastTry) === 'Ran' ? ['try:ran'] : []), ...(action === 'start' && h.where(c!) === 'queued' ? ['queued'] : [])]
      for (const key of keys) {
        seen.set(key, (seen.get(key) ?? 0) + 1)
        if (!(key in firstSeen)) firstSeen[key] = i
      }
      steps += 1
    }
  }
  const coverage = ['start', 'queued', 'read', 'readOther', 'writeTmpOther', 'renameOther', 'writeTmp', 'rename', 'crash', 'try:busy', 'try:ran']
  // The spec gate picks the committed fixtures from this: the fewest prefixes that still check every case.
  if (process.env.ITF_TALLY) writeFileSync(process.env.ITF_TALLY, `${JSON.stringify({ coverage, perTrace })}\n`)
  for (const key of coverage) {
    assert((seen.get(key) ?? 0) > 0, `no step checked "${key}" (${files.length} traces, ${steps} steps): ${JSON.stringify(Object.fromEntries(seen))}`)
  }
  if (process.env.LOCK_ITF_VERBOSE) console.log(JSON.stringify({ files: files.length, steps, seen: Object.fromEntries(seen) }))
})
