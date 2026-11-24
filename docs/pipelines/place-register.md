# Place register

Compares a scan with the Place's other calibrated scans and **proposes** a small
move that would line them up better. It measures how well two scans agree, which
nothing else in the app does: the two-point frame's only check on a return visit
is that the baseline length matched, and that is blind to a shifted or rotated
frame.

It never moves anything. A person applies a proposal in the editor, and what
that writes is an ordinary scan EditPatch (owner decision D17, approved).

Two methods answer the same question from different evidence, and the editor
shows them side by side:

- **Wall match** (`method: 'scan-match'`, slice 1): the scans' point clouds,
  rasterised to wall cells and lined up by correlative scan matching. No GPU, no
  COLMAP, no Python. Always runs first.
- **Photo match** (`method: 'sfm'`, slice 2): the scans' camera photographs,
  registered against each other with COLMAP on the CPU, and the move their recorded
  camera paths imply. **Off by default** behind `PLACE_REGISTER_SFM=1`. See
  [The photo method](#the-photo-method).

- Matcher: [`server/register/scan_match.ts`](../../server/register/scan_match.ts) — pure, no Deno API, runs under Node too
- Job: [`server/register/place_register.ts`](../../server/register/place_register.ts)
- Photo method: [`server/register/place_register_sfm.ts`](../../server/register/place_register_sfm.ts), its COLMAP steps in [`server/colmap/colmap_reference.ts`](../../server/colmap/colmap_reference.ts), and where it keeps files in [`server/register/sfm_workspace.ts`](../../server/register/sfm_workspace.ts)
- Shared types and Apply rules: [`src/world/register-proposal.ts`](../../src/world/register-proposal.ts)
- Editor card and preview: [`src/viewer/register-proposal.ts`](../../src/viewer/register-proposal.ts)
- DX9 table: [`scripts/dx9-collect.ts`](../../scripts/dx9-collect.ts)

## What it will not do

1. **Move a scan.** `scan.localToWorld` is untouched by the job.
2. **Set `scan.status`.** `'aligned'` is a claim that something was aligned. A
   proposal nobody has applied, and a run that proposes nothing, align nothing,
   so `applyCompletedJobToWorld` has no branch for this type.
3. **Touch the raw calibration.** The sidecar's `projectTransform` and
   `calibration.sessionToProject` stay as the capture measured them. The refined
   placement is the patch, and the residual that backs it travels with the patch
   as `provenance.residualM`.

## When it runs

- **When a second scan joins a Place.** `POST /upload-scan` queues a
  `place-register` job for the new scan after its `optimize-scan` job, when the
  Place already has another calibrated scan. The hook is `queuePlaceRegisterOnJoin`
  in `server/main.ts`; it is not awaited and a failure is only logged. Set
  `PLACE_REGISTER_AUTO_QUEUE` to `false` in `place_register.ts` to make it
  manual-only. Scans that enter a Place by reassignment or merge are not queued
  (their frames may differ; owner decision D4).
- **By hand.** "Alignment check (proposes a move)" in the editor's Advanced
  queue, or `POST /worlds/:slug/jobs` with `{ "type": "place-register", "scanId": … }`.
  The card's **Check with photos** queues the same job with
  `"payload": { "method": "sfm" }`, which asks the photo method to run even when the
  wall match proposed a move.
- **The photo method** runs inside the same job, after the wall match, when
  `PLACE_REGISTER_SFM=1` and either the wall match proposed nothing or the job was
  asked for it. Otherwise the result records why it did not run (`sfm.reason`), and
  the card says so: with the switch off it says "Photo matching is turned off on
  this server."

It is a `WorldJob` like every other (ADR 0001, ADR 0003): deduped on
`(type, scanId)`, single-flight in the one pump, requeued at boot, bounded in the
world's job history. None of that is re-implemented here. Re-running is safe: it
reads two files and writes the same artifact.

A scan is compared with the Place's **other calibrated scans** (the
`two-point-ground` and `ground-tap-compass` tiers; `known-distance` scans live in
solver coordinates and uncalibrated scans are placed by GPS or on a grid).
Which ones, in what order:

1. Scans filed under the **same area** come first, then scans with no area, each
   newest first. Scans filed under a **different area** are left out: two rooms of
   a similar plan whose frames overlap match each other by coincidence, and the
   score cannot tell that from the right room, but the person's own filing can.
   Putting the same area first means the earlier scan of this room is never
   dropped because newer scans of other rooms filled the list.
2. At most eight are read (`MAX_REFERENCE_CANDIDATES`), one at a time, each
   released after its pair is compared. The first four that can touch the new
   scan are searched (`MAX_REFERENCE_SCANS`); a pair turned away before any search
   (footprints too far apart, no floor, too few wall points) costs almost nothing
   and does not use one up.
3. Before each pair's search the job gives the rest of the server a turn (an
   upload or the event stream), so a job of several searches does not hold the one
   thread for the whole of them.

Nothing to compare, or a scan with no readable geometry, completes with a
`place-register-skip` artifact that says why. It is not a failure.

## What the matcher does

1. Carries each scan's points into the Place frame through its `localToWorld`
   (`readScanGlb` and `collectPointPositions`, the readers `export-world` and
   `panoptic-lift` use; the node hierarchy is applied, which matters for an
   optimized scan).
