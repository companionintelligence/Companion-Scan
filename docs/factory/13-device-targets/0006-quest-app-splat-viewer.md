> **Type:** Native app
> **Wave:** 13-device-targets
> **Branch:** `feat/quest-app-splat-viewer`
> **Commit style:** `feat(quest): summary`
> **Design:** ADR 0013
> **Dependencies:** 0005

## Goal

The Quest app shows a Gaussian splat that the person's server made, in the headset, with the Spatial SDK splat module. Until this wave no native target could view a splat. Splats were viewed in the web viewer only.

## Non-goals

- Do not train splats on the headset.
- Do not convert splat formats in the app. Show what the server already serves, or say which format is missing.
- Do not edit the splat or write it back.

## Pinned conventions

- ADR 0001 and ADR 0007. The app reads splat files the server already produces, through the existing scan file route. It does not add a route.
- The SDK module is `com.meta.spatial:meta-spatial-sdk-splat:0.15.0`, with the component `Splat(path: Uri)` (`com/meta/spatial/splat/Splat.kt:13`) and `SplatFeature(context, systemManager)` (`SplatFeature.kt:20`).
- Files come over HTTPS from the address the person entered (ticket 0005), into the app's files directory.

## Before implementation

- Read the splat module's stub sources and javadoc, to learn which formats `Splat` accepts and whether it streams.
- Read the server's splat artifact route and its suffix list in `server/main.ts` (`SPLAT_ARTIFACT_MIME`, around line 924). On 2026-11-23 its splat files were `.splat.ply`, `.compressed.ply` and `.sog`, served through `GET /scans/:filename`.
- Read how the web viewer finds a scan's splat (`src/viewer/splat-toolbox.ts`), and reuse the same lookup.

## Open questions & answers

- Q: Which formats does `Splat` accept? — OPEN. The stub sources do not say. If it does not accept a format the server makes, record that here, and leave the conversion to a server job (ADR 0003), not the app.
- Q: How large a splat can the headset render at frame rate? — OPEN until a headset run.

## Files impacted

- New: a viewer activity or feature in `meta/`, a downloader, and unit tests.
- Changed: `meta/app/build.gradle.kts` (the splat module is already a dependency).

## Schema required

None.

## Definition of Done

- [ ] The app lists the Place's scans that have a splat, downloads one, and shows it.
- [ ] A missing or unsupported format gives a message, not a crash.
- [ ] Unit tests cover the URL building and the format check.

## Tests

- [ ] JVM tests for the scan-to-URL lookup and for refusing http.

```bash
cd meta && ./gradlew testDebugUnitTest assembleDebug --no-daemon
```

## Acceptance Criteria

- [ ] Given a finished `splat-train` job, when the person picks the scan in the headset, then the splat appears at the Place's origin, with the server's scale.

## Risks / potential issues

- **Risk:** The splat module renders only some formats. — **Mitigation:** Find out first; add a server-side conversion job only if needed.
- **Risk:** Large files and memory on the headset. — **Mitigation:** Prefer the compressed output; show the size before downloading.
- **Risk:** Nothing is verified off a headset. — **Mitigation:** Record the first run's file size and frame rate.

## Subtasks

1. [ ] Learn the accepted formats.
2. [ ] Build the scan list and the download.
3. [ ] Show the splat with the `Splat` component.
4. [ ] Add tests, and record the first headset run.
