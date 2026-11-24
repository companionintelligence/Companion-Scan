/**
 * What the photo method does to a session's fit before it believes it (server/register/sfm_fit.ts): leave out the photographs COLMAP
 * placed wrongly, and say how well the camera path can fix the turn and the size at all.
 *
 * The fits here are made from known truth: a ring of cameras recorded in a session's own frame, and the same cameras in a solver
 * frame that is that frame turned, moved and resized, with noise on both. So what a fit should come out as is known, and the
 * standard errors are checked against the scatter of fits made from noise drawn again and again (seeded, so a failure is a case to
 * reproduce).
 */
import { assert, assertAlmostEquals, assertEquals, assertGreater } from 'jsr:@std/assert@^1.0.0'

import { applySim3, fitSessionToSolver, type Sim3 } from '../../../server/register/sim3_chain.ts'
import { combineUncertainty, fitUncertainty, fitWithTrim, sizeIsCarried, type TrimOptions } from '../../../server/register/sfm_fit.ts'
import type { Vec3Tuple } from '../../../server/splat/splat_align.ts'
import { gaussian, mulberry32 } from './toy_sfm_scene.ts'

type V3 = Vec3Tuple

/** The solver's frame: a turn about up, a size and a shift. Place metres per solver unit is 1 / SOLVER_SCALE. */
const SOLVER_SCALE = 0.37
const solverOf = (p: V3): V3 => {
  const a = (41 * Math.PI) / 180
  return [
    SOLVER_SCALE * (Math.cos(a) * p[0] + Math.sin(a) * p[2]) + 5,
    SOLVER_SCALE * p[1] - 2,
    SOLVER_SCALE * (-Math.sin(a) * p[0] + Math.cos(a) * p[2]) + 3,
  ]
}

/** A ring of `n` cameras of radius `r` round (2.5, 1.4, 2), with a little height wobble. */
function ring(n: number, r: number, seed = 5): V3[] {
  const next = mulberry32(seed)
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [2.5 + r * Math.cos(a), 1.4 + (next() - 0.5) * 0.12, 2 + r * Math.sin(a)] as V3
  })
}

interface Made {
  recorded: Map<string, V3>
  solved: Map<string, V3>
}

/** The truth carried into both frames, noise (metres, per axis) added to each, and `wrong` frames' solved cameras moved by the given offsets. */
function make(truth: readonly V3[], noise: { recorded: number; solved: number }, seed: number, wrong: Record<number, V3> = {}): Made {
  const next = mulberry32(seed)
  const recorded = new Map<string, V3>()
  const solved = new Map<string, V3>()
  truth.forEach((p, i) => {
    const key = `sess/kf-${String(i).padStart(5, '0')}.jpg`
    recorded.set(key, [p[0] + gaussian(next) * noise.recorded, p[1] + gaussian(next) * noise.recorded, p[2] + gaussian(next) * noise.recorded])
    const s = solverOf(p)
    const off = wrong[i] ?? [0, 0, 0]
    solved.set(key, [
      s[0] + (gaussian(next) * noise.solved + off[0]) * SOLVER_SCALE,
      s[1] + (gaussian(next) * noise.solved + off[1]) * SOLVER_SCALE,
      s[2] + (gaussian(next) * noise.solved + off[2]) * SOLVER_SCALE,
    ])
  })
  return { recorded, solved }
}

const options = (overrides: Partial<TrimOptions> = {}): TrimOptions => ({
  gateM: 0.15,
  metresPerSolverUnit: () => 1 / SOLVER_SCALE,
  minFrames: 6,
  minShare: 0.6,
  ...overrides,
})

const input = (made: Made) => ({ sessionId: 'sess', sessionCentres: made.recorded, solverCentres: made.solved })

/** What a fit says the session's own frame is to the solver's, compared with the truth: the size ratio and the turn about up, degrees. */
function against(fit: Sim3): { scale: number; yawDeg: number } {
  const a = (41 * Math.PI) / 180
  const r = fit.rotation
  const yaw = Math.atan2(r[0]![2]! - r[2]![0]!, r[0]![0]! + r[2]![2]!)
  return { scale: fit.scale / SOLVER_SCALE, yawDeg: ((yaw - a) * 180) / Math.PI }
}

// ─── Leaving out what does not agree ─────────────────────────────────────────

