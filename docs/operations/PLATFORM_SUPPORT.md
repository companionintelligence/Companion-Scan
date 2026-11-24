# Platform support

What actually runs, on which OS, with which accelerator — and, just as importantly, what
nobody has ever tried. Every row is marked **VERIFIED** (someone ran it and read the output)
or **UNVERIFIED** (inferred from the code, and therefore a guess with a citation). Nothing
here is presented as measurement unless it was measured.

## Ask your own machine instead of reading a table

```bash
node server/capabilities.ts                 # human table
node server/capabilities.ts --json          # machine-readable
node server/capabilities.ts --no-versions   # stat-only, no subprocesses
```

`server/capabilities.ts` probes every external tool the pipelines shell out to and reports,
for each: found or not, the **resolved absolute path**, the version where it is cheap to get,
and — when missing — the exact remediation the runner itself would have printed. It also lists
every candidate path it looked at, in order.

That last part is the reason the module exists. On 2026-08-30 COLMAP 3.13.0 was installed the
entire time at `~/.local/micromamba/envs/colmap/bin/colmap` while `which colmap` said it was
not, because a no-sudo micromamba env is not on `PATH`; ffmpeg was genuinely absent and only
said so as an HTTP 500 from `/ingest-video`. A report that answers "missing" without saying
where it looked would have cost the same hours in a nicer format.

## What was measured, and where

The **VERIFIED** rows below all come from one host, probed on 2026-08-30, when the server and
this report still ran on Deno. Since wave 18 the report runs on Node and its first line names the
Node version (`node 26.13.1`) where this one names Deno's:

> Ubuntu 26.04.1 LTS, Linux 7.0.0-30-generic x86_64, Deno 2.9.5,
> NVIDIA GeForce RTX 4080 Laptop GPU, driver 610.57.04, 12282 MiB.

```
platform  linux/x86_64  deno 2.9.5

TOOLS
  ok      ffmpeg               7.0.2-static  /home/<user>/.local/bin/ffmpeg  (path)
  ok      ffprobe              7.0.2-static  /home/<user>/.local/bin/ffprobe  (path)
  ok      colmap               3.13.0 (CUDA)  /home/<user>/.local/micromamba/envs/colmap/bin/colmap  (fallback)
  ok      brush                1.0.0  /home/<user>/brush/target/release/brush-cli  (fallback)
  ok      spirula              2026.8.28  /home/<user>/opt/spirula/spirula  (fallback)
  ok      panoptic-python      3.12.3  /home/<user>/.venvs/panoptic/bin/python  (fallback)
          torch: 2.13.0+cu130 → cuda (cuda 13.0)
  ok      panoptic-worker      /home/<user>/panoptic  (fallback)
  MISSING splat-detect-python  (looked in: /home/<user>/.venvs/splat-analyzer/bin/python)
  MISSING splat-detect-dir     (looked in: /home/<user>/splat_analyzer)
  ok      lingbot-map-python   3.14.4  /usr/bin/python3  (path)
          torch: absent — ModuleNotFoundError: No module named 'torch'
  MISSING lingbot-map-model    (looked in: nowhere — no candidate paths)

GPU (driver presence only)
  detected nvidia   NVIDIA GeForce RTX 4080 Laptop GPU, 610.57.04, 12282 MiB
  none     amd      No rocminfo/rocm-smi on PATH.
  none     apple    Not an Apple Silicon host.
```

Note what the last two tool rows say together: `/usr/bin/python3` exists and has **no torch**,
while `~/.venvs/panoptic/bin/python` on the same machine has torch 2.13.0+cu130. torch is a
per-interpreter fact, not a per-machine one, and `server/lingbot-map/lingbot_map.ts:446`
defaults to the bare `python3`. Any table that reported "torch: yes" for this host would be
lying about the process that actually needs it.

## Operating systems

| | Linux x86_64 | macOS (Apple Silicon) | macOS (Intel) | Windows |
| --- | --- | --- | --- | --- |
| API server (Node) + Vite frontend | **VERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Tool resolution (`server/capabilities.ts`) | **VERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED — both branches unit-tested, never run on Windows |
| ffmpeg / ffprobe ingest | **VERIFIED** (7.0.2) | UNVERIFIED (`brew install ffmpeg` lands on PATH) | UNVERIFIED | UNVERIFIED |
| COLMAP pose solve | **VERIFIED** (3.13.0 CUDA build, CPU features) | UNVERIFIED (`brew install colmap`) | UNVERIFIED | UNVERIFIED |
| Brush splat training | **VERIFIED** — one session, from a synthetic walkthrough video, trained end to end on 2026-08-30 (15k iterations, 37.5 MB `.ply`, 166 s; ADR 0007), and the probe found and version-stamped it | UNVERIFIED (needs Metal) | UNVERIFIED | UNVERIFIED |
| Spirula splat training | **VERIFIED** (binary + version only) | **Known not to work** — releases are `ubuntu-vulkan-x86_64` | Known not to work | UNVERIFIED |
| Panoptic / splat-detect / LingBot-Map workers | **VERIFIED** (panoptic venv only) | UNVERIFIED | UNVERIFIED | UNVERIFIED |

