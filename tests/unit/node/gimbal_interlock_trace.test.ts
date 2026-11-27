/**
 * Conformance of the gimbal interlock model (spec/quint/gimbalInterlock.qnt) with the decision code it models.
 *
 * Each trace is a `quint run --mbt` run of the model: a state per step, with the action the model took and its
 * nondeterministic picks. For every state this asks the code what the model decided, from the state before the step:
 *
 *  - the link level: protocol/link_state.mjs deriveLinkState, from the handle, the connect flag and the age of the
 *    last notification, against the level the model carries;
 *  - every outside frame (POST /api/command, a command probe), judged by protocol/motion_gate.mjs motionRefusal on
 *    the frame's own bytes, as backend.mjs judges it;
 *  - every move-to or arc probe at its door, by moveRefusal;
 *  - the capture's start and its advance, by captureStartRefusal and advanceRefusal (the door rules of
 *    POST /api/grid-capture and POST /api/grid-advance);
 *  - the capture's own frames (runOwned), and the writes that need a link.
 *
 * What it does not reach: backend.mjs's ordering of awaits, its registration and cancellation of outside motions,
 * and the run loop. Those are the model's assumptions, read from the code and covered by the subsystem's own
 * server tests (subsystems/osmo-ble/server/wp-f*.test.mjs).
 *
 * Traces: spec/quint/traces/gimbal/*.itf.json, which are committed, and the directory in GIMBAL_ITF_DIR when the
 * spec gate (npm run spec:gimbal) has written fresh seeded ones. No trace is a failure, not a pass.
 *
 * Run: npm run test:gimbal:interlock
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { itfAction, itfPicks, parseItfTrace, type ItfState, type ItfValue } from '../../../spec/quint/itf.ts'
import {
  advanceRefusal,
  captureStartRefusal,
  MotionRefusedError,
  motionRefusal,
  moveRefusal,
  OUTSIDE_MOTION_BUSY,
  SCAN_OWNS_GIMBAL,
} from '../../../subsystems/osmo-ble/protocol/motion_gate.mjs'
import { deriveLinkState, isLinked, isStreaming, LINK, STREAM_STALE_MS } from '../../../subsystems/osmo-ble/protocol/link_state.mjs'
import {
  buildGimbalRecenter,
  buildGimbalSetMode,
  buildGimbalSpeedControl,
  buildGimbalStickControlEnable,
  buildRawCommand,
} from '../../../subsystems/osmo-ble/protocol/commands.mjs'
import { decodeFrame } from '../../../subsystems/osmo-ble/protocol/duml.mjs'
import { CMD_ID, CMD_SET, GIMBAL_MODE } from '../../../subsystems/osmo-ble/protocol/constants.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FIXTURES = join(ROOT, 'spec', 'quint', 'traces', 'gimbal')
/** One model tick is one second (STALE_S = STREAM_STALE_MS / 1000 in the model). */
const TICK_MS = 1000
/** Any fixed clock: the link level depends only on how long ago the last notification was. */
const NOW = 1_800_000_000_000

// ── Reading the model's state ─────────────────────────────────────────────────────────────────────

type Rec = { [field: string]: ItfValue }
const rec = (value: ItfValue | undefined, what: string): Rec => {
  assert.ok(value !== undefined && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set) && !(value instanceof Map), `${what} is a record`)
  return value as Rec
}
const tag = (value: ItfValue | undefined): string => String(rec(value, 'variant').tag)
const num = (value: ItfValue | undefined): number => {
  assert.equal(typeof value, 'bigint', 'an integer')
  return Number(value)
}

/** The model's variables, by their own names: ITF names them module::instance::name. */
function vars(state: ItfState): Record<string, ItfValue> {
  const out: Record<string, ItfValue> = {}
  for (const [name, value] of Object.entries(state)) out[name.startsWith('mbt::') ? name : name.slice(name.lastIndexOf('::') + 2)] = value
  return out
}

