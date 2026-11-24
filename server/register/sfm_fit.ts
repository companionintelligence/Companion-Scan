/**
 * What the photo method (place_register_sfm.ts) does to a session's fit before it believes it: leave out the photographs COLMAP
 * placed wrongly, and say how well the camera path can fix the turn and the size at all.
 *
 * Both are about one fit of a session's recorded AR camera positions to the positions COLMAP solved for the same photographs
 * (`fitSessionToSolver`, sim3_chain.ts, which this file calls and does not repeat).
 *
 * ## Leaving out what does not agree
 *
 * A least-squares fit follows a few badly placed photographs as far as their share allows: a photograph COLMAP placed a metre
 * from where its camera was moves the size and the turn the fit reports, and keeps the RMS under the gate that refuses a fit
 * outright. So the fit is made again without the worst of them: fit everything, drop the one frame whose solved camera is farthest
 * (and more than the inlier gate, `INLIER_GATE_M`, the gate the proposal already counts inliers by) from where the fit puts its
 * recorded camera, fit what is left, and look again, until every frame that is left is inside the gate. One at a time, because a
 * few wrong frames drag the first fit toward themselves and push good frames out past the gate beside them: dropping everything
 * beyond the gate at once would take those with them (in 3,875 simulated cases, rooms of 10 to 30 photographs with up to 40% of
 * them placed 0.2 to 1.4 m wrong and up to 5 cm of noise, no photograph that was dropped agreed with the fit that was left).
 *
 * What "agree" means is therefore the inlier gate and a share: a fit is made when at least `minShare` of the paired frames (and at
 * least `minFrames`) are within the gate of it, and refused as a residual that is too high when fewer are, because what the camera
 * path and the solve say about each other is not one path. The plain fit's own residual gate (`DEFAULT_MAX_RESIDUAL_M`, 0.25 in the
 * session's own units) is still applied to the frames that are kept, and cannot fire for them unless the session's unit is under 0.6
 * Place metres: every frame kept is within 15 cm of the fit, so their RMS is. That is a change from the gate alone as the brief had it
 * (a fit of every frame with an RMS past 0.25 refused), and it is both stricter (a fit whose frames are all 0.2 m out has few within
 * the gate and is refused, where the RMS alone let it through) and more tolerant (a few gross outliers no longer sink an otherwise good
 * fit). Listed under needsDecision.
 *
 * ## How well the path fixes the turn and the size
 *
 * With `n` frames, a path whose cameras lie `R` from their middle on average (root mean square), and a fit that leaves an RMS
 * gap `rho` between each recorded and solved camera, the standard error of the fitted size, as a fraction of it, and of the turn
 * about up, in radians, are
 *
 *     size = rho / (R3 * sqrt(3n - 7))        turn = rho / (Rh * sqrt(3n - 7))
 *
 * where `R3` is the path's radius in three dimensions and `Rh` its radius across the floor. This is Umeyama's closed form under
 * independent noise on every camera position: the noise per axis is estimated from the residual with the seven fitted numbers
 * taken off the degrees of freedom (3n - 7), and a size and a turn are each fixed by how far from the middle the cameras are.
 *
 * **Validated range.** Against 600 simulated pairs of fits per cell (a ring of cameras, radius 0.3 to 2 m, 8 to 36 frames, 1 to 5 cm
 * of noise per axis on both the recorded and the solved positions, nothing left out) the scatter of the ratio of two fits' sizes and
 * of the difference of their turns was within 8% of what these give for the two, in every one of seven cells (the worst is the turn at
 * a radius of 0.35 m, 2.13 degrees against 1.98); tests/unit/server/sfm_fit.test.ts runs a seeded version and holds it to 15%.
 * Through {@link fitWithTrim}, with `rho` as it gives it, 300 pairs a cell on rings of radius 0.8 and 1.2 m: within 11% up to 4 cm of
 * noise per axis (5 to 6% of the frames left out), within 14% at 5 cm (16 to 18% left out), and 20 to 30% low at 6 cm (27 to 30%
 * left out), where a registration is near the edge of being refused for too few agreeing frames anyway (at 7 cm 25 of 300 pairs
 * were fitted at radius 1.2 m and 65 of 300 at 0.8 m). Past about 20% of the frames left out the estimate reads low, because the fit is made from a
 * subset chosen by its own residuals and a formula for noise that is independent of that choice cannot see the extra scatter.
 *
 * What it says. A walk round a room (radius 0.8 to 3 m) at 3 cm of noise fixes the turn of a registration (two fits) to under a degree
 * and the size to 1.5% or better. A stand-and-pan (radius 0.3 m) at the same noise fixes it to 2 degrees and 4%: the photographs say where
 * the scan is, and not how it is turned or how big it is. The two fits of a registration (the earlier scan's and the new one's) each
 * have their own, and they add in quadrature, so a small path on either side is enough.
 *
 * What it does not say. Noise that is not independent between cameras (the AR pose drifting along a long walk, a solve that
 * bends) is in the residual and so in the estimate, but the formula treats it as independent and under-counts what a bend does
 * to the turn. It is a measure of how well the path can fix these, not a promise about the proposal.
 *
 * Pure: no Node API, no file access.
 */