Deno.test('fitWithTrim: when every frame agrees it is exactly the plain fit, and nothing is left out', () => {
  const made = make(ring(24, 1.2), { recorded: 0.02, solved: 0.02 }, 1)
  const trimmed = fitWithTrim(input(made), options())
  const plain = fitSessionToSolver(input(made))
  assert(trimmed.fit.ok && plain.ok)
  assertEquals([trimmed.paired, trimmed.trimmed], [24, 0])
  assertEquals(trimmed.fit.sessionToSolver, plain.sessionToSolver)
  assertEquals(trimmed.fit.files, plain.files)
})

Deno.test('fitWithTrim: a few wrongly placed photographs are left out, and the fit is the one the others make', () => {
  // Three of 24 solved a metre or more from where their camera was. The plain fit follows them; the trimmed one does not.
  const wrong = { 3: [1.1, 0.1, 0.4] as V3, 11: [-0.9, 0.2, 1.2] as V3, 17: [0.5, -0.1, -1.4] as V3 }
  const made = make(ring(24, 1.2), { recorded: 0.015, solved: 0.015 }, 2, wrong)
  const trimmed = fitWithTrim(input(made), options())
  assert(trimmed.fit.ok)
  assertEquals([trimmed.paired, trimmed.trimmed], [24, 3])
  assertEquals(trimmed.fit.files.length, 21)
  for (const i of [3, 11, 17]) assert(!trimmed.fit.files.includes(`sess/kf-${String(i).padStart(5, '0')}.jpg`), `frame ${i} was kept`)

  // The same 21 frames fitted by themselves.
  const clean = fitSessionToSolver({
    sessionId: 'sess',
    sessionCentres: new Map(trimmed.fit.files.map((f) => [f, made.recorded.get(f)!])),
    solverCentres: new Map(trimmed.fit.files.map((f) => [f, made.solved.get(f)!])),
  })
  assert(clean.ok)
  assertEquals(trimmed.fit.sessionToSolver, clean.sessionToSolver)

  // And it lands where the truth is: the size to a fraction of a percent, the turn to a fraction of a degree. The plain fit does not.
  const t = against(trimmed.fit.sessionToSolver)
  assertAlmostEquals(t.scale, 1, 0.01)
  assertAlmostEquals(t.yawDeg, 0, 0.5)
  const plain = fitSessionToSolver({ ...input(made), maxResidualM: Infinity })
  assert(plain.ok)
  assertGreater(Math.abs(against(plain.sessionToSolver).scale - 1), Math.abs(t.scale - 1) * 3, 'the plain fit is pulled by the wrong frames')
})

Deno.test('fitWithTrim: frames are left out one at a time, because the wrong ones drag good frames past the gate beside them', () => {
  // Five of 20 solved 0.6 to 0.9 m off, all to one side: the first fit moves toward them and puts every other frame some 15 to 25 cm
  // from where it should be, so a gate applied to that fit at once would leave almost nothing. Dropping the worst, then looking again,
  // finds the five.
  const wrong: Record<number, V3> = {}
  for (const [k, i] of [2, 6, 9, 13, 16].entries()) wrong[i] = [0.6 + 0.07 * k, 0, 0.5 + 0.08 * k]
  const made = make(ring(20, 1.0, 9), { recorded: 0.01, solved: 0.01 }, 3, wrong)
  const loose = fitSessionToSolver({ ...input(made), maxResidualM: Infinity })
  assert(loose.ok)
  let beyondGate = 0
  for (const [key, c] of made.recorded) {
    const p = applySim3(loose.sessionToSolver, c)
    const s = made.solved.get(key)!
    if (Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]) / SOLVER_SCALE > 0.15) beyondGate++
  }
  assertGreater(beyondGate, 5, `the first fit has ${beyondGate} frames beyond the gate: more than the five that are wrong`)

  const trimmed = fitWithTrim(input(made), options())
  assert(trimmed.fit.ok, trimmed.fit.ok ? '' : trimmed.fit.message)
  assertEquals(trimmed.trimmed, 5)
  assertEquals(trimmed.fit.files.length, 15)
  assertAlmostEquals(against(trimmed.fit.sessionToSolver).scale, 1, 0.01)
})

Deno.test('fitWithTrim: when too few frames agree there is nothing to trim to, and it is a residual that is too high', () => {
  // Half of 20 are a metre off in different directions.
  const wrong: Record<number, V3> = {}
  for (let i = 0; i < 20; i += 2) wrong[i] = [Math.cos(i) * 1.2, 0.2, Math.sin(i * 1.7) * 1.2]
  const made = make(ring(20, 1.2), { recorded: 0.01, solved: 0.01 }, 4, wrong)
  const trimmed = fitWithTrim(input(made), options())
  assert(!trimmed.fit.ok)
  assertEquals(trimmed.fit.reason, 'high-residual')
  assertEquals(trimmed.fit.correspondenceCount, 20)
  assert(/agree with the fit/.test(trimmed.fit.message), trimmed.fit.message)
  assertGreater(trimmed.trimmed, 0)
})

