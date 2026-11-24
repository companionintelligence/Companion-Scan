/**
 * The tag families the scanner reads and the sheet generator prints, and which one is the default: the one place
 * either is decided.
 *
 * ## The default is a decision DX8 makes, so it is one constant
 *
 * `DEFAULT_TAG_FAMILY_NAME` is the family a sheet is printed in and the scanner looks for when nothing says
 * otherwise. It is the 6x6 family, `cscan-6x6-v1`, because that is the one whose false-accept arithmetic meets the gate the
 * WP-14b spec sets (2.8e-7 per quad that reached the matcher, one bit read loosely: 128 words x 4 turns x 37 grids over 2^36,
 * against 1e-6; the 5x5 family's 32 ids at distance 9 give 9.9e-5). That is a calculation, not a measurement: device experiment DX8, with the
 * negative-image run (`?debug=tagneg`), says whether it holds on real frames, and the owner decides the family
 * before any sheet is issued. Changing the decision is changing this constant, and nothing else: the
 * detector reads any family through `Dictionary`, the print sheet reads the cell count and the quad fraction from here,
 * and the QR payload names the family, so a sheet printed in one family is never read as another's.
 * `cscan-5x5-v1` stays registered: the tests use it (its 7x7 tag is cheaper to render and detect), and a sheet already
 * printed in it keeps working.
 *
 * ## The size a sheet states, and the size the detector sees
 *
 * `printedSizeMm` is the outer edge of the BLACK RING, and the `quadFraction` of a family is the detected quad's edge
 * over that. It is 1 for the two families here, whose detection quad is the black ring's outer edge: what a ruler
 * measures on the print is what the pose solver is told. It is not 1 for every family a contingency could bring in
 * (AprilTag's tag36h11 states its size between the black borders, 8 of its 10 cells, and its white margin is part of
 * the 10; tagStandard41h12's detection quad is 5/9 of its printed width), which is why the fraction is stated per
 * family and every consumer converts through {@link detectionQuadM} and not by assuming 1.
 *
 * Browser-safe (ADR 0002).
 */
import { CSCAN5_V1, CSCAN6_V1 } from './dictionary.ts'
import type { Dictionary } from './types.ts'

export interface TagFamily {
  dictionary: Dictionary
  /** Cells across the whole black square: the data cells and the ring (`bits + 2`). */
  cells: number
  /**
   * The edge of the quad the detector finds over the edge of the black ring as printed. 1 when the black ring's outer
   * edge is the detection quad, which it is for both of these families.
   */
  quadFraction: number
}

function family(dictionary: Dictionary, quadFraction: number): TagFamily {
  return { dictionary, cells: dictionary.bits + 2, quadFraction }
}

/** Every family the scanner can read, the default first. */
export const TAG_FAMILIES: readonly TagFamily[] = [family(CSCAN6_V1, 1), family(CSCAN5_V1, 1)]

/**
 * The family a sheet is printed in and the scanner looks for, by name. See the header: a decision for DX8, made
 * here and only here.
 */
export const DEFAULT_TAG_FAMILY_NAME = 'cscan-6x6-v1'

/** The family registered under `name`, or null. A name that came from a QR code or a stored record is checked here, never trusted. */
export function tagFamilyByName(name: string): TagFamily | null {
  return TAG_FAMILIES.find((f) => f.dictionary.name === name) ?? null
}

/** {@link DEFAULT_TAG_FAMILY_NAME}'s family. Resolved when the module loads, so a name that is not registered fails at once and not at the first sheet. */
export const DEFAULT_TAG_FAMILY: TagFamily = (() => {
  const found = tagFamilyByName(DEFAULT_TAG_FAMILY_NAME)
  if (!found) throw new Error(`the default tag family "${DEFAULT_TAG_FAMILY_NAME}" is not registered in families.ts`)
  return found
})()

/** The edge of the quad the detector will find, in metres, for a tag printed `printedSizeMm` across its black ring: the size the pose solver is given. */
export function detectionQuadM(tagFamily: TagFamily, printedSizeMm: number): number {
  return (printedSizeMm * tagFamily.quadFraction) / 1000
}
