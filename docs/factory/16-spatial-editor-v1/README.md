# 16-spatial-editor-v1

The web editor at `/editor` (`viewer.html`) is now called **Spatial Editor** and gets its v1
surface: a top bar that shows what the place holds and how its jobs are going, one View menu
for the six layer types, an object editor for a selected object, and a SHARE menu with the
links the place already issues.

The route, every storage key, and every identifier in CLAUDE.md's "Do not rename" table are
unchanged. The scanner (`src/main.ts`, `src/ar/`), scanner calibration, the GIS base map,
floor plans, the calibration pins, and the native apps are out of scope. The origin marker is in
scope from ticket 0005, which draws it with the shared `buildOriginDecal`.

## Tickets

| # | Ticket | Scope |
|---|--------|-------|
| 0001 | [rename and top bar](0001-rename-and-top-bar.md) | "Spatial Editor" title and UI strings; place stats and job progress |
| 0002 | [View menu layers](0002-view-menu-layers.md) | Six layer toggles, Show all / Hide all, empty layers disabled with a reason |
| 0003 | [object editor](0003-object-editor.md) | Rename, XYZ transform, physical-thing link readout (hide and show are wave 14's) |
| 0004 | [SHARE menu and drawers](0004-share-menu-and-drawers.md) | Three share entries from existing links; scanner link moved to Navigate |
| 0005 | [origin marker](0005-origin-marker.md) | The calibrated origin drawn with the shared origin decal; a two-point heading arrow ends on the heading pin |

## Ported onto main (2026-11-24)

The wave was written on 2026-11-16 and 2026-11-17, as a third `12-*` folder, on a branch that
was never pushed. It was ported onto main after wave 14 (#284 to #296) and renumbered 16: main
already had two `12-*` folders and waves 13 and 14, and #283 holds 15.

That branch had merged the web origin-calibration branch, which then landed on main unchanged as
#269: the branch's calibration tip plus #268 is exactly #269's tree. So the port is a three-way
merge of only this wave's change over that tip, 20 files, with the tip as the base. Three of
them conflicted (`src/viewer/viewer.ts`, `docs/factory/atlas.html`, `package.json`); a straight
merge of the branch conflicts in 16.

Wave 14's editor ticket (#288) and the place-alignment work before it had since fixed several of
the same things. Where the two overlap, main's code stayed and this wave was built on it:

| This wave had | Main has, and keeps | The port |
|---|---|---|
| Its own hidden list with Show buttons in the object panel (0003) | The Edit tab's Hidden objects list (F-20) | Uses main's list; the panel has none |
| Hide from the object panel, a `hiddenByEdit` flag, and the button disabled on a scan root (0003) | Hide with `userData.hidden`, one save key per object, and a message on a scan root (F-20) | Uses main's Hide; the panel binds no Hide |
| A toolbar layer count of the View layers with data (0001, 0002) | The count of Layers rows with something to show (F-19) | Keeps F-19's count. The View menu decides "has data" by the same rule, `layerHasContent` |
| No made-up camera trail (0002) | No made-up camera trail, and rows that say "no frames" (F-21) | Keeps F-21. The View menu's camera reasons speak of frames, and say so when a frame set could not be read |
| A Detected objects toggle driving the detections flag and the Bounds overlay (0002) | One switch for both, `globalLayerVisible.detections` (F-41) | The toggle is that one switch |
| View toggles writing the viewer's variables directly (0002) | `setLayerVisible()`, the one way a layer is switched (F-41) | The View menu writes through it, so the Layers rows and the HUD buttons follow |
| The origin decal at root-local `(0, 0, 0)` and its arrow to `(0, 0, separation)` (0005) | The anchor at the landmark as tapped, `inverse(M)·(0, 0, 0)` (`sessionAnchorPositions`) | The decal stands at main's landmark and its arrow ends at main's heading marker, both root-local |
| Rename posting its own label patch (0003) | `setObjectLabel()`, which keeps the GLB's own label; the Edit tab's save queue | Rename goes through `setObjectLabel()` and the patch and queue a tag or a note goes through |
| XYZ fields for any selection, saved straight away (0003) | Place precisely for a whole scan, whose size is locked; the `transform:<uuid>` save key | XYZ fields for an object only, saved under that key; a scan root keeps Place precisely |
| Share links fetched with no Place-switch guard (0004) | `worldGen` guards on the fetch (V3-7) | The SHARE menu keeps them, and a failed fetch clears the last Place's phone-scan link |
| A Share panel only this wave wrote to (0004) | `clearShareLinks()` on every world load (#270), which rewrote the panel's HTML | It resets the SHARE entries and the phone-scan link instead. Rewriting the HTML wiped the entries; the new spec caught it |

Three tests on main changed, because the ported feature is the change:

- `tests/mock-anchor-layer.spec.ts` finds the editor's decal by its new name, `calibration origin`,
  instead of `calibration anchor`. The positions it checks are unchanged.
- `tests/unit/node/wp-v3-viewer-guards.test.ts`, V3-7: the guarded failure write is the SHARE
  menu's `apply(null, …)` instead of the panel's `innerHTML`.
- `tests/ar-scan.spec.ts`: the sidebar title is "Spatial Editor".

## Where the code lives

The three panels mount from their own modules, each once, from `viewer.ts`:

- `src/viewer/view-menu.ts`: the View menu's six toggles and Show all / Hide all.
- `src/viewer/share-menu.ts`: the SHARE entries.
- `src/viewer/object-panel.ts`: the Object section (rename, the physical-thing link) and the XYZ fields.

The layer rules are in `src/world/layers.ts`, and the XYZ conversions in
`src/viewer/object-transform.ts`. `viewer.ts` still holds the scene state and the server calls:
the View menu's adapters (`readViewFlags`, `writeViewFlags`, `viewFacts`), `renameSelectedObject`,
and `addAnchorMarker`, which draws the origin with `buildOriginDecal` from
`src/world/origin-decal.ts` (the origin-calibration wave's file). Hide, Show and the Hidden objects
list are wave 14's, in `viewer.ts` and `src/viewer/layer-rows.ts`.

## Atlas entries this wave changes

All are in `docs/factory/atlas.html`:

- **Multi-scan World Editor** (World & Viewer). Before: a flat toggle per layer, enabled whether or
  not the place has data for it; the Edit tab moves an object only with the gizmo and cannot
  rename it; the calibration anchor is a ring with no heading. After: one View menu for the six
  layer types with empty layers disabled; an object editor that renames and takes position,
  rotation and scale as numbers; the calibrated origin drawn with the scanner's origin decal, with
  a heading arrow on two-point scans. Tickets 0002, 0003 and 0005.
- **`/worlds` CRUD, sharing & patches**. Before: the Share menu lists every role as a row with a QR.
  After: three SHARE entries (view-only, comment, edit), each copying an existing link; the
  phone-scan link moved to the Navigate menu. Ticket 0004.
- **Development waves**: a card for this wave, and the section's opening paragraph. The branch had
  no card, like the two wave-12 folders; the port added one.

## Verified

On the port's branch, 2026-11-24:

- `npm run verify`, run one step at a time: 100 of 100 steps pass. That is main's 98, plus
  `test:view-layers` (15 tests) and `test:object-transform` (6).
- The test box, chromium-mock, one worker, no retries: `mock-spatial-editor` (7 tests),
  `mock-editor-inventory`, `mock-anchor-layer` and `mock-ui-desktop` pass, 23 of 23.
- The full test box, six workers, no retries: 216 passed and 4 failed. Two are main's known
  failures, `mock-editor-homes` and `mock-splat-toolbox`. The other two, `mock-optimize-scan-job-update`
  and `mock-scan-load-dedup`, wait on a real optimize job in the server's queue under short
  timeouts, and both passed when run again on their own.
- Not run:
  - `tests/ar-scan.spec.ts` ("viewer.html loads", which now expects the sidebar title "Spatial
    Editor"): it needs a live server, and the test box does not run it;
  - a live Scan server with real scans;
  - any device.

## Not covered in v1

- Changing an object's physical-thing link. The link is read from the existing
  `ThingObservation` (see ticket 0003); writing one needs a server route that does not exist.
- Splat and photogrammetry layers are toggled through the existing splat visibility, which
  the Splat Toolbox also drives. Splat sequences (`splat4d`, person captures) are not one of
  the six layers; their switch is their Layers row.
- The owner link is no longer listed in the SHARE menu.
- The compass arrow and the calibration record text ("Heading unverified", the floor-check bypass) are
  not drawn. Both wait on decisions outside this wave; ticket 0005 covers the origin marker only.
- Not run against a live Scan server with real scans; the Playwright spec mocks the backend.
- The screenshots under `docs/ui-flow/` still show the menus as they were before this wave: the test
  box rewrites them on every run, and the port restored them rather than commit a run's images.
- Requests from the v1 plan review that were not made, because they conflict with the product
  note or with the brief, and need an owner decision first: changing the six View layers (the
  note lists detected objects and splats, and the review list drops them); share revoke (the
  brief says no permissions backend); moving a linked object's Thing with the object; hiding a
  whole scan through a scope-`scan` patch; and any change to the server's scan PATCH or comment
  check. The brief kept the wave inside `src/viewer/` and the editor.
- Moving the pre-existing module state of `viewer.ts` and its other panels (the Layers list, the
  Splat Toolbox, the Items list, review comments) into modules of their own.