Deno.test('fitWithTrim: it never leaves fewer frames than the floor, whatever share would allow', () => {
  // Eight frames, two wrong: 6 of 8 is 75%, but the floor is 7.
  const made = make(ring(8, 1.2), { recorded: 0.01, solved: 0.01 }, 5, { 1: [1, 0, 1], 5: [-1, 0, 0.8] })
  const refused = fitWithTrim(input(made), options({ minFrames: 7 }))
  assert(!refused.fit.ok)
  assertEquals(refused.fit.reason, 'high-residual')
  const allowed = fitWithTrim(input(made), options({ minFrames: 6 }))
  assert(allowed.fit.ok)
  assertEquals(allowed.trimmed, 2)
})

Deno.test('fitWithTrim: the share that must agree is held to at the edge', () => {
  // 10 frames, 4 wrong: 6 agree, which is exactly 60%, and 5 would not be.
  const wrong: Record<number, V3> = { 0: [1, 0, 1], 3: [-1, 0, 1], 6: [1.2, 0, -0.8], 8: [-0.9, 0, -1] }
  const made = make(ring(10, 1.2), { recorded: 0.01, solved: 0.01 }, 6, wrong)
  const six = fitWithTrim(input(made), options({ minShare: 0.6, minFrames: 6 }))
  assert(six.fit.ok, 'six of ten is the share asked for')
  assertEquals(six.trimmed, 4)
  const seven = fitWithTrim(input(made), options({ minShare: 0.61, minFrames: 6 }))
  assert(!seven.fit.ok, 'six of ten is not 61%')
})

Deno.test('fitWithTrim: the gate is in Place metres, so a solver with a small unit does not hide a far camera', () => {
  // A frame solved 0.3 m (Place) away. In the solver's own units (0.37 per metre) that is 0.11, which would pass a gate of 0.15 read there.
  const made = make(ring(16, 1.2), { recorded: 0.005, solved: 0.005 }, 7, { 4: [0.3, 0, 0] })
  const trimmed = fitWithTrim(input(made), options())
  assert(trimmed.fit.ok)
  assertEquals(trimmed.trimmed, 1)
  const wrongUnits = fitWithTrim(input(made), options({ metresPerSolverUnit: () => 1 }))
  assertEquals(wrongUnits.trimmed, 0, 'in the solver\'s units the same frame is inside the gate')
})

Deno.test('fitWithTrim: the structural refusals of the plain fit are the first fit\'s, and a straight line is still a straight line', () => {
  const line = Array.from({ length: 10 }, (_, i) => [1 + 0.4 * i, 1.4, 2] as V3)
  const made = make(line, { recorded: 0, solved: 0 }, 8)
  const trimmed = fitWithTrim(input(made), options())
  assert(!trimmed.fit.ok)
  assertEquals(trimmed.fit.reason, 'collinear')
  assertEquals(trimmed.trimmed, 0)
  const few = fitWithTrim(input(make(ring(3, 1), { recorded: 0, solved: 0 }, 9)), options())
  assert(!few.fit.ok)
  assertEquals(few.fit.reason, 'too-few-correspondences')
})

