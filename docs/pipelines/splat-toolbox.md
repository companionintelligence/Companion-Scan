# Splat toolbox

The **Splat Toolbox** is the set of tools that turn a Companion-Scan capture
session into a viewable, trainable, and queryable 3D Gaussian-splat scene. Each
tool is a thin Node driver over a proven external engine, wired into the
Companion Scan Spatial Editor as a job type (or exposed as a script). This document is the
inventory: what each tool is, when you reach for it, and how to drive it from
the **editor UI**, from a **scanner/session**, and from **curl**.

All the trained/derived artifacts land next to the scan in `SCANS_DIR` as
sidecars (`<base>.splat.ply`, `<base>.splat-train.manifest.json`,
`<base>.interactions.json`, `<base>.splat-detect.manifest.json`,
`<base>.splat-align.manifest.json`, the floor plan's `<base>.floor-plan.*`),
and are served back through the
`/scans/:filename` routes the Spatial Editor already understands. Pose-solving
outputs are the exception — they belong to the *session*, not the scan, and
stay in `scans/sessions/<id>/`.

> **A splat is unitless until `splat-align` says otherwise.** Monocular SfM
> recovers geometry only up to an unknown scale factor, so nothing between
> **Solve poses** and **Finish** produces a measurement. Real-world dimensions
> come from the **Align** stage alone, and only for a calibrated scan.

---

## Tools at a glance

| Tool | Engine | Job type / entry point | Produces |
|------|--------|------------------------|----------|
| **View** | SparkJS (`@sparkjsdev/spark`) | viewer splat layer | in-browser 3DGS render |
| **Solve poses** | [COLMAP](https://colmap.github.io/) (CPU) | `colmap-poses` world job (auto-chained *before* train) | `colmap.poses.json` + `colmap.point-cloud.ply` (+ manifest) |
| **Train** | [Brush](https://github.com/ArthurBrussee/brush) (wgpu) | `splat-train` world job | `<base>.splat.ply` (+ manifest) |
| **Finish** | [@playcanvas/splat-transform](https://github.com/playcanvas/splat-transform) | `splat-finish` world job (auto-chained after train) | `<base>.sog` + `<base>.compressed.ply` (+ manifest) |
| **Align** | Umeyama 7-DoF similarity fit (pure TS) | `splat-align` world job (**queued explicitly**) | `<base>.splat-align.manifest.json` — the metric scale |
| **Detect** | [splat_analyzer](#detect--splat_analyzer) + OWLv2 | `splat-detect` world job | `<base>.interactions.json` (+ manifest) |
| **Floor plan** | [`scripts/floor_plan_worker.py`](#floor-plan--walls-and-area-from-a-lingbot-map-cloud-cpu) (numpy, CPU) | `floor-plan` world job (auto-chained after `lingbot-map-reconstruct`) | `<base>.floor-plan.json` + `.svg` (+ manifest), fitted to the capture's AR poses: metres when they were |
| **Ingest video** | ffmpeg (+ adaptive fps + blur gate) | `scripts/ingest-video.mjs` / `POST /ingest-video` | keyframe session (pose-less) |
| **Ingest photos** | sharp/jimp (+ EXIF ordering + blur gate) | `scripts/ingest-photos.mjs` / `POST /ingest-photos` | keyframe session(s) (pose-less) |

### GPU placement (the multi-GPU AMD host, 2× RX 7900 XTX)

Placement differs by engine, and **the HIP device numbering is inverted vs
`rocm-smi`** — do not trust the index you read off `rocm-smi` for the pin:

| Engine | Pin env | Value on this box |
|--------|---------|-------------------|
| Brush (train / compress) | `CUBECL_WGPU_DEFAULT_DEVICE` | wgpu adapter index |
| splat_analyzer torch/HIP (detect) | `HIP_VISIBLE_DEVICES` | `1` on this host. Unset is no pin (the default since wave 14): set it here |

Unpinned Ollama has OOM'd torch jobs; keep the pins explicit when running detect
alongside a warm model.

---

## View — SparkJS

**What:** renders a trained `<base>.splat.ply` in the Spatial Editor as a
**Trained Splat** layer under the owning scan, using SparkJS's `SplatMesh`.

**When:** any time a scan has a `splat-train` manifest with `status: ok`.

**How**
- **Editor:** open the scan; the splat layer auto-discovers the manifest and
  loads the served `.ply` (`src/viewer/splat-layer.ts` → `splat-viewer.ts`).
- **curl:** `curl $BASE/scans/<base>.splat-train.manifest.json` to confirm a
  splat exists, then `GET /scans/<base>.splat.ply` for the geometry.

See `splat-train.md` for the full viewer wiring.

---

## Solve poses — COLMAP

**What:** CPU structure-from-motion. Feature-extract → exhaustive match → a
two-pass mapper, writing `colmap.poses.json` and a sparse seed cloud into the
session dir in the same format LingBot-Map uses, so `buildBrushDataset` reads
either provider through one path (ADR 0001). The emitted model is
gravity-aligned to world +Y up, because SfM carries no gravity reference.

**When:** the session has no per-frame poses — every `photo-ingest` and
video-ingest session. `splat-train` runs it automatically in that case, so
normally you never queue it by hand.

**How**
- **Auto:** any `splat-train` on a pose-less session (`SPLAT_TRAIN_AUTO_POSES=0`
  to opt out and have the "no camera poses" failure surfaced instead).
- **curl:** `-d '{"type":"colmap-poses","scanId":"scan-<id>"}'`

**Env:** `COLMAP_BIN` (default `colmap` on PATH), `COLMAP_FEATURE_TYPE`,
`COLMAP_MATCHER_TYPE`, `COLMAP_MAX_IMAGE_SIZE`. A missing binary → a `skipped`
manifest with a remediation. Full detail, including the two-layout gotcha and
the rotation-only-capture diagnosis, in
**[colmap-poses.md](colmap-poses.md)**.

---

## Train — Brush

**What:** converts a scan's keyframe session into a Nerfstudio dataset and spawns
the Brush CLI to train an INRIA-format 3DGS `.ply`, landed as a scan sidecar.

**When:** a scan has a finalized session with keyframes. Poses are no longer a
precondition you have to satisfy yourself: a live AR session carries
per-keyframe poses, and for a pose-less one `splat-train` auto-chains
`colmap-poses` (CPU) before giving up. `splat_train_dataset.ts` looks for
`colmap.poses.json` first and `lingbot-map.poses.json` second — COLMAP leads
because it is the solver that can actually have run on an arbitrary host, and
when both exist it is the model with a measured reprojection error behind it.

**How**
- **Editor:** Splat Toolbox → **Train splat** on the selected scan (enqueues a
  `splat-train` world job).
- **Session:** an ingest session's poses are solved first — by the auto-chained
  `colmap-poses` job, or by `lingbot-map-reconstruct` where that GPU worker is
  installed; then `splat-train` consumes either via `splat_train_dataset.ts`.
- **curl:**
  ```sh
  curl -X POST $BASE/worlds/default/jobs \
    -H 'authorization: Bearer <editor-token>' \
    -H 'content-type: application/json' \
    -d '{"type":"splat-train","scanId":"scan-<id>"}'
  ```

**Env:** `BRUSH_BIN` (then `brush-cli` on PATH, then `~/brush/target/release/brush-cli`). Missing
binary → a `skipped` manifest with a remediation hint, never a crash. Full
env/params table in `splat-train.md`.

**Building Brush bites twice** — `rustc` must be **1.95 or newer**
(burn/cubecl/rerun refuse to compile below it), and the build flag is
`cargo build --release -p brush-cli`, **not** `--bin brush-cli`. The workspace's
`default-members` scopes `--bin` to a different package, and the resulting
error is actively misleading: it says there is no bin target named `brush-cli`
while listing `brush-cli` as an available bin. Full setup in
[splat-train.md](splat-train.md#setup-one-time-on-the-inference-box).

Invariants preserved by the dataset converter: Nerfstudio `camera_model` is
**PERSPECTIVE**, and poses are emitted as OpenGL camera-to-world with **no extra
axis flip** (LingBot's `cameraToWorld` is treated as OpenCV world-to-camera and
converted).

---

## Detect — splat_analyzer

**What:** runs open-vocabulary 3D object detection over a splat. The driver
(`server/splat/splat_detect.ts`) spawns `splat_analyzer/run_local.py`, which renders the
splat, runs **OWLv2** open-vocab detection on the renders, lifts the 2D boxes
into 3D, and writes `interactions.json`. The driver copies that next to the scan
and writes a `splat-detect` manifest.

**When:** a scan has a trained `<base>.splat.ply` (preferred), **or** a session
point cloud (`lingbot-map.point-cloud.ply`) that the driver first converts to a
3DGS-attribute PLY via `pointcloud_to_gs.py`. So you can detect even before a
full Brush train has run.

**Tuning:** camera coverage (`SPLAT_DETECT_QUALITY` low/medium/high) and the
clustering knobs (`SPLAT_DETECT_MIN_VOTES` / `_SCORE_THRESHOLD` / `_MIN_PEAK_SCORE`,
or per-job payload `quality`/`minVotes`/`scoreThreshold`/`minPeakScore`) decide
detection quality far more than the pipeline does. They ship **uncalibrated** —
run `npm run tune:detect -- <room>.splat.ply` against a real trained room splat to
pick values, then set the env. See **[SPLAT_DETECT_ROADMAP.md](SPLAT_DETECT_ROADMAP.md)**
for the calibration runbook and the plan to surface detections in the AR scanner.

**How**
- **Editor:** Splat Toolbox → **Detect objects**; optional prompt override.
- **curl:**
  ```sh
  curl -X POST $BASE/worlds/default/jobs \
    -H 'authorization: Bearer <editor-token>' \
    -H 'content-type: application/json' \
    -d '{"type":"splat-detect","scanId":"scan-<id>","payload":{"prompt":"sofa, chair, table, tv"}}'
  ```

**Prompt:** optional per-job; defaults to env `SPLAT_DETECT_PROMPT`
(`sofa, chair, table, tv, lamp, plant, bed, desk, shelf, door, window`).

**Env:** `SPLAT_DETECT_PYTHON` (default `~/.venvs/splat-analyzer/bin/python`),
`SPLAT_DETECT_DIR` (default `~/splat_analyzer`), `HIP_VISIBLE_DEVICES` (default
unset: no pin, so torch takes its first device; it used to default to `1`, the second GPU of
one host), `POINT_SPLAT_SIZE` (default `6`), `SPLAT_DETECT_QUALITY` (default `medium`, 90
views; `low` is 24). A missing python/dir → a `skipped`
manifest; an analyzer crash or a run with no `interactions.json` → an `error`
manifest carrying a stderr tail.

---

## Ingest video — ffmpeg

**What:** "walk the house shooting normal video, upload it, get a 3D map." Splits
an ordinary phone video into scaled JPEG keyframes and lays them down as a
capture session the rest of the pipeline understands. The records carry **no
pose** — poses come later from `lingbot-map-reconstruct`.

Two quality gates run automatically:

- **Adaptive fps** — with no explicit `--fps`, the sample rate adapts to the
  clip length (`ffprobe` duration): `max(2, ceil(40 / seconds))`, capped at 10.
  Short clips still yield ≥40 frames of parallax; long walkthroughs keep the
  economical 2fps. An explicit `--fps` (or the route's `fps` field) always wins.
- **Blur gate** — each extracted frame's sharpness (variance of the 3x3
  Laplacian on downscaled grayscale, `scripts/ingest-quality.mjs`) is measured
  and frames under `--min-sharpness` (default 60, env `INGEST_MIN_SHARPNESS`,
  0 disables) are dropped. Survivors are re-indexed so `kf-NNNNN.jpg` stays
  contiguous; the count lands in `session.json` as `droppedBlurry`. If the gate
  would drop *every* frame, it keeps them all instead.

**When:** you have a video instead of a live AR scan, or you want a
non-interactive capture path.

**How**
- **Scanner:** the scanner's **Upload video** control posts to `/ingest-video`.
- **Script (box-side):**
  ```sh
  node scripts/ingest-video.mjs <video.mp4> --scans-dir <isolated-dir>
  ```
  Last stdout line is JSON `{ sessionId, frameCount, sessionDir, droppedBlurry, fps }`.
- **curl:**
  ```sh
  curl -X POST $BASE/ingest-video \
    -F video=@floor1.mp4 -F name='Downstairs'
  # → 202 { sessionId, scanId, jobId, frameCount }
  ```
  The route registers a `scan-<sessionId>` in the `default` world and
  auto-enqueues a `lingbot-map-reconstruct` job. Uploads over
  `INGEST_MAX_VIDEO_BYTES` (default 1.5 GB) get a `413`.

---

## Ingest photos — sharp/jimp

**What:** "shot a burst of stills around the room / found a folder of house
photos." Orders a photo set by capture time (EXIF `DateTimeOriginal`, file
mtime fallback — noted as `timesFrom` in `session.json`), drops blurry shots
with the same blur gate as the video arm, scales to the same long-edge cap,
and lays the survivors down as a pose-less keyframe session
(`source: 'photo-ingest'`). The CLI additionally **clusters by capture-time
gap** (default: a gap > 2h starts a new session — archive folders often hold
several visits); the server route always ingests one upload as one session.

**How**
- **Script (box-side, clustering on):**
  ```sh
  node scripts/ingest-photos.mjs <photos-dir> --scans-dir <isolated-dir> \
    [--cluster-gap-hours 2] [--min-sharpness 60]
  ```
  Last stdout line is JSON `{ sessionId, frameCount, sessionDir, droppedBlurry,
  timesFrom, sessions: [...] }`.
- **curl:**
  ```sh
  curl -X POST $BASE/ingest-photos \
    -F name='Kitchen stills' \
    -F files=@img_0001.jpg -F files=@img_0002.jpg -F files=@img_0003.jpg
  # → 202 { sessionId, scanId, jobId, frameCount, droppedBlurry }
  ```
  The route registers a `scan-<sessionId>` in the `default` world and
  auto-enqueues a `lingbot-map-reconstruct` job, exactly like `/ingest-video`.
  Uploads over `INGEST_MAX_PHOTOS_BYTES` (default `1500000000`: the 1000-photo count cap at 1.5 MB a photo) get a `413`.

---

## Finish — splat-transform (SOG + compressed PLY)

**What:** the post-processing Stage 4. `server/splat/splat_finish.ts` spawns the
[@playcanvas/splat-transform](https://github.com/playcanvas/splat-transform)
CLI (an npm devDependency, run via node) on a scan's trained
`<base>.splat.ply` to produce the two web-delivery artifacts plus a manifest:

- `<base>.sog` — super-compressed SOG bundle (ONE ZIP file holding `meta.json`
  + WebP attribute textures). ~8x smaller than the raw PLY (12.6% on the
  verify fixture); SparkJS loads it natively.
- `<base>.compressed.ply` — SuperSplat compressed PLY, ~4x smaller (26.5% on
  the fixture); loads through Spark's standard PLY path.
- `<base>.splat-finish.manifest.json` — status, `sizes`
  (`inputBytes`/`sogBytes`/`compressedBytes`), timing.

The viewer's splat layer **prefers the finished artifacts** (`.sog`, then
`.compressed.ply`) and gracefully falls back to the raw `.splat.ply`; the Splat
Toolbox shows the compressed sizes and a **Download .sog** link next to the
existing Download .ply.

**When:** automatically — every successful `splat-train` auto-enqueues a
`splat-finish` for the same scan (kill switch: `SPLAT_FINISH_AUTO=0`). Or
manually re-run it after tuning, via the job queue.

**How**
- **Editor:** Processing Queue → **Splat finish (compress)**.
- **curl:**
  ```sh
  curl -X POST $BASE/worlds/default/jobs \
    -H 'authorization: Bearer <editor-token>' \
    -H 'content-type: application/json' \
    -d '{"type":"splat-finish","scanId":"scan-<id>"}'
  ```
- **CLI (box-side smoke):**
  ```sh
  node node_modules/@playcanvas/splat-transform/bin/cli.mjs -w -g cpu \
    <base>.splat.ply <base>.sog
  node node_modules/@playcanvas/splat-transform/bin/cli.mjs -w \
    <base>.splat.ply <base>.compressed.ply
  ```

**Env:** `SPLAT_FINISH_AUTO` (default on; `0` disables the auto-chain),
`SPLAT_FINISH_GPU` (default `cpu`; a WebGPU adapter index from `-L` — dawn/
Vulkan numbering, NOT a HIP id), `SPLAT_FINISH_SH_ITERS` (k-means iterations,
default 10), `SPLAT_TRANSFORM_CLI` (override the cli.mjs path),
`SPLAT_FINISH_NODE` (default `node` on PATH). A missing input splat, CLI or
node → a `skipped` manifest with a remediation (a missing node used to fail the
job); a CLI crash or a run with no output → an `error` manifest carrying the
stderr tail. `GET /capabilities` reports node and the CLI as the
`splat-finish-node` and `splat-transform-cli` rows.

---

## Align — Umeyama similarity fit

**What:** the only stage that puts metres into a splat.
`server/splat/splat_align.ts` fits a 7-DoF similarity (rotation, translation,
uniform scale) between the SfM camera centres and the *same* cameras expressed
in the Place's metric frame, and writes
`<base>.splat-align.manifest.json` carrying a row-major `projectTransform`,
the `scale`, the RMS `residualM`, and the `calibrationMethod` behind it.

**When:** on a scan whose `ScanCalibration` has a real measured tier. The fit
itself needs only solved poses plus that calibration — it never reads the
`.ply` — so it can run before or after training; the manifest is simply named
after the splat it describes. **It is not auto-chained**: unlike
`splat-finish`, you queue it.

**How**
- **curl:** `-d '{"type":"splat-align","scanId":"scan-<id>"}'`

**It refuses rather than guesses.** An uncalibrated scan, a missing pose solve,
fewer than 4 paired cameras, a straight-line capture, a non-positive scale, or
a residual over 0.25 m all produce a `skipped` manifest with a remediation. A
wrong scale is worse than no scale — it makes every downstream distance wrong
while looking fine.

**Env:** none. Thresholds are exported constants in `splat_align.ts`.

> **Unverified end to end.** The fit and every refusal path are unit-tested,
> but no run against a real calibrated capture is recorded. See
> **[splat-align.md](splat-align.md)**.

---

## Floor plan — walls and area from a LingBot-Map cloud (CPU)

**What:** a 2D plan of the room: its walls, an outline and the outline's
area. `server/floor_plan.ts` runs `scripts/floor_plan_worker.py` (the standard
library and numpy: no torch, no GPU) on the session's
`lingbot-map.point-cloud.ply`, with the interpreter `LINGBOT_MAP_PYTHON` names:

0. first, the fit: the cloud is carried into the capture's own AR session
   frame (metric when the runtime is, and Y up), by the similarity that maps
   LingBot-Map's camera poses (`lingbot-map.poses.json`) onto the same
   keyframes' AR poses (`keyframes.jsonl`), paired by file name
   (`fitCloudToSession`). The rotation comes from the cameras' orientations,
   so a capture walked in a straight line still fixes it; the scale and the
   offset come from their centres,
1. a height histogram along that frame's Y → floor and ceiling heights,
2. the wall band (floor + 0.4 to ceiling − 0.3) rasterised into a 2 cm
   occupancy grid (wider cells past 4096 a side),
3. a morphological clean-up, then seeded-RANSAC line fits → wall segments,
   snapped to the dominant frame when within about 7°,
4. an outline: a rectangle from the outermost snapped walls, else the convex
   hull of the wall cells → area, perimeter, ceiling height.

The plan is drawn looking down, right-handed (x to the right, −z up the page),
so it is the room seen from above and not its mirror image.

> **Metres when the capture measured them.** A LingBot-Map reconstruction is
> in its own frame and units, so the fit above is what gives the plan a scale
> and an up axis, and the worker's thresholds (the 2 cm grid, the band
> margins, the 0.5 shortest wall) their meaning. One unit of the result is one
> unit of the capture's AR session, which the scan's `scaleKind` describes:
> `metric` (WebXR, ARCore, ARKit) gives `units: "m"`, `estimated-metric`
> (8th Wall absolute scale) gives `"m-estimated"`, and `arbitrary` or no
> record gives `"session"`, whose numbers are not known to be metres. The
> drawing's labels say "m" only for the first two. Derived, not survey-grade,
> either way: every file says so in its `disclaimer`.
>
> A capture with no AR poses (a photo or video ingest) has nothing to fit to,
> so its floor plan is a `skipped` job that says why, rather than a plan drawn
> on a guess. So is one whose poses the cloud does not fit: fewer than four
> keyframes posed by both, cameras that did not move, orientations more than
> 10° RMS apart, or centres more than 0.25 (in the session's units) RMS apart
> after the fit, the line splat-align uses.

Deterministic (a fixed RNG seed, no timestamps in the outputs). On a synthetic
4 × 3 box room of 3.65 million points it took 0.6 s on a development machine;
PR #273 reported about 4 s on a 3.65-million-point garden capture, which it
called a degenerate outdoor scene (32 walls, closed by convex hull). On
synthetic captures whose LingBot frame is shrunk to 0.3 and tilted 35°, the
4 × 3 m room comes out at 11.9 m² and a 1.2 × 6 m hallway at 7.1 m², both with a
2.5 m ceiling. The files land beside the scan, and go with it when it is
deleted:

- `<base>.floor-plan.json`: `walls: [{x1, y1, x2, y2, lengthM}]`,
  `rooms: [{polygon, areaM2, method}]`, `floorZ`/`ceilingZ`/`ceilingHeightM`,
  `areaM2`, `perimeterM`, `wallCount`, `gridCellM`, `upAxis`, `units`,
  `frame` (`scan`: the AR session frame) and `disclaimer`.
- `<base>.floor-plan.svg`: the plan drawn: walls, a mint room fill, the
  longest walls' lengths, a grid and a scale bar of one metre (or one unit),
  a north-arrow placeholder (the plan is not geo-referenced) and the
  disclaimer. Served under a policy that lets it run nothing.
- `<base>.floor-plan.manifest.json`: `status` (`ok`/`skipped`/`error`),
  `areaM2`, `wallCount`, `roomCount`, `ceilingHeightM`, `disclaimer`, `units`,
  `frame`, `alignment` (paired keyframes, scale, the two residuals), params
  and timing (`FloorPlanManifest`, `src/world/manifests.ts`). This is what the
  editor and report tooling read.

**In the editor:** Layers → **Floor plan** shows the selected scan's numbers,
with their unit, the drawing, **Download SVG** and **Download JSON**, and
**Generate floor plan**, which queues the job. It is a section of the Layers
tab, not a scene layer: nothing draws the plan in the 3D scene yet, so it adds
no Scene layers row and no View menu switch.

**When:** automatically after every successful `lingbot-map-reconstruct` of
the scan (kill switch: `FLOORPLAN_AUTO=0`), from the editor, or through the
jobs API.

**How**
- **Editor:** Layers → Floor plan → **Generate floor plan**.
- **curl:**
  ```sh
  curl -X POST $BASE/worlds/default/jobs \
    -H 'authorization: Bearer <editor-token>' \
    -H 'content-type: application/json' \
    -d '{"type":"floor-plan","scanId":"scan-<id>","payload":{"minWallM":0.5}}'
  ```
- **CLI (box-side smoke):** without `--transform` the worker draws the cloud in
  its own frame and units, guessing the up axis as the narrowest extent (a
  hallway defeats that guess); the job always passes the fit.
  ```sh
  "${LINGBOT_MAP_PYTHON:-python3}" scripts/floor_plan_worker.py \
    --ply scans/sessions/<sess>/lingbot-map.point-cloud.ply \
    --out-json plan.json --out-svg plan.svg
  ```

**Env:** `LINGBOT_MAP_PYTHON` (the interpreter; it needs numpy, which the
LingBot-Map venv has), `FLOORPLAN_AUTO` (default on; `0` stops the chain),
`FLOORPLAN_MIN_WALL_M` (shorter segments are dropped, in the plan's units,
default 0.5; a job's `payload.minWallM` wins), `FLOORPLAN_WORKER` (another copy
of the script), `FLOORPLAN_TIMEOUT_MS` (default 600000). No cloud, a cloud its
LingBot run judged degenerate, a capture the cloud cannot be fitted to, an
interpreter that is not found, a missing worker or an interpreter without
numpy → a `skipped` manifest with the fix; a worker crash, a timeout or a run
that wrote no plan → an `error` manifest with the stderr tail. A failed run
leaves the plan files already there; its manifest records the failure, as
splat-detect's does. `GET /capabilities` lists the stage as `floor-plan`, on
the `lingbot-map-python` row.

**Limits:** one outline per scan; a capture with no AR poses gets no plan; the
units are metres only when the capture's AR runtime measured in metres; the
north arrow is a placeholder; the fit and the plan have run on synthetic
captures only, not on a real LingBot-Map cloud.

---

## Further reading / candidate tools

Curated from the [awesome-3D-gaussian-splatting](https://github.com/MrNeRF/awesome-3D-gaussian-splatting)
index (which now fans out to an external paper database) against our specific
roadmap gaps. Verify current status before adopting; these are directions, not
dependencies.

**Compression (shrink the splat we ship to the viewer):**
- **Self-Organizing Gaussians (SOG)** — ✅ landed as the `splat-finish` job
  above (splat-transform's SOG writer); the viewer already prefers the `.sog`.
- **SPZ (Niantic)** — a compact binary splat container; splat-transform can
  also write `.spz`, so adding it to `server/splat/splat_finish.ts` is a one-liner if a
  consumer wants that format.

**Meshing from splats (the GLTF export leg):**
- **2D Gaussian Splatting (2DGS)** — flattens 3D Gaussians to oriented disks,
  giving far cleaner surfaces to extract a mesh from than vanilla 3DGS; the
  natural front-end for a splat→GLTF path.
- **SuGaR** — binds Gaussians to a surface and extracts a mesh via Poisson
  reconstruction; a candidate for turning a room splat into the GLTF the editor
  already renders.

**SLAM-coupled / pose-free 3DGS (skip the separate pose-solve step):**
- **MonoGS / Gaussian Splatting SLAM** — monocular SLAM that builds the splat and
  the trajectory jointly; could replace the two-stage ingest→solve→train
  for the video arm.
- **COLMAP-Free 3DGS (CF-3DGS)** — trains without precomputed poses. Less urgent
  now that `colmap-poses` gives pose-less sessions a CPU solver, but it would
  still collapse two stages into one. Note that neither of these recovers
  scale either — pose-free is not metric.

**Splat segmentation / language-embedded (richer than box detection):**
- **LangSplat** — embeds CLIP language features per Gaussian for open-vocab 3D
  queries; a step beyond OWLv2 boxes toward "select the sofa" in the splat.
- **Gaussian Grouping** — segments and edits the splat by object identity; useful
  for per-object layers in the editor instead of flat interaction boxes.
