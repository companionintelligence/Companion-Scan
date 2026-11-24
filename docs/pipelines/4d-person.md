# 4D person capture

Turns a clip of **a person** into an animated Gaussian-splat sequence you can play in the
World Editor.

Structured like [`splat-train.md`](splat-train.md): architecture, files, environment
variables, setup.

---

## Architecture

```
CAPTURE (this app, no GPU)                PROCESS (off-box)                PLAY BACK (this app)
──────────────────────────                ─────────────────                ────────────────────
N phones in one take                      ┌───────────────────────┐
 • all calibrated to the same    ───────► │ 1 clip  → 4DAnyone    │ ─────►  splat4d layer
   two ground markers (ADR 0005)          │           (densify)   │         SparkJS SplatMesh
   ⇒ shared frame = extrinsics            │ N clips → skip it     │         sequence on a clock
 • measured clock offset ⇒ sync           │                       │
 • MediaRecorder 1080p 9:16 clip          │ ⇒ per-timestep posed  │
 • pose track sampled from AR             │   multi-view frames   │
                                          │ ⇒ Brush per timestep  │
                                          │ ⇒ frame-NNNNN.ply     │
                                          └───────────────────────┘
                                            subsystems/4d-capture/
```

**The organising idea: 4DAnyone is a view-densifier standing in for cameras you did not
have.** With N synchronised phones the real views already exist and it is skipped entirely.
Both paths converge on the same artifact — a per-timestep set of posed multi-view frames,
which is exactly the shape `server/splat/splat_train_dataset.ts` already builds for Brush.
See [ADR 0006](../adr/0006-person-capture-is-a-calibrated-take-and-densification-is-a-subsystem.md).

### Stages

| # | Stage | Where | Artifact |
| --- | --- | --- | --- |
| 1 | Record | phone | `clip.mp4`/`clip.webm` + `pose-track.json` |
| 2 | Upload | `POST /ingest-video` (`mode=person`) | durable clip in the session dir |
| 3 | Sync | `POST /takes/:id/sync` | `TakeSync` per member session |
| 4 | Download | subsystem, with `FDANYONE_TOKEN` | the clip (Range requests) and its pose track |
| 5 | Densify *(unless the take has placed cameras)* | subsystem → 4DAnyone | `cameras.json` + `videos/dense/*.mp4` |
| 6 | Frame sets | subsystem → ffmpeg | per-timestep posed multi-view frames |
| 7 | Train | subsystem → Brush ×N | `frame-NNNNN.ply` |
| 8 | Ingest | `person-4d-reconstruct` job | `<base>.4d-capture.manifest.json` |
| 9 | Play | World Editor | `splat4d` layer |

### What crosses the wire