"VERIFIED (binary + version only)" means the probe found and version-stamped the tool on this
box. It does **not** mean a capture was pushed through it. Brush is the one trainer that was:
the end-to-end run on this same host on 2026-08-30 (COLMAP 27.6 s, Brush 166 s, on a session made
from a synthetic walkthrough video) is in ADR 0007's Context section, which is where that
measurement lives. Spirula has not trained a capture here.

### Windows: three things that are true by reading the code

1. `isRunnable()` and `whichPath()` (`server/exec_probe.ts`) both carry an explicit Windows
   branch — no POSIX exec bit, `;` as the PATH separator, PATHEXT suffixes tried before the
   bare name. Both branches are unit-tested from Linux via the injectable `ExecPlatform`
   (`tests/unit/server/capabilities.test.ts`, `tests/unit/server/exec_probe.test.ts`).
   **UNVERIFIED on real Windows** — the tests prove the logic, not the host.
2. Every fallback install path is built from the home directory by `resolveHome`
   (`server/exec_probe.ts`): `HOME`, then `USERPROFILE`, for the runners and the report alike.
   Until wave 14 the runners read `HOME` alone, so on Windows, which normally sets only
   `USERPROFILE`, their fallbacks resolved to nothing while the report found the tools.
   **UNVERIFIED on real Windows.** Setting the per-tool env var (`COLMAP_BIN`, `BRUSH_BIN`, …)
   sidesteps the question and is the recommended Windows configuration.
3. The fallback paths keep forward slashes after the home prefix
   (`C:\Users\you/brush/target/release/brush-cli`). Node's filesystem calls accept mixed
   separators on Windows, so this is expected to work — **UNVERIFIED**.

## Accelerators

| | NVIDIA / CUDA | AMD / ROCm | Apple Silicon / Metal + MPS | Intel / XPU | CPU only |
| --- | --- | --- | --- | --- | --- |
| Driver detected by the report | **VERIFIED** (nvidia-smi, on an RTX 4080 Laptop in the 2026-08-30 probe and an RTX 3070 on 2026-11-12) | UNVERIFIED (`rocminfo` / `rocm-smi` probe never exercised on AMD hardware) | UNVERIFIED (derived from `process.platform` and `process.arch`, no hardware) | UNVERIFIED — the report does not probe Intel GPU hardware; the torch check below is the only signal |
| torch reports the device | **VERIFIED** — `2.13.0+cu130` (2026-08-30) and `2.11.0+cu128` on an RTX 3070 (2026-11-12): `cuda_available=True`, `version.hip=None` | UNVERIFIED | UNVERIFIED | UNVERIFIED — `torch.xpu.is_available()` is probed; a CUDA wheel answers `False` | **VERIFIED** — a torch-less `python3` is reported as such |
| Worker device resolution (`scripts/_torch_device.py`) | **VERIFIED** on real torch 2.11.0+cu128, RTX 3070, 2026-11-12: auto → `cuda (NVIDIA CUDA, fp16)`; an fp16 autocast forward ran on the GPU; an explicit `xpu` request downgraded to CPU with a reason | UNVERIFIED — fake-torch unit tests only | UNVERIFIED — fake-torch unit tests only; workers set `PYTORCH_ENABLE_MPS_FALLBACK` | UNVERIFIED — fake-torch unit tests only; fp32 by policy | VERIFIED — the resolver's CPU path |
| Panoptic segmentation (Mask2Former) | **VERIFIED** end to end on 2026-11-12, RTX 3070: two real phone frames → 10 segments, device `cuda (NVIDIA CUDA, fp16)` | UNVERIFIED | UNVERIFIED | UNVERIFIED | Unmeasured here |
| ffmpeg ingest | **VERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED | works — ffmpeg here is CPU |
| COLMAP poses | **VERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED | works by design — `USE_GPU = '0'` in colmap_poses.ts, CPU feature extraction is the portable default |
| Brush / Spirula training | Brush trained once, end to end, on the 2026-08-30 host, which has an NVIDIA GPU (ADR 0007); which adapter wgpu used is not recorded. Spirula UNVERIFIED (found and version-stamped, never run) | UNVERIFIED (Vulkan) | UNVERIFIED (Brush needs Metal; Spirula has no macOS build here) | UNVERIFIED (Vulkan) | **Known not to work** — both need a Vulkan/Metal device |
| 4D person capture (4DAnyone) | **Known not to work on this host** — needs ~44 GiB on one CUDA device; this GPU has 8192 MiB (RTX 4080 host: 12282 MiB). Runs off-box only (ADR 0006) | Not supported (NVIDIA-only) | Not supported | Not supported | Known not to work |
| SenseNova Recon3D | Not run in this pass (needs CUDA 12.x and FlashAttention; `scripts/setup-sensenova-wsl.sh`) | Not supported | Not supported | Not supported | Not supported |

