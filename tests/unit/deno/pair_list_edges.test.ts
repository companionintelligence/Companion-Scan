/**
 * Edges of the pair-list builder (server/register/pair_list.ts) that the registration by photographs leans on and
 * tests/unit/deno/pair_list.test.ts does not pin: what a frame with a damaged pose is taken for, what a thinned or
 * repeated capture index does to the sequence window, and a list that holds no pair.
 *
 * The photographs of the new scan are thinned before they are offered, so their capture indices are not contiguous; a
 * pose that did not survive the epoch filter or the matrix maths can be NaN; and a session with a single usable frame
 * is not an error. Each of these has to give a list (or a refusal in words), never a pair COLMAP would be handed
 * half-gated or a throw.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import {
  buildPairList,
  CROSS_SESSION_MAX_DISTANCE_M,
  formatMatchList,
  type PairImage,
  planMatching,
  SEQUENCE_WINDOW,
} from '../../../server/register/pair_list.ts'

type V3 = [number, number, number]

const name = (sessionId: string, i: number): string => `${sessionId}/kf-${String(i).padStart(5, '0')}.jpg`
const AHEAD: V3 = [0, 0, 1]

function image(sessionId: string, index: number, position?: V3, forward?: V3): PairImage {
  const made: PairImage = { name: name(sessionId, index), sessionId, index }
  if (position) made.position = position
  if (forward) made.forward = forward
  return made
}

function mustBuild(images: PairImage[], options = {}) {
  const result = buildPairList(images, options)
  assert(result.ok, `expected a pair list, got ${result.ok ? '' : result.message}`)
  return result
}

const crossPairs = (pairs: { a: string; b: string; kind: string }[]) => pairs.filter((pair) => pair.kind === 'cross-session')

// ─── A pose that is not a pose ───────────────────────────────────────────────

Deno.test('a frame whose pose is not finite is unposed: it keeps its sequence neighbours and meets nobody by gate', () => {
  const reference = [image('sess-a', 0, [0, 0, 0], AHEAD)]
  const damaged = [
    image('sess-b', 0, [Number.NaN, 0, 0], AHEAD),
    image('sess-b', 1, [0, Number.POSITIVE_INFINITY, 0], AHEAD),
    image('sess-b', 2, [0.1, 0, 0], [0, Number.NaN, 1]),
    image('sess-b', 3, [0.1, 0, 0], AHEAD),
  ]
  const result = mustBuild([...reference, ...damaged])
  const gated = crossPairs(result.pairs)
  assertEquals(gated.map((pair) => `${pair.a} ${pair.b}`), [`${name('sess-a', 0)} ${name('sess-b', 3)}`])
  // The damaged frames are not counted as posed, and are still tied to their own session's sequence.
  assertEquals(result.stats.sessions.find((s) => s.sessionId === 'sess-b')!.posed, 1)
  assertEquals(result.pairs.filter((pair) => pair.kind === 'sequence').length, 6)
})

Deno.test('a position with no direction, or a direction with no position, is not a pose', () => {
  const result = mustBuild([
    image('sess-a', 0, [0, 0, 0], AHEAD),
    image('sess-b', 0, [0.1, 0, 0]),
    image('sess-b', 1, undefined, AHEAD),
  ])
  assertEquals(crossPairs(result.pairs), [])
  assertEquals(result.stats.posedImages, 1)
})

Deno.test('a direction of no length matches no direction: the frame is never paired by gate with another session', () => {
  const result = mustBuild([image('sess-a', 0, [0, 0, 0], AHEAD), image('sess-b', 0, [0, 0, 0], [0, 0, 0])])
  assertEquals(crossPairs(result.pairs), [])
  assertEquals(result.stats.isolatedSessions, ['sess-a', 'sess-b'])
})

Deno.test('frames at one place looking one way tie on every score, and each image takes the first of them by name', () => {
  const here: V3 = [1, 1.5, 1]
  const images = [
    image('sess-a', 0, here, AHEAD),
    image('sess-a', 1, here, AHEAD),
    image('sess-b', 0, here, AHEAD),
    image('sess-b', 1, here, AHEAD),
    image('sess-b', 2, here, AHEAD),
  ]
  const options = { sequenceWindow: 0, maxCrossPartnersPerSession: 1, maxRevisitPartners: 0 }
  const one = mustBuild(images, options)
  // The cap is per image and per other session. a0 and a1 both take b0; b0 takes a0, and b1 and b2 take a0.
  const pairs = one.pairs.map((pair) => `${pair.a} ${pair.b}`)
  assertEquals(pairs, [
    `${name('sess-a', 0)} ${name('sess-b', 0)}`,
    `${name('sess-a', 0)} ${name('sess-b', 1)}`,
    `${name('sess-a', 0)} ${name('sess-b', 2)}`,
    `${name('sess-a', 1)} ${name('sess-b', 0)}`,
  ])
  assertEquals(mustBuild([...images].reverse(), options).pairs, one.pairs)
})

// ─── Capture indices ─────────────────────────────────────────────────────────

Deno.test('the sequence window counts frames in capture order, not the gap between their indices', () => {
  // Every 10th keyframe, as a thinned session is: indices 0, 10, 20, ... 110.
  const thinned = Array.from({ length: 12 }, (_, i) => image('sess-a', i * 10))
  const result = mustBuild(thinned)
  const within = (x: number, y: number) => Math.abs(x - y) <= SEQUENCE_WINDOW
  const expected = new Set<string>()
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) if (within(i, j)) expected.add(`${name('sess-a', i * 10)} ${name('sess-a', j * 10)}`)
  assertEquals(new Set(result.pairs.map((pair) => `${pair.a} ${pair.b}`)), expected)
  // Frame 0 and frame 11 are 11 ranks apart, 110 indices apart: not neighbours either way.
  assert(!expected.has(`${name('sess-a', 0)} ${name('sess-a', 110)}`))
})

Deno.test('frames that share a capture index keep one order, the one their names give, whatever order they arrive in', () => {
  const twin: PairImage = { name: 'sess-a/kf-00005-b.jpg', sessionId: 'sess-a', index: 5 }
  const images = [image('sess-a', 5), twin, image('sess-a', 4), image('sess-a', 6)]
  const forward = mustBuild(images, { sequenceWindow: 1 })
  const backward = mustBuild([...images].reverse(), { sequenceWindow: 1 })
  assertEquals(forward.pairs, backward.pairs)
  // Ranked by index, then by name ('-' sorts before '.'): 4, 5-b, 5, 6. Each is paired with the next one.
  assertEquals(forward.pairs.map((pair) => `${pair.a} ${pair.b}`), [
    'sess-a/kf-00004.jpg sess-a/kf-00005-b.jpg',
    'sess-a/kf-00005-b.jpg sess-a/kf-00005.jpg',
    'sess-a/kf-00005.jpg sess-a/kf-00006.jpg',
  ])
})

// ─── Nothing to pair ─────────────────────────────────────────────────────────

Deno.test('a list can hold no pair and still be a list: one session, no window, no poses', () => {
  const result = mustBuild([image('sess-a', 0), image('sess-a', 1), image('sess-a', 2)], { sequenceWindow: 0 })
  assertEquals(result.pairs, [])
  assertEquals(formatMatchList(result.pairs), '')
  assertEquals(result.stats.totalPairs, 0)
  const plan = planMatching([image('sess-a', 0), image('sess-a', 1)], { sequenceWindow: 0 })
  assertEquals(plan.kind, 'pairs')
  assert(plan.kind === 'pairs' && plan.pairs.length === 0)
})

Deno.test('a session of one frame is paired by gate only, and is isolated when nothing is within reach', () => {
  const near = mustBuild([image('sess-a', 0, [0, 0, 0], AHEAD), image('sess-b', 0, [CROSS_SESSION_MAX_DISTANCE_M - 0.01, 0, 0], AHEAD)])
  assertEquals(near.pairs.map((pair) => pair.kind), ['cross-session'])
  const far = mustBuild([image('sess-a', 0, [0, 0, 0], AHEAD), image('sess-b', 0, [CROSS_SESSION_MAX_DISTANCE_M + 0.01, 0, 0], AHEAD)])
  assertEquals(far.pairs, [])
  assertEquals(far.stats.isolatedSessions, ['sess-a', 'sess-b'])
})

Deno.test('a reference session that is not among the images changes nothing: the largest tied group matters first', () => {
  const images = [
    image('sess-a', 0, [0, 0, 0], AHEAD),
    image('sess-a', 1, [0.2, 0, 0], AHEAD),
    image('sess-b', 0, [0.1, 0, 0], AHEAD),
    image('sess-c', 0, [50, 0, 0], AHEAD),
  ]
  const named = mustBuild(images, { referenceSessionId: 'sess-absent' })
  const plain = mustBuild(images)
  assertEquals(named.stats.groups, plain.stats.groups)
  assertEquals(named.stats.groups[0], ['sess-a', 'sess-b'])
  assertEquals(named.stats.isolatedSessions, ['sess-c'])
})

Deno.test('a pair cap of zero refuses any list that has a pair, and one that has none is still a list', () => {
  const refused = buildPairList([image('sess-a', 0), image('sess-a', 1)], { maxPairs: 0 })
  assert(!refused.ok && refused.reason === 'too-many-pairs')
  const empty = buildPairList([image('sess-a', 0), image('sess-a', 1)], { maxPairs: 0, sequenceWindow: 0 })
  assert(empty.ok && empty.pairs.length === 0)
})