2. Finds each floor, keeps the points 0.3 to 2.0 m above it, and rasterises them
   into 5 cm occupancy cells with isolated specks removed. A floor is the lowest
   layer with enough points, believed only if it sits within 10 cm of where the
   calibration puts it (`FLOOR_HINT_TOLERANCE_M`; both tiers map the tapped
   landmark to project y = 0). A layer farther from that is a platform, a step or
   a ceiling, and the calibration's floor is used in its place with no height
   claim (`details.floors` says which). Height is corrected only when both floors
   were measured from their clouds. A scan that a patch has placed (moved by hand
   with the Edit gizmo, or by an applied check) gets no promise: it may have been
   lifted, so its floor is wherever its cloud shows it.
3. Chooses which scan the search turns: the one that reaches less far (RMS
   distance from its own centre), or, when the two reach about as far, the one
   with fewer cells. The turn is about that scan's centre, which is where the two
   overlap, so a walk through several rooms is judged by the room it shares with
   the earlier scan and not by the far side of the house. The answer does not
   depend on which scan is called the new one: when the search turned the earlier
   scan, the transform is inverted. What the bound limits is the move of the part
   the two share.
4. Turns pairs whose footprints cannot meet anywhere in the search window away as
   `low-overlap` without searching.
5. Searches x, z and yaw about the vertical (gravity fixes the rest; height comes
   from the two floors) by correlative scan matching: exhaustively at 20 cm, then
   refined at 10, 5 and 2.5 cm around the best eight coarse peaks, with a final
   sub-step polish. Deterministic: no random numbers, and the order of a cloud's
   points does not change the answer.
6. Measures the result at the best position and applies the gates.

### The gates, and what each refusal means

A refusal has `transform: null`, the numbers it measured, and one reason. They
are checked in this order.

| Reason | Meaning |
| --- | --- |
| `too-few-points`, `too-large` | Too little wall in one scan, or a scan that reaches more than 25 m from its own centre |
| `no-floor` | No floor in a cloud and no hint from the calibration |
| `floor-mismatch` | Both floors were measured from their clouds and are more than 0.3 m apart: probably another level |
| `low-overlap` | Under 60% of the smaller scan lines up at the best position, or the two footprints cannot meet anywhere the search reaches |
| `loose-fit` | What lines up is more than 8 cm apart (RMS) |
| `correction-too-large` | The best match needs more than 1.0 m, 10 degrees or 0.3 m of height. The size is reported; no transform is offered |
| `ambiguous` | The walls do not settle one position: another place fits about as well, within the bound or anywhere in the global probe's window (a symmetric room, a row of pillars), or the score barely falls as the scan slides (a corridor, two parallel walls, one wall) |
| `low-score` | Every gate passed narrowly; the product above is under 0.5 |

`score` is `overlapFraction` times `distinctiveness` times `fit`. `distinctiveness`
is the smaller of two 0-to-1 tests, one for a second peak and one for how far the
near-best region reaches; `fit` is 1 at or under a 4 cm residual and falls to 0 at
the 8 cm gate. All three are in `details` so a later tuning run can see why a pair
passed or failed. A refusal reports the score it measured, as a proposal does: it
is nearly always low (an ambiguous or loose match scores under 0.3), and
`correction-too-large` keeps the high score its good match earned and reports the
size beside it.

### The starting acceptance values

A pair that passes the gates above is a proposal to the matcher. The job holds it to six
stricter values before it offers a move to a person (WP-15b, from the synthetic study
R2 ran: on 480 negatives, among them other rooms, twin footprints, a wrong size and a
perfectly symmetric room, they accepted none, and they accepted 69.8% of the true pairs).
Each is a named constant in `scan_match.ts`, **adopted, not measured (ADR 0005 rule 5)**:
R2 says itself that real clouds will score lower.

| Value | Constant | Must be |
| --- | --- | --- |
| Field score: the mean Gaussian likelihood of the new scan's cells at the best position | `MIN_FIELD_SCORE` | at least 0.80 |
| Global peak ratio: the best score over the best score of a place elsewhere | `MIN_GLOBAL_PEAK_RATIO` | at least 1.10 |
| Observability: the smallest fall in the field score for a 25 cm slide, as a share of it | `MIN_OBSERVABILITY` | at least 0.12 |
| Query inliers: the new scan's cells within 15 cm of a reference cell | `MIN_QUERY_INLIER_SHARE` | at least 85% |
| Reference coverage: the reference's cells inside the new scan's footprint that have a new cell within 15 cm | `MIN_REFERENCE_COVERAGE` | at least 45% |
| Inlier residual (RMS) | `MAX_ACCEPT_RMS_M` | at most 0.045 m |

"Somewhere else" is read by a **global ambiguity probe**, separate from the window a
correction may use: a coarse level over about 3 m and a full turn each way, looking for a
second peak outside an exclusion zone of 1 m and 25 degrees round the best position
(`GLOBAL_PROBE_WINDOW_M`, `GLOBAL_PROBE_WINDOW_YAW_DEG`, `GLOBAL_EXCLUSION_M`,
`GLOBAL_EXCLUSION_YAW_DEG`). A second peak at 0.9 of the best or more flags the room as
**symmetric** (`SYMMETRIC_PEAK_RATIO`). A narrow window cannot see this: a rectangle turned
a half turn fits itself at a turn beyond the bound. R2's own rule read the ratio outside a
smaller zone (0.5 m, 10 degrees), which is stricter; the brief's zone is the one used.

