> **Type:** Frontend
> **Wave:** 16-spatial-editor-v1 (written as a third `12-*` folder; renumbered when it was ported)
> **Branch:** `feat/spatial-editor-v1-port` (the port onto main; the branch it was written on was never pushed)
> **Commit style:** `feat(editor): ...`
> **Design:** the product note "Companion SCAN and Mobile MCP" (object editor)
> **Dependencies:** 0002 (the menu the editor sits beside is unaffected; no code dependency)
> **Ported:** 2026-11-24, onto main after wave 14. Where this ticket and wave 14 overlap, wave 14's code stayed and this ticket was built on it: see the README, § "Ported onto main".

## Goal

Clicking an object opens an object editor that shows its name, lets you rename it, hide it and
show it again, edit its position, rotation and scale as XYZ values, and shows the physical thing
it is linked to.

## Non-goals

- Do not change how a link is made. Writing a `ThingObservation` has no server route; the link
  readout is read-only in v1.
- Do not add a field to `src/world/types.ts`. The model already has the link (see Pinned conventions).
- Do not change the Move / Rotate / Scale gizmo buttons or the semantic tag and notes editors.

## Pinned conventions

- **Rename:** `POST /worlds/:slug/patches` with `label`. Scope is `thing` with `targetId` = the
  thing's id when the object has a link, otherwise `object` with `targetId` = `stableObjectId(obj)`.
  This is the scope `saveObjectSemanticPatch` writes, so a rename and a tag agree.
- **Hide / show:** a patch with `visible: false` (hide) or `visible: true` (show), scope `object`.
  The place's hidden list is the latest visibility patch per object.
- **Transform:** position is metres in the parent frame (`obj.position`). Rotation is Euler XYZ in
  degrees, converted to and from the quaternion (`src/viewer/object-transform.ts`). Scale is a
  multiplier; a zero component is rejected. Saved as the existing `transform` (matrix + position +
  quaternion + scale) through `saveSelectedTransform`.
- **Link readout:** `thingForTarget(stableObjectId(obj))`, which reads `world.thingObservations`
  (`targetId` → `thingId`) and `world.things`. Shows `canonicalLabel`, marked "linked by you" for
  `origin: 'user'` and "matched across scans" otherwise.
- **Hidden objects stay hidden:** *(ported: wave 14's `userData.hidden` does this, F-20, and the port uses it;
  Hide, Show and the hidden list are wave 14's, in the Edit tab)* `userData.hiddenByEdit` is set from the patch and read by
  `applyLayerVisibility`, so a layer toggle does not show a hidden node that sits in a layer.
- ADR 0001: reuses `EditPatch` (`label`, `visible`, `transform`), `Thing`, and `ThingObservation`
  from `src/world/types.ts`. Searched before concluding no link existed: `ThingObservation` is the
  link, and `EditPatch` has no `thingId` field (the server's patch route does not copy one).

## Before implementation

- `src/viewer/viewer.ts` `selectEditableObject`, `syncEditPanel`, `saveSelectedTransform`,
  `postEditPatch`, `saveObjectSemanticPatch`, `thingForTarget`, `applyStoredPatches`.
- `server/main.ts` `POST /worlds/:slug/patches` (which fields it copies).

## Open questions & answers

- Q: Is a new `thingId` field on `EditPatch` needed for the link? — A: No for v1. The link exists
  as `ThingObservation`. Writing it needs a server route, which this wave does not add (decided 2026-11-16).
- Q: Should a rename of a scan root be allowed? — A: No. The rename input is disabled for a
  `scan-root`, because a label on it would name a node no one selects (decided 2026-11-16).

## Files impacted

- New: `src/viewer/object-transform.ts`, `src/viewer/object-panel.ts`,
  `tests/unit/node/object_transform.test.ts`, `tests/mock-spatial-editor.spec.ts`
- Changed: `src/viewer/editor.ts` (`renameObject`), `src/viewer/viewer.ts` (`mountObjectPanel` call,
  `applyStoredPatches`, `applyLayerVisibility`, `updateTransformReadout`, `syncEditPanel`,
  `__editorTest` hooks), `viewer.html`
  (`#edit-object-section`, `#transform-fields`, `#edit-hidden-section` (dropped in the port: wave 14's
  `#hidden-objects-section` is the list)), `package.json`
  (`test:object-transform`, `test:spatial-editor`)

## Schema required

None. No change to `src/world/types.ts`.

## Definition of Done

- [x] Name rename, hide, show, and the hidden list work through the patch route.
- [x] XYZ fields commit on Enter or blur; invalid values are refused before save.
- [x] The link readout shows the existing `ThingObservation` link, or "Not linked".
- [x] The DEV test hook is gated by `?mock=editor` and `import.meta.env.DEV`, as before.
- [x] A scan root cannot be renamed or hidden from the object panel. A whole scan is hidden from the scan list instead.

## Tests

- [x] `tests/unit/node/object_transform.test.ts`: 6 tests (round trips through fields, object, and matrix; parsing; validity).
- [x] `tests/mock-spatial-editor.spec.ts`: "the object editor edits name, XYZ transform and visibility, and records each change".

```
npm run test:object-transform
VITE_URL=http://127.0.0.1:5199 npx playwright test --project=chromium-mock mock-spatial-editor
```

## Acceptance Criteria

- Given a selected object, when X is typed as 2.5 and Enter pressed, then one patch is posted with
  `transform.position.x` 2.5, and reading the fields back shows 2.5.
- Given a scale of 0, then nothing is posted and the field is marked invalid.
- Given Hide then a layer toggle, then the object stays hidden; Show from the hidden list shows it.

## Risks / potential issues

- **Risk:** a rotation with |Y| > 90° has more than one XYZ form, so the fields show the canonical
  one after an edit. **Mitigation:** orientation is preserved; documented in `object-transform.ts`.
- **Risk:** a patch's visibility could be overwritten by a later layer pass. **Mitigation:**
  `hiddenByEdit` is read in the same pass.

## Subtasks

1. [x] `object-transform.ts` with the pure conversions and their tests.
2. [x] `renameObject` on `SceneEditor`.
3. [x] Object section, XYZ rows, and hidden list in `viewer.html`.
4. [x] Wire the inputs, rename, and show / hide in `viewer.ts`.
