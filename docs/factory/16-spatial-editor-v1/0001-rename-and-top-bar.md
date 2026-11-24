> **Type:** Frontend
> **Wave:** 16-spatial-editor-v1 (written as a third `12-*` folder; renumbered when it was ported)
> **Branch:** `feat/spatial-editor-v1-port` (the port onto main; the branch it was written on was never pushed)
> **Commit style:** `feat(editor): ...`
> **Design:** this ticket is the spec
> **Dependencies:** None
> **Ported:** 2026-11-24, onto main after wave 14. Where this ticket and wave 14 overlap, wave 14's code stayed and this ticket was built on it: see the README, § "Ported onto main".

## Goal

The editor is named **Spatial Editor** in its page title and UI strings, and its top bar shows
the place's name, scan count, layer count, and job progress as current / total.

## Non-goals

- Do not rename the `/editor` route. Vite and the Deno server both rewrite it to `viewer.html`.
- Do not change the top-left brand mark, "Companion / Scan", beyond the stacked markup it has.
- Do not change `apple-mobile-web-app-title` in `viewer.html`. It is the home-screen install name.
- Do not change `index.html` (the scanner's page) or `src/main.ts`.

## Pinned conventions

- Product name: `Spatial Editor`. Page title: `<place name> - Spatial Editor`, or `Spatial Editor`
  before a place loads.
- Job progress: `finished / total`, where finished means `status === 'completed'` and total is
  every job in the place except `optimize-scan`, the same filter the Processing Queue applies
  (`renderWorldPanel`). A bar fills to `finished / total`. A running count appears in the
  element's title and as the active style.
- Layer count: the number of the six View layers (ticket 0002) that have data here.
- ADR 0001: no schema, env var, or connection is added. The top bar reads `WorldProject.scans`
  and `WorldProject.jobs` (`WorldJob`) that the page already loads.
- The "Do not rename" table in CLAUDE.md is untouched.

## Before implementation

- `viewer.html` `#top-toolbar`, `#toolbar-jobs`, `#sidebar-title`.
- `src/viewer/viewer.ts` `renderToolbarSummary`, `renderWorldPanel`, and the `document.title` writes.

## Open questions & answers

- Q: Should "layers" count the 13 `LAYER_ORDER` types or the six View layers? — A: The six View
  layers that have data here. The old 13 counted types the viewer never draws
  (decided by the Spatial Editor v1 brief, 2026-11-16).
- Q: Is the job bar "in progress / total" or "done / total"? — A: Done / total, with the
  running count shown separately (decided by the brief's "job progress as current / total",
  2026-11-16).

## Files impacted

- Changed: `viewer.html`, `src/viewer/viewer.ts`

## Schema required

None.

## Definition of Done

- [x] Title and sidebar title read "Spatial Editor".
- [x] The top bar shows scans, layers, and `finished / total` jobs with a bar.
- [x] The Playwright spec "the top bar names the product and shows scans, layers and job progress" passes.

## Tests

- [x] `tests/mock-spatial-editor.spec.ts`: "the top bar names the product and shows scans, layers and job progress".

```
VITE_URL=http://127.0.0.1:5199 npx playwright test --project=chromium-mock mock-spatial-editor
```

## Acceptance Criteria

- Given a place with one scan and three jobs (one completed), when the editor loads, then the
  title ends "Spatial Editor", the job count reads `1 / 3`, and the bar is one third full.
- Given `/editor`, the route still serves the editor.

## Risks / potential issues

- **Risk:** the stacked brand mark is narrow and may crowd the project name on small widths.
  **Mitigation:** the toolbar's existing overflow rules apply; not changed here.

## Subtasks

1. [x] Rename the title and sidebar default in `viewer.html`.
2. [x] Rename the `document.title` templates in `viewer.ts`.
3. [x] Change the job count and add the bar in `renderToolbarSummary`.
