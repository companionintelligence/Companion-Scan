# Gimbal-driven capture (DJI Osmo Mobile 6)

[`subsystems/osmo-ble/`](../../subsystems/osmo-ble/) controls a DJI Osmo Mobile 6 gimbal over
Bluetooth LE via reverse-engineered DUML commands, and exposes that control as an MCP server so
Claude Code (or any MCP client) can drive automated capture sweeps. It's vendored into this repo
(moved in from a standalone project on 2026-08-21) so a fresh clone gets the whole system in one
place — see the [root README's quick-setup section](../../README.md#quick-setup) to get running.

**Status (2026-08-21):** protocol codec and pairing are verified against a real captured frame.
Gimbal speed-control's axis order/signs were live-verified against a real OM6 via the web UI
joystick and corrected in `subsystems/osmo-ble/protocol/commands.mjs`. **The absolute-angle opcode
(cmdId 0x14) is confirmed non-functional** — a direct A/B test against real hardware (speed
command: delta 0.126, moved; absolute-angle command: delta 0.0002, not moved, same gimbal, same
session) showed it does nothing, consistent with earlier disassembly finding that DJI's real
angle-set commands are larger structs our guess never matched. `gimbal_move_to`, `gimbal_sweep`,
and `gimbal_recenter` were all rewritten to use closed-loop positioning instead — see
"Closed-loop positioning" below. The "mode" toggle (cmdId 0x44) is confirmed to be a
portrait/landscape switch, not a real lock/follow/fpv selector. The web control UI is a compact
one-handed PWA matching CI-Common's design tokens (`packages/tokens/src/tokens.css`, dark theme),
with a live orientation readout, a persistent command-coverage grid, and a structured frame
inspector. What is verified on hardware, and what has changed since without a rig, is listed
under ["Verification status"](#verification-status) at the end.

**Update (2026-08-25) — the web UI is now "Scanner Control", built around running a scan rather
than probing the protocol.** What changed, all in `subsystems/osmo-ble/web/`:

- **Scan-type presets** replace hand-typed position lists. Per station, as the code has them
  (`SCAN_PRESETS` in `subsystems/osmo-ble/web/page-state.mjs`):
  - **Dome**, the default: 150° of pan in 7 columns at 25°, crossed with tilts -25° and +5°, so
    **14 positions per station**. On the built-in arc that is pan 96° round through 180° to -114°.
  - **Quick**: 120° in 4 columns at 40°, tilts -20° and +5°, so 8 positions. A look, not a
    reconstruction.
  - **Band**: wide and shallow, for corridor-shaped rooms. As many columns 20° apart as fit at
    least 8° inside each stop (9 on the built-in arc, 91° → -109°), with tilts -15° and +5°.
  - **Custom**.

  The presets are dome *shapes* relative to the reachable arc the backend reports, so they
  follow the arc when a probe measures it from where the tripod stands. Editing any field moves
  the selection to Custom, so the lit name always describes the numbers on screen. The interior
  rows of the multi-row presets are interpolations, not separately measured coverage figures.
  (These replaced the original single-station presets of 105 and 25 positions when
  multi-station capture arrived. Stations, not positions, decide whether a capture can be solved.
  See "Multi-station capture" in the subsystem README.)
- **A compact action bar**, plus a **compass + tilt readout**. The compass needle shows the
  *gimbal's* pan (`web/orientation.mjs`). That pan is relative to wherever the gimbal booted and
  has no north. The *phone's* magnetometer heading has its own captioned block under the
  gimbal's numbers, filled from `phone-telemetry` frames relayed over the backend's `/ws`
  (`protocol/phone_telemetry.mjs`). It is shown *alongside* the gimbal's quaternion, never
  averaged into it: the phone heading is absolute but unreliable indoors near steel, and
  `headingAccuracyDeg` travels with it for exactly that reason. **Nothing in the app sends those
  frames yet.** `src/capture/phone-telemetry-sender.ts` is not imported anywhere, so the phone
  block reads "no phone telemetry yet". The relay keeps every key of a frame but drops its
  location (`lat`, `lng`, `accuracyM`, `altitudeM`), which nothing reads.
- **A scan-in-progress lock.** While a grid run sweeps, the backend rejects manual motion
  commands with **HTTP 409**, and the UI disables the joystick, Center, the orientation and stick
  buttons, raw send, the test matrix, the photo buttons and Run to match. This is an interlock,
  not a nicety. The joystick streams `speed` commands to the same two motors the closed-loop
  controller is steering, so one stray touch makes two controllers fight. It really happened;
  see the wedge note below. **While the run is parked between stations** the backend lets manual
  motion through again, and the page re-enables the same controls. The exceptions are Photo,
  which stays off because a camera-mode run holds the phone's one MCP session, and Run.
- **`POST /api/grid-stop`**, checked between positions, so a long dome unwinds cleanly instead
  of being killed mid-move, and immediate while the run is parked. It can be called from:
  - the page's **Stop scan** button;
  - `npm run cli -- stop`;
  - Ctrl-C during `npm run cli -- grid`, which stops the run on the backend and waits for it
    to end, so `manifest.json` is complete;
  - the MCP tool `stop_grid_capture`.
- **Wedge detection.** Three consecutive positions that end non-converged at the same pose
  (within 1.5°), or that the move loop reports as stalled, abort the run
  (`createWedgeGuard()` in `protocol/stall.mjs`). The message then compares where it stopped with
  the arc the station was planned against (`diagnoseJam()` in `protocol/dome.mjs`). A stop where
  the arc said there was travel means the arc moved with the tripod: re-probe, don't reset the
  gimbal. Two in a row could just be a tight corner; three is the signature. This was written
  after a stray joystick touch during a 105-position dome pinned the gimbal at one pose (pan
  -121.5, tilt -27.6) for six consecutive positions, each burning the full `maxMs` and
  photographing the same view.

**Architecture — one BLE connection, owned by `server/backend.mjs`:** the `osmo-gimbal` MCP
server does **not** hold its own Bluetooth connection. It's a Claude Code-spawned subprocess,
parented by the same process tree as Claude's own tool execution — and a captured macOS crash
report (`namespace: TCC`, missing `NSBluetoothAlwaysUsageDescription`) proved that tree cannot be
granted Bluetooth access. Every gimbal MCP tool is a thin HTTP client of
`subsystems/osmo-ble/server/backend.mjs` instead, which you run yourself in a real terminal — the
only place BLE has been proven to work. This also means there's only ever one BLE connection to
the single physical gimbal, not two independent ones fighting over it.

**Access: token, origins and bind address (wave 14).** The backend used to answer every origin
with `Access-Control-Allow-Origin *` on every interface, with no credential. So any web page the
operator had open could move the gimbal: a "simple" cross-site POST is not even preflighted.
There are now three settings, all optional, read from the shell that starts `npm run backend`
(rules in `subsystems/osmo-ble/server/access.mjs`):

| Setting | Default | Effect |
|---|---|---|
| `OSMO_BACKEND_TOKEN` | unset: no check | Every route except the CORS preflight needs `Authorization: Bearer <token>`, and `/ws` takes it as `?token=`. The CLI and the MCP server read the same variable; the page has a token field under Connect, Advanced. |
| `BACKEND_ALLOWED_ORIGINS` | the Gimbal control page's own origin: port 8787 on the host the backend was reached at, or a loopback name | A comma list of whole origins replaces the default; `*` restores the old open behaviour. A request with no `Origin` (CLI, MCP, curl) is never refused for its origin. |
| `BACKEND_HOST` | every interface | Bind address, for example `127.0.0.1`. |

The page server takes `WEB_HOST` the same way, and now serves only `web/` and `protocol/`. The
defaults keep the documented rig working: a phone opens `http://<machine>:8787` and points the
page at `http://<machine>:8788`. The origin check runs on the server, before any route, and on
the WebSocket upgrade. A refused page gets a 403 naming the origin to add. The default origin rule
does not stop a DNS-rebinding page served on port 8787. The token, an explicit
`BACKEND_ALLOWED_ORIGINS`, or `BACKEND_HOST=127.0.0.1` closes that. A phone-telemetry sender on
the scanner page (another origin) needs its origin listed, and `?token=` when a token is set.

**Known gotcha:** code changes only take effect once the long-running processes that loaded them
restart — Node doesn't hot-reload modules. `server/backend.mjs` now runs under `node --watch`
(`npm run backend`, restarts itself on save) but the `osmo-gimbal` MCP server subprocess still
needs an explicit `/mcp` reconnect (or a session restart) to pick up code changes or new tools.

**Known gotcha — the gimbal itself can get into a stuck BLE state.** Observed 2026-08-23: after
heavy scan/connect/disconnect churn plus a `bluetoothd` restart on the Mac side, the gimbal started
advertising as two separate peripherals at once (`OM6-E06YAM-1`/`-2`, same manufacturer data) and
refused new connections (`Error: Peripheral already connected`) even after a clean
`disconnect()`/rescan from our side — i.e. this was the *gimbal's* BLE stack wedged, not just ours.
**Fix: a hardware Bluetooth reset on the gimbal itself** — hold the shutter button, mode/switch
button, and trigger together for about a second. If a backend restart + rescan doesn't recover a
connection, try this before assuming it's a code or macOS-side problem.

**Known gotcha — `connected: true` used to be a claim, not a measurement (fixed 2026-08-30).**
After restarting `server/backend.mjs`, `transport.connect()` could fail *after* noble had already
handed over a GATT handle — and the transport kept that handle. `/api/status` then reported
`connected: true` with `lastQuaternion: null`: healthy in the web UI, no telemetry, and every
closed-loop move running with no feedback (each one burning its full `maxMs` and reporting
`timedOut`, which reads as "nearly there"). Every reconnect after that hit
`Error: Peripheral already connected` against that same handle, so only a full process restart
recovered — which is also the one action guaranteed to leave latched motors driving.

Two changes, both in this subsystem:

- **`connected` now means telemetry is flowing.** `/api/status` carries `link`, one of
  `disconnected` / `connecting` / `linked` / `streaming` (see
  `subsystems/osmo-ble/protocol/link_state.mjs`). **`linked` is the state to know**: a GATT handle
  exists so commands go out, but nothing is coming back. The web UI shows it as
  `LINKED BUT NOT STREAMING` with the reason. Routes that need feedback (`/api/move-to`,
  `/api/grid-capture`, both test probes) refuse at `linked`; routes that only write — including
  every stop — still work there, deliberately: a gimbal that has stopped reporting is a gimbal
  whose motors are most likely still latched.
- **A stale handle is dropped and re-established, not trusted.** noble's Linux HCI bindings adopt
  links they did not open, so a connection left behind by the previous backend process is already
  `connected` in a freshly started one. `connect()` now recognises that rejection, drops the
  handle, re-opens, and logs `[ble] <id>: Peripheral already connected — dropping that stale
  handle…`. A failed connect also tears its handle back down, so nothing half-open survives to be
  reported as connected. Regression tests: `npm run test:gimbal:link`.

Note this is distinct from the *gimbal-side* wedge above, which produces the same noble error but
is not recoverable from our side — if the automatic drop/re-open also fails, the error says so,
and the button-combo reset is the next step.

**Known gotcha — an unbonded gimbal ignores motor commands, and it looks like a code bug.**
Two separate problems presented as one symptom here on 2026-08-24, and the first was
misdiagnosed before the second was found. Both are now resolved; the sequence is recorded
because the *misdiagnosis* is the reusable lesson.

**Problem 1 — no macOS Bluetooth bond.** Before bonding, the gimbal honoured roughly one motor
command per connection and then silently ignored everything after it: `speed` at every tick
duration tried (250–900 ms), every settle gap tried (0–8 s), and `recenter` (a different command
type entirely) all left delta under 0.0002 — pure sensor noise, versus 0.02+ for anything that
actually moved. A plain `disconnect()`/`connect()` did not recover it. This looked exactly like
a protocol or timing bug, and was investigated as one at length. It was neither.

**Fix: pair the gimbal to macOS itself.** Running `POST /api/pair-trigger` (see below) surfaced
a *macOS* Bluetooth confirmation dialog — not the app's PIN flow. Accepting it created a real OS
bond, and the lockout vanished immediately: five consecutive `speed` commands all moved the
device, and reversing direction moved it freely at full delta. Note the device may show a plain
confirm rather than a PIN; the `SetPairingPin` handshake in `ble-transport.mjs` is a *different*
mechanism and was never the missing piece.

If motor commands go dead in this pattern, **check System Settings → Bluetooth for a bond before
touching any code.** `paired: false` in `/api/status` does not tell you — that flag is
`ble-transport.mjs`'s own heuristic (`this._paired = true // latch write channel regardless`),
not the OS bond state.

**Update (2026-08-26) — on Linux, neither a device-screen PIN nor a BlueZ prompt appeared.**
Retested from a fresh Linux host (BlueZ, not macOS): `scan_devices` → `connect` (clean service
discovery, `fff5`/`fff3` both present as expected) → `pair_trigger` all completed without error,
and the BLE connection stayed live throughout. But: no PIN appeared on the gimbal's own screen,
and — with a `bluetoothctl` agent (`agent on` / `default-agent`) armed and watching *before* the
trigger was sent — no OS-level pairing/confirmation request reached BlueZ either, unlike the
macOS dialog reported above. `bluetoothctl info <mac>` confirmed `Paired: no, Bonded: no`
throughout. So the 2026-08-21 "PIN is shown on the gimbal's own screen" claim (in Setup, below)
was already superseded by the macOS finding above (it's an OS dialog, not a device PIN) — and
this session found that even that OS-dialog path doesn't reproduce on Linux/BlueZ, at least not
within a few seconds of the trigger write. Root cause is still open: candidates are the gimbal's
screen being asleep (a purely physical state this session couldn't check), a platform difference
in how BlueZ vs. macOS's Bluetooth stack surfaces (or suppresses) the device's pairing request, or
this specific trigger not being sufficient on its own on this firmware. **Don't assume `pair()`
has anything to confirm against on Linux until one of these is actually observed** — check the
gimbal's screen is awake first, cheapest to rule out.

**On Linux, an unbonded gimbal still drives its motors — the macOS "unbonded lockout" did not
reproduce.** A first probe was misread: a single `gimbal_nudge(yaw=20°/s, 400ms)` moved the
quaternion by only ~0.0002 (noise-level), which looks exactly like the macOS lockout signature and
was briefly recorded here as one. It is not. Minutes later, still reporting `Paired: no` /
`Bonded: no` in `bluetoothctl`, `gimbal_sweep` drove the device through **tens of degrees** of real
pan across many steps, with telemetry streaming throughout — and the phone mounted in the cradle
went from "Tracking lost" to 935 and then 3133 SLAM points purely from that motion. So on
Linux/BlueZ the bond is **not** a precondition for motor control.

What the failed nudge actually shows is a **short-pulse / low-speed no-op**, a different problem:
one brief 400 ms pulse does nothing, while the closed loop's repeated sustained commands move the
device fine. Suspected causes are motor ramp-up against a startup deadband, and the first write
being spent latching the `fff5`-vs-`fff3` write candidate. **Don't diagnose a dead gimbal from a
single short nudge** — issue a sustained or repeated command before concluding anything, and on
Linux don't reach for the bond as the explanation.

**Known gotcha — the speed command is a LATCH, and that is how the hardware overheats.**
Found 2026-08-26, the first time this subsystem ran on Linux. The gimbal keeps driving at the
last commanded rate until something tells it otherwise, and stops were only sent on the happy
path. Nothing sent one on a thrown error, an aborted scan, or — the one that actually bit — the
process simply exiting. `npm run backend` runs under `node --watch`, so **every file save
restarted the backend mid-move, dropping the BLE link with the motors still latched**, after
which nothing could reach the gimbal to stop it. It drove against its own end-stop until it
thermally shut itself off, repeatedly, and the shutdowns looked mysterious because they happened
seconds *after* the run appeared to end. Now: `stopMotors()` on every exit path of the move
loop, in grid-capture's `finally`, and on SIGINT/SIGTERM/SIGHUP/SIGUSR2. An all-zero `speed` is
also no longer refused by the scan interlock — refusing it meant the one command that can save
overheating motors was unavailable exactly while a scan was driving them.

**Known gotcha — wedge detection existed but the scanner path skipped it.** Same session. The
grid loop aborts a run when consecutive positions end at the same pose, but the movement-only
branch `continue`d past that check, which lived inline in the photo path — so **scanner/AR mode,
the mode used for autonomous room scans, had no wedge detection at all**. A dome run took the
gimbal through 10 consecutive positions all reporting pan 105.56 / tilt 27.18 (bit-identical),
holding against the jam the whole way, and that is the run that cooked it. The guard is now
`createWedgeGuard()` in `protocol/stall.mjs`, called from both paths, tested against that
captured trace (`npm run test:gimbal:stall`).

**Fixed 2026-08-26 — the control law was bang-bang, and acted 2-3x per measurement.** Three
defects compounded, all now in `protocol/control.mjs` with tests (`npm run test:gimbal:control`):

- **No proportional term.** `Math.sign(error) * speedDegPerSec` commanded a flat 25°/s whether
  the error was 3° or 90°. One 250ms pulse is ~6° of travel against a 3° tolerance *half*-band,
  so the controller's smallest possible step was about twice its own target window — it could
  only land inside tolerance by luck, and otherwise limit-cycled at the step size. Now scaled by
  error (`PROPORTIONAL_GAIN`), floored at `MIN_EFFECTIVE_SPEED_DEG_PER_SEC` because the motors
  ignore very low speeds outright.
- **Acting on stale measurements.** The gimbal re-sends its last orientation rather than staying
  quiet, so frames keep arriving carrying an unchanged value, and the loop issued 2-3 full
  corrections per real measurement — visible as bit-identical float64 angles on consecutive
  ticks in any move history. Gate on the **derived pan/tilt**, not the quaternion: q and -q
  encode the same rotation and the device emits both, so raw-value comparison sees "new data"
  for an identical pose.
- **The sign-flip unlearned correct signs.** It flipped whenever the error grew — but an
  overshoot also grows the error, and there the error has changed *sign*, which
  `Math.sign(error)` already handles. Flipping too reversed the command twice and drove hard the
  wrong way. Only a growing error on the *same side* of zero is a wrong mapping.

**Problem 2 — the closed-loop controller steered on a dead axis.** Even bonded, `move-to` still
ran to timeout. Measured directly: physical pan moves the `roll` channel, while `yaw` sits pinned
at exactly -90.00 ±0.05 regardless of how far the gimbal actually turns. `moveToClosedLoop` read
`yaw`, so its error never changed and it looped until `maxMs` with a flat history. Fixed by
steering on `quatToGimbalControlDeg`'s pan/tilt instead — see "Closed-loop positioning" below.

**The lesson worth keeping:** a gimbal that does not move has at least three unrelated causes
that look identical from the API — no OS bond, a wedged BLE stack (the 2026-08-23 entry above),
and a controller reading a channel that carries no information. A flat `history` array is
consistent with all three. Check the bond first (cheapest), then whether telemetry responds to a
raw `speed` probe at all, and only then suspect the control loop.

## Why no signaling is needed for a passive sweep

The scanner client (`index.html` + `src/capture/*`, `src/ar/*`) never needs to be told a scan is
happening from outside — it already captures purely off the phone's own tracked movement:

- **Auto-capture** (`src/capture/auto-capture.ts`) polls pose ~every 400ms and fires whenever
  the camera has moved ≥0.35m (default) and ≥2.5s has passed since the last capture.
- **Keyframe streaming** (`src/capture/keyframes.ts`) fires on ≥minDistanceM movement or
  ≥minRotationDeg rotation, polled ~every 350ms.

So mounting the phone in the Osmo Mobile 6 and running a gimbal sweep is, from the scanner
client's perspective, indistinguishable from a human moving the phone by hand. For an *exact*
photo count instead of "however many the heuristics trigger," see the grid-capture section below
— it bypasses this scanner client entirely in favor of a plain camera app.

## Setup

1. Install `subsystems/osmo-ble`'s own dependencies: `cd subsystems/osmo-ble && npm install`.
2. Register the MCP server — already done via the `osmo-gimbal` entry in
   [`.mcp.json`](../../.mcp.json) at the repo root (`{"command":"node","args":["subsystems/osmo-ble/server/mcp-server.mjs"]}`,
   a repo-relative path so it works for any clone). Claude Code picks this up automatically.
3. Start the backend yourself, in a real terminal (see the architecture note above for why this
   can't be automated): `cd subsystems/osmo-ble && npm run backend`. First run needs Bluetooth
   granted to the Node process by macOS.
4. From a Claude Code session in this project: `scan_devices` → `connect` → `pair_trigger`, then
   check for a confirmation before calling `pair` — **not necessarily a PIN on the gimbal's own
   screen.** On macOS this has shown up as an OS Bluetooth confirmation dialog instead (see the
   pairing gotcha below); on Linux/BlueZ, as of 2026-08-26 neither a device PIN nor a BlueZ agent
   prompt has been observed to appear at all. Check the gimbal's screen is awake before assuming
   pairing is stuck. Once something confirms, proceed to `gimbal_sweep` or `gimbal_move_to`.

## Closed-loop positioning (`gimbal_move_to`, `gimbal_sweep`, `gimbal_recenter`)

Since the absolute-angle opcode does nothing, "move to an absolute angle" is instead built on top
of the confirmed-working speed command: `moveToClosedLoop` (`server/backend.mjs`) sends speed
corrections in a loop, reading the live quaternion after each tick via `quatToGimbalControlDeg`'s
pan and tilt (`protocol/telemetry.mjs`, shared with the web UI's orientation readout), until the
error is within `toleranceDeg` or `maxMs` elapses. (It read `quatToEulerDeg` until the
feedback-axis fix below.) Two things this does NOT solve, handled defensively instead:
- Euler angles from a tilted device mix axes together — this is a relative-change indicator, not
  a calibrated attitude readout, so "converged" means "close enough," not exact degrees.
- The correspondence between the pan/tilt sign and which physical direction a positive
  commanded speed drives each axis was never independently calibrated. Each axis adaptively flips
  its own sign when a correction makes that axis's error worse on the same side of zero, so a
  wrong initial guess self-corrects rather than diverging (`protocol/control.mjs`).

`gimbal_move_to(yawDeg, pitchDeg)` exposes this as a single step, returning
`{converged, timedOut, ticks, finalYaw, finalPitch, history}` — **check `converged`**, don't
assume a call that returned without erroring actually reached the target.

- **The target is checked first.** `POST /api/move-to` answers **400** for a pan outside the
  reachable arc the backend is using, or a tilt outside -45°..+16°. A running scan still answers
  409 first. That arc is measured from where the tripod stands, or else the built-in fallback, and
  the refusal says which. On the fallback, run `arc-probe` first. The joystick is unaffected.
- `gimbal_sweep` strings several moves together across a yaw range, stepping **along** the arc
  (96 → 180 → -114, never through the front). Both ends must be inside the arc.
- `gimbal_recenter` targets the **centre of the arc in use** (171° on the built-in arc) at tilt 0.
  It used to target pan 0, which is inside the fallback arc's dead zone.

**Fixed 2026-08-24 — the feedback axis was wrong, and it never converged before this.** The loop
read `quatToEulerDeg().yaw`. Measured live on a mounted OM6, that channel is pinned at exactly
-90.00 ±0.05 no matter how far the gimbal pans; the physical pan lands in `roll` instead, while
tilt correctly lands in `pitch`. The two real axes are cleanly decoupled — tilting leaves roll
flat — they were simply mislabeled by a constant frame rotation. So the loop's error never
changed, its adaptive sign-flip had no gradient to work with, and every call ran to `maxMs`
reporting `converged: false` with a flat `history`.

Measurements, three equal pan nudges then three reversing:

```
start        pan(roll)=164.5   yaw=-90.00   tilt(pitch)=0.3
+pan x3      pan=144.8 -> 127.9 -> 105.7    yaw=-90.00 throughout
-pan x3      pan=123.1 -> 144.7 -> 164.2    yaw=-90.00 throughout
```

The loop now steers on `quatToGimbalControlDeg`'s pan/tilt (`protocol/telemetry.mjs`). Verified
after the fix: targets 140°, 165°, 130° and 150° all returned `converged: true` in 7–20 ticks,
landing within the 5° tolerance. `finalYaw`/`finalPitch` in the result are pan/tilt values — the
field names are kept for wire compatibility.

**Still check `converged` rather than assuming success**, and if a run does fail, read the
`history` array and confirm pan/tilt actually change between ticks. A flat history means the
gimbal is not moving at all (see the bond/wedge causes above), which is a different problem from
a move that merely fell short.

**Movement-only rehearsal, live-tested 2026-08-21** (no photo capture — `android-beam-pro-1` was
unreachable at the time): before the closed-loop version existed, the 9-position grid from
`plan_scan_grid` was driven as 8 consecutive relative `gimbal_nudge` calls (delta between
successive targets → speed × duration, e.g. a 20° yaw delta at 30°/s ≈ 667ms), confirming the
grid-traversal *pattern* works end to end (cumulative quaternion delta ≈0.30 start-to-finish) even
before closed-loop absolute positioning existed. Prefer `gimbal_move_to` per-step going forward —
it gets verified convergence instead of open-loop timing.

Other relevant tools: `get_orientation` (poll current facing), `gimbal_nudge` (interactive single
speed move + auto-stop, no positioning), `get_recent_frames` (raw telemetry), `plan_scan_grid`
(see below).

## Stall detection: telling a jam from a slow move

`moveToClosedLoop` returns `stalled: true` when pan/tilt stop changing while the
error is still outside tolerance. Before this existed the loop spun until
`maxMs` regardless, and a jam and a nearly-there move were indistinguishable —
both came back `timedOut`, and the documented remedy was to read the `history`
array by eye.

Measured on 2026-08-26, an OM6 mid-session:

```
move_to(yaw=25), maxMs=30000
  t=0.0s   pan  84.72   error -59.7
  t=1.2s   pan  76.38   error -51.4     <- travelling
  t=2.4s   pan  75.65   error -50.7     <- hit a limit
  t=2.8s   pan  75.65   error -50.7
  ...      pan  75.66   error -50.7     <- 27 further seconds of this
  t=29.8s  pan  75.66   error -50.7
  => converged:false timedOut:true
```

Nothing about that result says "stop asking". It now returns after ~2.5s with
`stalled: true` and a reason naming the remedy.

**Thresholds** (`subsystems/osmo-ble/protocol/stall.mjs`): a tick that is really
driving the motors moves pan 5–15°; a wedged axis reports ~0.005°. The
`STALL_EPSILON_DEG = 0.25` cut sits two orders of magnitude above that noise
floor and an order below the smallest real step, so the two populations do not
overlap and it needs no tuning. `STALL_TICKS_LIMIT = 6` is ~2.4s at the default
tick.

This is the *common* end state, not an edge case — sweeps in one session
degraded 18 → 11 → 9 → 4 positions before jamming. Every caller benefits:
`gimbal_move_to`, `gimbal_sweep`, grid capture, and the CLI all route through
this one function.

Pan is compared with wrapping, because a sweep crosses ±180: unwrapped, one
seam crossing reads as a 340° leap and resets the counter, so a gimbal that
jammed just after the seam would keep looking alive.

Regression tests (`npm run test:gimbal:stall`) run against the two verbatim
telemetry runs above — a real jam and a real healthy move — rather than
synthetic fixtures, because this failure only appears on tired hardware and
cannot be reproduced on demand.

### The sign probe (why a "jam" is usually not a jam)

Before declaring a jam the loop flips the correction sign once and drives again
for a full stall budget. This is not defensive padding — it is the common case.

Measured 2026-08-26. A move was reported jammed at pan −53.6 three times in a
row, and the message told the operator to power-cycle. A raw `gimbal_nudge` of
+40°/s then moved it 20°, proving the hardware was fine. With the flip:

```
t=0.0–2.4s   pan −53.6   stuck, 6 stalled ticks  -> flip sign
t=2.8s       pan −59.8   moving
t=4.8s       pan −90.9
t=6.9s       pan −122.7  converged
```

The correction sign is derived from an approximate Euler decomposition of the
live quaternion, and it does not hold at every pose. When it is wrong the loop
drives into a limit and sits there, which is indistinguishable from a jam by
observation alone. The flip costs ~2.4s and turns a false diagnosis into a
recovery.

The state machine lives in `protocol/stall.mjs` as `createStallGuard()` rather
than as flags in the control loop, because the inline version grew two
control-flow bugs in one sitting — a `continue` that never commanded the
flipped direction, and a missing `else` that flipped and gave up in the same
tick. Both were invisible except as a nonsense "0 consecutive ticks" in the
error string. 13 regression tests cover it.

### Known pan limit on this rig

*Superseded by the reachable-arc model (2026-08-29, subsystem README): the limit is a stop fixed
to the tripod base, so it moves whenever the tripod does. Measure it with `arc-probe`. The
observations below are the history that led there.*

As of 2026-08-26 the pan axis will not travel past about **−53.5°**. Three
independent moves stalled there, and the sign probe confirmed neither direction
gets past it. Usable range is roughly **−145° to −53.5°** — about 90°, which is
enough for a sweep, but a scan grid spanning wider will stall at the boundary.

The limit is not fixed across sessions: before a power-cycle earlier the same
day it sat at **+75.7°** instead. That is consistent with a follow-mode range
measured relative to wherever the handle was when the gimbal booted, not a
mechanical stop — so re-measure it after any restart rather than hard-coding
either number.

### When it fires

`stalled: true` means the axis is jammed or at a limit. A longer `maxMs` will
not help. Recenter, or power-cycle the gimbal. If it has also stopped
advertising over BLE (`scan_devices` shows no `likelyOsmo` device), that is the
separate gimbal-side BLE wedge documented below, and needs the physical
button-combo reset.

## Automated N-shot grid capture → Companion Scan's real ingest pipeline

**The whole run is one command now.** The manual tool-by-tool sequence below still describes what
happens, and is what you want when driving it from an MCP client, but you no longer have to
orchestrate it by hand:

> **Verified end to end on real hardware, 2026-08-24.** One `npm run cli -- grid --ingest …`
> invocation: 9/9 positions converged (2–27 ticks each), 9 photos captured on the phone in the
> cradle, all 9 byte-distinct, `droppedBlurry: 0`, ingest job completed and the scan registered
> in the world as `status: ready`. The reconstruction itself reported its usual honest
> `skipped: No module named 'lingbot_map'` — that worker is not installed on this box. The CLI
> released the phone's MCP session on exit, confirmed by a fresh client being able to connect
> immediately afterwards.
>
> **A CPU pose solver exists now, but it does not rescue *this* path.** `/ingest-photos` still
> auto-enqueues `lingbot-map-reconstruct`, so that same `No module named 'lingbot_map'` skip is
> still what a box without the GPU worker shows. Queueing a `splat-train` now auto-chains a
> **`colmap-poses`** job that solves camera poses on CPU — but COLMAP needs parallax, and a
> gimbal pivoting on one spot produces none. See the parallax warning further down this section
> before assuming it applies here.

```bash
npm run cli -- grid --dry-run                       # print the plan, touch nothing
npm run cli -- grid --stations 4                    # 4 stations x 14 positions, reach probed at each
npm run cli -- grid --stations 4 --ingest http://localhost:8000/ingest-photos
npm run cli -- grid --pans 100,130,160 --tilts -15,0,15 --out ./myscan
npm run cli -- stop                                 # stop a running capture, from any terminal
```

(The verified 2026-08-24 run above was the CLI's default plan of the time, 3 x 3 from one spot.)

or press **Run scan** in the Scanner Control web UI (`npm run web`), which shows per-position
progress live. Both call `POST /api/grid-capture` on the backend, which is where the
orchestration actually lives — deliberately, so exactly one process ever holds an MCP session to
the phone.

**Both front-ends default to the same dome shape, 7 pan columns x 2 tilt rows = 14 positions per
station.** They send it differently:

- **The CLI** defaults to 150° of pan centred on the arc in use, at a 25° step, crossed with tilts
  -25° and 0°. The 25° step clears the scanner's 20° keyframe threshold. Without `--pans` it posts
  the centre and span, not the columns, so the backend **measures the reach at the start of every
  station** and re-plans the columns inside it, keeping their count. `--no-probe-arc` skips that.
  Until wave 14 the CLI posted the columns, so it never probed and `--no-probe-arc` did nothing.
  This behaviour is new on the rig and needs a rig run.
- **The web UI** defaults to the **Dome** preset (96° → -114° on the built-in arc, tilts -25° and
  +5°). It builds and checks the columns against the arc the backend reports in its status, and
  posts them as an explicit list. Explicit columns are the caller's, so the backend does not
  probe or move them per station. Switching the page to a centre/span plan is an owner decision.
  The Capture select is sent with the plan: **Scanner app** posts `capturePhotos: false`.

Either way the backend refuses manual motion commands with a 409 while a run sweeps, and stops
refusing them while it is parked. `POST /api/grid-stop` ends a run cleanly between positions, or
at once while parked; the page, the CLI and MCP all call it (see the 2026-08-25 update above).
**Run scan does not ingest anything.** Only the CLI's `--ingest` posts the photos to
`/ingest-photos`. A page-started camera run leaves them on the phone, and each result row links
to its photo.

**Prerequisite — the phone's MCP URL and token:** set `ANDROID_MCP_URL` and `ANDROID_MCP_TOKEN`
in the *backend's* environment (the CLI can also pass `--device-url` / `--device-token`). The
per-device token variables in `.env.example` are the same values; see
[DEVICE_TESTING.md](../testing/DEVICE_TESTING.md) for the fleet table.

> **The phone caps concurrent MCP sessions, and a Claude Code session counts.** Verified
> 2026-08-24: with Claude Code attached to `android-beam-pro-1`, every backend `initialize`
> returned `503 {"error":"Too many active sessions"}`. There is no way around it — probing the
> device with a valid token showed that apart from `/mcp`, `/health` and the `/s/<hash>` share
> URLs, every path 404s, so MCP is the only control interface and there is no REST fallback.
> The backend therefore opens a session, runs the grid, and `DELETE`s it, holding the slot only
> for the duration of a capture — but it still cannot run while another client is attached.
> **Detach the phone's MCP server in Claude Code before running a grid capture from the CLI or
> web UI.**

A non-converged position is recorded, not fatal — the photo is still taken and the result
carries `converged: false`. Aborting would throw away the frames already captured, and a frame
from a position that is merely close is usually still usable; the caller decides.

The CLI also checks that the downloaded frames are byte-distinct and warns if they are not.
That is not a formality: wave 04 hit a stalled camera returning six byte-identical JPEGs across
47 minutes, and nothing notices unless something compares them.

### The underlying sequence

For an *exact* photo count (e.g. "9 photos") rather than relying on auto-capture heuristics,
drive an explicit camera-capture tool instead — verified against this repo's actual capture→3D
pipeline, not invented:

1. `plan_scan_grid` (in `osmo-gimbal`, no device needed) — returns a serpentine-ordered
   `yawCount x pitchCount` grid of absolute `(yawDeg, pitchDeg)` targets for ONE station, planned
   along the reachable arc the backend reports (the built-in one when no backend answers).
   Defaults to 7 x 2 = 14 targets, minimizing travel between consecutive steps.
2. For each target: `gimbal_move_to(yawDeg, pitchDeg)` — closed-loop move, check `converged` in
   the result (see "Closed-loop positioning" above) before treating the step as actually there.
3. Immediately after each move: a photo-capture tool call on whichever Android device is
   physically mounted in the gimbal cradle — `android_take_camera_photo` or
   `android_save_camera_photo` on that device's MCP server (e.g. `android-beam-pro-1`), using its
   **plain camera app**, not the AR scanner page. (This mode doesn't need live SLAM tracking —
   that's what the passive sweep above is for.)
4. `POST /ingest-photos` (`main.ts:809-903`, multipart `files: File[]`, optional `name`) with the
   collected photos → `202 {sessionId, scanId, jobId, frameCount, droppedBlurry}`. This is the
   real, already-built ingest path for a pose-less photo batch: it EXIF-orders, blur-filters, and
   auto-enqueues a `lingbot-map-reconstruct` job (pose estimation runs server-side, on GPU).
5. Poll `GET /worlds/default/jobs` for that `jobId` until `status` is `completed` or `failed`.
6. The completed job's artifact exposes `pointCloudUrl: /sessions/{sessionId}/lingbot-map.point-cloud.ply`
   and `posesUrl: .../lingbot-map.poses.json`.
7. **On a box without the LingBot-Map Python worker, step 4's job skips and there is no point
   cloud.** A `colmap-poses` job is the CPU alternative for pose-less sessions in general — but
   read the warning immediately below before reaching for it here.

> ⚠️ **A gimbal turning in place is the exact capture structure-from-motion cannot solve, and
> that is geometry, not a setting.** SfM needs **parallax** — the camera must *translate*, not
> just rotate. Views from a rig pivoting on one spot are related by a homography, from which no
> depth can be triangulated at any resolution, with any feature detector, on any GPU.
> [`../pipelines/colmap-poses.md`](../pipelines/colmap-poses.md) names a gimbal explicitly as
> this failure case; COLMAP's own diagnosis is `PLANAR_OR_PANORAMIC` two-view geometries with no
> `CALIBRATED` ones.
>
> **Measured on this rig:** a capture confined to one narrow station classified **29 of 36 image
> pairs as `PLANAR_OR_PANORAMIC` and registered only 4 of 9 images.** A wider sweep measurably
> helps — the phone's lens sits off the pan/tilt axes, so a big pan does produce a small
> baseline, and each station simply sees more of the room — which is why the web UI defaults to
> its widest preset. But a wider sweep does not *manufacture* translation. For a well-conditioned
> capture the rig has to be physically moved between grids. That is now built in: `--stations N`
> in the CLI and the Stations field on the page park the run between domes while the tripod is
> carried. Measured over this rig's frames: one dome from one spot registered 3 of 17 images, and
> 5 stations registered 36 of 36 (see "Multi-station capture" in the subsystem README).
>
> LingBot-Map is a different kind of model — a feed-forward transformer that predicts geometry
> rather than triangulating it — so it is not bound by this constraint, which is part of why
> this path was built around it in the first place.

**Hardware limits the presets stay inside** (probed on the real OM6, so treat them as the
envelope for any `--pans`/`--tilts` you write by hand). Pan travels about **178°** and **cannot
rotate through the front**. The built-in arc runs +82° round *through* 180° to -100°, so a sweep
does cross the ±180 seam. Where that arc falls moves with the tripod base, so measure it with
`arc-probe` after every carry (the subsystem README's "reachable pan arc" sections). Tilt
converges down to about **−40°** but **stalls near +16°**, a real mechanical limit rather than a
display choice; the routes refuse tilts outside -45°..+16°. (An earlier note here said pan swept
±175° provided no move crossed the seam. That predates the arc being measured.)

**Correction to a common assumption:** this pipeline's real end artifact is a point cloud /
gaussian splat (`.ply`/`.sog`), not a GLTF — a `.glb` only exists as an optional lossy sidecar
(`server/lingbot-map/lingbot_map_glb.ts`) or as the *separate*, unrelated `server/pipeline.ts` (which optimizes a
pre-existing mobile-exported `.glb`, not something this pipeline produces). A full gaussian splat
is a further, manually-enqueued `splat-train` job — worth doing, but 9 sparse gridded photos is
thin input for 3DGS quality; the point cloud is the realistic fast result from one run. (This is
the same coverage problem the parallax warning above quantifies — it is why the control page now
defaults to a four-station dome rather than one grid from one spot. The CLI's `grid` still defaults to one
station: pass `--stations 3` or more for a capture meant to reconstruct.)

**And note what a splat from this path is *not*: measured.** Structure-from-motion is
scale-blind, so a reconstruction from gridded photos has no metres in it at any stage. Nothing
in this capture path is calibrated — a gimbal grid records no physically measured distance — so
the `splat-align` job that supplies metric scale will correctly *skip* on these scans. Do not
read dimensions off the result.

This whole sequence is inherently cross-MCP-server (gimbal moves from `osmo-gimbal`, photos from
an `android-*` server, ingest via a plain HTTP call to this repo's own Deno server) — no single
tool call does all of it, since MCP servers can't call each other's tools. Whatever orchestrates
the loop (an interactive Claude Code session, or a script written against all three) is what
makes it "one call" in practice.

## Android capture device (MCP) setup

The Android device mounted in the gimbal cradle is driven the same way as this repo's other test
devices — via `danielealbano/android-remote-control-mcp`, an accessibility-service-based remote
control app running on-device, exposed as an HTTP MCP server over Tailscale.

**Registration** (already done for the known devices) — an entry per device in *both* this
project's [`.mcp.json`](../../.mcp.json) and the user's global `~/.claude.json` `mcpServers` (so any
project/session can reach it, not just this one):
```json
"android-beam-pro-1": {
  "type": "http",
  "url": "http://beam-pro-1.<tailnet>.ts.net:8080/mcp",
  "headers": { "Authorization": "Bearer ${ANDROID_MCP_TOKEN_BEAM_PRO_1}" }
}
```
The bearer token comes from `${ANDROID_MCP_TOKEN_BEAM_PRO_1}`, an env var sourced from
`~/.claude/settings.json`'s `env` block — **not** a project `.env` file, which Claude Code does
not auto-load for this purpose.

**When a device's MCP connection is down** (confirmed to happen mid-session — the exact failure
this section exists to cover): reconnecting the on-device app is necessary but not always
sufficient; Claude Code's own client-side connection to that server may also need re-establishing.
Troubleshooting order:
1. On the device itself: confirm the Android Remote Control MCP app is running/foregrounded (its
   own persistent notification, "MCP Server Running", should be present in the notification
   shade — if it's gone, the app process died and needs relaunching).
2. Confirm network reachability from this Mac: `tailscale ping <device>.<tailnet>.ts.net`.
3. From an interactive Claude Code session, reconnect the specific server via `/mcp` (or restart
   the session) — a session that failed to connect at startup does not necessarily keep retrying
   indefinitely on its own, and fixing the device side alone does not re-establish an already-
   failed session-level connection.

## Verification status

What has run on the real gimbal, and when:

- **Backend + MCP proxy**: `gimbal_move_to` through the MCP server returns without erroring.
  **Done, 2026-08-21.**
- **Closed-loop convergence**: targets 140°, 165°, 130° and 150° returned `converged: true` in
  7–20 ticks after the feedback-axis fix. **Done, 2026-08-24** (see "Closed-loop positioning").
- **Dev-loop**: a save restarts the watched backend, which drops the BLE link every time, so
  reconnect after each code change. Since 2026-08-26 the restart stops the motors first (the
  latch gotcha above). **Confirmed.**
- **Full pipeline**: `npm run cli -- grid --ingest …` gave 9/9 positions converged, 9 byte-distinct
  photos, and the ingest job completed. **Done, 2026-08-24.** Judging the point cloud was not
  possible: the reconstruction step skipped without the LingBot-Map worker.
- **Reach probe**: 7 moves, 85 s, both stops found, and a second probe agreed within 0.1°.
  **Done, 2026-08-30** (subsystem README).

**Changed without a rig (wave 14, 2026-11-23). Each of these needs a rig run:**

- A CLI `grid` with no `--pans` now probes the reach at every station and re-plans.
  `--no-probe-arc` skips that.
- A page run with Capture set to **Scanner app** takes no photos and needs no phone token.
- **Stop scan** on the page, `cli stop`, Ctrl-C in `cli grid` and MCP `stop_grid_capture` each end
  a sweeping run after its current position and a parked run at once.
- While a run is parked, the joystick and Center work from the page, and Photo stays off.
- `gimbal_recenter` lands at the arc centre. `move-to` and `gimbal_sweep` refuse targets outside
  the arc.
- With `OSMO_BACKEND_TOKEN` set, the page (token under Advanced), the CLI and the MCP server all
  still connect. With the defaults, a phone that opens the page by the machine's name still
  reaches the backend.

## Open questions for a deeper integration

- Whether to register `osmo-gimbal` as the Tailscale-exposed `http` MCP server by default. The
  transport exists (`--http`, with `OSMO_MCP_TOKEN` required; see the subsystem README), and so do
  the backend's own access settings above. `.mcp.json` still registers stdio.
- Whether `dwellMs` needs tuning against this project's actual `minDistanceM`/`minRotationDeg`
  thresholds (check `src/capture/auto-capture.ts` and `src/capture/keyframes.ts`) for the
  *passive* sweep path specifically — the grid-capture path above sidesteps this by using
  explicit photo capture instead.
- Whether the closed loop needs more than the proportional control law and sign probe it now has
  (`protocol/control.mjs`, `protocol/stall.mjs`). It converges on live hardware (2026-08-24) and no
  longer limit-cycles (2026-08-26). Untested across a full multi-station dome after wave 14's
  changes.
- Whether the gimbal dropping off BLE advertising mid-session (observed 2026-08-21, cause
  unconfirmed — battery/sleep timeout/handling) needs a documented wake procedure once understood.
