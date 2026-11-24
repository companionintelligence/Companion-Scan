/**
 * Wave 14-0002 (F-43, FN-139): Things are filed under server/prompt.ts's label
 * canon, the one capture uses, instead of a second map that disagreed with it
 * (it folded tv and television onto monitor; the canon folds television onto tv
 * and keeps tv and monitor apart).
 *
 * Two regressions are held here: Things stored under the old normaliser still
 * match new sightings, and multi-word labels from other producers (ADE20K's
 * panoptic classes, a VLM's "office chair") still fuse with the VLM's nouns.
 *
 * Run: deno test tests/unit/deno/wp-runners-thing-canon.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { CORE_LABELS } from '../../../server/prompt.ts'
import {
  captureCanon,
  legacyThingLabel,
  normalizeThingLabel,
  runThingCorrespondence,
  sameThingKind,
  THING_ONLY_FOLDS,
  thingCandidates,
} from '../../../server/thing_match.ts'
import type { Thing } from '../../../src/world/types.ts'

Deno.test('canon: the capture canon decides every label it knows', () => {
  assertEquals(normalizeThingLabel('Television'), 'tv')
  assertEquals(normalizeThingLabel('tv'), 'tv')
  assertEquals(normalizeThingLabel('monitor'), 'monitor')
  assertEquals(normalizeThingLabel('couch'), 'sofa')
  assertEquals(normalizeThingLabel('recliner'), 'chair')
  assertEquals(normalizeThingLabel(' Chair '), 'chair')
  assertEquals(normalizeThingLabel(''), 'object')
  assertEquals(normalizeThingLabel('mug'), 'mug')
})

Deno.test('canon: multi-word labels land where the VLM\'s nouns do', () => {
  // The old first-word rule filed these as "office", "coffee" and "dining".
  assertEquals(normalizeThingLabel('office chair'), 'chair')
  assertEquals(normalizeThingLabel('coffee table'), 'table')
  assertEquals(normalizeThingLabel('dining table'), 'table')
  // ADE20K names: the leading name of a comma list, then the canon.
  assertEquals(normalizeThingLabel('television receiver, television, television set, tv'), 'tv')
  assertEquals(normalizeThingLabel('screen door, screen'), 'door')
  assertEquals(normalizeThingLabel('painting, picture'), 'painting')
  assertEquals(normalizeThingLabel('window '), 'window')
})

Deno.test('canon: the thing-only folds never contradict the capture canon', () => {
  for (const [from, to] of THING_ONLY_FOLDS) {
    // A key the canon already changes would be a second, disagreeing map: move or delete it.
    assertEquals(captureCanon(from), from, `${from} is canonicalised by server/prompt.ts now; delete its fold here`)
    assert(CORE_LABELS.includes(to), `${from} folds onto ${to}, which is not a CORE_LABEL`)
  }
  assertEquals(normalizeThingLabel('stool'), 'chair')
  assertEquals(normalizeThingLabel('bookcase'), 'shelf')
})

function thing(label: string, x = 0): Thing {
  return {
    thingId: `thing-${label}`,
    worldId: 'world-a',
    canonicalLabel: label,
    representativeTargetId: `scan-old/${label}`,
    position: { x, y: 0, z: 0 },
    firstSeenScanId: 'scan-old',
    lastSeenScanId: 'scan-old',
    observationIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    origin: 'matcher',
    changeKind: 'new',
  } as Thing
}

function sight(label: string, x = 0.1) {
  return { scanId: 'scan-new', sessionId: 'sess-new', targetId: `scan-new/${label}`, label, confidence: 0.9, worldPos: { x, y: 0, z: 0 } }
}

Deno.test('legacy: a Thing stored as monitor from a tv still takes a new tv sighting', () => {
  assertEquals(legacyThingLabel('tv'), 'monitor')
  assert(sameThingKind('monitor', 'tv'))
  const out = runThingCorrespondence({ worldId: 'world-a', things: [thing('monitor')], thingObservations: [] }, [sight('tv')])
  assertEquals(out.things.length, 1, 'a stored Thing was duplicated by the canon change')
  assertEquals(out.things[0].canonicalLabel, 'monitor', 'a stored label is not rewritten')
  assertEquals(out.things[0].changeKind, 'matched')
})

Deno.test('legacy: a Thing stored under the old first word still takes the full label', () => {
  const out = runThingCorrespondence({ worldId: 'world-a', things: [thing('office')], thingObservations: [] }, [sight('office chair')])
  assertEquals(out.things.length, 1)
})

Deno.test('fusion: a panoptic "television receiver" and a VLM "tv" become one new Thing', () => {
  const first = runThingCorrespondence({ worldId: 'world-a', things: [], thingObservations: [] }, [sight('tv', 0)])
  assertEquals(first.things[0].canonicalLabel, 'tv')
  const second = runThingCorrespondence(
    { worldId: 'world-a', things: first.things, thingObservations: first.observations },
    [{ ...sight('television receiver, television, tv', 0.2), targetId: 'scan-new:panoptic:kf-00001.json:0' }],
  )
  assertEquals(second.things.length, 1)
})

Deno.test('fusion: a new tv and a new monitor stay two Things', () => {
  const out = runThingCorrespondence({ worldId: 'world-a', things: [], thingObservations: [] }, [
    sight('tv', 0),
    { ...sight('monitor', 3), targetId: 'scan-new/monitor' },
  ])
  assertEquals(out.things.map((t) => t.canonicalLabel).sort(), ['monitor', 'tv'])
})

Deno.test('legacy: an old first-word Thing beside a canon Thing does not make every rescan mint another', () => {
  // `swivel` is what the old normaliser filed a "swivel chair" under. With the legacy name a peer of the canon,
  // the two were both candidates, so the match was ambiguous and a new Thing was minted on each rescan.
  const stored = [thing('swivel', 0), { ...thing('chair', 0.1), thingId: 'thing-chair' }]
  assertEquals(thingCandidates(stored, 'swivel chair', { x: 0.05, y: 0, z: 0 }).map((t) => t.canonicalLabel), ['chair'])
  const out = runThingCorrespondence({ worldId: 'world-a', things: stored, thingObservations: [] }, [sight('swivel chair', 0.05)])
  assertEquals(out.things.length, 2, 'a third Thing was minted')
  assertEquals(out.observations[0].thingId, 'thing-chair')
  assertEquals(out.artifacts.filter((a) => a.type === 'thing-ambiguity').length, 0)
})

Deno.test('legacy: the old name is used only when nothing is filed under the canon nearby', () => {
  const stored = [thing('swivel', 0)]
  assertEquals(thingCandidates(stored, 'swivel chair', { x: 0, y: 0, z: 0 }).map((t) => t.canonicalLabel), ['swivel'])
  assertEquals(thingCandidates(stored, 'swivel chair', { x: 5, y: 0, z: 0 }), [])
})
