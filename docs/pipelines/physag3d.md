# Interactive asset of a Thing (PhysAg3D)

The `thing-interactive-asset` job takes **one keyframe** of a scan and asks
[PhysAg3D](https://github.com/Supra-3D/PhysAg3D) to turn the Thing in it into a textured, physically interactive
3D asset: articulated parts and compliant regions, delivered as a refined GLB with a Blender file, a MuJoCo scene, a
motion video and a delivery report. The server lands the refined GLB and its own copy of the delivery report as the
job's artifacts.

It is optional, it is delegated, and it is never queued automatically. A run can take hours and **sends the image off
this box** (see [What leaves the box](#what-leaves-the-box)).

Driver: `server/physag3d/physag3d.ts`. File layout: `server/physag3d/asset_files.ts`. Runner:
`_runThingInteractiveAssetJob` in `server/main.ts`. It is a `WorldJob` like every other background task
([ADR 0003](../adr/0003-merged-job-system.md)); nothing here adds a queue.

### Limits to know before turning it on

None of these is enforced or worked around by the server. They are how it behaves.

- **A run holds the server's only job slot for hours.** The job queue runs one job at a time across every Place. A
  run lasts up to PhysAg3D's budget plus 15 minutes (three hours and a quarter by default), and every other job waits
  for it, including the `optimize-scan` that every upload queues. There is no cancel.
- **One job per scan at a time.** Deduplication is by scan: a second request for the same scan while one is queued or
  running gets that job back, whichever keyframe it names.
- **The server's deadline stops `execute.py`, not the worker.** PhysAg3D starts its agent worker in a session of its own,
  so the server's kill does not reach it: a worker can outlive its run and keep writing into its case folder. The job's
  error says so, and the case's `execution.json` names the worker's process to stop by hand.
- **The worker runs a shell as the server's user.** It is an agent with command access on the machine that runs the
  controller, which by default is the server, as the server's user: it can read what the server can read, including the
  scans, the worlds and the server's `.env`. Its instructions tell it to stay in its case folder, and that is all that
  does. Run the controller as a separate unprivileged user, or on another host. The server does not do this for you and
  does not check that it was done: `PHYSAG3D_PYTHON` is where a wrapper that switches user would go.

---

## Request

Only a request queues the job, through the job route, with the world's editor token:

```bash
POST /worlds/<slug>/jobs
{
  "type": "thing-interactive-asset",
  "scanId": "scan-…",
  "payload": { "keyframe": "kf-00012.jpg", "thingId": "thing-…" }
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `scanId` | yes | A scan in this Place whose capture session streamed keyframes |
| `payload.keyframe` | yes | The file name of one of that session's keyframes, `kf-NNNNN.jpg`, as `GET /sessions/:id/keyframes/:file` serves it |
| `payload.thingId` | no | A Thing in this Place. Recorded on the artifacts and used in their labels; it does not change what is sent |

**Why a keyframe.** It is the simplest image of a Thing the server holds as a file of its own, and the largest. A
detection's photo crop reaches the server only inside the scan's GLB, as a data URL of at most 256 px in a node's extras
(`src/export/gltf.ts`, `captureDetectionThumbnail`), and nothing on the server reads it out. Both names are shape-checked
the way the keyframe route checks them, so neither can name a path outside the session folder. A request that breaks a
rule fails when the job queue reaches it, with a message that says which rule.

There is no button in the editor. Like `person-4d-reconstruct`, it is reached through the API only.

---

## What happens

| Step | What runs | Model call | Deadline |
| --- | --- | --- | --- |
| 1 | `execute.py prepare --image <keyframe> --config <PHYSAG3D_CONFIG> --out <case folder>` copies the image and PhysAg3D's method files into a new case folder | no | 10 min |
| 2 | `execute.py plan <case folder>` prints the command step 3 will start; the server logs it | no | 10 min |
| 3 | `execute.py run <case folder>` checks the environment and the login, then starts the agent worker | **yes** | the case budget + 15 min |
| 4 | The server reads `execution.json` and `delivery.json`, lands the refined GLB and writes its report | no | — |

The case budget is PhysAg3D's own `max_case_active_seconds`, read from the case's `runtime.json` (prepare copies it from
the runtime config; 10800 s, three hours, when unset). PhysAg3D stops its worker at that budget and records
`controller_timeout`. The server's extra 15 minutes cover the checks `run` makes before the worker starts and the 30 s it
waits after stopping it, so PhysAg3D's own timeout always fires first.

**How the outcome is decided.** `run` exits 0 whatever its worker did, and PhysAg3D's README says a finished worker is
not a finished asset. So the job reads the `status` PhysAg3D's worker protocol defines in `delivery.json`, and nothing
else:

| `status` in delivery.json | Outcome | Job | Artifacts |
| --- | --- | --- | --- |
| `delivered` | complete | `completed` | input, GLB, report |
| `delivered_with_limitations`, `native_only` | partial | `completed` | input, GLB, report |
| `blocked`, `failed`, any other value, none | failed | `failed`, with the blocker when there is one | input, report |
| no `delivery.json` after the worker started | failed | `failed`, saying how the worker ended | input, report |
| PhysAg3D refused before the worker started | failed | `failed`, with PhysAg3D's own message | none |
| not configured | skipped | `completed`, with a hint | `interactive-asset-skip` |

A complete or partial delivery also needs a refined GLB the server can land; without one the job fails and says why.
A completed job's result carries `motion_kind`, `interaction_status` and `physics_status` verbatim, and so does the GLB
artifact, so a kinematic animation or an untested physics scene is never read as a simulated one.

---

## Files

```
scans/<scan>.interactive/        one folder per scan, beside it (like <scan>.4d/)
  <jobId>.glb                    the refined GLB, copied from the case        GET /scans/<scan>.interactive/<jobId>.glb
  <jobId>.delivery.json          the server's delivery report                  GET /scans/<scan>.interactive/<jobId>.delivery.json
  <jobId>.source.json            which session's keyframe the case copies (not served)
  <jobId>/                       the PhysAg3D case folder (not served)
```

With `PHYSAG3D_RUNS_DIR` set, `<jobId>.source.json` and `<jobId>/` are in that folder instead, side by side. The record
is written before `prepare` copies the image (prepare wants an empty case folder, so it cannot go inside), and it is how
a deletion of the session's frames finds the copy.

A folder and not files beside the scan: a `.glb` at the top of the scans directory is listed as a scan, and a `.json`
there is read as a scan's sidecar. The route serves exactly the two file names above from such a folder, so nothing in
a case folder is ever served.

The job's artifacts (`WorldJob.artifacts`):

| `type` | `url` | `metadata` |
| --- | --- | --- |
| `interactive-asset-input` | the keyframe that was sent | `sessionId`, `keyframe`, `thingId`. Added only once PhysAg3D's run may have started its worker |
| `interactive-asset-glb` | the landed GLB | `outcome`, `bytes`, `thingId`, `title`, `deliveryStatus`, `motionKind`, `interactionStatus`, `physicsStatus` |
| `interactive-asset-report` | the server's report | `outcome`, `limitations` |
| `interactive-asset-skip` | none | `reason`, `remediation` |

The server's report holds what it read and what it did: the outcome, how the worker ended (`execution.json`), the
delivery's text fields (title, statuses, limitations, blocker, repair rounds, acceptance passes), whether the GLB was
landed, and which of the outputs `delivery.json` lists are in the case folder. It leaves out every path `delivery.json`
holds, and the server adds none. The full record, with PhysAg3D's own `delivery.json`, logs and every delivered file, is
the case folder.

**What is checked before anything is landed.** `delivery.json` is written by the agent. Every path in it is resolved
inside the case folder by real path, so `..`, an absolute path elsewhere and a link out of the folder are refused.
The GLB is copied under a name the server chooses, and the copy must start with the binary glTF magic and be no larger
than `UPLOAD_MAX_SCAN_BYTES`, the cap on an uploaded scan.

---

## Configuration

All optional. Unset, the job completes as `skipped` with a hint, and nothing runs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PHYSAG3D_DIR` | unset | The PhysAg3D checkout, which holds `execute.py`. **Unset ⇒ skipped** |
| `PHYSAG3D_CONFIG` | unset | PhysAg3D's runtime config: the agent CLI, Blender, the generation host and the case budget. **Unset ⇒ skipped** |
| `PHYSAG3D_PYTHON` | `python3` on PATH | The interpreter that runs `execute.py`: Python 3.11 or later, standard library only |
| `PHYSAG3D_RUNS_DIR` | the scan's `<scan>.interactive/` folder | Where case folders go, one per job, named by job id. Wherever they are, a case folder goes when the frame it copied does (below) |

There is no time limit variable: the budget is the runtime config's `max_case_active_seconds`, and a second knob for it
would be a second name for the same thing. Keep `WORLD_JOB_DEADLINE_MS` (the job queue's backstop, 12 h by default) above
the budget plus 15 minutes.

### Setup

PhysAg3D's own README is the reference. On this server's side:

1. Clone PhysAg3D outside this repo, create its venv and install `requirements.observed.txt`, as its README says. That
   README does not set up Blender, the Codex CLI or the generation host; it says what each needs.
2. Write a runtime config from its `examples/`. This server is the controller: `python`, `blender` and `codex` are
   absolute paths on this server, and the `trellis` block names the generation host (`transport: ssh`, an SSH host alias
   with a known host key and non-interactive login). The launcher fixes the model, the reasoning effort and the native
   generation settings, and refuses a config that changes them.
3. Log the Codex CLI in with the ChatGPT account the runs should use, as the user the server runs as. PhysAg3D takes no
   API key.
4. Check it: `python execute.py doctor --config <config> --native`. It calls no model.
5. Set `PHYSAG3D_DIR` and `PHYSAG3D_CONFIG` (and `PHYSAG3D_PYTHON` when `python3` is older than 3.11) and restart the
   server. `GET /capabilities` then lists `physag3d-dir`, `physag3d-config`, `physag3d-python` and a
   `thing-interactive-asset` pipeline row.

`GET /capabilities` checks this server only. It does not probe the agent login or the generation host; `doctor --native`
does, and so does every `run` before it starts the worker.

---

## What leaves the box

Nothing leaves while PhysAg3D is unconfigured, and nothing leaves during `prepare` or `plan`. When `run` starts the
worker:

- **The keyframe goes to the agent service the runtime config names.** PhysAg3D's launcher starts the operator's own
  Codex CLI with the image attached and the ChatGPT login required, so today that is OpenAI's service, under the
  operator's account and its terms. The prompt goes with it, and names the case folder's path on this machine.
- **The keyframe goes to the generation host.** The worker submits it over SSH to the host in the config's `trellis`
  block, into a per-run folder under that host's `jobs_root`.
- **The worker runs commands on the controller's machine.** It is an agent with a shell, started with the flags
  PhysAg3D's launcher requires (`--approve-for-me` among them), as the user that runs the controller: the server's own,
  unless the operator arranges otherwise. PhysAg3D's protocol tells it to write only inside its case folder and not to
  read credential files. Nothing in this repo enforces that, and what it reads can reach the agent service (see
  [Limits](#limits-to-know-before-turning-it-on)).
- **Not sent by this server:** any other keyframe, the scan's GLB, the world file, or the server's environment. The child
  process gets an allowlist (`CHILD_ENV_NAMES`: PATH, HOME, the locale, the SSH agent socket, `CODEX_HOME`, the proxy
  and certificate settings, and what Windows needs to start Python), so tokens such as `CI_SERVER_TOKEN` and
  `FDANYONE_TOKEN` do not reach the worker. A proxy address that carries a password does reach it.

Copies held by the agent service and the generation host are outside this server's reach: deleting the scan does not
delete them.

## What stays on the box, and what removes it

- **The case folder**: a copy of the keyframe (`input/source.jpg`), PhysAg3D's method files, the worker's logs, and
  everything it delivered, which includes more images made from the frame (renders, comparisons, the generation host's
  condition image).
- **The two landed files**: the refined GLB and the server's report.

**A case folder does not outlive the frame it copied.** Whenever a session's frames are removed, every case folder that
copied one of them is removed first, whole, wherever it is (beside a scan or under `PHYSAG3D_RUNS_DIR`):
`DELETE /sessions/:id` ("Delete frames this phone sent"), the retention purge (`KEYFRAME_RETENTION_DAYS`), deleting the
scan, and clearing all scans. The whole folder goes and not only `input/`, because the agent's own images of the frame
are in it under names nobody chose in advance. The landed GLB and report stay, as a splat made from the same frames
does, until the scan is deleted.

While a run is using a session's frames, those deletions keep the frames and the copy, and say so: `DELETE /sessions/:id`
answers 500 with "try again when it has finished" (a phone keeps the session on its list and asks again; a 409 would make
it drop the request), and the purge counts the session as not deleted and takes it on its next pass. The copy is made
inside the session's write queue, which every removal of the session waits in too, so a deletion either finishes before
the copy (and the job then finds the keyframe gone) or finds the run holding the session.

Not covered: what the agent service and the generation host received, and a worker that outlived the server's deadline
and writes into its case folder after the folder was removed. That folder has no record left to be found by.

---

## Operational properties

The [limits](#limits-to-know-before-turning-it-on) above come first. Beyond them:

**A restart does not send the image twice.** Boot recovery requeues the job with the same id, so it finds the case folder
its first attempt made. A case PhysAg3D has started (it has `execution.json`) is never run again: the job reads its
`delivery.json` if there is one, and otherwise fails saying PhysAg3D does not resume a case. A case that was only prepared
continues from `plan`.

**Progress** moves at step boundaries only: 0.4 prepared, 0.45 planned, 0.5 running, 1 done. Nothing reports progress
during the run itself.

**Nothing is recorded on the scan.** An asset of one Thing says nothing about the scan's geometry, so the scan's status
does not change.

---

## Licences

- **PhysAg3D's own source is MIT** (its `LICENSE`). It bundles Three.js r170 under MIT (its `licenses/` folder), for its
  local viewer. Its README says external tools and model weights keep their own licences and are not covered by its
  MIT licence.
- **This repo copies no PhysAg3D code and ships none of it.** The server runs an operator's checkout as a separate
  program, so nothing is added to `THIRD_PARTY.md`, which lists this repo's own dependencies.
- **Not reviewed here:** the licences and terms of TRELLIS.2, DINOv3, BiRefNet, Blender, MuJoCo and the Codex CLI, and the
  ChatGPT terms the worker runs under. The operator installs and accepts them.

---

## Verified, and not verified

**Verified, by tests and type checks only** (`tests/unit/deno/physag3d.test.ts`, `scan_deletion.test.ts`,
`capabilities.test.ts`, one test in `keyframe_routes.test.ts`, `deno task check`):

- on the real server, without PhysAg3D: a request ends `completed` with the skip hint, a request without
  `payload.keyframe` ends `failed` with that rule, the asset folder serves its two names and nothing else, the landed GLB
  is not listed as a scan, and the folder goes with the scan;

- an unconfigured install is `skipped` with a hint and spawns nothing;
- the `prepare`, `plan` and `run` argument vectors, the order of the steps, each step's deadline, and the plan in the log;
- reading `delivery.json` for complete, partial and failed deliveries, a malformed one and a missing one;
- a deadline that stops `prepare` or `run`, and a delivery finished before the deadline fired;
- no path in `delivery.json` can make the server read or land a file outside the case folder, the landed names are the
  job id's, and the keyframe and served names cannot leave their folders;
- the child's environment holds no server token, through the real spawn as well as through the seam;
- a case already started is never run again;
- the asset folder goes with its scan and with "delete all", and nothing in `server/` queues the job by itself;
- a case folder goes, whole, before the session whose frame it copied, through `DELETE /sessions/:id`, the purge, scan
  deletion and "delete all", beside a scan and in a runs folder, and stays with its session while a run holds it (unit
  tests, and on the real server for the route and the purge).

The `_spawn` seam stands in for `execute.py`. What it writes follows PhysAg3D's `execute.py` and its worker protocol
(`method/WORKER_PROMPT.md`), as read at upstream commit `3b0dab9`.

**Not verified:**

- **No end-to-end PhysAg3D run has happened here.** PhysAg3D was not installed or run, and there was no agent login, no
  generation host and no GPU. No real `delivery.json`, GLB, video or timing has been seen.
- Whether a real worker's `delivery.json` matches the contract the parser follows.
- The runner's handling of a real delivery, with the server wired in: only the driver's has been tested.
- Whether the environment allowlist is enough on a real box. A machine whose tools need another variable (a library
  path, say) will fail in ways no test here shows; the names are in `CHILD_ENV_NAMES`.
- Whether the agent CLI confines what the worker reads.
- The 10-minute step deadlines and the 15-minute margin are untuned.
- The 28 GiB figure is the free GPU memory PhysAg3D's example profile asks for, not a measurement.
