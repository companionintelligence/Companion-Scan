> **Type:** Backend
> **Wave:** 19-headset-sessions
> **Branch:** `phase1/headsets`
> **Commit style:** `Detection: summary`
> **Design:** this ticket is the spec
> **Dependencies:** the detection service (#315)

## Goal

Let the Scan server use the detection service (`scripts/grounding_dino_server.py`, `POST /detect`) as its `/infer`
engine, so a capture's frame gets Grounding DINO's boxes from the box's GPU in about a quarter of a second, in the
`RawDetection[]` every engine returns.

## Non-goals

- Do not change the service, its contract or its unit.
- Do not change the default engine (`ollama`), the Ollama, ONNX or mock paths, or `/infer`'s own contract.
- Do not invent a description: the detector gives none.

## Pinned conventions

- **ADR 0001.** No new connection type or route: `/infer` keeps its one contract, and the engine is a fourth value of
  the existing `INFERENCE_MODE`. Searched before adding a variable: the service's `GDINO_HOST` is a bind address and
  its certificate names the box's Tailscale host, so no client URL can be derived from it; nothing else names the
  service's address. One new variable, `GDINO_URL`. The token reuses the service's own `GDINO_TOKEN`, so one env file
  serves both.
- **One vocabulary.** The prompt is `CORE_LABELS` (`server/prompt.ts`), the nouns the VLM prompt offers.
- **One output path.** The service's boxes go through `normalizeDetections`: label folding, clamping, the 0.45
  confidence floor, de-duplication and the cap of 8, as the Ollama engine's replies do.
- **One reading of `INFERENCE_MODE`**, `inferenceModeFrom` (`server/inference_mode.ts`), for the engine and the
  capability report, which each parsed it before.
- **F-07.** Log counts and timing, never what was found.

## Before implementation

- `server/inference.ts`, `server/prompt.ts`, `server/capabilities.ts` (`serviceProbes`).
- `scripts/grounding_dino_server.py`'s docstring (the contract) and `docs/operations/GPU_BACKENDS.md`.

## Open questions & answers

- Q: Wait at start-up until the service's model has loaded? — A: No. The service loads in the background and retries
  a failed load every minute, and both start at boot. The server needs the service to answer `GET /health`; a model
  that is not in yet is logged, and `/infer` passes on the service's 503 until it is.
- Q: Which confidence threshold to send? — A: None: the service's default (0.3) cuts the long tail, and
  `normalizeDetections` applies the engines' own floor (0.45).

## Files impacted

- New: `server/grounding_dino.ts`, `server/inference_mode.ts`, `tests/unit/server/inference_grounding_dino.test.ts`.
- Changed: `server/inference.ts`, `server/capabilities.ts`, `.env.example`, `deploy/cscan.env.example`,
  `docs/architecture.md`, `docs/operations/GPU_BACKENDS.md`, `docs/factory/atlas.html`.

## Schema required

None. `RawDetection` is unchanged.

## Definition of Done

- [x] `INFERENCE_MODE=grounding-dino` with `GDINO_URL` detects through `POST /detect`, and `GET /health` names the
  model the service runs.
- [x] Without `GDINO_URL`, or with a service that does not answer, the load fails with the reason, as Ollama's does.
- [x] The capability report's `inference-engine` row shows the address and whether the model is ready, and no token.

## Tests

- [x] `tests/unit/server/inference_grounding_dino.test.ts`: the configuration, the request, the reply's conversion,
  the failures, the engine end to end, and the report's row, all against a fake service.
- [x] `npm run verify`.

## Acceptance Criteria

- [x] Given a fake service that answers, when a frame is inferred, then the boxes come back as fractional corners,
  strongest first, folded and capped as the Ollama engine's are.
- [ ] Given the box's own detection service, when the box runs with this engine, then a capture's boxes reach the scan. Not run:
  this wave changes no shared host.

## Risks / potential issues

- **Risk:** no description on the scan's detections. — **Mitigation:** the engine is opt-in; the owner decides
  whether it becomes the box's default (wave README).

## Subtasks

1. [x] The client, the engine mode and the report row, with their tests.
2. [x] The docs and the atlas.
