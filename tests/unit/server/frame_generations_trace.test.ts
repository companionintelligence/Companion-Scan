/**
 * Conformance of the frame generation model (module frameModel in spec/quint/worldHandOver.qnt) with
 * `applySpatialFrameWrite` (server/wp-a-projects.ts, with decideReplacement from server/place_frames.ts) and with
 * the editor's chip for a scan (`frameChipFor`, src/viewer/frame-banner.ts).
 *
 * Each trace is a `quint run --mbt` run of the model. For every frame write in it, the replay builds the Place the
 * model holds before the write (its frame, revision and history), sends the write the model sent (the frame, the
 * revision the phone read, and what it says it replaces), and compares the answer (status, refusal code, whether it
 * saved) and the Place after it with the model's. After every step it asks `frameChipFor` about a two-point scan
 * measured against each generation the Place has held: a superseded one must be listed as a previous reference.
 *
 * Traces: spec/quint/traces/frames/*.itf.json (committed), and the directory in FRAMES_ITF_DIR when the spec gate
 * (npm run spec:world) has written seeded ones. No trace is a failure.
 */
import { assert, assertEquals } from './assert.ts'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { itfAction, itfPicks, parseItfTrace, type ItfState, type ItfValue } from '../../../spec/quint/itf.ts'
import { applySpatialFrameWrite } from '../../../server/wp-a-projects.ts'
import { frameIdOf } from '../../../src/world/frame-generations.ts'
import { frameChipFor } from '../../../src/viewer/frame-banner.ts'
import type { FrameHistoryEntry, Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FIXTURES = join(ROOT, 'spec', 'quint', 'traces', 'frames')
const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const AT = ['', '2026-11-16T08:00:00.000Z', '2026-11-16T09:00:00.000Z', '2026-11-16T10:00:00.000Z']

type Rec = { [field: string]: ItfValue }
const rec = (value: ItfValue | undefined): Rec => value as Rec
const tag = (value: ItfValue | undefined): string => String(rec(value).tag)
const num = (value: ItfValue | undefined): number => Number(value as bigint)

function vars(state: ItfState): Record<string, ItfValue> {
  const out: Record<string, ItfValue> = {}
  for (const [name, value] of Object.entries(state)) out[name.startsWith('mbt::') ? name : name.slice(name.lastIndexOf('::') + 2)] = value
  return out
}

interface ModelFrame { id: number; at: number; named: boolean }
const modelFrame = (value: ItfValue | undefined): ModelFrame => {
  const f = rec(value)
  return { id: num(f.id), at: num(f.at), named: f.named === true }
}

/** The model's frame as a two-point frame record: what it is made of depends only on its time, its id and its names. */
function frameOf(f: ModelFrame): ProjectSpatialFrame {
  const separationM = 1 + f.at
  return {
    version: 1,
    createdAt: AT[f.at]!,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...(f.id > 0 ? { frameId: `gen-${f.id}` } : {}),
    ...(f.named ? { pointLabels: ['door', 'window'] } : {}),
  } as ProjectSpatialFrame
}

/** The model's frame, read back from a stored one. */
function readBack(frame: ProjectSpatialFrame | undefined): ModelFrame {
  if (!frame) return { id: -1, at: 0, named: false }
  const id = frameIdOf(frame)
  return { id: id === null ? 0 : Number(id.replace(/^gen-/, '')), at: AT.indexOf(frame.createdAt), named: Array.isArray((frame as { pointLabels?: unknown }).pointLabels) }
}

function historyOf(value: ItfValue | undefined): { id: number; at: number }[] {
  return (value as ItfValue[]).map((entry) => ({ id: num(rec(entry).id), at: num(rec(entry).at) }))
}

function placeOf(state: Record<string, ItfValue>): Project {
  const held = modelFrame(state.held)
  const history = historyOf(state.history)
  return {
    projectId: 'proj-1',
    name: 'Home',
    createdAt: 1,
    updatedAt: 1,
    floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [] }],
    ...(held.id >= 0 ? { spatialFrame: frameOf(held) } : {}),
    ...(num(state.revision) > 0 ? { spatialFrameRevision: num(state.revision) } : {}),
    ...(history.length > 0
      ? {
        frameHistory: history.map((entry): FrameHistoryEntry => ({
          frameId: entry.id > 0 ? `gen-${entry.id}` : null,
          createdAt: AT[entry.at]!,
          method: 'two-point-ground',
          separationM: 1 + entry.at,
          supersededAt: new Date(NOW).toISOString(),
          reason: 'override',
        })),
      }
      : {}),
  }
}

const CODE: Record<string, string | undefined> = {
  NoCode: undefined,
  Stale: undefined,
  ReplacesRequired: 'replaces-required',
  ReplacesMismatch: 'replaces-mismatch',
  FrameIdReused: 'frame-id-reused',
}

