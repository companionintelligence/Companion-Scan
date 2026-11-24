/**
 * What the editor's scan list says about how a scan was placed (src/viewer/placement-note.ts), and where that line goes in
 * the list (`scanMetaMarkup`, src/viewer/scan-calibration-chip.ts).
 *
 * The data is the server's stamp (`placementSource`, `placementUncertaintyM`, `placementStale`). What is pinned:
 *
 *  - every source says what it proves and no more: a Place-frame scan has a place in the Place and none on Earth; a scan on the map
 *    is "approximate to about N m" (the record's own claim, never "within"); a GPS scan is approximate and is not in the Place
 *    frame; a scan on the grid says it was not placed;
 *  - the line takes the GPS accuracy's place on a scan with no calibration, and sits beside a calibrated scan's chip, which already
 *    says how it was calibrated, so a Place-frame scan adds nothing there;
 *  - a manifest that carries no stamp (every world file before the stamps) reads exactly as it always did;
 *  - a figure that is not a number prints no figure, and every piece of text is escaped.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/placement_note.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { placementNote, type PlacementScan } from '../../../src/viewer/placement-note.ts'
import { scanMetaMarkup } from '../../../src/viewer/scan-calibration-chip.ts'

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const scan = (extra: Partial<PlacementScan> = {}): PlacementScan => ({ ...extra })

test('a scan on the map is approximate to about N m, with the figure the record claims and no more, and never "within"', () => {
  const note = placementNote(scan({ placementSource: 'georeference', placementUncertaintyM: 3.52 }))!
  assert.equal(note.text, 'On the map, approximate to about 3.5 m')
  assert.equal(note.note, null)
  assert.equal(note.staleLine, null)
  assert.match(note.title, /may be out by about 3\.5 m/)
  assert.doesNotMatch(`${note.text} ${note.title}`, /within|verified|accurate to|exact|precise/i)
  assert.equal(placementNote(scan({ placementSource: 'georeference', placementUncertaintyM: 12.4 }))!.text, 'On the map, approximate to about 12 m')
  assert.equal(placementNote(scan({ placementSource: 'georeference', placementUncertaintyM: 4 }))!.text, 'On the map, approximate to about 4 m')
  // No figure, or one that is not a number: no figure, never "NaN m".
  for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) {
    const note2 = placementNote(scan({ placementSource: 'georeference', placementUncertaintyM: bad as number | null }))!
    assert.equal(note2.text, 'On the map', String(bad))
    assert.match(note2.title, /not recorded/)
  }
})

test('a scan placed by GPS and compass is approximate and not in the Place frame; one on the grid says it was not placed', () => {
  const gps = placementNote(scan({ placementSource: 'gps-compass', placementUncertaintyM: 10 }))!
  assert.equal(gps.text, 'Placed by GPS and compass, approximate to about 10 m')
  assert.equal(gps.note, 'Not in the Place frame')
  assert.match(gps.title, /no calibration/)
  assert.match(gps.title, /not in the Place frame/i)
  assert.equal(placementNote(scan({ placementSource: 'gps-compass', placementUncertaintyM: null }))!.text, 'Placed by GPS and compass', 'no figure to say')

  const grid = placementNote(scan({ placementSource: 'grid', placementUncertaintyM: null }))!
  assert.equal(grid.text, 'Not placed: on the grid')
  assert.equal(grid.note, 'Not in the Place frame')
  assert.match(grid.title, /grid/)
})

test('a scan in the Place frame has a place in the Place and none on Earth: its chip says the rest, and this says nothing', () => {
  assert.equal(placementNote(scan({ placementSource: 'place-frame', placementUncertaintyM: null })), null)
})

test('a scan moved by hand before the location was set says so, and says only that', () => {
  const moved = placementNote(scan({ placementSource: 'georeference', placementUncertaintyM: 4, placementStale: true }))!
  assert.equal(moved.staleLine, 'Moved before the location was set')
  assert.match(moved.title, /has not moved/)
  assert.match(moved.title, /Reset to calibrated/)
  // On its own, with no source, and in the Place frame.
  assert.equal(placementNote(scan({ placementStale: true }))!.staleLine, 'Moved before the location was set')
  assert.equal(placementNote(scan({ placementSource: 'place-frame', placementStale: true }))!.text, null)
  assert.equal(placementNote(scan({ placementStale: false })), null)
})

test('a manifest with no stamp says nothing: absence is not a claim', () => {
  assert.equal(placementNote(scan()), null)
  assert.equal(placementNote(scan({ placementUncertaintyM: 5 })), null)
  assert.equal(placementNote(scan({ placementSource: undefined, placementStale: undefined })), null)
})

const base = { calibrationMethod: undefined, calibrationStatus: undefined, accuracyM: 4, capturedAt: '2026-11-01T10:00:00.000Z' } as const

test('in the scan list the line takes the GPS accuracy\'s place on a scan with no calibration, and the old text stays when there is no stamp', () => {
  const html = (extra: Partial<PlacementScan>) => scanMetaMarkup({ ...base, ...extra } as never, 'Nov 1, 10:00', null, escape)
  // As it always was.
  assert.equal(html({}), '<div class="scan-meta">Nov 1, 10:00 · accuracy 4.0m</div>')
  assert.equal(scanMetaMarkup({ ...base, accuracyM: null } as never, 'Nov 1, 10:00', null, escape), '<div class="scan-meta">Nov 1, 10:00 · manual align</div>')
  // With a stamp: the placement text, its title, and the label on its own line.
  const gps = html({ placementSource: 'gps-compass', placementUncertaintyM: 10 })
  assert.match(gps, /<div class="scan-meta" title="[^"]*no calibration[^"]*">Nov 1, 10:00 · Placed by GPS and compass, approximate to about 10 m<\/div>/)
  assert.match(gps, /data-tone="plain"[^>]*>Not in the Place frame<\/div>/)
  assert.doesNotMatch(gps, /accuracy 4\.0m/, 'the phone\'s fix accuracy is not the scan\'s placement')
  const grid = html({ placementSource: 'grid', placementUncertaintyM: null })
  assert.match(grid, /Nov 1, 10:00 · Not placed: on the grid<\/div>/)
  assert.match(grid, />Not in the Place frame<\/div>/)
})

test('beside a calibrated scan\'s chip: a georeference line, the stale line, and nothing for a Place-frame scan', () => {
  const calibrated = { ...base, calibrationMethod: 'two-point-ground', calibrationStatus: 'verified', calibrationResidualM: 0.02, calibrationToleranceM: 0.15, calibratedAt: '2026-11-01T10:00:00.000Z' } as const
  const html = (extra: Partial<PlacementScan>) => scanMetaMarkup({ ...calibrated, ...extra } as never, 'Nov 1, 10:00', 'two-point-ground', escape)
  const plain = html({})
  const frame = html({ placementSource: 'place-frame', placementUncertaintyM: null })
  assert.equal(frame, plain, 'a Place-frame scan adds no line: its chip already says how it was calibrated')
  const map = html({ placementSource: 'georeference', placementUncertaintyM: 4.2 })
  assert.match(map, /two-point · verified · spacing 2 cm off/, 'the chip is where it was')
  assert.match(map, /data-tone="plain"[^>]*>On the map, approximate to about 4\.2 m<\/div>/)
  const stale = html({ placementSource: 'georeference', placementUncertaintyM: 4.2, placementStale: true })
  assert.match(stale, /data-tone="warn"[^>]*>Moved before the location was set<\/div>/)
})

test('every piece of text is escaped, the title included', () => {
  const hostile = scanMetaMarkup({ ...base, placementSource: 'gps-compass', placementUncertaintyM: 10 } as never, '<img src=x onerror=alert(1)>', null, escape)
  assert.doesNotMatch(hostile, /<img/)
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('a scan a person placed says so, and makes no claim about the map: not its accuracy, and not that it is on it', () => {
  for (const source of ['georeference', 'gps-compass', 'grid', 'place-frame', undefined] as const) {
    const note = placementNote(scan({ ...(source ? { placementSource: source } : {}), placementUncertaintyM: 3.5 }), { placedByHand: true })!
    assert.equal(note.text, 'Placed by hand', String(source))
    assert.equal(note.note, null)
    assert.equal(note.staleLine, null)
    assert.doesNotMatch(`${note.text} ${note.title}`, /approximate|within|on the map|georeference|GPS|about \d/i, 'the stamp of how it was first placed is not what holds it')
  }
  // Without the option a stamped scan reads as it did: the option is the only thing that changes the line.
  assert.equal(placementNote(scan({ placementSource: 'georeference', placementUncertaintyM: 3.5 }))!.text, 'On the map, approximate to about 3.5 m')
  assert.equal(placementNote(scan({ placementSource: 'georeference', placementUncertaintyM: 3.5 }), { placedByHand: false })!.text, 'On the map, approximate to about 3.5 m')
  // A moved scan can still carry the flag that the location came after the move.
  const stale = placementNote(scan({ placementSource: 'gps-compass', placementUncertaintyM: 10, placementStale: true }), { placedByHand: true })!
  assert.equal(stale.text, 'Placed by hand')
  assert.equal(stale.staleLine, 'Moved before the location was set')
})

test('in the scan list a scan a person placed reads "Placed by hand" where it read the GPS accuracy or the map claim', () => {
  const stamped = { placementSource: 'georeference' as const, placementUncertaintyM: 3.5, accuracyM: 5 }
  const html = scanMetaMarkup(stamped, 'Nov 1', undefined, escape, true)
  assert.match(html, /Placed by hand/)
  assert.doesNotMatch(html, /On the map|approximate to/)
  // Not placed by hand: the claim stands, as it did.
  assert.match(scanMetaMarkup(stamped, 'Nov 1', undefined, escape), /On the map, approximate to about 3\.5 m/)
  assert.match(scanMetaMarkup(stamped, 'Nov 1', undefined, escape, false), /On the map, approximate to about 3\.5 m/)
  // A scan with no calibration, placed by GPS and compass, and then by hand: no GPS accuracy, no "Not in the Place frame".
  const gps = scanMetaMarkup({ placementSource: 'gps-compass' as const, placementUncertaintyM: 10, accuracyM: 6 }, 'Nov 1', undefined, escape, true)
  assert.match(gps, /Placed by hand/)
  assert.doesNotMatch(gps, /accuracy 6|GPS and compass|Not in the Place frame/)
})

test('a GPS placement of a world from before the scene was corrected claims no figure, and says why it has none', () => {
  const note = placementNote(scan({ placementSource: 'gps-compass', placementUncertaintyM: null }))!
  assert.equal(note.text, 'Placed by GPS and compass')
  assert.match(note.title, /before the scene was corrected/)
  assert.match(note.title, /is not known/)
  assert.doesNotMatch(note.title, /several metres/, 'no figure is stood behind')
  // With a figure the title is the one it always was.
  assert.match(placementNote(scan({ placementSource: 'gps-compass', placementUncertaintyM: 10 }))!.title, /several metres/)
})