Per-vendor setup, the stage-by-backend matrix and the environment variables are in
[GPU_BACKENDS.md](GPU_BACKENDS.md).

### ROCm is not a separate branch, and must not become one

A ROCm build of torch reports `torch.cuda.is_available() == True` and uses the device string
`"cuda"`. That is how ROCm ships — it is not a bug and must not be "fixed" into a separate
device branch. `torch.version.hip` being non-`None` is the only honest NVIDIA/AMD
discriminator; `deriveAccelerator()` in `server/capabilities.ts` checks it first for exactly
this reason, and the report prints `→ rocm` where a naive reading would print `→ cuda`.

`server/splat/splat_detect.ts` is the one place already wired for AMD: it passes
`HIP_VISIBLE_DEVICES` to the analyzer subprocess when the setting is given. Unset, the default
since wave 14, it passes none, and the runtime picks its device. The old default, `"1"`, selected
the *second* device, a pin for the multi-GPU host it was written on that named a nonexistent
device on a single-GPU AMD box. On a multi-GPU AMD box, set it to choose the card.
**UNVERIFIED** — no AMD hardware was available.

### Apple Silicon

No Apple hardware was available, so everything in this section is UNVERIFIED by reading:

- The report detects Apple Silicon from `platform === 'darwin' && arch === 'aarch64'`, read from
  `process.platform` and `process.arch` (Node's `arm64` is reported as `aarch64`, `hostArch` in
  `server/exec_probe.ts`).
  There is no `apple-smi` to ask, and every arm64 Mac has an integrated GPU, so the platform
  fact *is* the measurement. An Intel Mac correctly reports not-detected.
- Python worker device selection (MPS included) goes through `scripts/_torch_device.py`,
  which both `scripts/panoptic_worker.py` and `scripts/lingbot_map_worker.py` import. Before
  it, they each resolved `cuda` or `cpu` and never consulted `torch.backends.mps`, so a Mac
  ran on CPU silently. Check that file for the current behaviour rather than trusting this
  paragraph.
- Brush's remediation string names Metal as supported (the `brush` row in `server/exec_probe.ts`). Untested here.
- Spirula publishes `ubuntu-vulkan-x86_64` releases; no macOS build is referenced anywhere in
  this repo, which is why the OS table calls it known-not-to-work rather than untested.

## Where each tool is looked for

The runners and the capability report find a tool through one function, `locateTool` in
`server/exec_probe.ts`, with one convention, in this order for every row: **the env var always
wins, then `PATH`, then the documented no-sudo install path.** An env var that points at nothing
is reported missing — it is never silently replaced by a fallback, because an operator whose
override has a typo needs to be told.

Until wave 14 ([14-inventory-fixes](../factory/14-inventory-fixes/README.md), ticket 0002) the
Brush and Spirula runners skipped `PATH`, so a trainer installed only there was reported found
while its job skipped. A few inputs are still checked for existence rather than located: the
splat-transform CLI, and the analyzer and panoptic checkouts.

