# 4D Capture

The off-box worker that turns a **take** — one or more clips of a person, recorded by
Companion Scan — into a playable 4D Gaussian-splat sequence.

It runs [4DAnyone](https://github.com/ant-research/4DAnyone) when a take has only one clip,
skips it when the take has real cameras, and trains one splat per timestep either way.

```
GET  /health                        liveness, and whether this is stub mode
POST /takes                         submit a take (idempotent on takeId)
GET  /takes/:takeId                 status: running | ok | skipped | error
GET  /takes/:takeId/sequence        the finished frame list
GET  /takes/:takeId/frames/:frame   one trained timestep, frame-NNNNN.(sog|ply)
```

Submitting a take that is running or finished re-attaches to it. A take that ended `error` or
`skipped` can be submitted again, which is how a fixed install gets a second try.

## What a take does

1. **Download.** Each clip's `url` and `poseTrackUrl` are fetched from the appliance with
   `Authorization: Bearer <FDANYONE_TOKEN>`. The clip comes in Range requests, following
   `Content-Range` to the end (the appliance sends at most 8 MiB per 206), streamed to disk.
2. **Path.** Two or more clips with a measured sync, a pose track and a session-to-Place matrix
   (`localToWorld`) are a multi-camera take, and 4DAnyone is skipped. Anything else densifies
   the best single clip. The reason is recorded either way (`pathReason`, `degraded`).
3. **Frames.** Timesteps are sliced at `timestepFps` across the span every view covers, and
   ffmpeg extracts one frame per view per timestep.
4. **Place.** A real camera's pose is its pose track sampled at that timestep (the phone
   moves), carried into the Place frame by `localToWorld`; its lens is the pose track's
   intrinsics. A densified view's pose and lens are 4DAnyone's `cameras.json` (or its
   `metadata.json`). Intrinsics are scaled to the pixels that landed. A view that cannot be
   placed is left out, and never trained at an identity pose or an assumed lens.
5. **Train.** Brush trains each timestep, and its export is renamed `frame-NNNNN.ply`, the
   names `/sequence` lists and `/frames` serves.

The clip's length comes from the pose track's `durationMs`, then ffprobe on the downloaded
clip, then the `durationMs` the appliance sent.

## Access

With `FDANYONE_TOKEN` set, every route needs `Authorization: Bearer <FDANYONE_TOKEN>`
(compared in constant time), and the same token is sent when fetching clips. Set the same
value on the appliance, which sends it on every request and admits it on its clip and
pose-track routes.

**Defaults kept on purpose** (owner decision, wave 14): unset, the routes stay open, and
unset `LISTEN_HOST` binds every interface, as before. That keeps `npm run stub` plus
`FDANYONE_HOST=http://localhost:9040` working with no setup. The service warns at start when no
token is set. On a shared network, set both.

## Confidence levels

Read this before trusting anything below.

| Part | Status |
| --- | --- |
| The service: routes, token check, take-id validation, idempotent submit, retry after error | **Verified** by `npm test` (`test/service.test.mjs`) |
| Download with the token, following Content-Range | **Verified** against the appliance's own range helper, in `tests/unit/deno/wp-runners-4d-e2e.test.ts` |
| A whole take, appliance → service → frames back, with ffmpeg, 4DAnyone and Brush stood in by scripts that write what they write | **Verified** in the same Deno test, and with fakes in `test/pipeline.test.mjs` |
| Pose sampling, the session-to-Place transform, intrinsics scaling | **Verified** by `npm test` (`test/pose.test.mjs`), and `poseToMatrix` is held equal to the appliance's |
| Frame-set slicing from clips | **Verified** against synthetic inputs |
| Stub mode | **Verified** — produces a real, loadable `.ply` sequence |
| 4DAnyone invocation and its output layout (`cameras.json`, `videos/dense/`) | **Unverified against the real model.** Written against its documented CLI. Three camera shapes are read (a 4x4 or flat-16 camera-to-world, or position + rotation, with fx/fy or a vertical fov); anything else fails the take by name |
| Brush per-timestep training | **Unverified in this context.** The flags are the ones `brush-cli --help` lists and the appliance's splat-train passes, which *are* proven — but not at sequence scale |
| End-to-end on real hardware | **Never run.** See below |

**Nothing here has executed a real 4DAnyone inference**, because no host on the fleet can.
That is a stated limitation, not an oversight: `npm run stub` exists precisely so the rest of
the pipeline — capture, upload, the job, playback — is real and testable regardless.

## Hardware requirements

4DAnyone's own measurements (`docs/inference_performance.md` upstream), 6-view full orbit:

| GPU | Backend | Denoising | Peak CUDA allocated |
| --- | --- | ---: | ---: |
| H200 | FlashAttention-3 | 7.8 min | 43.3 GiB |
| H20-3E | FlashAttention-3 | 16.6 min | 43.3 GiB |
| RTX A6000 | SDPA | 22.9 min | 43.3 GiB |

So: **a CUDA GPU with ≥44 GiB, on one device.** It does not shard across two cards, and it is
a CUDA stack (FlashAttention-3, GVHMR, ViTPose, SMPL-X). Upstream lists "Low-memory inference
(<32 GB)" as *not done*.

The fleet was probed on 2026-08-24: its largest cards are 24 GiB ROCm devices and a 10 GiB
CUDA card. **No host qualifies.** Add one, point `FDANYONE_HOST` at this service, and the
appliance's skip path becomes the real path with no other change.

## Licensing — read before deploying

The 4DAnyone *code* is Apache-2.0, but the shipped weights are mixed:

- **GVHMR** (`gvhmr_siga24_release.ckpt`) — a **mandatory** pipeline stage — is under a
  research/non-profit licence that **excludes commercial use**.
- **YOLOv8** (`yolov8x.pt`) is AGPL-3.0.
- **VGG-19** is CC BY 4.0 (attribution).

Companion Scan ships under a commercial licence. **This is unresolved**, and it is why the
model download is an explicit opt-in step rather than automatic on first run. Do not deploy
this into a commercial product without settling it. See ADR 0006.

## Setup

```bash
# 1. The service itself (no dependencies beyond Node ≥22)
cd subsystems/4d-capture && npm install

# 2. Stub mode — no GPU, no 4DAnyone, produces a real loadable sequence
npm run stub

# 3. Real mode: install 4DAnyone somewhere with a ≥44 GiB CUDA GPU
git clone https://github.com/ant-research/4DAnyone && cd 4DAnyone
conda create -n 4danyone python=3.11 -y && conda activate 4danyone
pip install -r requirements.txt
python scripts/download_smplx.py && python scripts/download_model.py   # see Licensing

# 4. Point the service at it and run
FDANYONE_DIR=~/4DAnyone \
FDANYONE_PYTHON=~/miniconda3/envs/4danyone/bin/python \
FDANYONE_TOKEN=<the same value as the appliance's> \
npm run serve
```

`npm test` runs this subsystem's tests. They need no GPU and none of the tools.

## Environment

Tools resolve the way the appliance's do (`docs/operations/PLATFORM_SUPPORT.md`): the env var
always wins and is only probed, then `PATH`, then the documented path. A missing tool makes the
take `skipped` with its fix, never `error`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `9040` | Listen port |
| `LISTEN_HOST` | unset (every interface) | Listen address, e.g. `127.0.0.1` or the tailnet address |
| `FDANYONE_TOKEN` | unset (routes open) | Shared secret: checked on every route, and sent when fetching clips |
| `FDANYONE_DIR` | unset | 4DAnyone checkout. Unset ⇒ a single-clip take reports `skipped`, never `error` |
| `FDANYONE_PYTHON` | `python3` on PATH | Interpreter for `inference.py` |
| `FFMPEG_BIN` | `ffmpeg` on PATH | Frame extraction |
| `FFPROBE_BIN` | `ffprobe` on PATH | Clip length, when the pose track has none |
| `BRUSH_BIN` | `brush-cli` on PATH, then `~/brush/target/release/brush-cli` | Per-timestep splat trainer — the appliance's own default |
| `BRUSH_DEVICE` | unset (no pin) | wgpu adapter pin, forwarded as `CUBECL_WGPU_DEFAULT_DEVICE` — **not** a HIP id. Set it only on a multi-GPU host, as on the appliance |
| `BRUSH_TRAIN_ITERS` | `3000` | Lower than the 15000 a static scan uses: this is multiplied by the timestep count |
| `WORK_DIR` | `./work` | Scratch and output |
| `STUB_MODE` | `0` | `1` (or `--stub`) produces a synthetic sequence with no GPU |

`BRUSH_BIN` and `BRUSH_DEVICE` used to default to a `src/` checkout path and to
`DiscreteGpu(1)`. Both now match the appliance's splat-train, which documents why a hard-coded
adapter pin selects nothing on most machines. The iteration count is the one deliberate
difference.

## How the appliance treats this service

A Companion Scan install with no `FDANYONE_HOST` set works exactly as it did before this
subsystem existed: person clips are captured and stored, and reconstruction reports that no
host is configured. An unreachable host, and any `skipped` take (a tool missing here), also
complete the appliance's job as skipped, with the hint. A failed run, a misconfigured
`FDANYONE_VIEWS_PER_LAYER`, a take with no clips, or a submit this service refuses (a wrong
token, HTTP 401) fails the job, with the reason — those are faults to fix, not a GPU host that
is absent.
