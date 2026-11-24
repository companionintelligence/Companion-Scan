/**
 * The hook sites of the georeference work that the review of it added, in the hub files (src/viewer/viewer.ts, server/main.ts).
 *
 * viewer.ts runs its DOM code when it is imported and server/main.ts starts the server, so neither can be loaded by a test. The
 * behaviour behind each hook is tested where it lives (scan_placement_by_hand, georef_anchor_pins, placement_note and georef_hud
 * on the Node side; world_origin and georef_replace on the Deno side). What none of those can see is a hook that was lost: the hub
 * files are merged from several packages, and a dropped one-line call leaves every module test green and the editor drawing a scan
 * where an undo left it, the red pins metres from the taps, and a claim about the map on a scan a person moved. These checks read the
 * source and pin each call site, scoped to the function it sits in, in the style of stitch_wiring.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/georef_viewer_wiring.test.ts
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
const viewer = read('src/viewer/viewer.ts')
const server = read('server/main.ts')

/** One top-level function, from its declaration to the closing brace at column 0. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('))
  assert.notEqual(start, -1, name + ' is declared')
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, name + ' closes at column 0')
  return source.slice(start, end)
}

function inOrder(text: string, before: string | RegExp, after: string | RegExp, what: string): void {
  const a = typeof before === 'string' ? text.indexOf(before) : text.search(before)
  const b = typeof after === 'string' ? text.indexOf(after) : text.search(after)
  assert.notEqual(a, -1, `${what}: the first call is there`)
  assert.notEqual(b, -1, `${what}: the second call is there`)
  assert.ok(a < b, what)
}

test('the editor puts a scan where the world and the moves that still count say, and replays no other scan patch over it', () => {
  const apply = fn(viewer, 'applyStoredPatches')
  assert.match(apply, /applyMatrix\(root, replayedScanPlacement\(world\.editPatches, scan\)\)/, 'the placement is the replayed one')
  assert.doesNotMatch(apply, /applyMatrix\(root, patch\.transform/, 'no scan patch is applied one by one: an undone move and the record of its undo would be')
  // The scan-scope patches are skipped in the loop (they are the replayed placement), and the object patches still apply.
  assert.match(apply, /patch\.scope === 'scan' && \([^)]*\)\) continue/)
  assert.match(apply, /applyMatrix\(target, patch\.transform\.matrix\)/)
})

test('the calibration pins of a georeferenced Place are drawn through the georeference\'s turn: the scan\'s red pins and the Place\'s white ones', () => {
  const marker = fn(viewer, 'addAnchorMarker')
  assert.match(marker, /sessionAnchorPositions\(\s*sessionToProjectOfPlacement\(\s*scan\.calibratedLocalToWorld \?\? scan\.localToWorld,\s*placeFrameToSceneFor\(world\?\.georeference, scan, currentProject\?\.spatialFrame\),?\s*\)/)
  const expected = fn(viewer, 'refreshExpectedAnchorPins')
  inOrder(expected, /applyMatrix\(group, placeFrameToScene\(world\.georeference\)\)/, 'worldGroup.add(group)', 'the group is turned before it joins the world')
})

test('the scan list says "Placed by hand" for a scan a person placed, and refreshes when a move is saved or taken back', () => {
  assert.match(fn(viewer, 'buildScanItem'), /scanMetaHtmlFor\(scan, [^)]*escHtml, isHandPlaced\(world\?\.editPatches \?\? \[\], scan\)\)/)
  assert.match(fn(viewer, 'refreshScanMeta'), /redrawScanMeta\([\s\S]*isHandPlaced\(world\?\.editPatches \?\? \[\], scan as ScanManifest\)[\s\S]*\)/)
  inOrder(fn(viewer, 'postEditPatch'), 'world = scopeWorldToActiveProject(payload.world)', 'refreshScanMeta()', 'a saved move redraws the scan list')
  inOrder(fn(viewer, 'postPatchRevert'), 'world = scopeWorldToActiveProject(answered)', 'refreshScanMeta()', 'an undo redraws the scan list')
})

test('the flags know whether the Place\'s location is for an earlier alignment, from the Place the editor holds', () => {
  assert.match(fn(viewer, 'renderPlacementFlag'), /placementFlagHtml\(world, Boolean\(activeProjectId\), \{ earlierAlignment: currentProject !== null && isEarlierFrame\(currentProject\) \}\)/)
})

test('a world is not given scans while its Place cannot be read, keeps a georeferenced world\'s origin through a delete-all, and matches Things only among the scans that belong together', () => {
  const refresh = fn(server, 'refreshWorldScans')
  assert.match(refresh, /if \(additions\.length > 0 && loadedPlace\) \{/)
  const removeAll = fn(server, 'removeAllScansFromWorlds')
  assert.match(removeAll, /if \(!world\.georeference\) \{[\s\S]*world\.originGeoPose = \{ lat: null[\s\S]*world\.localFrame\.origin = world\.originGeoPose[\s\S]*\}/)
  const detections = fn(server, 'detectionLikesForWorld')
  // Which scans take part is the one D6 rule the server has (scanTakesPartInThingMatching, server/thing_match.ts): a scan in the
  // Place frame. The editor's mixed-Place flag (scansOutsidePlaceFrame) counts a subset of the scans it leaves out.
  assert.match(detections, /for \(const scan of world\.scans\) \{\s*\/\/[^\n]*\n\s*if \(!scanTakesPartInThingMatching\(scan\)\) continue/)
})