`buildSubmitRequest` (`server/person4d/person_4d.ts`) sends each clip's `url`, `mimeType`,
`poseTrackUrl`, `sync` (the member's `TakeSync`, verbatim) and `clientId`, and, when the job
knows them, `durationMs` and `localToWorld` (the member scan's column-major session-to-Place
matrix). Both are `null` otherwise, never a guess.

The subsystem then:

- fetches the clip and pose track with `Authorization: Bearer <FDANYONE_TOKEN>`, the clip in
  Range requests that follow `Content-Range` (the clip route sends at most 8 MiB per 206);
- takes the length from the pose track's `durationMs`, then ffprobe, then `durationMs`;
- for a real camera, samples the pose track at each timestep (no axis flip) and maps it through
  `localToWorld`, with the pose track's intrinsics. Pose-track poses are in each phone's own
  session frame, so **a clip without `localToWorld` cannot be one of a multi-camera take's
  views**: such a take densifies its best clip and says so in `pathReason`;
- for a densified view, uses 4DAnyone's camera and lens;
- names each trained timestep `frame-NNNNN.ply`, numbered contiguously, which is what
  `/sequence`, `/frames`, the appliance's frame route and the viewer all expect.

`person-4d-reconstruct` in `server/main.ts` does not send `durationMs` or `localToWorld` yet,
so today every multi-clip take densifies. The single-clip path does not depend on either.

---

## Files

**Client**

| Path | Role |
| --- | --- |
| `src/capture/clip-recorder.ts` | `MediaRecorder` lifecycle, codec negotiation, camera teardown |
| `src/capture/clip-validation.ts` | 4DAnyone's input rules, checked on device |
| `src/capture/pose-track.ts` | timestamped pose sampling; `medianSpeedMps` |
| `src/capture/clock-sync.ts` | NTP-style offset estimation |
| `src/capture/clip-upload.ts` | XHR upload with progress |
| `src/viewer/splat4d-layer.ts` | windowed sequence loader |
| `src/viewer/playback-clock.ts` | wall-clock playhead |

**Server**

| Path | Role |
| --- | --- |
| `server/take_id.ts`, `src/shared/take-id.ts` | take vocabulary (two-file split, ADR 0002) |
| `server/world/rtc_rooms.ts` | N-member signalling rooms |
| `server/world/take_sync.ts` | offsets → inter-member residual |
| `server/http_range.ts` | the codebase's only ranged serving |
| `server/person4d/person_4d.ts` | the driver — submits, polls, ingests |

**Subsystem** — `subsystems/4d-capture/` (own `package.json`, outside both builds).

**Artifacts**

```
scans/sessions/<sessionId>/
  clip.mp4 | clip.webm        the durable artifact — NOT deleted
  pose-track.json
  session.json                gains takeId / clientId / sync / clipFile
scans/
  <base>.4d-capture.manifest.json
  <base>.4d/frame-00000.ply …     (.sog too, if a later stage converts them)
```

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `FDANYONE_HOST` | unset | The 4d-capture subsystem. **Unset ⇒ jobs report `skipped`, not failed** |
| `FDANYONE_TOKEN` | unset | The shared secret. The appliance sends it to the subsystem; the subsystem checks it on every route and sends it back when fetching clips and pose tracks, and the appliance admits exactly that token on those two routes when its session guard is on. Set the same value on both |
| `FDANYONE_VIEWS_PER_LAYER` | `6` | Synthesized views per orbit layer. **Must be divisible by 4 or 6** |
| `FDANYONE_TIMESTEP_FPS` | `5` | Timesteps per second. **Adopted, not measured** |
| `FDANYONE_POLL_MS` | `15000` | Status poll interval |
| `FDANYONE_MAX_WAIT_MS` | `2700000` | Hard stop (45 min), so a wedged subsystem cannot hold the pump forever |
| `FDANYONE_CALLBACK_BASE` | Tailscale name + `$PORT` | Base URL the subsystem fetches clips from |
| `INGEST_MAX_VIDEO_BYTES` | `1500000000` | Also bounds a person clip |

Subsystem-side variables (`LISTEN_HOST`, `FDANYONE_TOKEN`, `FFMPEG_BIN`, `FFPROBE_BIN`,
`BRUSH_BIN`, `BRUSH_DEVICE`, …) are documented in `subsystems/4d-capture/README.md`.

`GET /capabilities` reports the host as the `fdanyone-host` row: configured or not, and, when
probed with versions on, whether `/health` answered (with the token).

---

## Setup

```bash
# Without a GPU host — capture, upload, and playback all work; reconstruction reports skipped.
npm start

# With one: run the subsystem in stub mode to exercise the whole path, no GPU needed
cd subsystems/4d-capture && npm run stub          # listens on :9040

# Point the appliance at it
FDANYONE_HOST=http://localhost:9040 npm start

# Then, in the editor, queue a job for a person-capture scan:
#   POST /worlds/<slug>/jobs  {"type":"person-4d-reconstruct","scanId":"scan-…"}
```

For real inference see `subsystems/4d-capture/README.md` — it needs a CUDA GPU with **≥44 GiB
on one device**, which no host on the current fleet has.

---

## Operational properties

Four things worth knowing before running this in anger.

**A person job holds the global job slot.** The `WorldJobPump` is single-flight *across all
worlds* (ADR 0003) — "splat-train holds the box's one GPU regardless of which world asked".
A person job polls a remote subsystem for as long as that run takes, and during that window no
`optimize-scan` from any upload will run. There is no priority lane and no cancellation.
`FDANYONE_MAX_WAIT_MS` is the backstop.

**Clips accumulate.** A person clip is the durable artifact, and nothing in this repo prunes
session directories. A 1080p clip is orders of magnitude larger than the JPEG keyframes the
session layout was sized for, and a trained sequence adds one splat per timestep on top.
**Retention policy is unbuilt** — budget disk accordingly.

**Sequence length is the cost budget.** Total time ≈ timesteps × per-timestep train, and
timesteps = clip duration × `FDANYONE_TIMESTEP_FPS`. A 5s clip at 5fps is ~24 trains. Both
that rate and the subsystem's `BRUSH_TRAIN_ITERS` (defaulting far below a static scan's 15000)
are tunable, and both are **adopted rather than measured** — record the real numbers on the
first real run.

