> **Type:** Decision and infrastructure
> **Wave:** 15-ar-runtime-targets
> **Branch:** None until the owner chooses
> **Commit style:** `build(mobile): ...` once a choice is made
> **Design:** This ticket is the spec.
> **Dependencies:** [0002](0002-locar-role.md), [0005](0005-locar-viewer.md)

## Goal

Decide whether a locar wrapper may ship the 8th Wall engine, and how the wrapper chooses the page it starts on.

## Non-goals

- Any change to the 8th Wall engine files or their licence text.
- Store submission.

## Pinned conventions

- `scripts/native/build-web.mjs` requires the XR Engine files in the mobile bundle, and `scripts/native/check-xr-engine.mjs` checks their bytes. A locar-only bundle without them fails the build.
- ADR 0001: reuse the build-time switch introduced in commit `4125bb1` (`VITE_AR_RUNTIME`). Check for an existing variable before adding one.
- ADR 0009: the wrapper is the native shell beside 8th Wall.
- The Android application id `com.companionintelligence.scan` is provisional. "An Android id is permanent once uploaded" (`mobile/README.md`).

## Facts

- The local spike wrapper starts on the viewer ([0005](0005-locar-viewer.md)), copied over `index.html` before `cap sync`. That page has a Legal notices button, so the engine and ARCore notices can be reached from it.
- It is built under its own application id, `com.companionintelligence.scan.locarspike`, with its own label, through a Gradle init script kept outside the repo. So it installs beside any other Scan build and never wipes the scanner's data. It is signed with a throwaway key.
- The shell's manifest registers the main app's sign-in return, `com.companionintelligence.scan://auth`, and a wrapper built from it would register the same scheme beside the main app. Android could then hand the main app's sign-in return to the wrapper. The same init script therefore adds a release manifest overlay that removes that filter from the wrapper. The wrapper built from `a2c20b0` registers no URL scheme. The ARCore APK built with it still registers `com.companionintelligence.scan://auth`.
- It has its own app storage, so the Scan server address the main app saves does not reach it. On first launch the viewer asks for the server with the editor's server dialog, then reads Places from it ([0005](0005-locar-viewer.md)). It cannot sign in: the viewer has no sign-in control, and the server hands a shell sign-in back only to the main app's scheme, `com.companionintelligence.scan://auth` (`SHELL_RETURN_URL`, `server/portal_auth.ts`). So it reads Places only from a server that answers the pins route without sign-in.
- It still bundles `assets/public/xr.js`, `xr-slam.js`, `xr-face.js`, the engine's resource files and the ARCore SDK. That was checked by entry name, not by bytes, and the APK was not extracted.
- The licence sources conflict. `docs/audits/2026-11-11-publish-readiness.md:23` says `public/xr.js` carries a PolyForm Noncommercial restriction. `mobile/README.md:19` names the XR Engine License Agreement for the same file.

## Before implementation

- `scripts/native/build-web.mjs` and `check-xr-engine.mjs`.
- `mobile/README.md` (Licences and Signing), and line 23 of the audit.

## Open questions & answers

- Does the repo settle the licence question? No. Two documents disagree.
- May an APK that bundles the engine go on the owner's own phone for testing? Yes, on the owner's own phone only. Owner, 2026-11-23. It goes to no other device. This does not decide the engine policy or the start page, which stay open.

## Options

- **Engine policy**
  - A. Keep the engine in the locar wrapper, as the spike does. Internal builds only, until the licence is settled.
  - B. Let the build skip the engine for a locar target, and prove the bundle has no engine file by name and by bytes. The owner would accept that the engine check no longer guards that target, and the notices would then drop the engine section.
  - C. Ship no locar wrapper, and keep the WebView on the 8th Wall path.
- **Start page**
  - 1. Copy the viewer over `index.html` in the locar build, as the spike does. Simple, but spike-grade.
  - 2. A dedicated entry selected by `VITE_AR_RUNTIME`. Preferred, because it reuses the variable already in `src/main.ts`.
  - 3. A `?ar=locar` route in the main app.

## Files impacted

- For B: `scripts/native/build-web.mjs`, `scripts/native/check-xr-engine.mjs`, and the tests `tests/unit/node/xr_engine.test.ts` and `native_build.test.ts`.
- For start page 2: `vite.config.ts` and the build script.

## Schema required

N/A.

## Definition of Done

- [ ] The owner picks an engine policy (A, B or C).
- [ ] The owner picks a start page (1, 2 or 3), and it is implemented if it changes the build.
- [ ] The licence conflict is resolved, or it has its own ticket.

## Tests

For B: `npm run test:xr-engine`, `npm run test:native-build`, and a new check that the bundle has no engine file, by name and by bytes.

## Acceptance Criteria

- [ ] A recorded decision. The build, the APK manifest and the APK's entry names all match it.
- [ ] A shipping locar wrapper reaches Legal notices (`openLegalNotices`, `src/ui/legal-notices.ts`) from its start page, with the engine and ARCore sections, or under B with those sections gone because the bundle no longer carries them.

## Risks / potential issues

- Shipping an APK that contains the engine outside the team could breach the engine licence.
- Copying a page over `index.html` removes the scanner from that APK. That is acceptable only for a spike.

## Subtasks

- [ ] Engine policy: owner decision
- [ ] Start page: pick an option
- [ ] Licence conflict: owner decision