Deno.test('fitWithTrim: the RMS gap it gives for the uncertainty is the fit\'s own when nothing was left out, and the noise\'s when frames were', () => {
  // Nothing left out: exactly the fit's own.
  const clean = make(ring(24, 1.2), { recorded: 0.02, solved: 0.02 }, 21)
  const plain = fitWithTrim(input(clean), options())
  assert(plain.fit.ok)
  assertEquals(plain.trimmed, 0)
  assertEquals(plain.rho, plain.fit.residualSessionUnits)

  // Honest noise of 5 cm a metre per axis on both sides, 36 frames: the gate cuts the tail, so the RMS of the frames that are kept reads
  // low, and the estimate from every frame's gap does not. The truth is sqrt(3) x sqrt(0.05^2 + 0.05^2) x sqrt(1 - 7 / 108).
  const truth = Math.sqrt(3) * Math.sqrt(0.05 ** 2 + 0.05 ** 2) * Math.sqrt(1 - 7 / 108)
  const estimates: number[] = []
  const kept: number[] = []
  let trimmed = 0
  for (let trial = 0; trial < 40; trial++) {
    const t = fitWithTrim(input(make(ring(36, 1.2), { recorded: 0.05, solved: 0.05 }, 400 + trial)), options())
    assert(t.fit.ok && t.rho !== null, `trial ${trial}`)
    estimates.push(t.rho!)
    kept.push(t.fit.residualSessionUnits)
    trimmed += t.trimmed
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  assert(trimmed / (40 * 36) > 0.1, `a good share of honest frames was cut by the gate: ${trimmed / (40 * 36)}`)
  assertAlmostEquals(mean(estimates) / truth, 1, 0.08, `the estimate ${mean(estimates)} against the noise ${truth}`)
  assert(mean(kept) / truth < 0.88, `what is left reads low: ${mean(kept)} against ${truth}`)

  // Wrong frames do not pull it up: three of 24 a metre out, 1.5 cm of noise.
  const wrong = { 3: [1.1, 0.1, 0.4] as V3, 11: [-0.9, 0.2, 1.2] as V3, 17: [0.5, -0.1, -1.4] as V3 }
  const outliers = fitWithTrim(input(make(ring(24, 1.2), { recorded: 0.015, solved: 0.015 }, 22, wrong)), options())
  assert(outliers.fit.ok)
  assertEquals(outliers.trimmed, 3)
  const noise = Math.sqrt(3) * Math.sqrt(0.015 ** 2 * 2) * Math.sqrt(1 - 7 / 72)
  assertAlmostEquals(outliers.rho! / noise, 1, 0.3, `${outliers.rho} against ${noise}`)
  const everyFrame = fitSessionToSolver({ ...input(make(ring(24, 1.2), { recorded: 0.015, solved: 0.015 }, 22, wrong)), maxResidualM: Infinity })
  assert(everyFrame.ok && everyFrame.residualSessionUnits > 5 * outliers.rho!, 'the RMS of every frame is the wrong frames\' and says nothing about the noise')

  // No fit, no number.
  assertEquals(fitWithTrim(input(make(ring(3, 1), { recorded: 0, solved: 0 }, 23)), options()).rho, null)
})

Deno.test('fitWithTrim: the plain residual gate is still the last word on the frames that were kept, and only a session with a small unit can reach it', () => {
  // Every frame's solved camera is about 0.12 m (Place) from the fit, inside the 0.15 m gate, in a direction that varies. In a session
  // whose unit is the metre that is an RMS of about 0.12 against the 0.25 limit. In a session whose unit is 0.4 m the same gaps are about
  // 0.3 in its own units, which is past it: the limit is in the session's units, and what is kept is within the gate in metres.
  const truth = ring(24, 1.2)
  const offsets = truth.map((_, i): V3 => {
    const a = i * 2.399963
    const b = i * 1.7
    return [Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)]
  })
  const build = (unit: number): Made => {
    const recorded = new Map<string, V3>()
    const solved = new Map<string, V3>()
    truth.forEach((p, i) => {
      const key = `sess/kf-${String(i).padStart(5, '0')}.jpg`
      recorded.set(key, [p[0] / unit, p[1] / unit, p[2] / unit])
      const q = solverOf(p)
      const d = offsets[i]!
      const n = Math.hypot(...d)
      solved.set(key, [q[0] + (d[0] / n) * 0.12 * SOLVER_SCALE, q[1] + (d[1] / n) * 0.12 * SOLVER_SCALE, q[2] + (d[2] / n) * 0.12 * SOLVER_SCALE])
    })
    return { recorded, solved }
  }
  const metric = fitWithTrim(input(build(1)), options())
  assert(metric.fit.ok, 'a metric session with every frame about 12 cm out is fitted')
  assertEquals(metric.trimmed, 0)
  assert(metric.fit.residualSessionUnits < 0.25)
  const small = fitWithTrim(input(build(0.4)), options())
  assert(!small.fit.ok, 'the same gaps in a session whose unit is 0.4 m are about 0.3 of its units, past the limit')
  assertEquals(small.fit.reason, 'high-residual')
  assertEquals(small.trimmed, 0, 'nothing was cut: they are all inside the gate in metres')
})

// ─── How well the path fixes the turn and the size ───────────────────────────

