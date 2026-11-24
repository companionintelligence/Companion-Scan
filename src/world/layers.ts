import type { LayerManifest, LayerType } from './types'

export const LAYER_ORDER: LayerType[] = [
  'points',
  'mesh',
  'floor',
  'detections',
  'labels',
  'cameraPath',
  'cameraFrustums',
  'rgbFrames',
  'depth',
  'semanticMasks',
  'splat',
  'splat4d',
  'anchor',
]

/**
 * Layer types that start hidden. Lives here, beside LAYER_ORDER, because two
 * places decide this and they disagreed: `defaultLayerIndex` below wrote
 * `visibleByDefault: false` for `anchor` (with a comment explaining why), while
 * the editor's own runtime state derived visibility from a separate hardcoded
 * list that omitted `anchor` — so calibration anchors rendered on every scan,
 * which is the opposite of what the manifest recorded. One set, both readers
 * (ADR 0001).
 *
 * `rgbFrames`/`depth`/`semanticMasks`/`splat` are heavy or usually absent;
 * `anchor` is a deliberate alignment aid, not core scan geometry.
 *
 * `detections` (the detection bounds) starts hidden too. The editor had two switches for it, the HUD's Bounds button
 * (off by default) and the Detections row (on), and drew the bounds only when both were on, so they started hidden
 * while this set said otherwise. One switch now (src/viewer/viewer.ts, setLayerVisible), and the default it had in
 * effect is the one written here: a manifest's `visibleByDefault` for `detections` is false.
 */
export const LAYERS_HIDDEN_BY_DEFAULT: ReadonlySet<LayerType> = new Set<LayerType>([
  'detections',
  'rgbFrames',
  'depth',
  'semanticMasks',
  'splat',
  'splat4d',
  'anchor',
])

export const LAYER_LABELS: Record<LayerType, string> = {
  points: 'Point cloud',
  mesh: 'Meshes',
  floor: 'Floors',
  detections: 'Detections',
  labels: 'Labels',
  cameraPath: 'Camera path',
  cameraFrustums: 'Camera frustums',
  rgbFrames: 'RGB frames',
  depth: 'Depth',
  splat: 'Gaussian splat',
  splat4d: '4D person',
  semanticMasks: 'Semantic masks',
  anchor: 'Calibration anchors',
}

export function defaultLayerIndex(meta: Record<string, unknown>): LayerManifest[] {
  const pointCount = asNumber(meta['pointCount'])
  const detectionCount = asNumber(meta['detectionCount'])
  const poseCount = asNumber(meta['poseCount'])
  const keyframeCount = asNumber(meta['keyframeCount'])

  return LAYER_ORDER.map((type) => {
    const encodedInGlb = type === 'points'
      || type === 'mesh'
      || type === 'floor'
      || type === 'detections'
      || type === 'labels'
      || type === 'cameraPath'
    const hasFrames = (type === 'rgbFrames' || type === 'cameraFrustums') && (keyframeCount ?? 0) > 0
    const future = !hasFrames && (type === 'rgbFrames' || type === 'depth' || type === 'splat' || type === 'semanticMasks')
    // `hasFrames` still decides `source` below (a scan with keyframes really does
    // have an rgbFrames sidecar), but it no longer forces the layer visible: the
    // editor has never shown RGB frames by default, so claiming otherwise here
    // made the manifest describe a view the app does not render.
    const visibleByDefault = !LAYERS_HIDDEN_BY_DEFAULT.has(type) && !future
    return {
      id: `layer-${type}`,
      type,
      label: LAYER_LABELS[type],
      visibleByDefault,
      encodedInGlb,
      source: hasFrames ? 'sidecar' : future ? 'future' : encodedInGlb ? 'glb' : 'derived',
      count: layerCount(type, pointCount, detectionCount, poseCount, keyframeCount),
    }
  })
}

