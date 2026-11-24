// The Gimbal control page's rules, as pure functions: which controls are live, what the status
// dot shows, how far the progress bar is, what a preset means against the arc in use, and what
// Run scan sends.
//
// No DOM, so Node tests them (tests/unit/node/gimbal_page_state.test.ts) and backend-client.mjs
// only applies them. These rules used to be spread across a dozen enable/disable sites, and they
// disagreed. Run unlocked on the linked tier in one place and the streaming tier in another. Photo
// and Run re-enabled themselves in their own `finally` whatever the state. A parked run kept the
// manual controls locked, though the backend lets them through.

import {
  toArcDeg, fromArcDeg, unreachablePans, describeArc, DEFAULT_PAN_ARC, MIN_STATIONS_FOR_PARALLAX,
  SCANNER_MIN_ROTATION_DEG, DOME_PAN_STEP_DEG,
} from '../protocol/dome.mjs';

/**
 * A few hundred positions is hours of gimbal-and-phone time, and a mistyped step is the easy way
 * to ask for one by accident (a step of 0 would not terminate at all). Generation stops at this
 * many values per axis, and the summary says so rather than truncating in silence.
 */
export const MAX_STEPS_PER_AXIS = 60;

/**
 * Which controls may be pressed: one decision, from what the link can do and what the capture is
 * doing.
 *
 * - `linked`: a GATT handle exists, so commands go out. Everything that only WRITES stays available
 *   here, deliberately including the joystick. A gimbal that has stopped reporting is a gimbal
 *   whose motors may well be latched and driving, and taking the manual controls away exactly
 *   then removes the operator's only way to stop it.
 * - `streaming`: notifications are arriving. Only this tier unlocks what READS telemetry back: Run
 *   (closed-loop at every position) and the test probes (a before/after pose comparison).
 * - `scanning` / `parked`: while a capture sweeps, the backend refuses every outside motion with a
 *   409, so the manual controls are locked. While it is parked between stations the backend lets
 *   them through, because nothing is driving the motors and the operator is handling the rig, so
 *   they come back.
 * - Photo and Photo x2 stay locked for the whole run, parked included. Photos go through the
 *   phone's MCP server, which takes one session at a time, and a camera-mode capture holds that
 *   session from its first station to its last.
 *
 * @param {object} s
 * @param {boolean} [s.backendUp]  the page's WebSocket to the backend is open
 * @param {boolean} [s.linked]
 * @param {boolean} [s.streaming]
 * @param {boolean} [s.scanning]  a capture owns the gimbal
 * @param {boolean} [s.parked]  that capture is waiting for the tripod to be moved
 * @param {boolean} [s.planReachable]  every pan column is inside the arc in use
 * @param {boolean} [s.testRoutes]  the backend was started with BACKEND_TEST_ROUTES=1
 * @param {{ run?: boolean, stop?: boolean, photo?: boolean }} [s.busy]  a request of that kind is in flight
 */
export function controlStates({
  backendUp = false, linked = false, streaming = false, scanning = false, parked = false,
  planReachable = true, testRoutes = false, busy = {},
} = {}) {
  const motionFree = !scanning || parked;
  return {
    /** Disconnect, the PIN field and Pair. */
    linkControls: linked,
    /** The joystick, Center, the orientation and stick buttons, and raw send. */
    manual: linked && motionFree,
    /** Photo and Photo x2. */
    photo: linked && !scanning && !busy.photo,
    /** The command test matrix. */
    tests: streaming && testRoutes && motionFree,
    /** Run scan. */
    run: streaming && !scanning && planReachable && !busy.run,
    /** Stop scan: works sweeping or parked, and needs no gimbal link, only the backend. */
    stop: backendUp && scanning && !busy.stop,
  };
}

/**
 * Whether a pathway's status dot is green.
 *
 * Each client now says what its link is, as a `data-link` attribute on its status text. That is
 * what decides, when it is there. The dot used to classify the text alone, and it matched only
 * "connected" or "paired", so the Server dot stayed amber while telemetry streamed ("backend:
 * streaming telemetry"). Adding "streaming" to that match would have turned "LINKED BUT NOT
 * STREAMING" green. The text rule is kept for a status with no attribute, and checks the negative
 * phrases first.
 */
export function statusDotOn({ link, text } = {}) {
  if (typeof link === 'string' && link) return link === 'streaming' || link === 'connected';
  const t = String(text ?? '').toLowerCase();
  if (/not reachable|not connected|disconnected|not streaming|refused/.test(t)) return false;
  return /\bstreaming\b|\bconnected\b|\bpaired\b/.test(t);
}