Deno.test('fitUncertainty: the numbers follow the closed form, written out by hand for a ring of eight', () => {
  // Eight cameras at radius 1 in one horizontal plane: R3 = Rh = 1. With rho = 0.05 and 3n - 7 = 17:
  const flat = Array.from({ length: 8 }, (_, i) => [Math.cos((2 * Math.PI * i) / 8), 0, Math.sin((2 * Math.PI * i) / 8)] as V3)
  const u = fitUncertainty(flat, 0.05)!
  assertAlmostEquals(u.sizeRel, 0.05 / Math.sqrt(17), 1e-12)
  assertAlmostEquals(u.turnDeg, ((0.05 / Math.sqrt(17)) * 180) / Math.PI, 1e-9)
  assertAlmostEquals(u.turnDeg, 0.6948, 1e-3)
  // Twice the noise, twice the uncertainty; twice the radius, half.
  const twice = fitUncertainty(flat, 0.1)!
  assertAlmostEquals(twice.sizeRel, 2 * u.sizeRel, 1e-12)
  const wider = fitUncertainty(flat.map((p) => [2 * p[0], 0, 2 * p[2]] as V3), 0.05)!
  assertAlmostEquals(wider.sizeRel, u.sizeRel / 2, 1e-12)
  assertAlmostEquals(wider.turnDeg, u.turnDeg / 2, 1e-9)
  // More frames fix it better: n = 32 against 8 at one noise.
  const many = fitUncertainty(Array.from({ length: 32 }, (_, i) => [Math.cos((2 * Math.PI * i) / 32), 0, Math.sin((2 * Math.PI * i) / 32)] as V3), 0.05)!
  assertAlmostEquals(many.sizeRel, 0.05 / Math.sqrt(89), 1e-12)
})

Deno.test('fitUncertainty: the turn is fixed by the spread across the floor and the size by the spread in every direction', () => {
  // Eight cameras one above another: a path with height and no width. The size is fixed by it, the turn about up is not.
  const column = Array.from({ length: 8 }, (_, i) => [2, 0.4 * i, 3] as V3)
  const u = fitUncertainty(column, 0.02)!
  assert(Number.isFinite(u.sizeRel))
  assertEquals(u.turnDeg, Infinity)
  // Cameras all in one place fix neither.
  const here = fitUncertainty(Array.from({ length: 6 }, () => [1, 1, 1] as V3), 0.01)!
  assertEquals([here.sizeRel, here.turnDeg], [Infinity, Infinity])
})

Deno.test('fitUncertainty: fewer than four frames say nothing, because seven numbers are fitted to them', () => {
  assertEquals(fitUncertainty(ring(3, 1), 0.01), null)
  assert(fitUncertainty(ring(4, 1), 0.01) !== null)
  assertEquals(fitUncertainty(ring(8, 1), Number.NaN), null)
  assertEquals(fitUncertainty(ring(8, 1), -1), null)
})

Deno.test('fitUncertainty: it predicts the scatter of fits made from noise drawn again and again', () => {
  // For each cell, 300 pairs of independent fits of one ring (the earlier scan's and a new session's). The scatter of the log of the
  // ratio of their sizes and of the difference of their turns is what a registration's own size and turn scatter by; the prediction
  // is each fit's own estimate from its own residual, added in quadrature, averaged over the pairs.
  const cells: Array<{ r: number; n: number; noise: number }> = [
    { r: 0.35, n: 24, noise: 0.03 },
    { r: 0.8, n: 24, noise: 0.03 },
    { r: 1.2, n: 36, noise: 0.01 },
    { r: 2, n: 14, noise: 0.05 },
  ]
  for (const cell of cells) {
    const truth = ring(cell.n, cell.r)
    const logRatios: number[] = []
    const turns: number[] = []
    const predictedSize: number[] = []
    const predictedTurn: number[] = []
    for (let trial = 0; trial < 300; trial++) {
      const fits = [0, 1].map((k) => {
        const made = make(truth, { recorded: cell.noise, solved: cell.noise }, 1000 + trial * 2 + k)
        const fit = fitSessionToSolver({ ...input(made), maxResidualM: Infinity })
        assert(fit.ok)
        const u = fitUncertainty(fit.files.map((f) => made.recorded.get(f)!), fit.residualSessionUnits)!
        return { ...against(fit.sessionToSolver), u }
      })
      logRatios.push(Math.log(fits[0]!.scale / fits[1]!.scale))
      turns.push(fits[0]!.yawDeg - fits[1]!.yawDeg)
      const both = combineUncertainty(fits[0]!.u, fits[1]!.u)
      predictedSize.push(both.sizeRel)
      predictedTurn.push(both.turnDeg)
    }
    const sd = (xs: number[]): number => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
    const label = `radius ${cell.r} m, ${cell.n} frames, ${cell.noise * 100} cm`
    // Within 15%: a standard deviation from 300 draws is known to about 4%, and the estimate is itself noisy.
    assertAlmostEquals(sd(logRatios) / mean(predictedSize), 1, 0.15, `${label}: size scatter ${sd(logRatios)} against predicted ${mean(predictedSize)}`)
    assertAlmostEquals(sd(turns) / mean(predictedTurn), 1, 0.15, `${label}: turn scatter ${sd(turns)} against predicted ${mean(predictedTurn)}`)
  }
})