**Clips leave the appliance.** The subsystem fetches them over the tailnet from
`FDANYONE_CALLBACK_BASE`, with `FDANYONE_TOKEN`. Video of identifiable people going to a cloud
GPU is a different privacy posture from scanning an empty room; see ADR 0006. The subsystem's
routes are open and bind every interface unless `FDANYONE_TOKEN` and `LISTEN_HOST` are set
there (its README, "Access").

---

## Failure modes

Every stage follows the house contract: `ok` / `skipped` / `error`, always a manifest, and a
missing tool is a **green** job with a hint.

| Symptom | Meaning | Fix |
| --- | --- | --- |
| Job completes, "skipped: FDANYONE_HOST is not set" | No GPU host configured | Expected default. Set `FDANYONE_HOST` |
| Job completes, "skipped: subsystem unreachable" | Host set but not answering | Check the subsystem is running and reachable on the tailnet |
| Job fails, "divisible by 4 or 6" | Bad `FDANYONE_VIEWS_PER_LAYER` | Use 4, 6, 8, 12, 16, 24, 48 |
| Job fails, "did not finish within 45 min" | Subsystem wedged or genuinely slow | Check subsystem logs; raise `FDANYONE_MAX_WAIT_MS` |
| Job fails, "subsystem rejected the take (HTTP 401)" | The subsystem has `FDANYONE_TOKEN` and the appliance sent another, or none | Set the same `FDANYONE_TOKEN` on both |
| Job fails, "could not download clip 1: … set the same FDANYONE_TOKEN" | The appliance refused the subsystem's clip request | Same fix; the appliance admits the token only with its session guard on |
| Job completes, "skipped: ffmpeg not found" (or Brush, or the 4DAnyone python) | A tool is missing on the subsystem's host | Install it or set `FFMPEG_BIN` / `BRUSH_BIN` / `FDANYONE_PYTHON` there |
| Job fails, "cameras.json has no camera this pipeline can place" | 4DAnyone's camera format is not one the subsystem reads | See the subsystem README's confidence table; this part is unverified against the real model |
| Clip rejected on device: "record at least N s" | Below 4DAnyone's 121-frame floor | Record longer |
| Clip rejected: "hold the phone upright" | Landscape or non-9:16 | Portrait |
| Manifest has no `syncResidualMs` | Take was unsynced | Expected for a solo capture. **Not** an error, and never reported as `0` |
| `viewSource: 'densified'` on a multi-clip take | Members were not measurably synchronised, or had no pose track, or no `localToWorld` | `pathReason` says which. Until `person-4d-reconstruct` sends `localToWorld`, every multi-clip take lands here |
