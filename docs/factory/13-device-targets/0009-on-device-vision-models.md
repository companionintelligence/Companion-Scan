> **Type:** Native app / Frontend
> **Wave:** 13-device-targets
> **Branch:** `feat/on-device-vision`
> **Commit style:** `feat(vision): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0005

## Goal

Choose an on-device vision model for the capture targets, and run it where it helps without changing what the server receives. Until this wave inference ran on the server. The web app's ONNX path used weights that no app bundles, because their licence was unchecked (`scripts/native/build-web.mjs`, `NATIVE_EXCLUDED`).

## Non-goals

- Do not fetch or bundle any weights without the owner's yes.
- Do not add fields to keyframe `meta`.
- Do not replace server inference.

## Pinned conventions

- ADR 0001. On-device outputs that are ever uploaded map onto `WorldDetection` and `DetectObject`. No new "thing" type.
- Runtimes:
  - Quest and Android: ONNX Runtime (`com.microsoft.onnxruntime:onnxruntime-android`, 1.32.0 on Maven Central). The hook lands in `meta/` with ticket 0005.
  - iOS: Core ML, later.
- Candidates, with each licence as its repository states it (read 2026-11-23):

  | Model | Task | Licence |
  |---|---|---|
  | Depth Anything V2 Small | monocular depth | Apache-2.0. Base, Large and Giant are CC-BY-NC-4.0 |
  | EfficientSAM (S, Ti) | segmentation | Apache-2.0 |
  | MobileSAM | segmentation | Apache-2.0 |
  | RT-DETR | detection | Apache-2.0. The page does not address weights |
  | D-FINE | detection | Apache-2.0. Its Objects365 checkpoints are not cleared for commercial use |

- The weights rule stays: an app bundles only weights whose licence is checked and recorded in the third-party notices (`scripts/native/third-party-notices.mjs`).

## Before implementation

- Read `server/inference.ts` and the detection path (`WorldDetection` in `src/world/types.ts`), to see what an on-device result would have to match.
- Read `scripts/native/build-web.mjs` (`NATIVE_EXCLUDED`) and `scripts/native/third-party-notices.mjs`.

## Open questions & answers

- Q: Which task helps capture most: depth, segmentation or detection? — OPEN, for the owner.
- Q: Do the weights carry the code's licence? — OPEN for RT-DETR, EfficientSAM and MobileSAM: their pages do not say.
- Q: How fast is each model on a Quest 3? — OPEN, unmeasured.

## Files impacted

- Changed: `meta/` (the model runner, behind the hook from 0005), and later `mobile/android` and `mobile/ios`.
- Changed: `scripts/native/third-party-notices.mjs`, only when a model is chosen.

## Schema required

None in this ticket. A mapping onto `WorldDetection` is designed before any upload.

## Definition of Done

- [ ] The owner has chosen a model, and the weights' licence is recorded.
- [ ] The Quest app runs it from the app's files directory, at a measured rate, and shows the output on the device.

## Tests

- [ ] A JVM test runs the ONNX hook against a tiny test model, generated in the test, with no downloaded weights.

```bash
cd meta && ./gradlew testDebugUnitTest --no-daemon
```

## Acceptance Criteria

- [ ] Given no model file, the app says that no model is installed and captures normally.
- [ ] Given the chosen model, when a capture runs, then frame upload rate does not drop below its setting.

## Risks / potential issues

- **Risk:** A weights licence differs from the code's. — **Mitigation:** Record the weights' own terms before any bundling.
- **Risk:** Inference competes with capture for the headset GPU. — **Mitigation:** Run at a low rate on downsampled frames, off the render thread.

## Subtasks

1. [ ] The owner picks a task and a model.
2. [ ] Check and record the weights' licence.
3. [ ] Run the model behind the hook.
4. [ ] Measure the rate on a headset.
5. [ ] Design the `WorldDetection` mapping, if results are to be uploaded.
