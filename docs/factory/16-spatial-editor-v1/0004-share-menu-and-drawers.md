> **Type:** Frontend
> **Wave:** 16-spatial-editor-v1 (written as a third `12-*` folder; renumbered when it was ported)
> **Branch:** `feat/spatial-editor-v1-port` (the port onto main; the branch it was written on was never pushed)
> **Commit style:** `feat(editor): ...`
> **Design:** the product note "Companion SCAN and Mobile MCP" (SHARE dropdown, drawer chevrons)
> **Dependencies:** None
> **Ported:** 2026-11-24, onto main after wave 14. Where this ticket and wave 14 overlap, wave 14's code stayed and this ticket was built on it: see the README, § "Ported onto main".

## Goal

The SHARE dropdown has three entries: a view-only link to copy, a comment link, and an edit link.
Each copies a share link the place already issues. The phone-scan link leaves this menu for the
Navigate menu. Both drawers keep their chevron show and hide buttons.

## Non-goals

- Do not build a permissions backend or mint a link. An entry whose role has no link is disabled.
- Do not change `server/main.ts`.
- Do not redesign the drawers' contents.

## Pinned conventions

- Entries and roles: "Copy view-only link" → `viewer`, "Comment" → `commenter`, "Edit" → `editor`
  (`MemberRole` in `src/world/types.ts`), read from `GET /worlds/:slug/share` → `links`.
- A missing link is disabled with the note "Coming soon". A failed request shows
  "Share links unavailable" and disables all three.
- Copy writes the link to the clipboard and the entry's note reads "Link copied" for 1.5 s.
- The phone-scan link (`links.scanner`) renders into `#scanner-share-host` in the Navigate menu,
  with its QR still behind an explicit click. Closing the Navigate menu collapses it.
- ADR 0001: reuses the existing share route and `ShareLinksResponse`. No connection is added.
- Drawers: the left drawer's `#sidebar-collapse-btn` / `#sidebar-reopen-tab` and the right drawer's
  `#details-collapse-btn` / `#details-reopen-tab` already exist. They are verified, not rebuilt.

## Before implementation

- `src/viewer/viewer.ts` `loadShareLinks`, `renderScannerShare`, `bindCopyLink`, `buildQrDisclosure`.
- `viewer.html` `#share-menu`, `#workspace-menu`, and the drawer script at the end of the body.

## Open questions & answers

- Q: Should the owner link stay in the menu? — A: No. The brief names three entries. The owner
  link is no longer listed (decided 2026-11-16).
- Q: Where does the phone-scan link go? — A: Navigate, under "Scan a Place", so the capability
  stays reachable (decided 2026-11-16).

## Files impacted

- New: `src/viewer/share-menu.ts` (the three entries, their notes, and the copy feedback)
- Changed: `viewer.html` (`#share-menu`, `#scanner-share-host`), `src/viewer/viewer.ts`
  (`loadShareLinks`, `renderScannerShare`, the Navigate menu toggle hook)

## Schema required

None.

## Definition of Done

- [x] Three SHARE entries, each enabled when its link exists, otherwise disabled with "Coming soon".
- [x] Copy writes the existing viewer link to the clipboard.
- [x] The phone-scan link is offered from Navigate.
- [x] Both drawers collapse and reopen.

## Tests

- [x] `tests/mock-spatial-editor.spec.ts`: "the SHARE menu copies the existing view-only link and says Coming soon for a missing one".
- [x] `tests/mock-spatial-editor.spec.ts`: "the left and right drawers collapse and reopen from their chevrons".

```
VITE_URL=http://127.0.0.1:5199 npx playwright test --project=chromium-mock mock-spatial-editor
```

## Acceptance Criteria

- Given a place with viewer and editor links but no commenter link, then "Copy view-only link" and
  "Edit" are enabled, and "Comment" is disabled with "Coming soon".
- Given "Copy view-only link" is clicked, then the clipboard holds the viewer link.

## Risks / potential issues

- **Risk:** a user who used the old menu to copy the scanner or owner link will not find it there.
  **Mitigation:** the scanner link is in Navigate; the owner link is noted as removed in the wave README.
- **Risk:** the clipboard write needs a permission in some browsers. **Mitigation:** a failure reads "Copy failed".

## Subtasks

1. [x] Replace the share rows with three entries in `viewer.html`.
2. [x] Move the three entries into `share-menu.ts`. `loadShareLinks` passes it the links.
3. [x] Move the scanner block to `renderScannerShare` in the Navigate menu.
