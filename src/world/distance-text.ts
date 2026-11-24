/**
 * How a distance is written in a sentence. Two readings, one copy each (FN-086):
 *
 *  - `formatCm`: a figure a check quotes, signed, one decimal below a metre.
 *  - `wholeCentimetres`: a distance quoted without a sign (a residual, a move), in whole centimetres.
 *
 * No imports, so anything can use it: the capture flow, the editor's calibration chip and register cards, and the
 * server's place-register job (through ./register-proposal.ts), whose image copies src/world/ and src/shared/ only.
 * ./frame-fit.ts re-exports both for its importers.
 */

/**
 * Centimetres for a sentence: one decimal below a metre, so 17.0 against 16.8 does not read as 17 against 17.
 * Exported so that every line that quotes a figure from a check (the capture flow's readout, the scanner's status
 * line, the editor's chip) writes it as the verdict does.
 */
export function formatCm(metres: number): string {
  const cm = metres * 100
  return Math.abs(cm) < 100 ? cm.toFixed(1) : cm.toFixed(0)
}

/**
 * Whole centimetres, unsigned, for a distance a line quotes without a sign (a residual, a move), or null for a number that
 * does not exist: one that is absent, not finite, or finite and too large to convert (1e308 metres times 100 is Infinity).
 * Never prints "NaN cm". The editor's calibration chip and the register proposal's card both write distances this way
 * (FN-086: each had its own copy).
 */
export function wholeCentimetres(metres: number | null | undefined): string | null {
  if (typeof metres !== 'number') return null
  const cm = Math.abs(metres * 100)
  return Number.isFinite(cm) ? cm.toFixed(0) : null
}