Deno.test('fitUncertainty through fitWithTrim: it still predicts the scatter when the gate cuts a share of honest noise, within the range the header states', () => {
  // 300 pairs of fits a cell on a ring 1.2 m in radius, 36 frames, the uncertainty from each fit's `rho` as fitWithTrim gives it.
  const cells: Array<{ noise: number; within: number }> = [{ noise: 0.03, within: 0.1 }, { noise: 0.04, within: 0.15 }, { noise: 0.05, within: 0.25 }]
  for (const cell of cells) {
    const truth = ring(36, 1.2)
    const logRatios: number[] = []
    const turns: number[] = []
    const predictedSize: number[] = []
    const predictedTurn: number[] = []
    for (let trial = 0; trial < 300; trial++) {
      const fits = [0, 1].map((k) => {
        const made = make(truth, { recorded: cell.noise, solved: cell.noise }, 5000 + trial * 2 + k)
        const t = fitWithTrim(input(made), options())
        assert(t.fit.ok && t.rho !== null, `${cell.noise}: trial ${trial} was refused`)
        const u = fitUncertainty(t.fit.files.map((f) => made.recorded.get(f)!), t.rho!)!
        return { ...against(t.fit.sessionToSolver), u }
      })
      logRatios.push(Math.log(fits[0]!.scale / fits[1]!.scale))
      turns.push(fits[0]!.yawDeg - fits[1]!.yawDeg)
      const both = combineUncertainty(fits[0]!.u, fits[1]!.u)
      predictedSize.push(both.sizeRel)
      predictedTurn.push(both.turnDeg)
    }
    const sd = (xs: number[]): number => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
    const label = `${cell.noise * 100} cm`
    assertAlmostEquals(sd(logRatios) / mean(predictedSize), 1, cell.within, `${label}: size scatter ${sd(logRatios)} against predicted ${mean(predictedSize)}`)
    assertAlmostEquals(sd(turns) / mean(predictedTurn), 1, cell.within, `${label}: turn scatter ${sd(turns)} against predicted ${mean(predictedTurn)}`)
  }
})

Deno.test('combineUncertainty: two independent fits add in quadrature', () => {
  const c = combineUncertainty({ sizeRel: 0.03, turnDeg: 0.4 }, { sizeRel: 0.04, turnDeg: 0.3 })
  assertAlmostEquals(c.sizeRel, 0.05, 1e-12)
  assertAlmostEquals(c.turnDeg, 0.5, 1e-12)
  assertEquals(combineUncertainty({ sizeRel: Infinity, turnDeg: 0.1 }, { sizeRel: 0.01, turnDeg: 0.1 }).sizeRel, Infinity)
})

Deno.test('sizeIsCarried: a size is carried when it clears both the floor and three standard errors, at the edge of each', () => {
  // The floor alone, no uncertainty.
  assertEquals(sizeIsCarried(1.0199, 0, 0.02, 3), false)
  assertEquals(sizeIsCarried(1.02, 0, 0.02, 3), true)
  assertEquals(sizeIsCarried(0.98, 0, 0.02, 3), true)
  assertEquals(sizeIsCarried(0.9801, 0, 0.02, 3), false)
  // Three standard errors: a size of 1.10 with 3% uncertainty has an error of 0.033, and three of them is 0.099.
  assertEquals(sizeIsCarried(1.1, 0.03, 0.02, 3), true)
  assertEquals(sizeIsCarried(1.09, 0.03, 0.02, 3), false)
  // The same size is carried by a well-fixed path and not by a poorly fixed one.
  assertEquals(sizeIsCarried(1.06, 0.002, 0.02, 3), true)
  assertEquals(sizeIsCarried(1.06, 0.02, 0.02, 3), false)
  // A path that fixes nothing carries nothing.
  assertEquals(sizeIsCarried(1.5, Infinity, 0.02, 3), false)
  assertEquals(sizeIsCarried(1.5, Number.NaN, 0.02, 3), false)
})
