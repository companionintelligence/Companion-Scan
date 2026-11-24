/**
 * Spatial Editor View menu: the state rules behind the six layer toggles.
 *
 * A toggle must never claim geometry a place does not have, a hidden layer must clear
 * every flag it drives, and "show all" must leave empty layers off. These tests pin those
 * rules on the pure module, so the menu's behaviour does not depend on a browser run.
 *
 * Run: npm run test:view-layers
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FLAG_LAYER,
  LAYER_ORDER,
  VIEW_FLAGS,
  VIEW_LAYERS,
  emptyViewFlagState,
  setAllViewLayers,
  setViewLayer,
  viewLayerOn,
  viewLayerStatus,
  type ViewFlagState,
  type ViewLayerFacts,
  type ViewLayerDef,
} from '../../../src/world/layers.ts'

const NO_DATA: ViewLayerFacts = { withContent: {}, pendingTypes: {} }

function layer(key: ViewLayerDef['key']): ViewLayerDef {
  const def = VIEW_LAYERS.find(candidate => candidate.key === key)
  if (!def) throw new Error(`no view layer ${key}`)
  return def
}

function allOn(): ViewFlagState {
  return Object.fromEntries(VIEW_FLAGS.map(flag => [flag, true])) as ViewFlagState
}

test('the menu lists the six product layers, in the product note order', () => {
  assert.deepEqual(VIEW_LAYERS.map(def => def.key), [
    'cameraTrail',
    'scannedImages',
    'detectedObjects',
    'hitPoints',
    'planes',
    'splats',
  ])
})

test('every flag belongs to exactly one layer, and draws a LayerType the manifest knows', () => {
  for (const flag of VIEW_FLAGS) {
    const owners = VIEW_LAYERS.filter(def => def.flags.includes(flag))
    assert.equal(owners.length, 1, `flag ${flag} must belong to exactly one layer`)
    assert.ok(LAYER_ORDER.includes(FLAG_LAYER[flag]), `${FLAG_LAYER[flag]} must be a LayerType in src/world/layers.ts`)
  }
})

test('a layer with no data in the place is disabled, with its reason', () => {
  const status = viewLayerStatus(layer('planes'), NO_DATA)
  assert.equal(status.available, false)
  assert.equal(status.reason, 'No planes: no ground plane was found in this place.')
})

test('while a scan is still loading, an empty layer reads as loading rather than empty', () => {
  const facts: ViewLayerFacts = { withContent: {}, pendingTypes: { cameraPath: true } }
  const status = viewLayerStatus(layer('cameraTrail'), facts)
  assert.equal(status.available, false)
  assert.match(status.reason ?? '', /Loading/)
})

test('a layer with data is available and carries no reason', () => {
  const facts: ViewLayerFacts = { withContent: { points: true }, pendingTypes: {} }
  assert.deepEqual(viewLayerStatus(layer('hitPoints'), facts), { available: true, reason: null })
})

test('turning on a layer sets only its flags that have data', () => {
  const facts: ViewLayerFacts = { withContent: { cameraFrustums: true }, pendingTypes: {} }
  const next = setViewLayer(emptyViewFlagState(), layer('scannedImages'), true, facts)
  assert.equal(next.cameraFrustums, true)
  assert.equal(next.rgbFrames, false, 'no images here, so the images flag must stay off')
  assert.equal(viewLayerOn(layer('scannedImages'), next, facts), true)
})

test('a layer with no data cannot be switched on', () => {
  const before = emptyViewFlagState()
  const after = setViewLayer(before, layer('cameraTrail'), true, NO_DATA)
  assert.deepEqual(after, before)
  assert.equal(viewLayerOn(layer('cameraTrail'), after, NO_DATA), false)
})

test('turning a layer off clears every one of its flags, including ones with no data', () => {
  const facts: ViewLayerFacts = { withContent: { cameraFrustums: true }, pendingTypes: {} }
  const state = { ...emptyViewFlagState(), cameraFrustums: true, rgbFrames: true }
  const next = setViewLayer(state, layer('scannedImages'), false, facts)
  assert.equal(next.cameraFrustums, false)
  assert.equal(next.rgbFrames, false)
})

test('the detected-objects checkbox is the detections layer\'s one switch, the one the HUD\'s Bounds button shares', () => {
  const facts: ViewLayerFacts = { withContent: { detections: true }, pendingTypes: {} }
  const def = layer('detectedObjects')
  assert.deepEqual(def.flags, ['detections'])
  // The detections start hidden (LAYERS_HIDDEN_BY_DEFAULT), so the checkbox starts off.
  assert.equal(viewLayerOn(def, emptyViewFlagState(), facts), false)
  const on = setViewLayer(emptyViewFlagState(), def, true, facts)
  assert.equal(on.detections, true)
  assert.equal(viewLayerOn(def, on, facts), true)
  const off = setViewLayer(on, def, false, facts)
  assert.equal(off.detections, false)
})

test('a splat layer with only a mesh turns on the mesh and leaves the splat switch alone', () => {
  const facts: ViewLayerFacts = { withContent: { mesh: true }, pendingTypes: {} }
  const def = layer('splats')
  const next = setViewLayer(emptyViewFlagState(), def, true, facts)
  assert.equal(next.mesh, true)
  assert.equal(next.splat, false)
  assert.equal(viewLayerOn(def, next, facts), true)
})

test('show all turns on every layer with data and leaves empty layers off', () => {
  const facts: ViewLayerFacts = { withContent: { points: true, floor: true }, pendingTypes: {} }
  const shown = setAllViewLayers(emptyViewFlagState(), true, facts)
  assert.equal(shown.points, true)
  assert.equal(shown.floor, true)
  assert.equal(shown.cameraPath, false)
  assert.equal(shown.splat, false)
  assert.equal(shown.mesh, false)
})

test('hide all turns every layer off, whatever it was', () => {
  const facts: ViewLayerFacts = { withContent: { points: true }, pendingTypes: {} }
  const hidden = setAllViewLayers(allOn(), false, facts)
  for (const flag of VIEW_FLAGS) assert.equal(hidden[flag], false, `${flag} must be off`)
})

test('a camera layer with recorded poses but no frames to draw says so, and an unreadable frame set says that instead', () => {
  const empty = viewLayerStatus(layer('cameraTrail'), NO_DATA)
  assert.equal(empty.available, false)
  assert.equal(empty.reason, 'No camera trail: no scan here has frames to draw it from.')
  const unreadable: ViewLayerFacts = { withContent: {}, pendingTypes: {}, unreadableTypes: { cameraPath: true, cameraFrustums: true } }
  assert.equal(viewLayerStatus(layer('cameraTrail'), unreadable).reason, 'No camera trail: the frames of this place could not be read.')
  assert.equal(viewLayerStatus(layer('scannedImages'), unreadable).reason, 'No scanned images: the frames of this place could not be read.')
  // A layer with no frame set behind it keeps its own reason.
  assert.equal(viewLayerStatus(layer('planes'), unreadable).reason, 'No planes: no ground plane was found in this place.')
})

test('loading wins over unreadable: a scan still loading may yet bring frames', () => {
  const facts: ViewLayerFacts = { withContent: {}, pendingTypes: { cameraPath: true }, unreadableTypes: { cameraPath: true } }
  assert.match(viewLayerStatus(layer('cameraTrail'), facts).reason ?? '', /Loading/)
})
