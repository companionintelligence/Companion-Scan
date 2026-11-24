> **Type:** Frontend
> **Wave:** 16-spatial-editor-v1 (written as a third `12-*` folder; renumbered when it was ported)
> **Branch:** `feat/spatial-editor-v1-port` (the port onto main; the branch it was written on was never pushed)
> **Commit style:** `feat(editor): ...`
> **Design:** the product note "Companion SCAN and Mobile MCP" (layers and View menu)
> **Dependencies:** 0001 (the layer count in the top bar)
> **Ported:** 2026-11-24, onto main after wave 14. Where this ticket and wave 14 overlap, wave 14's code stayed and this ticket was built on it: see the README, § "Ported onto main".

## Goal

One **View** menu switches the six layer types the product note lists, each on its own, with
Show all and Hide all. A layer this place has no data for is disabled and says why. The viewer
no longer draws a made-up camera trail when a scan has no frame observations.

## Non-goals

- Do not change the GIS base map (`geomap.ts`), anchors, or the origin marker. The GIS map and
  calibration anchor checkboxes stay in the menu, unchanged, under "Other views".
- Do not add a layer type. The six map onto existing `LayerType` values.
- Do not change `src/world/layers.ts`.

## Pinned conventions

The six layers and the flags each drives (`src/world/layers.ts`, `FLAG_LAYER`):

| Layer (menu label) | Flags | LayerType |
|---|---|---|
| Camera trail | `cameraPath` | `cameraPath` |
| Scanned images & frustums | `cameraFrustums`, `rgbFrames` | `cameraFrustums`, `rgbFrames` |
| Detected objects | `detectionBounds` (the Bounds overlay), `detections` | `detections` |
| Hit points | `points` (with `cloudVisible`) | `points` |
| Planes | `floor` | `floor` |
| Splats & photogrammetry | `mesh`, `splat` (`scanSplatVisible`) | `mesh`, `splat` |

*Ported:* wave 14 made the Bounds overlay and the Detections row one switch (`globalLayerVisible.detections`, F-41) and removed `cloudVisible`, so on main Detected objects drives `detections` alone and Hit points drives `points` alone. The menu writes through `setLayerVisible()`, the switch the HUD buttons and the Layers rows use.

- A layer's checkbox reads the first of its flags that has data here. Turning it on sets only
  the flags that have data. Turning it off clears all of its flags.
- A layer has data when its loaded scene nodes for those types are non-empty. While a scan the
  manifest says carries the type has not loaded, the reason reads "Loading".
  *Ported:* a layer has data by wave 14's rule for the Layers rows and the toolbar's layer count
  (`layerHasContent`, `src/viewer/layer-rows.ts`, F-19 and F-21), so the three agree; a camera layer
  whose frame set could not be read says so.
- Empty-layer reasons are the `emptyReason` strings in `VIEW_LAYERS`.
- ADR 0001: the layers reuse `LayerType` and the existing `globalLayerVisible`, `cloudVisible`,
  `detectionBoundsVisible`, and `scanSplatVisible` switches. Nothing new in `src/world/types.ts`.
  *Ported:* on main only `globalLayerVisible` and `scanSplatVisible` remain.

## Before implementation

- `src/world/layers.ts` (`LAYER_ORDER`, `LAYER_LABELS`, `LAYERS_HIDDEN_BY_DEFAULT`).
- `src/viewer/viewer.ts` `applyLayerVisibility`, `layerVisibilityFor`, `syncViewMenu`.

## Open questions & answers

- Q: Does "Splats & photogrammetry" include `splat4d` (person captures)? — A: No. It is a
  sequence, not one of the six layers (decided 2026-11-16).
- Q: Should the splat switch be separate from the Splat Toolbox toggle? — A: No. Both drive
  `setScanSplatVisible`, so they stay in step (decided 2026-11-16).

## Files impacted

- New: `src/viewer/view-menu.ts`, `tests/unit/node/view_layers.test.ts`
- Changed: `src/world/layers.ts` (the view layer rules; they were a separate `view-layers.ts` until
  the viewer refactor folded them in), `viewer.html` (`#view-menu`), `src/viewer/viewer.ts`
  (`readViewFlags`, `writeViewFlags`, `viewFacts`, `syncViewMenu`, `addDerivedCameraLayers`),
  `package.json` (`test:view-layers`)

## Schema required

None.

## Definition of Done

- [x] Six layer toggles, each with its reason when disabled.
- [x] Show all and Hide all.
- [x] Placeholder camera geometry removed; a scan without frame observations draws no trail.
- [x] `view_layers.test.ts` passes.

## Tests

- [x] `tests/unit/node/view_layers.test.ts`: 13 tests (status, on/off, detected-objects Bounds coupling, splat with mesh only, show all, hide all, count).
- [x] `tests/mock-spatial-editor.spec.ts`: "the View menu has six layer toggles; an empty layer is disabled with its reason".

```
npm run test:view-layers
VITE_URL=http://127.0.0.1:5199 npx playwright test --project=chromium-mock mock-spatial-editor
```

## Acceptance Criteria

- Given a place whose only geometry is a mesh, when the View menu opens, then "Splats &
  photogrammetry" is enabled and checked, and the other five are disabled, each with its reason.
- Given Hide all, then every layer is off; given Show all, then only layers with data turn on.
- Given a scan with no frame observations, then no camera trail or frustums are added to the scene.

## Risks / potential issues

- **Risk:** removing the placeholder changes what a scan without frame observations shows, which
  was a fabricated four-pose path. **Mitigation:** intended by the "do not fake data" rule; noted in the report.
- **Risk:** `applyLayerVisibility` runs often, and `viewFacts` walks the loaded scans. **Mitigation:**
  it only counts set sizes, so the cost is per loaded node type, not per geometry.

## Subtasks

1. [x] Add the pure rules (first in `src/viewer/view-layers.ts`, folded into `src/world/layers.ts` later).
2. [x] Replace the six per-toggle handlers with one generic handler and Show all / Hide all.
3. [x] Make `syncViewMenu` set disabled and reason from `viewLayerStatus`.
4. [x] Remove the placeholder camera layers.