import type { Vec3Tuple } from '../splat/splat_align.ts'
import {
  applySim3,
  fitSessionToSolver,
  type SessionFitInput,
  type SessionFitRefused,
  type SessionFitResult,
  type SessionSim3Fit,
} from './sim3_chain.ts'

// ─── Leaving out what does not agree ─────────────────────────────────────────

export interface TrimmedFit {
  /** The fit made from the frames that agree, or why there is none. */
  fit: SessionFitResult
  /** Frames the recorded positions and the solve both have, before any were left out. */
  paired: number
  /** Frames left out of the fit because their solved camera does not agree with the fit. 0 when every frame agreed. */
  trimmed: number
  /**
   * The RMS gap between the recorded and the solved camera positions that {@link fitUncertainty} is to be given, in the session's own
   * units; null when there is no fit. When every frame was kept it is the fit's own RMS. When some were left out it is estimated from
   * the median of the gaps of **every** paired frame to the fit (1.1264 times it, which is the RMS of a three-dimensional gap when
   * the median is of its length and each axis is Gaussian): the RMS of only the frames that were kept is cut short by the gate, which
   * reads the noise low, and the RMS of all of them is pulled up by the frames that are wrong.
   */
  rho: number | null
}

export interface TrimOptions {
  /** A frame whose solved camera is farther than this from where the fit puts its recorded camera is left out, metres in the Place frame. */
  gateM: number
  /** Place metres per solver unit, from a first fit: the gap is measured in the solver's units and the gate is in metres. */
  metresPerSolverUnit(first: SessionSim3Fit): number
  /** Fewest frames the fit may be made from after leaving some out. */
  minFrames: number
  /** Least share of the paired frames that must agree. */
  minShare: number
}

function pairedKeys(input: SessionFitInput): string[] {
  const keys: string[] = []
  for (const key of input.sessionCentres.keys()) if (input.solverCentres.has(key)) keys.push(key)
  return keys.sort()
}

/** The same frames, in new maps: `fitSessionToSolver` pairs by key, so leaving a frame out is leaving its key out of both. */
function restrictTo(input: SessionFitInput, keys: readonly string[]): SessionFitInput {
  const recorded = new Map<string, Vec3Tuple>()
  const solved = new Map<string, Vec3Tuple>()
  for (const key of keys) {
    recorded.set(key, input.sessionCentres.get(key)!)
    solved.set(key, input.solverCentres.get(key)!)
  }
  return { ...input, sessionCentres: recorded, solverCentres: solved }
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i])
}

/**
 * `fitSessionToSolver` for a session, made from the frames that agree with it. A fit in which every frame agrees is exactly the
 * plain fit, refusals and all. See the header for what happens when some do not.
 *
 * The structural refusals (too few frames, a path in one place or on a line, a size that is not positive) come from the first
 * fit, which is made with no residual gate so that a few wrong frames cannot hide the shape of the rest.
 */
export function fitWithTrim(input: SessionFitInput, options: TrimOptions): TrimmedFit {
  const keys = pairedKeys(input)
  const paired = keys.length
  const loose = fitSessionToSolver({ ...input, maxResidualM: Infinity })
  if (!loose.ok) return { fit: loose, paired, trimmed: 0, rho: null }

  /** The gap between the solved camera and where the fit puts the recorded one, in the solver's units. */
  const solverGap = (fit: SessionSim3Fit, key: string): number => {
    const predicted = applySim3(fit.sessionToSolver, input.sessionCentres.get(key)!)
    const solved = input.solverCentres.get(key)!
    return Math.hypot(predicted[0] - solved[0], predicted[1] - solved[1], predicted[2] - solved[2])
  }
  const gap = (fit: SessionSim3Fit, key: string): number => solverGap(fit, key) * options.metresPerSolverUnit(fit)
  const farthest = (fit: SessionSim3Fit, among: readonly string[]): { key: string; gapM: number } => {
    let worst = { key: among[0]!, gapM: -1 }
    for (const key of among) {
      const gapM = gap(fit, key)
      if (gapM > worst.gapM) worst = { key, gapM }
    }
    return worst
  }
  const tooFew = (count: number): boolean => count < options.minFrames || count < options.minShare * paired
  /** The finished answer: the fit, and the RMS gap to read its uncertainty from. */
  const done = (kept: readonly string[]): TrimmedFit => {
    const fit = fitSessionToSolver(kept.length === paired ? input : restrictTo(input, kept))
    if (!fit.ok) return { fit, paired, trimmed: paired - kept.length, rho: null }
    if (kept.length === paired) return { fit, paired, trimmed: 0, rho: fit.residualSessionUnits }
    const gaps = keys.map((key) => solverGap(fit, key) / fit.sessionToSolver.scale).sort((a, b) => a - b)
    const middle = gaps.length % 2 === 1 ? gaps[(gaps.length - 1) / 2]! : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2
    return { fit, paired, trimmed: paired - kept.length, rho: MEDIAN_GAP_TO_RMS * middle }
  }

  let kept = [...keys]
  let fit: SessionSim3Fit = loose
  while (farthest(fit, kept).gapM > options.gateM) {
    const worst = farthest(fit, kept).key
    kept = kept.filter((key) => key !== worst)
    if (tooFew(kept.length)) return { fit: tooFewAgree(loose, paired, kept.length, input), paired, trimmed: paired - kept.length, rho: null }
    const refit = fitSessionToSolver({ ...restrictTo(input, kept), maxResidualM: Infinity })
    if (!refit.ok) return { fit: refit, paired, trimmed: paired - kept.length, rho: null }
    fit = refit
  }
  // The residual gate applies to the frames that were kept.
  return done(kept)
}

