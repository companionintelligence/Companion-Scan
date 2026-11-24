/**
 * Wave 14, ticket 0004 (F-44, FN-042): one colour per label. The GLB's boxes (src/export/gltf.ts) used to carry their own
 * table, which gave the same labels different colours from src/shared/cv-palette.ts. Both now come from cv-palette's
 * `labelDisplayRgb`, and CV_PALETTE itself, the mock detector's match table, is left exactly as it was.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-palette.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CV_PALETTE,
  LABEL_DISPLAY_DEFAULT_RGB,
  classifyPixel,
  labelDisplayCss,
  labelDisplayHex,
  labelDisplayRgb,
  paletteColorFor,
} from '../../../src/shared/cv-palette.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

test('CV_PALETTE is unchanged: it is the mock detector\'s match table, and xr8-mock.js mirrors it', () => {
  assert.deepEqual(
    CV_PALETTE.map((p) => [p.label, p.rgb, p.colorName]),
    [
      ['chair', [41, 98, 255], 'blue'],
      ['sofa', [255, 109, 0], 'orange'],
      ['bed', [170, 0, 255], 'purple'],
      ['table', [109, 76, 65], 'walnut'],
      ['lamp', [255, 214, 0], 'yellow'],
      ['plant', [0, 200, 83], 'green'],
      ['tv', [0, 184, 212], 'teal'],
      ['shelf', [197, 17, 98], 'crimson'],
    ],
  )
  // A display-only label is not something the mock detects.
  for (const extra of [[165, 214, 167], [255, 204, 128], [128, 222, 234], [120, 144, 156]] as const) {
    assert.equal(classifyPixel(extra[0], extra[1], extra[2]), null)
  }
})

test('every palette label is drawn in its palette colour', () => {
  for (const entry of CV_PALETTE) {
    assert.deepEqual(labelDisplayRgb(entry.label), entry.rgb, entry.label)
    assert.deepEqual(labelDisplayRgb(entry.label), paletteColorFor(entry.label), entry.label)
  }
})

test('an alias shares its palette label\'s colour, and the labels the palette lacks keep the GLB\'s old ones', () => {
  assert.deepEqual(labelDisplayRgb('couch'), labelDisplayRgb('sofa'))
  assert.deepEqual(labelDisplayRgb('monitor'), labelDisplayRgb('tv'))
  assert.deepEqual(labelDisplayRgb('bookcase'), labelDisplayRgb('shelf'))
  // gltf.ts's LABEL_COLORS at e897380, for the labels CV_PALETTE has no entry for.
  const before: Record<string, number> = { desk: 0xa5d6a7, door: 0xffcc80, window: 0x80deea, wall: 0x78909c, floor: 0x546e7a, ceiling: 0x90a4ae }
  for (const [label, hex] of Object.entries(before)) assert.equal(labelDisplayHex(label), hex, label)
  assert.equal(labelDisplayHex('mystery object'), 0xb0bec5, 'the old default grey')
  assert.deepEqual(labelDisplayRgb('mystery object'), [...LABEL_DISPLAY_DEFAULT_RGB])
  assert.deepEqual(paletteColorFor('mystery object'), [...LABEL_DISPLAY_DEFAULT_RGB], 'the two fallbacks are one grey')
})

test('a label is matched by the first key it contains, lowercased, in the order the GLB always used', () => {
  assert.equal(labelDisplayHex('Office Chair'), labelDisplayHex('chair'))
  assert.equal(labelDisplayHex('table lamp'), labelDisplayHex('table'), 'table comes before lamp')
  assert.equal(labelDisplayHex('floor lamp'), labelDisplayHex('lamp'), 'lamp comes before floor')
  assert.equal(labelDisplayHex('bookshelf'), labelDisplayHex('shelf'))
  assert.equal(labelDisplayHex('TV stand'), labelDisplayHex('tv'))
  assert.equal(labelDisplayHex('standing desk'), 0xa5d6a7)
  assert.equal(labelDisplayHex(''), 0xb0bec5)
  assert.equal(labelDisplayHex(undefined as unknown as string), 0xb0bec5, 'a missing label is the default, not a throw')
})

test('the three forms agree, and the rgb handed out is a copy', () => {
  assert.equal(labelDisplayHex('chair'), 0x2962ff)
  assert.equal(labelDisplayCss('chair'), '#2962ff')
  assert.equal(labelDisplayCss('plant'), '#00c853', 'zero-padded')
  const rgb = labelDisplayRgb('chair')
  rgb[0] = 0
  assert.deepEqual(labelDisplayRgb('chair'), [41, 98, 255])
  assert.deepEqual(CV_PALETTE[0]!.rgb, [41, 98, 255])
})

test('gltf.ts has no colour table of its own and colours both boxes from cv-palette', () => {
  const src = read('src/export/gltf.ts')
  assert.doesNotMatch(src, /LABEL_COLORS/)
  assert.doesNotMatch(src, /function labelColor\b/)
  assert.match(src, /import \{ labelDisplayHex \} from '\.\.\/shared\/cv-palette\.ts'/)
  assert.equal(src.match(/labelDisplayHex\(det\.label\)/g)?.length, 2, 'the solid box and its wireframe')
})

test('cv-palette.ts imports nothing, so the server and the Docker image can keep importing it', () => {
  assert.doesNotMatch(read('src/shared/cv-palette.ts'), /^import /m)
})