/**
 * The progress bar's width (0-100) for one grid-progress event, or null to leave it where it is.
 *
 * Every position moves it, on `moving` as well as `capturing`. The moving branch used to return
 * before the shared update, so the bar only ever stepped on `capturing`. A new run starts it at 0
 * instead of where the last one left it. A run that finished every station fills it.
 */
export function progressPercent(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.phase === 'start') return 0;
  if ((msg.phase === 'moving' || msg.phase === 'capturing' || msg.phase === 'captured') && msg.total > 0) {
    return Math.max(0, Math.min(100, Math.round((msg.position / msg.total) * 100)));
  }
  if (msg.phase === 'done' && msg.complete) return 100;
  return null;
}

/**
 * What Run scan posts to /api/grid-capture.
 *
 * The Capture choice decides whether the backend takes photos over the phone's MCP server. It was
 * never sent, so the backend fell back to photos and every page-started run photographed, whatever
 * the select said. Scanner app means the phone's scanner page captures its own pose-tagged
 * keyframes, so no photo is taken, no phone token is needed, and "both orientations" (two photos
 * per position) does not apply.
 */
export function gridRequestBody({ pans, tilts, stations, captureMode, bothOrientations }) {
  const scanner = captureMode === 'scanner';
  return {
    pans,
    tilts,
    stations,
    capturePhotos: !scanner,
    bothOrientations: !scanner && Boolean(bothOrientations),
  };
}

/** Values from `from` to `to` (either order) every `step`, capped at MAX_STEPS_PER_AXIS. */
export function axisValues({ from, to, step }) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const stride = Math.max(1, Math.abs(step));
  const out = [];
  // The 1e-9 slack keeps the far endpoint in when lo/hi/stride divide evenly but land a hair
  // under hi through float accumulation.
  for (let v = lo; v <= hi + 1e-9 && out.length < MAX_STEPS_PER_AXIS; v += stride) {
    out.push(Math.round(v * 10) / 10);
  }
  return out;
}

/**
 * Pan columns, generated ALONG the reachable arc in use rather than numerically between two degrees.
 *
 * axisValues() sorts from/to and walks upward, which is right for tilt and wrong for pan. Pan's
 * reachable travel crosses the +/-180 seam, so the numerically smaller end is often the one
 * further round the arc: 96 -> -114 walked numerically is -114..96, the entire dead zone, and
 * walked along the arc it is the intended 96 -> 180 -> -114.
 *
 * `arc` is the backend's (arcFromPayload of its status). It used to be the built-in fallback
 * always, while the backend refused against its measured arc.
 */
export function panColumns({ from, to, step }, arc = DEFAULT_PAN_ARC) {
  return axisValues({ from: toArcDeg(from, arc), to: toArcDeg(to, arc), step })
    .map((a) => Math.round(fromArcDeg(a) * 10) / 10);
}

/**
 * The scan presets, each a dome shape relative to the arc in use rather than fixed angles. So
 * after a probe has measured the arc somewhere else, Dome still means "150 degrees across the
 * middle of what this gimbal can reach from here", not columns past its stop.
 *
 * On the built-in arc (centre 171) they come out with the column counts the fixed presets had:
 * - Dome: 96 -> -114, step 25, 7 columns.
 * - Quick: 111 -> -129, step 40, 4 columns.
 * - Band: 91 -> -109, step 20, 9 columns, 9 degrees inside each stop. The old fixed numbers were
 *   92 -> -104, whose last column landed at -108.
 *
 * Ordered widest-first, and Dome is the default. Reconstruction quality is driven by how much of
 * the room each station sees, and the failure this pipeline keeps hitting is too FEW viewing
 * angles. A measured example from this rig: a capture confined to one narrow station classified
 * 29 of 36 image pairs PLANAR_OR_PANORAMIC and registered only 4 of 9 images.
 *
 * Tilt rows stay fixed angles: tilt's stops (about -40 and +16) do not move with the tripod. The
 * interior rows are interpolations between tilts that were run on hardware, a plan choice rather
 * than a re-measurement.
 */
