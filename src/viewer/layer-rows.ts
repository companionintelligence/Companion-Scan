/**
 * What the editor's Scene layers list, its toolbar and its hidden-object list say (F-19, F-20, F-21).
 *
 * Pure, and kept out of viewer.ts, so the rules can be tested without a scene or a DOM.
 *
 * ## The rows
 *
 * One row per layer type the editor draws (`LAYER_ORDER`, src/world/layers.ts), except:
 *
 *  - the static Gaussian splat, which has its own controls in Splat tools;
 *  - the layers no code draws yet (`UNRENDERED_LAYER_TYPES`): a row for them was a checkbox that switched nothing.
 *
 * `LAYER_ORDER` itself is unchanged, because the server writes every type into each scan's `layerIndex`.
 *
 * ## The counts
 *
 * A row's count is what the scans' manifests report for it when any does, else how many objects of that layer the
 * loaded scans actually hold. A layer with neither says so. The word "planned" is gone: every listed layer is built.
 *
 * The camera layers are counted from what was drawn, not from the manifests. A manifest's pose or keyframe count is the
 * capture's, and the layers are drawn from a scan's frame set alone: a scan without a usable one now draws nothing rather
 * than a made-up trail (F-21), and its row says "no frames", or that its frames could not be read.
 *
 * ## The toolbar metric
 *
 * The number of listed layers that have something to show in this Place. It used to be `LAYER_ORDER.length`, 13,
 * for every Place.
 */
import { LAYER_ORDER } from '../world/layers.ts'
import type { EditPatch, LayerType } from '../world/types.ts'

/** Layer types no code in the editor draws yet. Their rows are hidden until a renderer exists. */
export const UNRENDERED_LAYER_TYPES: ReadonlySet<LayerType> = new Set<LayerType>(['depth', 'semanticMasks'])

/** Layer types drawn from a scan's frame set: the camera path, its frustums and the RGB frames. */
export const FRAME_LAYER_TYPES: ReadonlySet<LayerType> = new Set<LayerType>(['cameraPath', 'cameraFrustums', 'rgbFrames'])

/** The layer types the Scene layers list shows a row for, in `LAYER_ORDER`'s order. */
export function listedLayerTypes(): LayerType[] {
  return LAYER_ORDER.filter((type) => type !== 'splat' && !UNRENDERED_LAYER_TYPES.has(type))
}

/** What the editor knows about one layer across the Place's scans. */
export interface LayerContent {
  /** The sum of the counts the scans' manifests report for this layer, or null when none reports one. */
  manifestCount: number | null
  /** How many objects of this layer the loaded scans hold in the scene. */
  objectCount: number
  /**
   * For a camera layer: how many frames the loaded scans' frame sets drew, and how many scans' frame sets could not be
   * read. Absent for the other layers.
   */
  frames?: { drawn: number; unreadable: number }
}

/** True when a layer has something to show. A camera layer counts only what was drawn. */
export function layerHasContent(type: LayerType, content: LayerContent): boolean {
  if (FRAME_LAYER_TYPES.has(type)) return content.objectCount > 0 || (content.frames?.drawn ?? 0) > 0
  return (content.manifestCount ?? 0) > 0 || content.objectCount > 0
}

const plural = (count: number, one: string, many: string): string => `${count.toLocaleString()} ${count === 1 ? one : many}`

/** The count line of one row. */
export function layerCountText(type: LayerType, content: LayerContent): string {
  if (FRAME_LAYER_TYPES.has(type)) {
    const drawn = content.frames?.drawn ?? 0
    if (drawn > 0) return plural(drawn, 'frame', 'frames')
    // A camera path a GLB carries in itself is drawn with no frame set.
    if (content.objectCount > 0) return plural(content.objectCount, 'object', 'objects')
    return (content.frames?.unreadable ?? 0) > 0 ? 'frames could not be read' : 'no frames'
  }
  if (content.manifestCount !== null) return plural(content.manifestCount, 'item', 'items')
  if (content.objectCount > 0) return plural(content.objectCount, 'object', 'objects')
  return 'none'
}

/** The toolbar's layers metric: how many listed layers have something to show. */
export function layersWithContent(contentOf: (type: LayerType) => LayerContent): number {
  return listedLayerTypes().filter((type) => layerHasContent(type, contentOf(type))).length
}

/** One object the patch log leaves hidden: the scan it is in, when the patch named one, and its target id. */
export interface HiddenObject {
  scanId: string | undefined
  targetId: string
}

/**
 * The objects the patch log leaves hidden, in the order they were first hidden.
 *
 * Patches are read in the order the world holds them, which is the order the editor applies them in
 * (`applyStoredPatches`): for each object the last patch that sets `visible` decides, so a hide that a later
 * `visible: true` undid is not listed. Only object patches carry visibility.
 */
export function hiddenObjects(patches: readonly EditPatch[] | null | undefined): HiddenObject[] {
  const latest = new Map<string, HiddenObject & { visible: boolean }>()
  for (const patch of patches ?? []) {
    if (!patch || patch.scope !== 'object' || typeof patch.visible !== 'boolean' || typeof patch.targetId !== 'string') continue
    const key = `${patch.scanId ?? ''}\u0000${patch.targetId}`
    const seen = latest.get(key)
    if (seen) seen.visible = patch.visible
    else latest.set(key, { scanId: patch.scanId, targetId: patch.targetId, visible: patch.visible })
  }
  return [...latest.values()].filter((entry) => !entry.visible).map(({ scanId, targetId }) => ({ scanId, targetId }))
}

/** The patch that shows a hidden object again: the Hide button's patch with `visible: true`. */
export function unhidePatch(object: HiddenObject): { scope: 'object'; targetId: string; scanId: string | undefined; visible: true } {
  return { scope: 'object', targetId: object.targetId, scanId: object.scanId, visible: true }
}

/**
 * The PendingSaves key of an object's visibility. Hide and Show of one object share it, so a Show pressed while a
 * Hide is still unsaved replaces it instead of racing it.
 */
export function visibilitySaveKey(object: Pick<HiddenObject, 'scanId' | 'targetId'>): string {
  return `visibility:${object.scanId ?? ''}:${object.targetId}`
}
