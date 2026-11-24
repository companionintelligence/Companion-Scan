/**
 * What the editor's Scene layers list, toolbar, hidden-object list and Advanced queue say (src/viewer/layer-rows.ts,
 * src/world/job-types.ts). F-19, F-20, F-21, F-24.
 */
import { assert, assertEquals } from './assert.ts'
import {
  FRAME_LAYER_TYPES,
  hiddenObjects,
  layerCountText,
  layerHasContent,
  layersWithContent,
  listedLayerTypes,
  UNRENDERED_LAYER_TYPES,
  unhidePatch,
  visibilitySaveKey,
  type LayerContent,
} from '../../../src/viewer/layer-rows.ts'
import { jobRequiresScan, SCAN_REQUIRED_JOB_TYPES } from '../../../src/world/job-types.ts'
import { LAYER_ORDER, LAYERS_HIDDEN_BY_DEFAULT, defaultLayerIndex } from '../../../src/world/layers.ts'
import type { EditPatch, LayerType } from '../../../src/world/types.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

const NONE: LayerContent = { manifestCount: null, objectCount: 0 }

test('F-19: the rows are every drawn layer, without the static splat and without Depth and Semantic masks', () => {
  const rows = listedLayerTypes()
  assertEquals(rows.includes('depth'), false)
  assertEquals(rows.includes('semanticMasks'), false)
  assertEquals(rows.includes('splat'), false, 'the static splat has its own controls in Splat tools')
  assertEquals(rows.includes('splat4d'), true, 'the 4D person row drives the 4D layer')
  // Order follows LAYER_ORDER, and nothing else is dropped.
  assertEquals(rows, LAYER_ORDER.filter((type) => type !== 'splat' && !UNRENDERED_LAYER_TYPES.has(type)))
  // LAYER_ORDER itself is untouched: the server writes every type into each scan's layerIndex.
  assert(LAYER_ORDER.includes('depth') && LAYER_ORDER.includes('semanticMasks'))
  assertEquals(defaultLayerIndex({}).map((layer) => layer.type), LAYER_ORDER)
})

test('F-19: a row says what is there, and "planned" is gone', () => {
  assertEquals(layerCountText('points', { manifestCount: 1200, objectCount: 3 }), '1,200 items')
  assertEquals(layerCountText('mesh', { manifestCount: null, objectCount: 1 }), '1 object')
  assertEquals(layerCountText('mesh', { manifestCount: null, objectCount: 4 }), '4 objects')
  assertEquals(layerCountText('anchor', NONE), 'none')
  for (const type of LAYER_ORDER) assert(!layerCountText(type, NONE).includes('planned'), type)
})

test('F-21: a camera layer is counted from what its frame sets drew, never from the manifest', () => {
  for (const type of ['cameraPath', 'cameraFrustums', 'rgbFrames'] as LayerType[]) {
    assert(FRAME_LAYER_TYPES.has(type))
    assertEquals(layerCountText(type, NONE), 'no frames', type)
    // The manifest's pose or keyframe count is the capture's: with no frame set nothing is drawn, and the row says so.
    const noFrameSet: LayerContent = { manifestCount: 40, objectCount: 0, frames: { drawn: 0, unreadable: 0 } }
    assertEquals(layerCountText(type, noFrameSet), 'no frames', type)
    assertEquals(layerHasContent(type, noFrameSet), false, type)
    assertEquals(layerCountText(type, { ...noFrameSet, frames: { drawn: 0, unreadable: 1 } }), 'frames could not be read', type)
    const drawn: LayerContent = { manifestCount: 40, objectCount: 1, frames: { drawn: 37, unreadable: 0 } }
    assertEquals(layerCountText(type, drawn), '37 frames', type)
    assertEquals(layerHasContent(type, drawn), true, type)
  }
  // A camera path the GLB carries in itself is drawn with no frame set.
  assertEquals(layerCountText('cameraPath', { manifestCount: null, objectCount: 2, frames: { drawn: 0, unreadable: 0 } }), '2 objects')
  assertEquals(layerCountText('cameraPath', { manifestCount: null, objectCount: 0, frames: { drawn: 1, unreadable: 0 } }), '1 frame')
})

test('F-19: the toolbar metric counts the rows that have something to show, not the layer types', () => {
  const content = new Map<LayerType, LayerContent>([
    ['points', { manifestCount: 500, objectCount: 1 }],
    ['mesh', { manifestCount: null, objectCount: 4 }],
    ['cameraPath', { manifestCount: 0, objectCount: 0 }],
    // An unrendered layer with a count is not a row, so it does not count either.
    ['depth', { manifestCount: 10, objectCount: 0 }],
  ])
  const of = (type: LayerType) => content.get(type) ?? NONE
  assertEquals(layersWithContent(of), 2)
  assertEquals(layersWithContent(() => NONE), 0, 'an empty Place shows 0, not 13')
  assertEquals(layerHasContent('points', { manifestCount: 0, objectCount: 0 }), false)
  // A camera layer whose manifest reports poses but that drew nothing does not count.
  assertEquals(layersWithContent((type) => type === 'cameraPath' ? { manifestCount: 40, objectCount: 0, frames: { drawn: 0, unreadable: 0 } } : NONE), 0)
})