function traceFiles(): string[] {
  const dirs = [FIXTURES, ...(process.env.FRAMES_ITF_DIR ? [process.env.FRAMES_ITF_DIR] : [])]
  return dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.itf.json')).sort().map((name) => join(dir, name)) : []))
}

test('applySpatialFrameWrite and frameChipFor do what the frame model does, on every step of every trace', () => {
  const files = traceFiles()
  assert(files.length > 0, `no traces in ${FIXTURES}${process.env.FRAMES_ITF_DIR ? ` or ${process.env.FRAMES_ITF_DIR}` : ''}`)
  const seen = new Map<string, number>()
  const perTrace: { file: string; firstSeen: Record<string, number> }[] = []
  let firstSeen: Record<string, number> = {}
  let current = 0
  const count = (key: string) => {
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (!(key in firstSeen)) firstSeen[key] = current
  }
  let steps = 0
  for (const file of files) {
    const trace = parseItfTrace(readFileSync(file, 'utf8'))
    const states = trace.states.map(vars)
    const name = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file
    firstSeen = {}
    perTrace.push({ file, firstSeen })
    for (let i = 1; i < states.length; i++) {
      current = i
      const at = `${name} step ${i}`
      const action = itfAction(trace.states[i]!)
      const picks = itfPicks(trace.states[i]!)
      const pre = states[i - 1]!
      const post = states[i]!
      if (action === 'writeFrame') {
        const client = rec((pre.clients as Map<ItfValue, ItfValue>).get(picks.c!))
        const sent = { id: num(picks.id), at: num(picks.at), named: picks.named === true }
        const replaces = rec(picks.replaces)
        const body: Record<string, unknown> = { frame: frameOf(sent), expectedRevision: num(client.revision) }
        if (tag(replaces) === 'ReplacesId') {
          const id = num(replaces.value)
          body.replaces = { frameId: id > 0 ? `gen-${id}` : null, reason: 'override' }
        }
        const projects = [placeOf(pre)]
        const { result, save } = applySpatialFrameWrite(projects, 'proj-1', body, NOW)
        const model = rec(post.lastWrite)
        assertEquals(result.status, num(model.status), `${at}: status`)
        assertEquals(save, model.stored === true, `${at}: saved`)
        assertEquals((result.body as { code?: string }).code, CODE[tag(model.code)], `${at}: refusal code`)
        assertEquals((result.body as { unchanged?: boolean }).unchanged === true, model.unchanged === true, `${at}: unchanged`)
        const after = projects[0]!
        assertEquals(readBack(after.spatialFrame), modelFrame(post.held), `${at}: the frame held`)
        assertEquals(after.spatialFrameRevision ?? 0, num(post.revision), `${at}: the revision`)
        assertEquals((after.frameHistory ?? []).map((entry) => ({ id: entry.frameId ? Number(entry.frameId.replace(/^gen-/, '')) : 0, at: AT.indexOf(entry.createdAt) })), historyOf(post.history), `${at}: the history`)
        count(`write:${result.status}:${(result.body as { code?: string }).code ?? (save ? 'stored' : 'unchanged-or-stale')}`)
      } else {
        assertEquals(action, 'readPlace', `${at}: the replay knows ${action}`)
        count('read')
      }
      // A scan measured against each generation the Place has held: a superseded one is a previous reference.
      const place = placeOf(post)
      for (const g of post.measured as Set<ItfValue>) {
        const id = Number(g)
        const chip = frameChipFor({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified', calibrationFrameId: `gen-${id}`, calibratedAt: AT[1]! }, place)
        if (id === modelFrame(post.held).id) assertEquals(chip, null, `${at}: a scan of the current generation has no chip`)
        else {
          assertEquals(chip?.kind, 'previous-reference', `${at}: a scan of generation ${id} is listed`)
          count('chip:previous')
        }
      }
      steps += 1
    }
  }
  const coverage = ['read', 'write:200:stored', 'write:200:unchanged-or-stale', 'write:409:unchanged-or-stale', 'write:409:replaces-required', 'write:409:replaces-mismatch', 'write:409:frame-id-reused', 'chip:previous']
  // The spec gate picks the committed fixtures from this: the fewest prefixes that still check every case.
  if (process.env.ITF_TALLY) writeFileSync(process.env.ITF_TALLY, `${JSON.stringify({ coverage, perTrace })}\n`)
  for (const key of coverage) {
    assert((seen.get(key) ?? 0) > 0, `no step checked "${key}" (${files.length} traces, ${steps} steps): ${JSON.stringify(Object.fromEntries(seen))}`)
  }
  if (process.env.FRAMES_ITF_VERBOSE) console.log(JSON.stringify({ files: files.length, steps, seen: Object.fromEntries(seen) }))
})