A pair that misses one is refused with the matcher's own vocabulary (the first value it
missed: peak ratio and observability are `ambiguous`, the two shares are `low-overlap`, the
residual is `loose-fit`, the field score is `low-score`), and the comparison row lists every
value it missed in `startingValuesFailed`. `PLACE_REGISTER_ENFORCE_STARTING_VALUES` in
`place_register.ts` is the one switch: false offers what the matcher said and still records
the numbers. **Every searched pair's numbers are recorded, refused or not** (`comparisons[]`:
`queryInlierShare`, `referenceCoverage`, `observability`, `fieldScore`, `globalPeakRatio`,
`symmetric`, `startingValuesFailed`), because the rejected pairs are what DX9 tunes from. A
record an earlier build wrote has none of them and reads as before.

**Size.** When the two scans' sessions ran in different units (their `scaleMode`s differ, and
not both are metric by contract) the matcher also searches the new scan's size: 11 sizes from
0.80 to 1.25, evenly on a log scale (`SCALE_SEARCH_*`), and reports the recovered ratio
(`details.scale`, `comparisons[].scaleRecovered`). R2 recovered a 10% size error in 36% of
trials without the search and about 90% with it, at about ten times the cost. Whether two
scans in one 8th Wall responsive mode can differ in unit is DX1.

## Constants are adopted, not measured

Every threshold in `scan_match.ts` is **adopted, not measured** (ADR 0005 rule
5). The repo holds no real two-scan captures (`test-data/real` is a README), so
they were set against synthetic rooms. Each carries its own revisit trigger in
the source. The run records the values it used in the artifact's `params`.

## The photo method

`method: 'sfm'` registers the new scan's camera photographs against an earlier scan's with
COLMAP and proposes the move that the two scans' own recorded camera paths imply. It reads
photographs where the wall match reads walls. **Off by default**: it needs `PLACE_REGISTER_SFM=1`
(owner decision D16 gates shipping it, not building it), COLMAP on the server (`COLMAP_BIN`,
the same lookup `colmap-poses` uses) and the scans' keyframes (the phone's "Camera frames"
stream). It composes [`pair_list.ts`](../../server/register/pair_list.ts),
[`colmap_sessions.ts`](../../server/colmap/colmap_sessions.ts),
[`session_priors.ts`](../../server/register/session_priors.ts) and
[`sim3_chain.ts`](../../server/register/sim3_chain.ts), and re-implements none of them.

**What it does.** The wall match has run. If it proposed nothing, or the job was asked for
photos, then:

1. It chooses the earlier scan whose photographs look, by their poses in the Place frame,
   at what the new scan's do (the most pairs the pair list would match).
2. It solves that scan's session once, by itself: one camera per session, features, the
   pair list's matches, the mapper, grown from the largest model. That is the **reference**
   and it is kept (below) for every later scan of the same Place frame.
3. It registers each of the new scan's sessions (at most three) to the reference with the
   reference's cameras held fixed (`mapper --input_path <reference> --Mapper.fix_existing_frames 1`):
   a star, never one new session against another, where errors would add.
4. It fits each session's recorded camera centres to the solved ones (Umeyama), from the
   photographs that agree: the one whose solved camera is farthest from where the fit puts its
   recorded one, and more than 15 cm from it, is left out and the fit is made again, until every
   photograph that is left is inside the gate (a few photographs COLMAP placed wrongly would
   otherwise turn and resize the scan and still pass the 0.25 residual limit; in 3,875 simulated
   cases of 10 to 30 photographs with up to 40% of them 0.2 to 1.4 m wrong, no photograph that was
   left out agreed with the fit that remained). The fit is made when at least 60% of the paired
   photographs, and at least 6, agree; fewer is `high-residual`. **This replaces the brief's gate
   alone** (a fit of every photograph whose RMS gap is past 0.25 refused): the 0.25 limit is still
   applied to the photographs that are kept and cannot fire for them unless the session's unit is
   under 0.6 Place metres, because each of them is within 15 cm. It is stricter (a fit whose
   photographs are all 0.2 m out is refused, where the RMS alone let it through) and more tolerant
   (a few gross outliers no longer sink a good fit); the owner decides which is wanted. It then chains `T_new->Place = T_ref x Sim_ref^-1 x Sim_new`. Both AR
   frames are gravity-aligned, so it keeps the turn about up, the shift and the size and drops
   the tilt (recorded as `tiltDeg`). A reference scan that was tilted by hand with the Edit
   gizmo is not followed for the same reason: its tilt is not in the answer.
5. It holds the move to the bound the wall match is held to (1 m, 10 degrees, 0.3 m of height)
   and to what a placement can hold (a size between 0.5 and 2), and proposes it with the
   photographs registered, the inliers (cameras within 15 cm of where the scan recorded them),
   the photographs left out of the fit, the RMS gap, the unit mismatch between the two runtimes
   (`scaleRatio`), how well the camera path fixes the turn and the size (below) and the time. The
   unit mismatch is carried into the move as a size only when it is at least 2% from 1 **and** at
   least three standard errors from 1; when it is not carried the middle of the scan still goes
   where the whole correction puts it, and only its far parts are not resized.