/** The RMS of a three-dimensional gap over its median, for isotropic Gaussian noise: sqrt(3) over the median of a chi distribution with three degrees of freedom (1.5382). */
const MEDIAN_GAP_TO_RMS = Math.sqrt(3) / 1.5382

function tooFewAgree(loose: SessionSim3Fit, paired: number, agreeing: number, input: SessionFitInput): SessionFitRefused {
  return {
    ok: false,
    sessionId: input.sessionId,
    reason: 'high-residual',
    correspondenceCount: paired,
    spreadRatio: loose.spreadRatio,
    umeyamaScale: loose.sessionToSolver.scale,
    residualSessionUnits: loose.residualSessionUnits,
    message: `Only ${agreeing} of the ${paired} frames of ${input.sessionId} that the solve and the recorded path both have agree with the fit, ` +
      'so the solved and recorded camera paths are not one path and this fit is not trustworthy.',
  }
}

// ─── How well the path fixes the turn and the size ───────────────────────────

/** A radius at or under this is none, in the session's own units. */
const NO_EXTENT = 1e-9

/** The standard error of a fit's size and turn: see the header for what it assumes and what it leaves out. */
export interface FitUncertainty {
  /** The size's standard error as a fraction of the size (0.02 is 2%). Infinity when the path has no extent. */
  sizeRel: number
  /** The turn about up's standard error, degrees. Infinity when the path has no extent across the floor. */
  turnDeg: number
}

/**
 * How well the cameras at `centres` (a session's recorded positions in its own units, the frames of the fit) fix a size and a
 * turn, given the RMS gap `rho` the fit left between recorded and solved positions, in the same units. Null for fewer than 4
 * frames, where the seven fitted numbers leave no degrees of freedom to estimate noise from.
 */
export function fitUncertainty(centres: readonly Vec3Tuple[], rho: number): FitUncertainty | null {
  const n = centres.length
  if (n < 4 || !Number.isFinite(rho) || rho < 0) return null
  const mean: Vec3Tuple = [0, 0, 0]
  for (const c of centres) {
    mean[0] += c[0] / n
    mean[1] += c[1] / n
    mean[2] += c[2] / n
  }
  let r3 = 0
  let rh = 0
  for (const c of centres) {
    const dx = c[0] - mean[0]
    const dy = c[1] - mean[1]
    const dz = c[2] - mean[2]
    r3 += dx * dx + dy * dy + dz * dz
    rh += dx * dx + dz * dz
  }
  const r3Rms = Math.sqrt(r3 / n)
  const rhRms = Math.sqrt(rh / n)
  const dof = Math.sqrt(3 * n - 7)
  // A path spread over less than a nanometre is not spread: summing the same position again and again leaves rounding of that size.
  return {
    sizeRel: r3Rms > NO_EXTENT ? rho / (r3Rms * dof) : Infinity,
    turnDeg: rhRms > NO_EXTENT ? ((rho / (rhRms * dof)) * 180) / Math.PI : Infinity,
  }
}

/** The uncertainty of a registration made from two fits (the earlier scan's and the new one's): independent, so they add in quadrature. */
export function combineUncertainty(a: FitUncertainty, b: FitUncertainty): FitUncertainty {
  return { sizeRel: Math.hypot(a.sizeRel, b.sizeRel), turnDeg: Math.hypot(a.turnDeg, b.turnDeg) }
}

/**
 * Whether a size `measured` (1 is no difference) is to be carried into a proposal: it must be at least `floor` away from 1 and
 * at least `sigmas` standard errors away from 1. A size inside either is the scatter of the fits, and a proposal that resized
 * a scan by it would resize every scan by a different noise.
 */
export function sizeIsCarried(measured: number, sizeRel: number, floor: number, sigmas: number): boolean {
  const spread = measured * sizeRel
  return Math.abs(measured - 1) >= Math.max(floor, sigmas * (Number.isFinite(spread) ? spread : Infinity))
}
