/**
 * The sign convention of the gimbal's closed-loop correction (B16), on real doubles.
 *
 * spec/lemmascript/controlSign.ts proves, with numbers as mathematical integers, that the correction's direction is
 * zero inside the tolerance and the error's side times the learned sign outside it, that the learned sign flips only
 * when the error grew on the same side, and so that an overshoot reverses the command once. This checks the shipped
 * functions in subsystems/osmo-ble/protocol/control.mjs against those on random doubles (differential), and checks
 * the proved properties, and the magnitude bounds the proof leaves out, on control.mjs itself (property).
 *
 * The domain is what the move loop passes: a finite error (wrapDeg of two finite angles), a tolerance of 0 or more,
 * a speed above 0, and a learned sign of 1 or -1. A speed of 0 or less is outside it: the magnitude is then not above
 * 0 and the direction is not the error's side (POST /api/move-to does not check speedDegPerSec).
 *
 * Run: npm run test:gimbal:control
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCorrection,
  MIN_EFFECTIVE_SPEED_DEG_PER_SEC,
  shouldFlipSign,
} from '../../../subsystems/osmo-ble/protocol/control.mjs'
import { correctionDirection, overshootReversesOnce, shouldFlip } from '../../../spec/lemmascript/controlSign.ts'

const SEED = 0x5ca1ab1e
const RUNS = 20000

/** mulberry32: a small seeded generator, so a failure names a run that can be repeated. */
function generator(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = generator(SEED)
const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!

/** The next double above a finite x of 0 or more: one more in its bit pattern. */
function nextUp(x: number): number {
  const bits = new Float64Array([x === 0 ? 0 : x])
  const asInt = new BigInt64Array(bits.buffer)
  asInt[0] = asInt[0]! + 1n
  return bits[0]!
}

/** An error in degrees: mostly ordinary, often at or near a tolerance's edge, sometimes extreme. */
function error(tolerance: number): number {
  const edge = pick([tolerance, -tolerance, nextUp(tolerance), -nextUp(tolerance)])
  return pick([
    () => (random() - 0.5) * 400,
    () => (random() - 0.5) * 2 * (tolerance + 1),
    () => edge,
    () => pick([0, -0, 1e-300, -1e-300, 1e9, -1e9, Number.MAX_VALUE, -Number.MAX_VALUE]),
  ])()
}
const tolerance = () => pick([0, 3, 4, 5, random() * 20])
const speed = () => pick([MIN_EFFECTIVE_SPEED_DEG_PER_SEC, 20, 25, MIN_EFFECTIVE_SPEED_DEG_PER_SEC + random() * 50, 0.5 + random() * 7])
const sign = () => pick([1, -1])
const epsilon = () => pick([0.5, 0, random() * 2])

/** Math.sign without the negative zero, which `===` treats as zero and assert.strictEqual does not. */
const direction = (x: number) => Math.sign(x) + 0

test('control.mjs commands the direction correctionDirection proves, on random doubles', () => {
  for (let run = 0; run < RUNS; run++) {
    const tol = tolerance()
    const e = error(tol)
    const s = sign()
    const v = speed()
    const commanded = computeCorrection(e, { toleranceDeg: tol, speedDegPerSec: v, sign: s })
    assert.equal(direction(commanded), correctionDirection(e, tol, s), `run ${run}: error ${e}, tolerance ${tol}, speed ${v}, sign ${s} commanded ${commanded}`)
  }
})

test('control.mjs flips the learned sign exactly when shouldFlip proves it does, on random doubles', () => {
  for (let run = 0; run < RUNS; run++) {
    const tol = tolerance()
    const e = pick([error(tol), Number.NaN])
    const eps = epsilon()
    const previous = pick([error(tol), error(tol), Number.NaN, null, undefined])
    const flips = shouldFlipSign(e, previous, eps)
    const proved = shouldFlip(e, previous ?? 0, previous !== null && previous !== undefined, eps)
    assert.equal(flips, proved, `run ${run}: error ${e}, previous ${previous}, epsilon ${eps}`)
  }
})

test('inside the tolerance the correction is zero; outside it, its size is between the deadband floor and the speed', () => {
  for (let run = 0; run < RUNS; run++) {
    const tol = tolerance()
    const e = error(tol)
    const v = speed()
    const commanded = computeCorrection(e, { toleranceDeg: tol, speedDegPerSec: v, sign: sign() })
    if (Math.abs(e) <= tol) {
      assert.ok(Object.is(commanded, 0), `run ${run}: error ${e} is inside ${tol}, commanded ${commanded}`)
    } else {
      assert.ok(Math.abs(commanded) <= v, `run ${run}: ${commanded} is above the speed ${v}`)
      assert.ok(Math.abs(commanded) >= Math.min(v, MIN_EFFECTIVE_SPEED_DEG_PER_SEC), `run ${run}: ${commanded} is below the floor`)
    }
  }
})

test('an overshoot reverses the command once: the direction turns and the learned sign is kept', () => {
  let overshoots = 0
  for (let run = 0; run < RUNS; run++) {
    const tol = tolerance()
    const before = error(tol)
    const after = error(tol)
    const crossed = (before > tol && after < -tol) || (before < -tol && after > tol)
    if (!crossed) continue
    overshoots += 1
    const s = sign()
    const v = speed()
    const eps = epsilon()
    const first = computeCorrection(before, { toleranceDeg: tol, speedDegPerSec: v, sign: s })
    const second = computeCorrection(after, { toleranceDeg: tol, speedDegPerSec: v, sign: s })
    assert.equal(direction(second), -direction(first), `run ${run}: ${before} then ${after}`)
    assert.equal(shouldFlipSign(after, before, eps), false, `run ${run}: an overshoot does not flip the sign`)
    assert.equal(overshootReversesOnce(before, after, tol, s, eps), true, `run ${run}: the proved function agrees`)
  }
  assert.ok(overshoots > 1000, `only ${overshoots} overshoots were drawn`)
})
