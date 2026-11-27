//@ backend dafny
/**
 * The sign convention of the gimbal's closed-loop correction, proved with LemmaScript (B16).
 *
 * subsystems/osmo-ble/protocol/control.mjs is the shipped code. Outside the tolerance, computeCorrection commands
 * Math.sign(error) * sign * magnitude, and inside it commands nothing; shouldFlipSign inverts the learned sign only
 * when the error grew on the same side of zero, because after an overshoot the error has changed side and
 * Math.sign(error) already reverses the command. Flipping the sign as well reversed it twice, which is the
 * 2026-08-26 failure control.mjs records.
 *
 * These three functions state the direction part of that in the subset LemmaScript proves: no Math.sign, no null,
 * and numbers that are mathematical integers. tests/unit/node/gimbal_control_sign.test.ts checks on random doubles
 * that control.mjs commands the direction correctionDirection gives and flips when shouldFlip says, and checks the
 * proved properties, and the magnitude bounds this file does not prove, on control.mjs itself.
 */

/** The direction computeCorrection commands for one axis: -1, 0 or 1. */
export function correctionDirection(error: number, toleranceDeg: number, sign: number): number {
  //@ verify
  //@ requires sign === 1 || sign === -1
  //@ requires toleranceDeg >= 0
  //@ ensures -toleranceDeg <= error && error <= toleranceDeg ==> \result === 0
  //@ ensures error > toleranceDeg ==> \result === sign
  //@ ensures error < -toleranceDeg ==> \result === -sign
  const size = error >= 0 ? error : -error
  if (size <= toleranceDeg) return 0
  if (error > 0) return sign
  return -sign
}

/**
 * Whether the learned sign is inverted after a tick (shouldFlipSign): never without a previous error, never when the
 * error changed side, and exactly when it grew by more than epsilonDeg on the same side.
 */
export function shouldFlip(error: number, prevError: number, hasPrev: boolean, epsilonDeg: number): boolean {
  //@ verify
  //@ ensures !hasPrev ==> !\result
  //@ ensures (error > 0 && prevError <= 0) || (error < 0 && prevError >= 0) || (error === 0 && prevError !== 0) ==> !\result
  //@ ensures hasPrev && error > 0 && prevError > 0 ==> (\result <==> error > prevError + epsilonDeg)
  //@ ensures hasPrev && error < 0 && prevError < 0 ==> (\result <==> -error > -prevError + epsilonDeg)
  //@ ensures hasPrev && error === 0 && prevError === 0 ==> (\result <==> 0 > epsilonDeg)
  if (!hasPrev) return false
  const side = error > 0 ? 1 : error < 0 ? -1 : 0
  const prevSide = prevError > 0 ? 1 : prevError < 0 ? -1 : 0
  if (side !== prevSide) return false
  const size = error >= 0 ? error : -error
  const prevSize = prevError >= 0 ? prevError : -prevError
  return size > prevSize + epsilonDeg
}

/**
 * An overshoot: the error changes side and is outside the tolerance on both. The command reverses and the learned
 * sign is kept, so the command reverses once, not twice.
 */
export function overshootReversesOnce(before: number, after: number, toleranceDeg: number, sign: number, epsilonDeg: number): boolean {
  //@ verify
  //@ requires sign === 1 || sign === -1
  //@ requires toleranceDeg >= 0
  //@ requires (before > toleranceDeg && after < -toleranceDeg) || (before < -toleranceDeg && after > toleranceDeg)
  //@ ensures \result
  const first = correctionDirection(before, toleranceDeg, sign)
  const second = correctionDirection(after, toleranceDeg, sign)
  const flips = shouldFlip(after, before, true, epsilonDeg)
  return second === -first && !flips
}
