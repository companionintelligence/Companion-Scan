# Mobile room-scan parity review

Reviewed: 2026-11-27

## Scope

This review compares Companion Scan’s current capture and reconstruction path with phone/LiDAR room-scanning products, platform APIs, open-source tools, and the supplied Room Scan Exporter Quest APKs and PC companion installers. The binaries were analyzed statically; no app or installer was run and no device accuracy tests were performed. Product accuracy figures below are vendor claims, not independent measurements.

## Where Companion Scan stands

Companion Scan already records poses and color keyframes, reconstructs scans with COLMAP/LingBot-Map and Brush 3DGS, exposes typed scan layers with visibility controls, and has an implemented floor-plan job that emits JSON and SVG from point-cloud geometry. The floor-plan output is derived wall/outline geometry, not a parametric BIM model; runtime quality and dimensional accuracy were not remeasured in this review. Object detections, labels, and panoptic jobs already exist. Room-structure semantics such as walls, openings, and merged room models remain a gap.

The native iOS/Android bridges can return depth from the same captured AR frame, but the normal provider starts with depth disabled and `captureFrame()` requests `depth: false`. The provider then discards native depth and projection; `KeyframeStreamer` uploads JPEG plus metadata only, and the server accepts/stores JPG keyframes. The unused `FrameObservation.depthUrl` field does not establish a working depth path. ARKit’s frame depth includes a corresponding confidence map ([`ARDepthData`](https://developer.apple.com/documentation/arkit/ardepthdata)); ARCore automatic depth supplies dense depth while per-pixel confidence comes from raw depth, whose timestamp must be preserved ([ARCore depth modes](https://developers.google.com/ar/reference/java/com/google/ar/core/Config.DepthMode), [ARCore `Frame`](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame)). A complete pickup therefore spans a versioned depth/confidence package, native capture metadata, upload/storage/serving, size budgets, and retention; simply turning on the bridge flag would still lose the observation.

References: [architecture](../architecture.md), [floor-plan worker](../../scripts/floor_plan_worker.py), [iOS target](../targets/ios.md), [Android ARCore target](../targets/android-arcore.md), [mobile bridge notes](../../mobile/README.md).

## Product and platform comparison

| System | Capture and output | Useful parity target | Evidence and limits |
|---|---|---|---|
| Apple RoomPlan | LiDAR and camera capture; parametric walls, doors, windows, openings, and furniture; USD/USDZ output. Apple also documents combining rooms into one structure. | Native iOS capture adapter, semantic room schema, and multi-room coordinate-frame merge. | [RoomPlan API](https://developer.apple.com/documentation/roomplan), [multi-room scanning](https://developer.apple.com/documentation/roomplan/scanning-the-rooms-of-a-single-structure). Availability is platform/device dependent. |
| Polycam Spatial Capture | Markets a single capture session that produces a photorealistic model and aligned 2D/3D plans. | One capture package feeding mesh, plan, and measurements; clear completion/coverage feedback. | [Polycam Spatial Capture](https://poly.cam/spatial-capture). Its 0.5-inch interior tolerance is a product claim. |
| Floor Plan App | iPhone/iPad capture with LiDAR-assisted and manual/AR paths; edits walls, openings, furniture, labels, area, and 2D/3D views. | A usable manual correction loop after automatic geometry; SVG/PDF handoff. | [Feature page](https://floorplan-app.com/#features). The “few cm” accuracy is a product claim. |
| The Future3D scan-to-BIM service | Professional laser scans and registered point clouds in E57/XYZ/RCP/LAS; BIM modeling is a separate delivery service. | Keep point-cloud capture, model authoring, and BIM conversion as explicit stages with traceable source data. | [Service page](https://www.thefuture3d.com/services/scan-to-bim/). The stated ±2 mm scanner figure is a service claim and is not a fair phone-camera benchmark. |
| Room Scan Exporter for Quest | The supplied v0.2/v0.3 Quest builds contain depth/volume, GPU mesh, keyframe texturing, package persistence, and PC-link modules. The recovered PC v0.2 companion bakes registered keyframes into textured OBJ/MTL/PNG; PC v0.3 converts the same scan payload to COLMAP, attempts pose refinement, trains with Brush, and returns full and Quest-frame splats. | Coverage-guided capture, a durable scan package, local PC refinement, and a distinct camera-pose reconciliation step before splat training. | [Publisher page and release notes](https://zoynctech.itch.io/room-scan-exporter-for-meta-quest-3). Static binary analysis plus publisher description, not a runtime or accuracy test. The PC Python reconstruction is incomplete; the bundled native Brush executable was not decompiled. The file named v0.1 contains Meta Phanto/scene-meshing code rather than the later `Genesis.RoomScan` assembly. |

Apple’s ARKit scene mesh can classify faces such as floor, wall, ceiling, door, and window; Android can provide raw depth and confidence on supported ARCore devices. These are platform inputs, not a shared cross-platform room model. [ARKit mesh classification](https://developer.apple.com/documentation/arkit/armeshclassification), [ARCore Raw Depth](https://developers.google.com/ar/develop/java/depth/raw-depth).

## Open-source components worth evaluating

| Project | License / role | Recommendation |
|---|---|---|
| [Open3D](https://github.com/isl-org/Open3D) | MIT; RGB-D TSDF integration and point-cloud registration. | Best immediate server-side candidate for an optional depth reconstruction/refinement job. Keep COLMAP/Brush as existing paths and compare outputs on the same fixture. [TSDF tutorial](https://www.open3d.org/docs/latest/tutorial/pipelines/rgbd_integration.html), [registration tutorial](https://www.open3d.org/docs/release/tutorial/pipelines/global_registration.html), [license](https://github.com/isl-org/Open3D/blob/main/LICENSE). |
| [OpenPlan3D](https://github.com/laanlabs/openPlan3D) | MIT; editable floor-plan web tool with RoomPlan import/export paths. | Evaluate as a plan editor or import/export reference; keep Companion Scan’s capture pipeline and product schema independent. |
| [OpenScan](https://github.com/barkleesanders/openscan) | MIT; early ARKit scene-reconstruction sample with face labels, measurements, and PLY/OBJ/USDZ export. | Useful native iOS implementation reference, not a production surveying stack. |
| [ScanComplete](https://github.com/angeladai/ScanComplete) | Apache-2.0 research code for semantic completion; depends on TensorFlow 1.3/Python 2.7. | Use as a research baseline only; its legacy runtime makes direct adoption unattractive. [Paper](https://www.3dunderstanding.org/papers/2018/dai2018scancomplete/). |
| [SSR-2D](https://arxiv.org/html/2302.03640v4) | Research method using source RGB-D views to jointly complete geometry, color, and semantics. | Extract evaluation ideas; no maintained implementation was identified in the paper materials. |

## Pickup plan

| Priority | Work | Current state | Concrete exit gate |
|---|---|---|---|
| P0 | Persist synchronized phone depth observations | Native depth is a separate read from ordinary color capture, so the current path lacks a registered same-frame observation. | Add an atomic capture payload with RGB/depth association, timestamp, pose, intrinsics, depth scale/registration, and confidence when available. A scan without supported depth still imports cleanly. |
| P1 | Depth-aware coverage and rescan guidance | Existing quality monitoring covers capture readiness; sensor-depth coverage and confidence are not represented in the package. | Show low-coverage/low-confidence regions in the editor and link them to capture recommendations. Validate against a repeatable room fixture. |
| P1 | Semantic room-model adapter | Object detections and panoptic output exist; normalized room surfaces/openings are not yet produced by the semantic jobs. | Add a RoomPlan-backed iOS adapter and normalize room surfaces/openings into a platform-neutral schema. Preserve source labels and dimensions. |
| P2 | Multi-room plan merge and correction | No verified multi-room semantic merge path. | Merge room models in a shared metric frame and let users correct walls/openings before export. Record measurement provenance and an accuracy band. |
| P2 | Optional RGB-D mesh refinement | COLMAP/Brush and point-cloud reconstruction already exist; depth reconstruction is a placeholder. | Evaluate Open3D TSDF/registration on the same captured sessions and keep the job selectable by device capability and quality result. |
| P2 | AR/COLMAP pose reconciliation | COLMAP already solves camera poses before training. `splat-align` is a post-training similarity transform into the metric Place frame. | Compare AR poses with COLMAP on a repeatable capture, record residual/drift and provenance, and keep metric splat alignment as a separate stage. |

The target is reviewable room geometry with honest measurement quality. Phone and headset capture should not inherit professional scanner tolerances from a service brochure.

## Static Quest APK output

The local Cpp2IL/ILSpy output, unpacked PC apps, reconstructed Python modules, and per-file hashes are in the user-supplied analysis folder at `~/Desktop/room-scan/decompiled-analysis-2026-11-27/`. The PC server binds on all interfaces and uses UDP discovery; its recovered FastAPI setup advertises wildcard CORS, with no visible authentication/TLS handling in the recovered route setup. This is static analysis of incomplete reconstructed code. This repository review records findings only; reconstructed third-party code and binaries are not included.
