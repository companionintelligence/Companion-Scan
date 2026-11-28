# Capture engine and editor integrations

## Capture assistance

[Open Reality](https://github.com/reality-opened/openreality) takes a phone video through reconstruction and exposes the persistent scene, object inventory, measurement, path queries, jobs, and exports through its [MCP interface](https://github.com/reality-opened/openreality/tree/main/mcp). Its scene tools carry scale provenance through to the answer. The project is BSD-2-Clause and documents separate noncommercial terms for its default self-hosted VGGT reconstruction stack. Companion Scan can deliver similar inspection with its existing Place, jobs, calibrated geometry, and reconstruction workers.

| Step | Scope | Acceptance |
| --- | --- | --- |
| 1. Capture evidence | Add ordered `guidanceCodes` to the existing capture quality summary. The same codes produce the existing human-readable recommendations. Return recognized codes in the scan manifest alongside current metrics and copy. | An interrupted scan and a drift check expose different codes. Older summaries can omit the field. A missing field represents unavailable evidence. |
| 2. Read-only tools | Expose `inspect_capture`, `list_scene_objects`, and `get_reconstruction_status` over existing authenticated Place and job reads. Include scan ID, observation time, tracking and coverage evidence, scale provenance, and links to authorized results. | An authorized reader can explain why a scan needs review. Cross-Place reads are refused. Measurement identifies metric, relative, or unknown scale. Job skips, failures, and unavailable assets are visible. |
| 3. Suggested actions | Suggest a rescan, reconstruction retry, or export with inputs and a reason. Use the app's existing confirmation and job routes for actions that change the Place, publish media, or control capture hardware. | Suggestions can be dismissed. An approved retry reuses the existing queue and keeps its job ID and provenance. |

## Quest capture and live inference

[Unity QuestVisionStream](https://github.com/danieloquelis/Unity-QuestVisionStream) is a Unity beta that sends passthrough video to a remote inference service over WebRTC and returns detections over a data channel. Its example demonstrates the interactive loop. Scan's [native Meta Spatial SDK app](../targets/meta-quest.md) uses Camera2, pairs frames with interpolated headset/lens poses, can record a local dataset, and uploads selected JPEGs and calibration to its reconstruction service. Scan also has a local ONNX inference hook. Those paths provide the baseline for the comparison. For a Unity spike, use the current [Meta passthrough camera documentation](https://developers.meta.com/vr/documentation/unity/unity-pca-documentation) for image timestamps and calibration.

1. Compare local inference and the current keyframe queue on a Quest 3 using the same movement, images, and detector. Record capture-to-result delay, pose age, dropped frames, CPU/GPU load, headset thermal behavior, and upload rate.
2. Add an opt-in live stream to a user-selected Companion endpoint. Keep live traffic on an independent bounded queue so reconstruction uploads can continue when the stream drops. Pair returned detections with the originating frame ID, camera timestamp, stream dimensions, intrinsics, camera pose, and tracking epoch. Discard results that are too old or whose epoch has ended.
3. Compare Wi-Fi and remote conditions, including queue saturation, reconnect, and an origin change mid-session. Require explicit start and stop, per-session authorization, and a visible streaming state. The recorded data path remains available whenever live inference is unavailable.

## Spark in the editor

The `/editor` already uses [Spark](https://github.com/sparkjsdev/spark) inside its Three.js scene for trained, imported, and 4D splats. It currently prefers SOG, then compressed PLY, then raw PLY for trained assets. It uses the existing authorization and alignment paths. The native Quest APK has a separate Spatial SDK viewer.

| Step | Scope | Acceptance |
| --- | --- | --- |
| Editor startup and reliability | Load Spark when a splat is requested. Attach one compositor after the first decode for each Place scene. Exclude its mesh from picking and release a splat mesh if decoding fails. | The geometry-only editor opens without the Spark bundle. Trained, imported, and 4D splats render through their existing entry points. A failed import reports the failure and a subsequent valid import renders. |
| Spark version and cleanup | Evaluate [Spark 2.4](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0) against the currently locked 2.1.0. Its release notes cover SPZ v4, pluggable paged data access, WebXR sizing, and worker/LoD disposal fixes. Validate renderer disposal on repeated Place changes, including a change while sorting or loading. | Use the same assets to verify no prior Place splats, stale status, orphaned loads, or rising retained WebGL resources. Preserve private asset access and `projectTransform` placement. |
| Mobile and desktop budgets | Use a small imported splat, a typical compressed room, and a large room with an aligned overlay. Collect bytes to first scene, time to first rendered frame, p95 frame time while orbiting, memory/context loss, and 4D scrub performance. Cover desktop Chromium, Android Chrome, and iOS Safari with named devices. | Choose the default quality from measured results. Compare SOG, compressed PLY, and raw fallback. Evaluate paged LoD for the large room after the aligned compressed path is stable. |
