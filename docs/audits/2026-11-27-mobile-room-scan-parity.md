# Mobile room-scan parity review

Reviewed: 2026-11-27

## Scope

This review compares Companion Scan’s current capture and reconstruction path with phone/LiDAR room-scanning products, platform APIs, open-source tools, and the supplied Room Scan Exporter Quest APKs. The APKs were analyzed statically; no app or installer was run and no device accuracy tests were performed. Product accuracy figures below are vendor claims, not independent measurements.

## Where Companion Scan stands

Companion Scan already records poses and color keyframes, reconstructs scans with COLMAP/LingBot-Map and Brush 3DGS, exposes editable scan layers, and has a working floor-plan job that emits JSON and SVG from point-cloud geometry. The floor-plan output is a derived wall/outline representation rather than a parametric BIM model. The native iOS and Android bridges can expose sensor depth, but the mobile target notes say depth is not uploaded with the scan package. `semantic-pass` and `depth-reconstruct` remain placeholder jobs.

References: [architecture](../architecture.md), [floor-plan worker](../../scripts/floor_plan_worker.py), [iOS target](../targets/ios.md), [Android ARCore target](../targets/android-arcore.md), [mobile bridge notes](../../mobile/README.md).

## Product and platform comparison

| System | Capture and output | Useful parity target | Evidence and limits |
|---|---|---|---|
| Apple RoomPlan | LiDAR and camera capture; parametric walls, doors, windows, openings, and furniture; USD/USDZ output. Apple also documents combining rooms into one structure. | Native iOS capture adapter, semantic room schema, and multi-room coordinate-frame merge. | [RoomPlan API](https://developer.apple.com/documentation/roomplan), [multi-room scanning](https://developer.apple.com/documentation/roomplan/scanning-the-rooms-of-a-single-structure). Availability is platform/device dependent. |
| Polycam Spatial Capture | Markets a single capture session that produces a photorealistic model and aligned 2D/3D plans. | One capture package feeding mesh, plan, and measurements; clear completion/coverage feedback. | [Polycam Spatial Capture](https://poly.cam/spatial-capture). Its 0.5-inch interior tolerance is a product claim. |
| Floor Plan App | iPhone/iPad capture with LiDAR-assisted and manual/AR paths; edits walls, openings, furniture, labels, area, and 2D/3D views. | A usable manual correction loop after automatic geometry; SVG/PDF handoff. | [Feature page](https://floorplan-app.com/#features). The “few cm” accuracy is a product claim. |
| The Future3D scan-to-BIM service | Professional laser scans and registered point clouds in E57/XYZ/RCP/LAS; BIM modeling is a separate delivery service. | Keep point-cloud capture, model authoring, and BIM conversion as explicit stages with traceable source data. | [Service page](https://www.thefuture3d.com/services/scan-to-bim/). The stated ±2 mm scanner figure is a service claim and is not a fair phone-camera benchmark. |
| Room Scan Exporter for Quest | The supplied v0.2/v0.3 builds contain depth/volume, GPU mesh, keyframe texturing, package persistence, and PC-link modules. v0.3 adds Gaussian-splat streaming/training. | Coverage-guided capture, a durable scan package, local PC refinement, and camera-pose correction before splat training. | [Publisher page and release notes](https://zoynctech.itch.io/room-scan-exporter-for-meta-quest-3). This is static binary analysis plus publisher description, not a runtime or accuracy test. The file named v0.1 contains Meta Phanto/scene-meshing code rather than the later `Genesis.RoomScan` assembly. |

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
| P0 | Persist phone depth observations | Native bridges expose depth; it is not carried through the upload path. | Version the scan package with timestamped depth, color-frame reference, pose, intrinsics, and confidence when available. A scan without supported depth still imports cleanly. |
| P1 | Depth-aware coverage and rescan guidance | Existing quality monitoring covers capture readiness; sensor-depth coverage is not represented in the package. | Show low-coverage/low-confidence regions in the editor and link them to capture recommendations. Validate against a repeatable room fixture. |
| P1 | Semantic room-model adapter | Floor-plan job exists; `semantic-pass` is a placeholder. | Add a RoomPlan-backed iOS adapter and normalize room surfaces/openings into a platform-neutral schema. Preserve source labels and dimensions. |
| P2 | Multi-room plan merge and correction | No verified multi-room semantic merge path. | Merge room models in a shared metric frame and let users correct walls/openings before export. Record measurement provenance and an accuracy band. |
| P2 | Optional RGB-D mesh refinement | COLMAP/Brush and point-cloud reconstruction already exist; depth reconstruction is a placeholder. | Evaluate Open3D TSDF/registration on the same captured sessions and keep the job selectable by device capability and quality result. |
| P2 | Splat camera-pose correction | Companion Scan already has COLMAP/Brush and a splat alignment stage. | Measure pose relocation before/after training on a repeatable capture; retain transform and source observations in job provenance. |

The target is reviewable room geometry with honest measurement quality. Phone and headset capture should not inherit professional scanner tolerances from a service brochure.

## Static Quest APK output

The local Cpp2IL/ILSpy output and per-file hashes are in the user-supplied analysis folder at `~/Desktop/room-scan/decompiled-analysis-2026-11-27/`. This repository review records findings and method names only; reconstructed third-party code and APKs are not included.
