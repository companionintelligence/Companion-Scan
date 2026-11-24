# Scan server

The one server every target talks to: a Deno API that stores scans and Places, runs the
background jobs, and runs object detection. The phone apps and the desktop app have no server of
their own; each is pointed at a Scan server by its https address.

## What it is

- **The API.** `server/main.ts` serves HTTP and WebSocket routes on `:8000`: scans, sessions and
  keyframes, Places and worlds, edit patches, jobs, inference, sign-in, live events (`/events`)
  and WebRTC signalling. The canonical route table is in
  [architecture.md](../architecture.md#api-routes--interface-specification); the most used routes
  are in [README.md](../../README.md#server-api).
- **Behind Vite.** Phones and browsers reach the API through Vite on `:5173`, which serves the web
  app over HTTPS and proxies the API routes, in development (`npm run dev`) and in production
  (`vite preview`, [DEPLOY.md](../operations/DEPLOY.md)).
- **One job system.** Every background job is a `WorldJob`, run by the single-flight pump in
  `server/world/world_job_pump.ts`, with crash recovery, dedupe and bounded history
  ([ADR 0003](../adr/0003-merged-job-system.md)). Every upload queues an `optimize-scan` job
  (`server/pipeline.ts`: quantization, Draco and point-cloud LODs). There are twenty-four job
  types, and a client may queue twenty-three of them by name (all but `optimize-scan`). Eighteen
  have a runner; six (`ingest`, `extract-layers`, `align-scan`, `merge-points`, `semantic-pass`,
  `depth-reconstruct`) are No-op placeholders that complete without doing anything. They are
  listed in [architecture.md](../architecture.md#world-job-types--processing-worldsslugjobs).
- **Reconstruction.** Two pipelines run as `WorldJob`s: the fast GLB optimizer above, and the
  slower chain of poses (LingBot-Map, or COLMAP with a quality verdict), Gaussian-splat training
  (Brush by default, or Spirula Studio, chosen by `SPLAT_BACKEND`), then splat detection, alignment
  and compression. A LingBot-Map cloud also gets a 2D floor plan (`floor-plan`, numpy on the CPU),
  fitted to the capture's AR poses, so in metres when the capture measured in metres. A person
  capture is reconstructed off-box in `subsystems/4d-capture/`
  ([ADR 0006](../adr/0006-person-capture-is-a-calibrated-take-and-densification-is-a-subsystem.md)).
- **Optional tools.** Every reconstruction tool is an external program the server runs. A missing
  one makes its job complete as `skipped` with a `remediation`, so a box with none of them still
  runs the whole queue. Since wave 14 that includes `memory-push` without Companion Memory, a
  LingBot-Map interpreter that is not found and a `node` for splat-finish that is not found. A tool
  that is found and fails to start for another reason still fails the job.
- **Inference.** `INFERENCE_MODE` picks the engine: `ollama` (the default, running
  `OLLAMA_MODEL`, `qwen3-vl:4b` unless set), `onnx` (the bundled `LiquidAI/LFM2.5-VL-1.6B-ONNX`) or
  `mock` (a deterministic colour-blob engine for tests). The on-device WebGPU path runs in the
  browser and needs no server ([README.md](../../README.md#inference)).
- **Sign-in and origins.** "Sign in with Companion Account" (CI-Portal OIDC, `server/portal_auth.ts`)
  is off unless `PORTAL_OIDC_ENABLED` is on. `server/origin.ts` admits `https://<TAILSCALE_HOSTNAME>`
  on any port, `ALLOWED_ORIGIN_PREFIX`, `APP_BASE_URL` and the apps' own origins, and admits
  localhost and LAN pages only with `ALLOW_DEV_ORIGINS=1`.

## Status

From [PLATFORM_SUPPORT.md](../operations/PLATFORM_SUPPORT.md), where a row is VERIFIED only when
someone ran it and read the output:

- **The server and the Vite frontend: VERIFIED on Linux x86_64**, on one host. macOS and Windows
  are UNVERIFIED.
- **Tools on that host**, probed on 2026-08-30. ffmpeg ingest and the COLMAP pose solve are
  VERIFIED. Brush trained one session end to end there on 2026-08-30, from a synthetic
  walkthrough video (166 s, recorded in ADR 0007). Spirula is VERIFIED as found and
  version-stamped only.
- **Panoptic segmentation** is VERIFIED end to end on a different GPU, an RTX 3070, on 2026-11-12.
- **Known not to work:** Brush or Spirula on a CPU-only host, Spirula on macOS, and 4D person
  capture on this fleet (it needs about 44 GiB on one CUDA device, so it delegates off-box).
- **PhysAg3D interactive asset (opt-in, not run here).** The `thing-interactive-asset` job hands
  one keyframe to an operator-configured PhysAg3D controller. That controller uses its own agent
  service and a GPU host with at least 28 GiB free, and makes an articulated, simulated asset of a
  Thing.
  - Unconfigured, the job is skipped with a hint. It never starts on its own.
  - The image leaves the box.
  - A run holds the job slot for hours.
  - See [physag3d.md](../pipelines/physag3d.md) and
    [ticket 0011](../factory/13-device-targets/0011-physag3d-interactive-asset-job.md). Unit tests
    only; no real run.
- **CI.** `deno task check` and `deno task test` run in `.github/workflows/deno-ci.yml` only when
  started by hand. The pre-push hook runs `npm run verify` locally.

## Entry points and files

| What | Where |
|---|---|
| Routes, CORS, capability tokens | `server/main.ts` |
| Origins the server admits | `server/origin.ts` |
| Job pump | `server/world/world_job_pump.ts`; legacy job shapes in `server/jobs.ts` |
| Scan optimization | `server/pipeline.ts` |
| Inference | `server/inference.ts`, `server/prompt.ts` |
| Sign-in | `server/portal_auth.ts` |
| Companion Memory push | `server/memory_push.ts` |
| Whole-Place export | `server/world_export.ts` |
| Splat, COLMAP, LingBot-Map, panoptic, person 4D | `server/splat/`, `server/colmap/`, `server/lingbot-map/`, `server/panoptic/`, `server/person4d/` |
| Tool probe | `server/capabilities.ts` |
| Deployment | `deploy/` (systemd units and env template), `Dockerfile` |
| Settings | `.env.example` |

## Build

There is no build step: Deno runs the TypeScript. Install with `npm ci`, not `npm install`; Deno
shares the `node_modules` tree (`deno.json`'s `nodeModulesDir: "auto"`). Type-check with
`deno task check` after any change to `server/main.ts`. The container image is built from the
`Dockerfile` by `.github/workflows/docker-publish.yml`, run by hand.

## Run

- Development: `npm start` runs the API (`npm run server`) and Vite together. On a dev machine use
  `ALLOW_DEV_ORIGINS=1 npm start` for pages on `localhost` ([README.md](../../README.md#quick-setup)).
- `npm run server` and `deno task start` pass `--env-file`, so they read a `.env` file. The
  systemd unit and the Docker image do not.
- A persistent Linux server: the systemd units, cert renewal and GPU inference in
  [DEPLOY.md](../operations/DEPLOY.md).
- On a Companion Hub, the Hub supplies the Companion Memory, vision model and sign-in settings
  ([COMPANION_HUB.md](../operations/COMPANION_HUB.md)).
- The settings the server reads, the first-run status rows and sign-in are in
  [README.md](../../README.md#first-run-setup-status-and-settings). Where each external tool is
  found, and how to install it, is in
  [README.md](../../README.md#reconstruction-toolchain-all-optional).

Ask a running box what it has: `GET /health` reports the inference engine, and `GET /capabilities`
(or `deno run --allow-read --allow-env --allow-run server/capabilities.ts`) reports every external
tool it found and where.

## Test

Before a device test, check the server the device will use:

- [DEVICE_TESTING.md](../testing/DEVICE_TESTING.md#prerequisites): `curl -fs https://<host>:5173/health`
  shows `"engineLoadState":"ready"`.
- [DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md): `npm run device:preflight` checks the
  Tailscale host, the HTTPS origin and the Vite proxy into the API. The
  [Surfaces](../testing/DEVICE_TEST_KIT.md#surfaces) table covers the whole-Place glTF
  (`export-world`), and the
  [GPU backend report](../testing/DEVICE_TEST_KIT.md#amd-apple-and-intel-machines-which-gpu-backend-the-workers-get)
  says which backend the workers get on AMD, Apple and Intel machines.

Without a device:

- `deno task test`: the Deno unit suites in `tests/unit/deno/`.
- `npm run verify`: the hermetic gate (server type-check, the Deno suites, the frontend
  type-check and the Node suites). No servers or browsers.
- `npm run test:api`: the `api` Playwright project against a running server.
  `npm run test:box`: the browser loop on its own scratch servers and data.
- `npm run smoke:pipeline`: the scan-optimization pipeline end to end.
- [HOUSE_VALIDATION.md](../testing/HOUSE_VALIDATION.md): the whole-house field protocol
  (`npm run test:house`).

## Known gaps

- The job queue is one worker, and it shares the box with the vision model.
- Six job types have no worker. They complete with a result that starts `No-op:` and a report
  artifact, and change nothing. Several runners complete as `skipped`, with a hint, when their
  tool is not configured.
- With sign-in off, which is the default, anyone who can reach the server can read and write
  scans unless `SCAN_REQUIRE_AUTH=1` is set. World reads are open by default, and
  `WORLD_STRICT_AUTH=1` requires capability tokens for protected world actions.
- On Windows the runners build their fallback tool paths from `HOME`, which Windows does not
  usually set: set the per-tool variables (`COLMAP_BIN`, `BRUSH_BIN`, ...) there.
- The `memory-push` job does not call Companion Memory's `ingest/finish` step yet
  ([COMPANION_HUB.md](../operations/COMPANION_HUB.md#companion-memory)).
