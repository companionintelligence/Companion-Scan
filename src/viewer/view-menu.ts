/**
 * The Spatial Editor's View menu: the six layer toggles, Show all and Hide all.
 *
 * This module owns the menu's DOM and its clicks. The rules it applies (what a toggle does,
 * and when a layer has no data) are pure and live in src/world/layers.ts. The viewer supplies
 * the state: it reads its visibility switches into a ViewFlagState, and takes the state back
 * after each change through the same setLayerVisible() the HUD buttons and the Layers rows use.
 *
 * The toolbar's layer count is not this menu's: it counts the Layers rows that have something
 * to show (layersWithContent in ./layer-rows.ts, F-19).
 */
import {
  VIEW_LAYERS,
  setAllViewLayers,
  setViewLayer,
  viewLayerOn,
  viewLayerStatus,
  type ViewFlagState,
  type ViewLayerFacts,
  type ViewLayerKey,
} from '../world/layers'

/** The View menu checkbox each layer drives (viewer.html, #view-menu). */
const VIEW_LAYER_TOGGLE_IDS: Readonly<Record<ViewLayerKey, string>> = {
  cameraTrail: 'view-toggle-path',
  scannedImages: 'view-toggle-frustums',
  detectedObjects: 'view-toggle-detections',
  hitPoints: 'view-toggle-points',
  planes: 'view-toggle-floor',
  splats: 'view-toggle-mesh',
}

export interface ViewMenuDeps {
  readFlags: () => ViewFlagState
  /** Writes the state back to the viewer's switches, which redraw the scene and every control. */
  writeFlags: (state: ViewFlagState) => void
  facts: () => ViewLayerFacts
}

export interface ViewMenu {
  /** Re-reads each toggle's availability, reason and checked state. */
  sync: () => void
}

export function mountViewMenu(deps: ViewMenuDeps): ViewMenu {
  const sync = (): void => {
    const facts = deps.facts()
    const flags = deps.readFlags()
    for (const def of VIEW_LAYERS) {
      const status = viewLayerStatus(def, facts)
      const control = document.getElementById(VIEW_LAYER_TOGGLE_IDS[def.key]) as HTMLInputElement | null
      if (control) {
        control.disabled = !status.available
        control.checked = status.available && viewLayerOn(def, flags, facts)
      }
      document.querySelector<HTMLElement>(`[data-view-layer="${def.key}"]`)?.classList.toggle('is-disabled', !status.available)
      const reason = document.getElementById(`view-reason-${def.key}`)
      if (reason) {
        reason.textContent = status.reason ?? ''
        reason.hidden = status.available
      }
    }
  }

  const write = (state: ViewFlagState): void => {
    deps.writeFlags(state)
    // The static splat's switch redraws nothing of this menu, so read the result back here.
    sync()
  }

  for (const def of VIEW_LAYERS) {
    document.getElementById(VIEW_LAYER_TOGGLE_IDS[def.key])?.addEventListener('change', (event) => {
      const on = (event.target as HTMLInputElement).checked
      write(setViewLayer(deps.readFlags(), def, on, deps.facts()))
    })
  }

  const setAll = (on: boolean): void => {
    write(setAllViewLayers(deps.readFlags(), on, deps.facts()))
  }
  document.getElementById('view-show-all')?.addEventListener('click', () => setAll(true))
  document.getElementById('view-hide-all')?.addEventListener('click', () => setAll(false))
  // Frames and splats arrive after their scans load, so the menu reads the scene again each time it opens.
  document.getElementById('view-menu')?.addEventListener('toggle', (event) => {
    if ((event.currentTarget as HTMLDetailsElement).open) sync()
  })

  return { sync }
}