export const SCAN_PRESETS = {
  // 7 columns x 2 rows = 14 positions per station. At 4 stations that is 56 frames, sized against
  // the capture that actually reconstructed: 5 stations, 36 images, all 36 registered.
  dome: { pan: { spanDeg: 150, step: DOME_PAN_STEP_DEG }, tilt: { from: -25, to: 5, step: 30 } },
  // A coarse pass for checking the rig works, not for reconstructing: 4 columns x 2 rows. Still
  // multi-station, because a single-station capture is degenerate at any density.
  quick25: { pan: { spanDeg: 120, step: 40 }, tilt: { from: -20, to: 5, step: 25 } },
  // Wide and shallow, for long or corridor-shaped rooms, where the useful information is spread
  // around the horizon: nearly the whole arc, as many 20-degree columns as fit at least 8 degrees
  // inside each stop.
  band: { pan: { insetDeg: 8, step: 20 }, tilt: { from: -15, to: 5, step: 20 } },
};

/**
 * The from/to/step fields a preset fills in, against `arc`, or null for an unknown name (Custom).
 *
 * The span is a whole number of steps, so the last column lands on `to`. A span that is not used
 * to stop a step short, which silently dropped Band's ninth column. The ends are whole degrees for
 * the fields, rounded INWARD. An end rounded outward can land a fraction past a stop, and there it
 * reads as the far side of the dead zone, so a whole preset came out unreachable.
 */
export function presetFields(name, arc = DEFAULT_PAN_ARC) {
  const preset = SCAN_PRESETS[name];
  if (!preset) return null;
  const { step } = preset.pan;
  const width = arc.endArc - arc.startArc;
  const wanted = preset.pan.spanDeg ?? Math.max(0, width - 2 * (preset.pan.insetDeg ?? 0));
  let span = Math.max(0, Math.floor(Math.min(width, wanted) / step + 1e-9) * step);
  const centre = (arc.startArc + arc.endArc) / 2;
  const lo = Math.ceil(centre - span / 2 - 1e-9);
  // Rounding the near end up can push the far end past the arc; give back one step if it did.
  if (lo + span > arc.endArc + 1e-9) span = Math.max(0, span - step);
  return {
    pan: { from: Math.round(fromArcDeg(lo)), to: Math.round(fromArcDeg(lo + span)), step },
    tilt: { ...preset.tilt },
  };
}

/**
 * Everything the summary line says about a plan, and whether Run may be pressed for it.
 *
 * A plan that crosses the dead zone is refused here, against the arc the backend will check it
 * against, rather than by the backend two seconds into a run. The operator is looking at the
 * fields that caused it.
 *
 * @returns {{ perStation: number, total: number, reachable: boolean, warnings: string[], capped: boolean }}
 */
export function planSummary({ pans, tilts, stations, arc = DEFAULT_PAN_ARC, captureMode, panStep, tiltStep }) {
  const perStation = pans.length * tilts.length;
  const warnings = [];
  const unreachable = unreachablePans(pans, arc);
  if (unreachable.length) {
    warnings.push(`${unreachable.length} column(s) are past a stop of the arc in use `
      + `(${unreachable.map((u) => `${u.pan}°`).join(', ')}): pan can only travel ${describeArc(arc)}`);
  }
  // Stations, not positions, decide whether this can be reconstructed at all. Measured: one dome
  // from one spot registered 3 of 17 images; five stations registered 36 of 36.
  if (stations < MIN_STATIONS_FOR_PARALLAX) {
    warnings.push('one station is pure rotation: no baseline to triangulate against '
      + '(3 of 17 images registered, measured). Use 3–5 stations.');
  }
  // Scanner mode has a step floor that camera mode does not, and getting it wrong fails silently.
  // The scanner emits a keyframe only once the camera has rotated SCANNER_MIN_ROTATION_DEG, so a
  // finer grid drives the gimbal through positions that capture nothing, and the run still reports
  // them all "converged".
  if (captureMode === 'scanner') {
    const tooFine = [
      panStep && Math.abs(panStep) < SCANNER_MIN_ROTATION_DEG ? `pan ${Math.abs(panStep)}°` : null,
      tiltStep && Math.abs(tiltStep) < SCANNER_MIN_ROTATION_DEG ? `tilt ${Math.abs(tiltStep)}°` : null,
    ].filter(Boolean);
    if (tooFine.length) {
      warnings.push(`${tooFine.join(' and ')} below the scanner's ${SCANNER_MIN_ROTATION_DEG}° keyframe threshold: those positions capture nothing`);
    }
  }
  return {
    perStation,
    total: perStation * stations,
    reachable: unreachable.length === 0,
    warnings,
    capped: pans.length >= MAX_STEPS_PER_AXIS || tilts.length >= MAX_STEPS_PER_AXIS,
  };
}

/** Stations requested, floored at 1 and capped at 12 like the backend. An empty field is not zero. */
export function stationCount(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(12, n) : 1;
}