| Tool | Env var | On PATH as | Documented fallback |
| --- | --- | --- | --- |
| ffmpeg | *(none — see below)* | `ffmpeg` | — |
| ffprobe | *(none)* | `ffprobe` | — |
| COLMAP | `COLMAP_BIN` | `colmap` | `~/.local/micromamba/envs/colmap/bin/colmap` |
| Brush | `BRUSH_BIN` | `brush-cli` | `~/brush/target/release/brush-cli` |
| Spirula | `SPIRULA_BIN` | `spirula` | `~/opt/spirula/spirula`, `~/.local/bin/spirula`, `/usr/local/bin/spirula` |
| Panoptic interpreter | `PANOPTIC_PYTHON` | — | `~/.venvs/panoptic/bin/python` |
| Panoptic checkout | `PANOPTIC_DIR` | — | `~/panoptic` |
| splat_analyzer interpreter | `SPLAT_DETECT_PYTHON` | — | `~/.venvs/splat-analyzer/bin/python` |
| splat_analyzer checkout | `SPLAT_DETECT_DIR` | — | `~/splat_analyzer` |
| LingBot-Map interpreter (the floor-plan job runs on it too, needing only its numpy) | `LINGBOT_MAP_PYTHON` | `python3` | — |
| LingBot-Map checkpoint | `LINGBOT_MAP_MODEL_PATH` | — | — |
| splat-finish's Node | `SPLAT_FINISH_NODE` | `node` | — |
| splat-transform CLI | `SPLAT_TRANSFORM_CLI` | — | the repository's `node_modules/@playcanvas/splat-transform/bin/cli.mjs` |
| SenseNova shell | `SENSENOVA_BASH` | `bash` | — |
| SenseNova checkout | `SENSENOVA_DIR` | — | — |
| SenseNova model | `SENSENOVA_MODEL_PATH` | — | — |
| PhysAg3D interpreter | `PHYSAG3D_PYTHON` | `python3` | — |
| PhysAg3D checkout | `PHYSAG3D_DIR` | — | — |
| PhysAg3D config | `PHYSAG3D_CONFIG` | — | — |

ffmpeg has **no** env var on purpose. `scripts/ingest-video.mjs` spawns the bare name and
resolves it from `PATH`, so an override that only the capability report honoured would
describe a resolution the ingest path cannot make (ADR 0001: don't invent a second name for
something that already has one). If ffmpeg is installed and ingest still fails, restart the
server — it resolves ffmpeg from the `PATH` it started with, not the one in your shell.

## Known not to work

| | Why |
| --- | --- |
| Brush or Spirula on a CPU-only host | Both need a Vulkan (or Metal) device. |
| Spirula on macOS | Releases are `ubuntu-vulkan-x86_64`; no macOS build is referenced in this repo. |
| 4D person capture on this fleet | `person-4d-reconstruct` needs ~44 GiB on one CUDA device. It delegates off-box by design and reports `skipped` with a hint when unconfigured — ADR 0006, `docs/pipelines/4d-person.md`. |
| ffprobe missing while ffmpeg is present | `scripts/ingest-video.mjs` guards on ffmpeg and then calls ffprobe, so a single-binary install passes the guard and fails after it. The report gives them separate rows for this reason. |

## The same report over HTTP

`GET /capabilities` serves this report (`app.get('/capabilities', …)` in `server/main.ts`), and
`?format=text` returns the table the CLI prints. The answer is cached for 30 seconds
(`CAPABILITY_TTL_MS`), and concurrent misses share one probe. `?versions=0` is the cheap mode:
pure `stat` calls with no subprocesses, at the cost of the version strings and the torch
blocks. `?fresh=1` skips the cache, for the "I just installed it" case. With sign-in on, or
`SCAN_REQUIRE_AUTH=1`, the route needs a Companion session like the other data routes
(`SESSION_GUARDED_PATHS`). `GET /health` is separate and reports the inference engine.

Beside the tool rows the report has three service rows: `fdanyone-host` (a `GET /health` to the
4D host, with `FDANYONE_TOKEN`), `companion-memory` (configured or not; no request is made) and
`inference-engine` (Ollama is asked `GET /api/tags`; `onnx` needs its model folder; `mock` is
always found), and a ready or blocked verdict for each pipeline. The service rows' requests are
made only with versions on and network permission. With `?versions=0`, or from the CLI without
`--allow-net` (as in the commands at the top of this page), an Ollama row with `OLLAMA_HOST`
unset reads not found, and the capture verdict that depends on it reads blocked.

## Related

- ADR 0007 — the toolchain survey this doc grew out of, including the end-to-end timings.
- ADR 0006 — why 4D person capture is a subsystem rather than a local job.
- `docs/operations/AR_DEVICE_SUPPORT.md` — the same treatment for phones: which devices can run
  the live scanner, measured from the phone's own remote console.
- `docs/operations/COLMAP_SETUP.md` — the micromamba install that `which colmap` cannot see.
- `docs/pipelines/splat-train.md` — Brush and Spirula setup.