interface View {
  link: Rec
  cap: Rec
  ctl: Map<number, Rec>
  wire: Rec
  event: Rec
}

function view(state: ItfState): View {
  const v = vars(state)
  const ctl = v.ctl
  assert.ok(ctl instanceof Map, 'ctl is a map')
  return {
    link: rec(v.link, 'link'),
    cap: rec(v.cap, 'cap'),
    ctl: new Map([...ctl].map(([slot, c]) => [num(slot), rec(c, 'ctl entry')])),
    wire: rec(v.wire, 'wire'),
    event: rec(v.event, 'event'),
  }
}

const scanRunning = (s: View) => tag(s.cap.phase) !== 'CapIdle'
const parked = (s: View) => tag(s.cap.phase) === 'CapParked'
const anyRegistered = (s: View) => [...s.ctl.values()].some((c) => c.registered === true)
const otherRegistered = (s: View, slot: number) => [...s.ctl].some(([k, c]) => k !== slot && c.registered === true)
const eventIs = (s: View, name: string, source?: string) =>
  tag(s.event) === name && (source === undefined || tag(rec(s.event, 'event').value) === source)

/** The inputs deriveLinkState reads, for the model's link: one subscription whenever there is a handle. */
function codeLevel(link: Rec): string {
  const up = link.up === true
  return deriveLinkState({
    peripheralState: up ? 'connected' : 'disconnected',
    connecting: link.connecting === true,
    subscribedChars: up ? ['fff4'] : [],
    lastNotifyAt: link.notified === true ? NOW - num(link.age) * TICK_MS : 0,
    now: NOW,
  })
}

const MODEL_LEVEL: Record<string, string> = {
  Disconnected: LINK.DISCONNECTED,
  Connecting: LINK.CONNECTING,
  Linked: LINK.LINKED,
  Streaming: LINK.STREAMING,
}

// ── Frames, as the code builds and decodes them ───────────────────────────────────────────────────

/** The frame the model calls `kind`, built by the same builders the routes use, then decoded as buildAndSend does. */
function frameFor(kind: string) {
  const bytes = {
    Stop: () => buildGimbalSpeedControl(1, {}),
    Speed: () => buildGimbalSpeedControl(1, { yawDegPerSec: 30 }),
    Recenter: () => buildGimbalRecenter(1),
    SetMode: () => buildGimbalSetMode(1, GIMBAL_MODE.FOLLOW),
    StickOn: () => buildGimbalStickControlEnable(1, true),
    StickOff: () => buildGimbalStickControlEnable(1, false),
    NonGimbal: () => buildRawCommand(1, { cmdSet: CMD_SET.WIFI, cmdId: CMD_ID.SET_PAIRING_PIN, payloadHex: '0100' }),
  }[kind]
  assert.ok(bytes, `a frame the model names: ${kind}`)
  return decodeFrame(bytes())
}

/** The wording motionRefusal and moveRefusal give, by whether the scan is parked. */
function assertWording(refusal: unknown, pre: View) {
  assert.ok(refusal instanceof MotionRefusedError)
  assert.equal(refusal.status, 409)
  const wording = parked(pre) ? OUTSIDE_MOTION_BUSY : SCAN_OWNS_GIMBAL
  assert.equal(refusal.message, wording.error)
  assert.equal(refusal.remediation, wording.remediation)
}

// ── The replay ────────────────────────────────────────────────────────────────────────────────────

/** How often each decision was checked, by outcome: a replay that never reaches one checks nothing about it. */
type Tally = Record<string, number>

/** The decisions whose both outcomes the traces must reach. */
const COVERAGE = [
  'command:sent', 'command:refused', 'probe:sent', 'probe:refused', 'move:admitted', 'move:refused',
  'start:started', 'start:refused', 'advance:resumed', 'advance:refused', 'pulse:streaming',
  'level:disconnected', 'level:connecting', 'level:linked', 'level:streaming',
]