function layerCount(
  type: LayerType,
  pointCount: number | null,
  detectionCount: number | null,
  poseCount: number | null,
  keyframeCount: number | null,
): number | null {
  if (type === 'points') return pointCount
  if (type === 'detections' || type === 'labels') return detectionCount
  if (type === 'cameraFrustums' || type === 'rgbFrames') return keyframeCount ?? poseCount
  if (type === 'cameraPath') return poseCount
  return null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// ─── View layers (the Spatial Editor's View menu) ──────────────────────────────
//
// The six layer types the View menu switches, the viewer-side switch each one drives, and the
// rules for what a toggle does. Pure: no DOM, no three.js. The menu (src/viewer/view-menu.ts)
// renders these rules, and the viewer supplies its visibility switches as a ViewFlagState.
//
// A flag is the viewer's one switch for one LayerType (`globalLayerVisible` in viewer.ts, which
// setLayerVisible() writes), except `splat`, which is the static splat's own "Show trained splat"
// switch. Nothing here adds a second layer vocabulary (ADR 0001).

/** Every viewer-side visibility switch a view layer can drive. */
export const VIEW_FLAGS = [
  'cameraPath',
  'cameraFrustums',
  'rgbFrames',
  'detections',
  'points',
  'floor',
  'mesh',
  'splat',
] as const

export type ViewFlag = typeof VIEW_FLAGS[number]
export type ViewFlagState = Record<ViewFlag, boolean>

/** The LayerType whose geometry each flag shows. */
export const FLAG_LAYER: Readonly<Record<ViewFlag, LayerType>> = {
  cameraPath: 'cameraPath',
  cameraFrustums: 'cameraFrustums',
  rgbFrames: 'rgbFrames',
  detections: 'detections',
  points: 'points',
  floor: 'floor',
  mesh: 'mesh',
  splat: 'splat',
}

export type ViewLayerKey = 'cameraTrail' | 'scannedImages' | 'detectedObjects' | 'hitPoints' | 'planes' | 'splats'

export interface ViewLayerDef {
  key: ViewLayerKey
  label: string
  /** The flags this layer switches together, in the order its checkbox reads them. */
  flags: readonly ViewFlag[]
  /** Shown beside the toggle when this place has no data for the layer. */
  emptyReason: string
  /** Shown instead when the layer's data is there but could not be read: a camera layer's frame set. */
  unreadableReason?: string
}

/**
 * The product note's six layer types, in the order the View menu lists them.
 *
 * The camera layers are drawn from a scan's frame set alone (F-21): a scan with recorded poses but
 * no usable frame set draws no trail, so their reasons speak of frames, as the Layers rows do.
 */
export const VIEW_LAYERS: readonly ViewLayerDef[] = [
  {
    key: 'cameraTrail',
    label: 'Camera trail',
    flags: ['cameraPath'],
    emptyReason: 'No camera trail: no scan here has frames to draw it from.',
    unreadableReason: 'No camera trail: the frames of this place could not be read.',
  },
  {
    key: 'scannedImages',
    label: 'Scanned images & frustums',
    flags: ['cameraFrustums', 'rgbFrames'],
    emptyReason: 'No scanned images: no scan here has frames to draw them from.',
    unreadableReason: 'No scanned images: the frames of this place could not be read.',
  },
  {
    key: 'detectedObjects',
    label: 'Detected objects',
    flags: ['detections'],
    emptyReason: 'No detected objects: nothing has been detected in this place yet.',
  },
  {
    key: 'hitPoints',
    label: 'Hit points',
    flags: ['points'],
    emptyReason: 'No hit points: this place has no point cloud yet.',
  },
  {
    key: 'planes',
    label: 'Planes',
    flags: ['floor'],
    emptyReason: 'No planes: no ground plane was found in this place.',
  },
  {
    key: 'splats',
    label: 'Splats & photogrammetry',
    flags: ['mesh', 'splat'],
    emptyReason: 'No splat or scanned mesh: this place has neither yet.',
  },
]

/**
 * What this place holds, as the View menu reads it. `withContent` marks the LayerTypes that have
 * something to show, by the rule the Layers rows and the toolbar's layer count use
 * (`layerHasContent` in src/viewer/layer-rows.ts). `pendingTypes` marks the types a scan in this
 * place carries but that has not finished loading, so a layer reads "Loading" rather than empty.
 * `unreadableTypes` marks the types whose data could not be read.
 */
export interface ViewLayerFacts {
  withContent: Partial<Record<LayerType, boolean>>
  pendingTypes: Partial<Record<LayerType, boolean>>
  unreadableTypes?: Partial<Record<LayerType, boolean>>
}

export interface ViewLayerStatus {
  available: boolean
  /** Why the layer cannot be shown, or null when it can. */
  reason: string | null
}

export function flagHasData(flag: ViewFlag, facts: ViewLayerFacts): boolean {
  return facts.withContent[FLAG_LAYER[flag]] === true
}

export function viewLayerStatus(def: ViewLayerDef, facts: ViewLayerFacts): ViewLayerStatus {
  if (def.flags.some(flag => flagHasData(flag, facts))) return { available: true, reason: null }
  if (def.flags.some(flag => facts.pendingTypes[FLAG_LAYER[flag]])) {
    return { available: false, reason: 'Loading this place’s scans…' }
  }
  const unreadable = def.unreadableReason && def.flags.some(flag => facts.unreadableTypes?.[FLAG_LAYER[flag]])
  return { available: false, reason: unreadable ? def.unreadableReason! : def.emptyReason }
}

/**
 * Whether a layer's checkbox is on. It reads the first of the layer's flags that has data here,
 * so a layer with only frustums (no images) reads its frustum flag, and a layer with no data is never on.
 */
export function viewLayerOn(def: ViewLayerDef, state: ViewFlagState, facts: ViewLayerFacts): boolean {
  const flag = def.flags.find(candidate => flagHasData(candidate, facts))
  return flag !== undefined && state[flag]
}

/**
 * Switches one layer. Turning it on sets only the flags that have data here, so a layer never
 * claims geometry the place does not have. Turning it off clears every one of its flags, including
 * ones with no data, so no stale switch survives a hide.
 */
export function setViewLayer(state: ViewFlagState, def: ViewLayerDef, on: boolean, facts: ViewLayerFacts): ViewFlagState {
  const next: ViewFlagState = { ...state }
  for (const flag of def.flags) {
    if (!on) next[flag] = false
    else if (flagHasData(flag, facts)) next[flag] = true
  }
  return next
}

/** Show all turns on every layer that has data here. Hide all turns every layer off. */
export function setAllViewLayers(state: ViewFlagState, on: boolean, facts: ViewLayerFacts): ViewFlagState {
  return VIEW_LAYERS.reduce((next, def) => setViewLayer(next, def, on, facts), state)
}

/** A state with every flag off, the starting point before the viewer reads its own switches. */
export function emptyViewFlagState(): ViewFlagState {
  return Object.fromEntries(VIEW_FLAGS.map(flag => [flag, false])) as ViewFlagState
}
