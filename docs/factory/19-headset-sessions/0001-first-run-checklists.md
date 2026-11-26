> **Type:** Docs
> **Wave:** 19-headset-sessions
> **Branch:** `phase1/headsets`
> **Commit style:** `Docs: summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0002 (the checklists name its panel and camera settings)

## Goal

One first-run checklist per headset, in `docs/testing/`, so the owner's first session on each is one pass: XREAL Aura,
Meta Quest 3 and PICO 4 Pro. Each merges the device kit's order with the target page's first-run list and gives the
exact adb commands.

## Non-goals

- Do not change `DEVICE_TESTING.md` or `DEVICE_TEST_KIT.md`, which the phones and web paths share.
- Do not add steps for companion-scan-unity or Companion-Scan-Meta, which wait on an owner decision.
- Do not claim any result: nothing here has run on a device.

## Pinned conventions

- The first-run lists in `xreal-aura.md`, `pico.md` and `meta-quest.md` are the source; a checklist points back to its
  page for the record.
- Every install, and every permission granted over adb, needs the owner's yes. A recording or a keyframe shows a room
  and stays out of the repository.

## Before implementation

- `docs/targets/xreal-aura.md`, `pico.md`, `meta-quest.md`, `web-webxr.md`, `android-xr/README.md`.

## Open questions & answers

- Q: One file or three? — A: Three, one per headset: each session uses one.

## Files impacted

- New: `docs/testing/FIRST_RUN_XREAL_AURA.md`, `FIRST_RUN_QUEST_3.md`, `FIRST_RUN_PICO_4_PRO.md`.
- Changed: the three target pages link their checklist.

## Schema required

None.

## Definition of Done

- [x] Three checklists, each with the connect steps, every path in order, the exact commands and what to record.
- [x] Each target page links its checklist.

## Tests

- [x] `npm run verify`.

## Acceptance Criteria

- [ ] The owner can run a first session on each headset from its checklist alone.

## Risks / potential issues

- **Risk:** a command differs on a device's software. — **Mitigation:** each step says what to record, so a
  difference is a result, not a dead end.

## Subtasks

1. [x] The three checklists and the links.