/** Replays one trace. Returns, for each key, the first step that checked it. */
function replay(trace: ReturnType<typeof parseItfTrace>, tally: Tally, where: string): Record<string, number> {
  const firstSeen: Record<string, number> = {}
  let current = 0
  const count = (key: string) => {
    tally[key] = (tally[key] ?? 0) + 1
    if (!(key in firstSeen)) firstSeen[key] = current
  }
  const states = trace.states.map(view)
  states.forEach((s, i) => {
    current = i
    const level = codeLevel(s.link)
    assert.equal(level, MODEL_LEVEL[tag(s.link.level)], `${where} state ${i}: deriveLinkState gives ${level} for ${JSON.stringify(s.link, (_, v) => (typeof v === 'bigint' ? Number(v) : v))}`)
    assert.equal(isLinked(level), ['Linked', 'Streaming'].includes(tag(s.link.level)), `${where} state ${i}: isLinked`)
    assert.equal(isStreaming(level), tag(s.link.level) === 'Streaming', `${where} state ${i}: isStreaming`)
    count(`level:${level}`)
  })

  for (let i = 1; i < trace.states.length; i++) {
    current = i
    const at = `${where} step ${i}`
    const action = itfAction(trace.states[i]!)
    const picks = itfPicks(trace.states[i]!)
    const pre = states[i - 1]!
    const post = states[i]!
    const preLevel = codeLevel(pre.link)
    assert.ok(action, `${at}: the trace names its action`)

    // A frame went out in this step: the code can only write over a linked link.
    const wrote = num(post.wire.onLink) > num(pre.wire.onLink) && action !== 'connectDone'
    if (wrote) {
      assert.ok(isLinked(preLevel), `${at}: ${action} wrote over a ${preLevel} link`)
      count('write over a linked link')
    }

    switch (action) {
      case 'command': {
        const kind = tag(picks.f)
        assert.ok(isLinked(preLevel), `${at}: POST /api/command needs a linked link ('write')`)
        const refusal = motionRefusal(frameFor(kind), { scanRunning: scanRunning(pre), parked: parked(pre), runOwned: false, outsideMotion: anyRegistered(pre) })
        assert.equal(refusal !== null, eventIs(post, 'Refused', 'Command'), `${at}: command ${kind}: the code ${refusal ? 'refuses' : 'sends'} it`)
        if (refusal) assertWording(refusal, pre)
        count(`command:${refusal ? 'refused' : 'sent'}`)
        break
      }
      case 'probeSend': {
        const slot = num(picks.s)
        const kind = tag(picks.f)
        assert.ok(isStreaming(preLevel), `${at}: a command probe needs a streaming link`)
        const refusal = motionRefusal(frameFor(kind), { scanRunning: scanRunning(pre), parked: parked(pre), runOwned: false, outsideMotion: otherRegistered(pre, slot) })
        assert.equal(refusal !== null, eventIs(post, 'Refused', 'ProbeFrame'), `${at}: probe ${kind} in slot ${slot}`)
        if (refusal) assertWording(refusal, pre)
        else assert.equal(post.ctl.get(slot)!.registered, true, `${at}: a probe that sent is registered`)
        count(`probe:${refusal ? 'refused' : 'sent'}`)
        break
      }
      case 'moveRequest': {
        assert.ok(isStreaming(preLevel), `${at}: POST /api/move-to checks linkRefusal('stream') first`)
        count('move:checked')
        break
      }
      case 'moveAdmit': {
        const slot = num(picks.s)
        const refusal = moveRefusal({ scanRunning: scanRunning(pre), parked: parked(pre), outsideMotion: anyRegistered(pre) })
        assert.equal(refusal !== null, eventIs(post, 'MoveRefused'), `${at}: moveRefusal for slot ${slot}`)
        if (refusal) assertWording(refusal, pre)
        else assert.equal(post.ctl.get(slot)!.registered, true, `${at}: an admitted move is registered`)
        count(`move:${refusal ? 'refused' : 'admitted'}`)
        break
      }
      case 'captureStart': {
        const startRefusal = captureStartRefusal({ scanRunning: scanRunning(pre), outsideMotion: anyRegistered(pre) })
        const codeStarts = isStreaming(preLevel) && startRefusal === null
        assert.equal(codeStarts, tag(post.cap.phase) === 'CapSweep', `${at}: the capture door ${codeStarts ? 'opens' : 'stays shut'}`)
        if (startRefusal) assert.equal(typeof startRefusal.error, 'string')
        count(`start:${codeStarts ? 'started' : 'refused'}`)
        break
      }
      case 'gridAdvance': {
        const refusal = advanceRefusal({ scanRunning: scanRunning(pre), parked: parked(pre), streaming: isStreaming(preLevel), outsideMotion: anyRegistered(pre) })
        assert.equal(refusal === null, tag(post.cap.phase) === 'CapSweep', `${at}: the advance ${refusal ? 'is refused' : 'goes on'}`)
        count(`advance:${refusal ? 'refused' : 'resumed'}`)
        break
      }
      case 'captureOwnFrame': {
        if (isLinked(preLevel)) {
          const refusal = motionRefusal(frameFor('SetMode'), { scanRunning: scanRunning(pre), parked: parked(pre), runOwned: true, outsideMotion: anyRegistered(pre) })
          assert.equal(refusal, null, `${at}: the run's own mode change is never refused`)
          assert.equal(tag(rec(post.wire.last, 'last').src), 'CaptureOwn', `${at}: and the model sent it`)
          count('run-owned:sent')
        }
        break
      }
      case 'capturePulse':
      case 'outsidePulse': {
        assert.ok(isStreaming(preLevel), `${at}: driveClosedLoop writes a speed only while transport.connected`)
        count('pulse:streaming')
        break
      }
      default:
        count(`other:${action}`)
    }
  }
  return firstSeen
}