**What the camera path can fix.** A turn and a size are fixed by how far from their middle the
cameras are. With `n` frames in the fit, a path whose cameras lie `R` from its middle (root mean
square) and a fit that leaves an RMS gap `rho` between each recorded and solved camera, the
standard error of the size, as a fraction of it, is `rho / (R3 x sqrt(3n - 7))`, and of the turn
about up, in radians, `rho / (Rh x sqrt(3n - 7))`, with `R3` the radius in three dimensions and
`Rh` across the floor ([`sfm_fit.ts`](../../server/register/sfm_fit.ts) has the derivation). When
photographs were left out of the fit, `rho` is estimated from the median of every photograph's gap
to the fit, because the RMS of those that were kept is cut short by the gate and reads the noise
low. The two fits of a registration (the earlier scan's and the new one's) add in quadrature, so a
small path on either side is enough to refuse it; the detail on the refusal says which was how
uncertain. **Validated range** (simulated rings of cameras, 300 to 600 pairs of fits a cell, equal
noise on the recorded and the solved positions, which is an assumption): within 8% of the scatter
in every one of seven cells of radius 0.3 to 2 m, 8 to 36 frames and 1 to 5 cm of noise per axis
with nothing left out (the worst is the turn at a radius of 0.35 m: 2.13 degrees against 1.98
predicted); through the trimmed fit (`fitWithTrim`'s own `rho`), on rings of radius 0.8 and
1.2 m, within 11% up to 4 cm of noise per axis (5 to 6% of the photographs left out), within 14% at
5 cm (16 to 18% left out) and 20 to 30% low at 6 cm (27 to 30% left out), where a registration is
near the edge of being refused for too few agreeing photographs anyway (at 7 cm, 25 of 300 pairs
at radius 1.2 m and 65 of 300 at 0.8 m were fitted). Past about 20% left out the estimate reads low, so
a proposal near the turn limit with many photographs left out is more uncertain than it says. A
walk round a room (radius 0.8 to 3 m) at 3 cm of noise fixes the turn of a registration to under a
degree and its size to 1.5% or better; a stand-and-pan (radius 0.3 m) at the same noise fixes the turn
to 2 degrees and the size to 4%, so the photographs say where the scan is and not how it is turned
or how big it is. Both numbers are on every proposal (`turnUncertaintyDeg`, `sizeUncertainty`) and
on the card. A registration whose turn is uncertain by more than 1 degree is refused as
`turn-uncertain` (`SFM_ENFORCE_TURN_UNCERTAINTY` turns the refusal off and leaves the numbers); a
size is carried only when it clears three of its own standard errors. Simulated (60 trials a cell,
solver noise equal to the recorded noise, both assumptions): without them a path 0.35 m across at
3 cm of noise carried a size more than 3% wrong in 28 of 60 proposals and a turn more than 2
degrees wrong in 12; with them 58 of the 60 are refused as `turn-uncertain` and 2 as
`up-axis-disagrees`, a proposal's size was more than 3% wrong in none of the 21 cells of the sweep,
and every cell with a path 0.8 m across or more was proposed in 60 of 60. With 8% of the
photographs placed up to 1.5 m wrong, the ring, walk and big-walk paths of 24 photographs were
proposed 40 of 40 times (9 to 12 before), none with a size more than 3% wrong (2 to 7 before); the
small-loop paths (0.5 m across) 0 of 40, refused as `turn-uncertain`.

Everything runs on the CPU: every command asks for `use_gpu 0` and the child is started with
no GPU visible. It is one `place-register` job in the one pump (single flight, deduped,
requeued at boot), with a wall-clock limit (`PLACE_REGISTER_SFM_TIMEOUT_MS`, 45 minutes): no
COLMAP step starts after it and one running past it is killed, and the work directory is removed
however the run ends.

**Not run** (`sfm.status: 'skipped'`, never an error): `off`, `not-needed` (the wall match proposed
and nobody asked), `colmap-missing` (with the install hint, as every optional tool), `no-place`,
`no-keyframes` (the scan has no photographs on this server), `no-reference` (no other
calibrated scan has), `frame-mismatch` (the scans were calibrated against different
generations of the Place's reference; an unrecorded generation is neutral) and `no-overlap`
(by their poses none of the new scan's photographs looks at what an earlier scan's does).
**Run and refused** (`sfm.status: 'refused'`, no transform):

| Reason | Meaning |
| --- | --- |
| `colmap-failed`, `timed-out` | A COLMAP step failed (its words, with every path and frame name removed), or the run passed its limit |
| `reference-weak` | The earlier scan's photographs did not join into one model, so there is nothing to register against |
| `too-few-registered`, `sub-model-split` | Fewer than 6 of the new photographs (or under COLMAP's registration ratio) found their place. With COLMAP 3.13.0 a session it cannot tie in shows as `too-few-registered` with none registered (one model, holding only the earlier scan's photographs, measured on a room that was not the earlier scan's); `sub-model-split` is for a build that writes them as a model of their own, which is told from the registration by which model holds the earlier scan's photographs and not by which is largest |
| `reference-moved` | The earlier scan's cameras moved while the new photographs were added, so its fit no longer describes the model |
| `reference-unusable`, `too-few-correspondences`, `collinear`, `degenerate-scale`, `high-residual`, `up-axis-disagrees` | The solved camera path does not agree with the recorded one well enough to chain a placement through it (the refusals of `sim3_chain.ts`). `high-residual` is also what too few agreeing photographs is: when fewer than 60% of them (or fewer than 6) are within 15 cm of the fit there is nothing to leave the others out to |
| `turn-uncertain` | The camera paths are too small, or their positions too noisy, for the photographs to fix the turn to within a degree (one standard error): either the new scan's path or the earlier scan's is enough |
| `scale-out-of-range` | The size between the two scans is more than a placement can hold |
| `correction-too-large` | The move is beyond the wall match's bound |
| `sessions-disagree` | Two sessions of one scan share its frame and put it in different places: more than 15 cm or 2 degrees apart at the middle of the scan, or sizes that differ by more than 5% and more than three of their own standard errors (compared as each fit measured them, not as a proposal would carry them, so two sessions either side of the 2% line agree) |

**On the card.** With the photo method on, the card has two sections, **Wall match** and
**Photo match**, each with its own numbers, **Show** and **Apply**, and a line for how far
apart the two put the scan (translation, turn and size, measured at the middle of the scan). When
they differ by more than 15 cm, 2 degrees or 5% in size (`METHOD_AGREEMENT_BOUND`, adopted) the
card says neither is preferred and puts neither forward. The two methods each choose the earlier
scan they compare with (the wall match the one that lines up best, the photographs the one whose
photographs overlap most), and when they chose different ones the line says so. The Photo match
section also says how many photographs were left out of the fit, what the move does to the
scan's size (from the move itself: a measured size the move leaves alone is said as that), how
well the photographs fix the turn and the size, and how far the farthest camera moves when that
is clearly more than the middle of the scan does. Every card says what was not checked, the single
section card a scan gets when the wall match proposed and nobody asked for photos included: that
these scans are of the same room, and where the Place is on a map. Nothing says "aligned" or
"verified". If "Check with photos" is pressed while the scan already has an alignment check queued
or running, the server answers with that check and the card says it will not use the photos.

**What it keeps, and where (D15).** Photographs of the inside of a home, and COLMAP's database
and model made from them, are private. It writes no image anywhere and sends nothing anywhere.
COLMAP reads each frame where its session keeps it (the sessions folder is its image root; a
link or a copy would be a second photograph, and COLMAP 3.13 stores a link under the path it
resolves to, so a link cannot carry the name the pair list uses). It makes two things:

- **A work directory** for the run, `<Place data directory>/register-work/run-<jobId>-<unique>/`
  (`scans/projects/<id>/`, the folder that holds the Place's reference photos). It holds COLMAP's
  database and output and is removed when the run ends, however it ends. Its name is different for
  every run, so a job a restart requeued under the same id never shares a directory with the
  attempt before it (COLMAP outlives a server that was killed, and would otherwise write into the
  new run's files). A run killed with the server leaves one, which the next run, the boot sweep and
  "clear every scan" remove, and deleting the Place removes its folder whole. A sweep removes only
  entries named `run-*`, unlinks a link and never follows one (a `register-work` folder that is a
  link to a sessions folder loses nothing), and leaves the directory of a run that is still going
  alone. "Clear every scan" answers an error, and keeps the scans, while a leftover could not be
  removed. COLMAP's words in a result have every path removed: the folders the run was given
  whole (a space in a person's name is ordinary on a desktop), then anything of the shape of a
  path, relative and home paths and `file://` addresses included, and the install hint of a missing
  COLMAP names no folder of the operator's.
- **The reference model**, `<session directory>/sfm-reference/`: inside the earlier scan's own
  session folder, so every path that removes that scan's frames (`DELETE /scans/:filename`,
  `DELETE /scans?confirm=delete-all`, `DELETE /sessions/:id`, the retention purge) removes it in
  the same call, with no list of paths to extend. It is keyed to the Place's frame generation, the
  scan, the session, the epoch and a fingerprint of the frames, and checked when used: one made for
  another frame or other frames is removed, not reused, and a model copied to another session is not
  believed there. A run removes the models made for an older generation of the Place's reference,
  including those of scans it leaves out.

`tests/unit/deno/sfm_privacy.test.ts` runs the real deletion and retention code against real
directories for each of these.

**What it cannot see.** Which room it is: photographs of a twin room with the same furniture register as
well as the right one. Two scans calibrated against the same wrong landmark. The AR poses' own
drift over a long walk, which the fit averages in. A mirrored capture (see "What the chain cannot
see" below). It does not know where the Place is on Earth.

**What was measured.** Only on rendered rooms, never on a real scan. With the real COLMAP 3.13
(`COLMAP_E2E=1`, [`place_register_sfm_toy.test.ts`](../../tests/unit/deno/place_register_sfm_toy.test.ts)),
two sessions of 36 photographs each on the toy room, the second with a unit 12% bigger and a
calibration 42 cm out: 36 of 36 photographs registered, 36 inliers, RMS 1.8 cm, the unit mismatch
recovered as 1.119, the cameras 1.9 cm from where they were after the move, 29 seconds for the whole
method on a 32-thread CPU (re-run after the fit changes: 31 seconds). Running it against the real binary found two things the stand-in COLMAP
could not have: COLMAP stores an image linked from elsewhere under the path the link resolves to
(frames are therefore read in place), and one session of outward-looking views alone does not
solve into one model (14 outward views split into two or fail to initialise), so a reference
needs a capture with parallax; a real room's walk may be refused as `reference-weak` for the same
reason. That is a reason for the refusal to exist, and DX9 says how often. Registering a session
of a room that was not the earlier scan's, twice (the new one larger and smaller), and one that was,
against the real binary: the first two wrote one model holding only the earlier scan's photographs
(0 of 36 registered, no other models, `too-few-registered`), the third 36 of 36 with a size of
1.122 for a true 1.12. A stand-and-pan 0.3 m across with 3 cm of noise added to the recorded
positions, the same rendered photographs registered four times: before the size had to clear three
of its own standard errors, two of the four carried a size that was wrong (3.5% and 2.3%) and one
turn was 1.1 degrees out; after, no wrong size was carried and the two least certain were refused
as `turn-uncertain` (a turn uncertain by 1.0 and 1.04 degrees).

**Constants** (all adopted, not measured; named in `place_register_sfm.ts` and `sfm_fit.ts`,
recorded in `sfm.params`): the wall-clock limit (45 minutes), at least 6 registered photographs
(and 60% of them, COLMAP's own registration ratio, which is also what must agree with the fit),
at most 120 photographs per session (thinned evenly), at most 3 sessions, a reference that moved by
more than a thousandth of its spread, the 15 cm a photograph's solved camera may be from the fit's
before it is left out (the inlier gate), the 2% floor and the three standard errors a size must
clear to be carried, the 1 degree of turn uncertainty a proposal may have, 5% and 15 cm and 2
degrees for two sessions or two methods to agree, and the 5 degree up-axis limit of `sim3_chain.ts`.

## Apply

The editor lists each scan's newest check in the World tab ("Alignment checks"):
what was compared, how much lined up, the proposed move, **Show** (the scan's
points in red where they are and green where the proposal puts them) and
**Apply**. With the photo method on, each method has its own **Show** and **Apply**
(the buttons say which) and the card says how far apart the two put the scan.
Apply POSTs a scan patch whose matrix is the correction on top of the
scan's placement at proposal time and whose provenance is
`{ source: 'place-register', jobId, score, residualM }`, with `method: 'sfm'` added for the
photo method (its `score` is the share of the scan's photographs that found their place,
because that method has no composite score and a made-up one would claim something nothing
measured). A patch without a method is the wall match's.

There is no Undo button. The check keeps the scan's placement from before
(`moving.localToWorld` in the artifact), the sidecar keeps the capture's own
calibration, and the Edit gizmo can move the scan back; running the check again
afterwards proposes from where the scan now is.

The server holds that provenance to what the job proposed (`guardRegistrationPatch`):
the job exists and proposed a move **by that method** for this scan; neither this scan nor
its reference has moved since; the matrix and numbers are the job's own. A second
apply of one job, by either method, from a second tab or a double press, gets the first
patch back (`duplicate: true`) and writes nothing. A patch without provenance is untouched.

## What it cannot see

- **Identity.** Two different rooms with one plan match perfectly. Filing under
  areas keeps most of them apart (scans filed under another area are not
  compared), but two scans with no area, or two rooms filed under one area, are
  not told apart. Two scans that are both shifted the same way against the
  building cannot be told from correct ones. Only photos, a fiducial or the person
  looking at the preview see that.
- **A turn by the room's own symmetry.** A bare square room turned a quarter turn
  about its own centre, or a bare rectangle turned a half turn, fits itself. The
  global probe sees that second place and the job refuses the pair as ambiguous: the
  walls cannot say which wall is which, and a refusal is the honest answer. A
  doorway, a piece of furniture or a photo can say, which is what the photo method
  is for. (With `PLACE_REGISTER_ENFORCE_STARTING_VALUES` off the matcher says what its
  own gates say, as it did in slice 1: "no move", with the matching turn kept out by
  the bound.)
- **Mass that is not wall.** Unrelated points between 0.3 and 2.0 m above the
  floor (floating junk, a ceiling at or below 2.0 m, a great deal of furniture)
  flatten the score everywhere, and the check then says the walls do not settle one
  position when they would. It refuses; it does not guess. On synthetic 5 x 4 m
  rooms with the same furniture in both scans, 12 pieces got a proposal in 28 of 40
  pairs and 16 pieces in 6 of 40, none of them wrong; a ceiling at 2.0 m refused
  all 30. Normalising the score against the window's median made those cases
  propose (16 pieces: 38 of 40) and was not adopted: it also proposed positions
  along a single wall that were more than 5 cm out (up to 10 cm) in 10 of 40 pairs. Real clutter is the
  first thing DX9 should show. The band's limits are adopted constants
  (`SLAB_MIN_ABOVE_FLOOR_M`, `SLAB_MAX_ABOVE_FLOOR_M`).
- **A platform within the floor tolerance.** A low platform standing in for a
  barely seen floor is believed if it is within 10 cm of where the calibration
  puts the floor, and then the height change can be up to that far out.
- **Wall ends.** Position along a wall that was scanned for a different length
  each time is weakly determined. The matcher refuses parallel walls on their
  own, but a long wall plus a short unrelated feature can look better than it is:
  in 40 synthetic pairs of two parallel walls against a full room, 1 was proposed,
  9 cm out along the wall (the same either way round).
- **After Apply and a reload**, the red and white calibration pins are drawn
  from `localToWorld`, which a patch replaces. This is true of any scan patch
  (see `addAnchorMarker` in `src/viewer/viewer.ts`) and is not specific to this job.

## Time

A search is arithmetic on the one thread the upload routes and the event stream
share. Measured on synthetic clouds: 0.4 to 2.3 s per pair for 66 000 to 590 000
points over 4 to 24 rooms, and 3 to 7 s per pair for 250 000 points (the phone's
cap) filling a disc of 10 to 24 m radius. The job yields before each pair, not
inside one. The matcher has no Deno dependency precisely so that a worker thread
can run it later; that is the next step if DX9 shows long searches in practice.

The photo method is COLMAP on the CPU and takes minutes where the wall match takes
seconds: 29 seconds for the whole method (the earlier scan's model and the new
registration) on two rendered sessions of 36 photographs each, on a 32-thread box. Nothing
is known for real keyframes, and the pair list and the 120-photographs-a-session cap exist
to keep it from growing with the square of the photographs. It is a child process, not
the server's one thread, and the job holds the pump's single slot while it runs.

## DX9: what real data would settle

DX9 needs **at least 8 rooms of 3 sessions each**: 24 same-room pairs and 252 cross-room
pairs. **One scan pair is a smoke test**: it shows that the pipeline runs on real data, and it
cannot tune a constant. Zero false accepts in n independent negatives bounds the true
false-accept rate below 10% at n of 29, 5% at 59, 2% at 149 and 1% at 299 (95% confidence),
and a success rate to +-10% needs about 97 independent pairs (worst case). The pairs of one
room share sessions, so they are not independent, and 252 is the most they can show, not a
guarantee. The procedure is in
[`DEVICE_TESTING.md`](../testing/DEVICE_TESTING.md#procedure-5--server-registration-on-real-scans-dx9).

What to record per pair is what the job already stores, and
[`scripts/dx9-collect.ts`](../../scripts/dx9-collect.ts) puts it in one table, read-only and
offline: for the wall match every searched pair's overlap, inlier residual, score, query
inliers, reference coverage, observability, field score, peak ratio, whether it was flagged
symmetric, which starting values it missed, the size it recovered and its time; for the photo
method the photographs offered and registered, the inliers, the RMS, the unit mismatch, the tilt
it dropped, whether the reference model was made or reused and the time; how far apart the two
methods put the scan; the disagreement between the registration and the scan's own constellation
fit (`calibrationFitMaxM`); and the keyframes' count and bytes. With a file of room labels it says
how each method answered the same-room pairs and the cross-room pairs, counts the distinct
pairs it has, and says whether that reaches the sample above. It uses the newest run of each pair
and method, and `--all` keeps every run. One job searches at most four references
(`MAX_REFERENCE_SCANS`) and reads at most eight (`MAX_REFERENCE_CANDIDATES`), so a job per scan does
not make the whole matrix: the collector counts the pairs it finds, not the pairs wanted.

Those numbers are what set the starting values, the pair-list gates, the 100-image limit and the
up-axis limit, and the correction against a manually set truth is what says whether a proposal
was right.

## Slice 2 prerequisites seen in the code

- `runColmapPoses` passes `--ImageReader.single_camera 1` to `feature_extractor`
  and matches exhaustively. That is right for the one session it solves, and it
  is unchanged (a golden test pins its command lines and its files). Across
  sessions it was wrong, and exhaustive matching does not scale to a Place's
  worth of keyframes: `runColmapJointPoses` is the answer, see below.
- Keyframe sessions are opened by `KeyframeStreamer.start()` and rotated at each
  autosave and export (`src/main.ts` rotates the session after a successful
  upload), so one scan is one session once streaming is on. Streaming itself is
  a manual toggle ("Stream keyframes to server"); making it default for Place
  scans is owner decision D15.
- `server/splat/splat_align.ts` already does Umeyama between camera sets and is
  the piece to reuse for chaining a session to the Place frame.

## Slice 2 building blocks

What the photo method is made of: these were built and tested before the job that composes
them ([The photo method](#the-photo-method)). Nothing is applied automatically.

- **One camera per session.** `runColmapJointPoses`
  ([`server/colmap/colmap_joint.ts`](../../server/colmap/colmap_joint.ts); it
  builds its command lines with the builders in
  [`colmap_poses.ts`](../../server/colmap/colmap_poses.ts), which solves one
  session and is unchanged) links each session's keyframes into
  `images/<sessionId>/` and gives each folder a camera of its own
  (`--ImageReader.single_camera_per_folder`), started from that session's own
  field of view in `keyframes.jsonl`
  ([`colmap_sessions.ts`](../../server/colmap/colmap_sessions.ts)). A session
  that reported none is left to COLMAP's default, not given a made-up prior, and
  so is one whose every frame reported exactly 60 degrees (what a runtime says
  before its first real projection) or a field of view outside 20 to 140
  degrees; `prior.ignored` in the report counts what was left out. Its output is
  a work directory of its own, never a session's, however either is spelled
  (relative paths and symbolic links are resolved before the check): poses are
  keyed `<sessionId>/kf-NNNNN.jpg`, the lens of each session is under `cameras`,
  and the model is left in COLMAP's frame. The report says, per session, how many
  frames joined the model, which lens COLMAP fitted, and whether the session
  came out as a model of its own. A session COLMAP cannot tie to the others
  usually does, but not always: with a session whose pictures were mirrored (its
  AR poses right, its images unable to match), COLMAP 3.13.0 and the relaxed
  mapper thresholds put 3 of its 14 frames into the model that held the other two
  sessions, 2 to 3 m from where the cameras were, and the report said registered
  3, unregistered 11. So "registered" is not "joined": the fit and the
  registration's checks (below) are what refuse such a session, and
  `COLMAP_E2E` has that session as a negative control. The thresholds stay the
  single-session ones: with COLMAP's own defaults the same frames were not
  registered, but nothing says what defaults would do to a real session's weaker
  overlap with another, which is DX9. The work directory holds the sessions'
  keyframes as hard links, and COLMAP's feature database. A hard link keeps a
  photograph alive after its session is deleted, so a deletion path (owner
  decision D15) that removes only `scans/sessions/<id>/` leaves those frames
  behind: whoever picks the directory deletes it with the scan or the Place. The
  photo method does not call this driver: it reads the frames where their sessions
  keep them and writes no image anywhere.
- **Pair lists.** [`pair_list.ts`](../../server/register/pair_list.ts) builds the
  list for `matches_importer --match_type pairs`: each image with its next ten
  in capture order, revisits within a session, and, across sessions, frames
  within 3 m and 60 degrees of each other in the Place frame by the AR poses
  ([`session_priors.ts`](../../server/register/session_priors.ts) carries them
  there through each scan's `sessionToProject`, one epoch only, and refuses a
  matrix that is not a column-major similarity, so a row-major one cannot move
  every frame silently). Exhaustive matching is refused beyond about 100 images,
  with the reason, and a list is refused beyond 20,000 pairs as soon as the
  pairs found pass that. The sessions the pairs tie into one group are reported
  (`stats.groups`); the group that matters is the one holding the reference
  session (`pairOptions.referenceSessionId`), else the largest, and every
  session outside it is isolated, even one that has a partner of its own. The
  plan then falls back to exhaustive matching when the image count allows it, and
  says which sessions the poses could not tie. Deterministic.
- **The chain.** [`sim3_chain.ts`](../../server/register/sim3_chain.ts): an
  Umeyama fit per session of its recorded camera centres to the solve's
  (`splat_align.ts`), then `T_new->Place = T_ref x Sim_ref^-1 x Sim_new` for every
  session against the reference, never against each other. The result comes in
  both conventions (`sessionToProject` is column-major,
  `SplatAlignManifest.projectTransform` is row-major) and carries the per-session
  scale ratio, the unit mismatch between runtimes (the scale of the placement is
  that times the scale of the reference's own calibration, 1 for an AR session).
  The up axis is read from the fit to the AR poses, not guessed from the cameras.
  A session is refused when its fit is (too few frames, a straight line, a scale
  that is not positive, a residual past 0.25), and when the solve tips its up
  axis more than 5 degrees against the reference's: every AR frame is
  gravity-aligned, so that angle is the noise of the two fits when the
  registration is right and arbitrary when it is not. Of 4 frames COLMAP placed
  0.5 m from where they were, 7% got past the residual gate and 0.35% past both
  (simulated; the limit is adopted, `MAX_UP_AXIS_TILT_DEG`). `describeCorrection`
  sets a registration against the scan's own calibration in the vocabulary of the
  matcher's proposals (shift, turn, height, with the same limits), plus tilt and
  scale, which those limits do not cover.

What the chain cannot see. A solve that is the mirror image of the AR poses fits a
nearly flat camera path almost as well as the real one, because the proper
rotation the fit is held to turns the path over (simulated: 99 to 100 of 100
registered at a 5 cm spread of camera height, 85 at 10 cm, none from 30 cm);
camera centres alone cannot tell, and a mirrored capture is a bug to find where
it is made. A camera path that is nearly a line (a corridor) leaves the turn about
its own length poorly fixed; the up-axis limit bounds that, and does not remove it
(simulated, a point 3 m off a 20 m by 0.3 m walk: 16% of the registrations refused,
the rest placing it within a median 12 cm and at worst 27 cm, where it was 56 cm
without the limit).

How it was tested. The unit tests stub COLMAP. `COLMAP_E2E=1` runs the real
COLMAP 3.13.0 on a rendered room of three sessions (three lenses, two image
sizes, three AR frames, one unit 12% bigger than the reference's) and checks that
the frames register in one model, each session on its own camera, and that the
chain recovers each session's frame, and then on the same room with one session's
pictures mirrored, which the chain must not register; see
[`colmap_toy_sfm.test.ts`](../../tests/unit/deno/colmap_toy_sfm.test.ts) for the
numbers it measured. That room is easy: no blur, no lighting change, no moved
furniture. Nothing has been measured on a real scan; that is DX9, and it is also
the only thing that can set the constants, which are all adopted (3 m, 60
degrees, the sequence window, the partner caps, the 100-image limit, the pair
cap, the 5 degree up-axis limit, the 20 to 140 degree field-of-view range) and
named as such where they are defined.

Two things the gates trust. Each session's frames reach the Place frame through
its own calibration, so a session whose calibration is wrong by more than the
gates (a one-point frame turned by the baseline's bearing, a frame that moved
after calibration) is not tied by the pair list. And the fit trusts the AR poses
of one epoch, the one the calibration was made in (`frameEpochs.calibrationEpoch`
in the upload sidecar); frames of other epochs go to COLMAP but take no part in
the gates or the fit.