test('F-41: the detection bounds start hidden, in the manifest and in the editor alike', () => {
  // The HUD's Bounds button was off by default and the Detections row on; the bounds drew only when both were on.
  // One switch now, and the default it had in effect is the one the set says.
  assert(LAYERS_HIDDEN_BY_DEFAULT.has('detections'))
  assertEquals(defaultLayerIndex({ detectionCount: 3 }).find((layer) => layer.type === 'detections')?.visibleByDefault, false)
})

function patch(over: Partial<EditPatch>): EditPatch {
  return {
    patchId: `p-${Math.random()}`,
    worldId: 'w',
    scope: 'object',
    targetId: 'scan-a/0-chair',
    scanId: 'scan-a',
    createdAt: '2026-11-23T10:00:00.000Z',
    ...over,
  } as EditPatch
}

test('F-20: the hidden list is what the patch log leaves hidden, the last visibility patch deciding', () => {
  const patches = [
    patch({ targetId: 'scan-a/0-chair', visible: false }),
    patch({ targetId: 'scan-a/0-lamp', visible: false }),
    patch({ targetId: 'scan-a/0-lamp', visible: true }),
    patch({ targetId: 'scan-a/0-table', label: 'desk' }),
    patch({ scope: 'scan', targetId: 'a.glb', visible: false }),
    patch({ targetId: 'scan-b/0-chair', scanId: 'scan-b', visible: false }),
    patch({ targetId: 'scan-a/0-chair', label: 'armchair' }),
  ]
  assertEquals(hiddenObjects(patches), [
    { scanId: 'scan-a', targetId: 'scan-a/0-chair' },
    { scanId: 'scan-b', targetId: 'scan-b/0-chair' },
  ])
  assertEquals(hiddenObjects(undefined), [])
  assertEquals(hiddenObjects([null as unknown as EditPatch]), [], 'a malformed entry is skipped, not thrown on')
})

test('F-20: Show posts the Hide patch with visible: true, under the same save key as Hide', () => {
  const object = { scanId: 'scan-a', targetId: 'scan-a/0-chair' }
  assertEquals(unhidePatch(object), { scope: 'object', targetId: 'scan-a/0-chair', scanId: 'scan-a', visible: true })
  assertEquals(visibilitySaveKey(object), visibilitySaveKey({ ...object }))
  assert(visibilitySaveKey(object) !== visibilitySaveKey({ scanId: 'scan-b', targetId: 'scan-a/0-chair' }))
  // A hide that is then shown again leaves nothing in the list.
  const afterShow = [patch({ visible: false }), patch({ ...unhidePatch(object) })]
  assertEquals(hiddenObjects(afterShow), [])
})

test('F-24: the Advanced queue needs a scan for the job types that read one', () => {
  for (const type of ['splat-train', 'splat-detect', 'splat-finish', 'lingbot-map-reconstruct', 'sensenova-vision', 'panoptic-scan', 'panoptic-lift', 'place-register', 'extract-layers', 'semantic-pass', 'depth-reconstruct']) {
    assertEquals(jobRequiresScan(type), true, type)
  }
  for (const type of ['ingest', 'merge-points', 'thing-correspondence', 'export-world', 'optimize-scan', 'not-a-type']) {
    assertEquals(jobRequiresScan(type), false, type)
  }
  assertEquals(new Set(SCAN_REQUIRED_JOB_TYPES).size, SCAN_REQUIRED_JOB_TYPES.length, 'no type listed twice')
})

test('F-24: every scan-backed type the Advanced queue offers is guarded, and the queue reads the shared list', async () => {
  const html = await fs.readFile(new URL('../../../viewer.html', import.meta.url), 'utf8')
  const select = html.slice(html.indexOf('<select class="ci-select ci-select-block" id="job-type"'), html.indexOf('</select>', html.indexOf('id="job-type"')))
  const offered = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]!)
  assert(offered.length > 0)
  const source = await fs.readFile(new URL('../../../src/viewer/viewer.ts', import.meta.url), 'utf8')
  assert(/jobRequiresScan\(type\) && !selectedScanId/.test(source), 'queueSelectedJob checks the selected scan first')
  // Every offered type is either guarded or a Place-wide job the server runs without a scan.
  const placeWide = new Set(['ingest', 'merge-points', 'thing-correspondence', 'export-world'])
  for (const type of offered) assert(jobRequiresScan(type) || placeWide.has(type), type)
})