function traceFiles(): string[] {
  const dirs = [FIXTURES, ...(process.env.GIMBAL_ITF_DIR ? [process.env.GIMBAL_ITF_DIR] : [])]
  return dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.itf.json')).sort().map((name) => join(dir, name)) : []))
}

test('the gimbal interlock model agrees with motion_gate.mjs and link_state.mjs on every step of every trace', () => {
  const files = traceFiles()
  assert.ok(files.length > 0, `no traces in ${FIXTURES}${process.env.GIMBAL_ITF_DIR ? ` or ${process.env.GIMBAL_ITF_DIR}` : ''}`)
  const tally: Tally = {}
  const perTrace: { file: string; steps: number; firstSeen: Record<string, number> }[] = []
  let steps = 0
  for (const file of files) {
    const trace = parseItfTrace(readFileSync(file, 'utf8'))
    steps += trace.states.length - 1
    perTrace.push({ file, steps: trace.states.length - 1, firstSeen: replay(trace, tally, file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file) })
  }
  // The spec gate picks the committed fixtures from these: the fewest prefixes that still check every key.
  if (process.env.ITF_TALLY) writeFileSync(process.env.ITF_TALLY, `${JSON.stringify({ coverage: COVERAGE, perTrace })}\n`)
  // Both outcomes of every decision the model makes, or the replay has not tested it.
  for (const key of COVERAGE) {
    assert.ok((tally[key] ?? 0) > 0, `no step checked ${key} (${files.length} traces, ${steps} steps): ${JSON.stringify(tally)}`)
  }
  if (process.env.GIMBAL_ITF_VERBOSE) console.log(JSON.stringify({ files: files.length, steps, tally }))
})

test('the model ticks in whole seconds of STREAM_STALE_MS', () => {
  assert.equal(STREAM_STALE_MS % TICK_MS, 0)
  assert.equal(STREAM_STALE_MS / TICK_MS, 3, 'STALE_S in gimbalInterlock.qnt')
})
