/**
 * What a printed-marker calibration keeps about how it was measured: the shape `ScanCalibration` and
 * `ProjectSpatialFrame` are to store for a `'fiducial'` member. Neither has that member yet: the marker step that
 * would write one is a later package (the WP-14b flow), and today the record is made and judged in the session only.
 *
 * Declared here and nowhere else, for the reason `./calibration-evidence.ts` gives for the tap, fit and
 * check records: the detector that builds this record imports the AR provider (three.js and the DOM), and a
 * type the Deno server reads must not sit in a module that does (ADR 0002). `src/ar/fiducial/types.ts`
 * re-exports it under the name it has always had. `src/world/types.ts` is to import it from here when it gains the member.
 *
 * ## Why it is one flat record
 *
 * ADR 0005 rule 3: a status that claims verification must be backed by a measurement. A `'verified'` on a
 * marker calibration is derived by `fiducialVerdict()` (`src/ar/fiducial/tag-session.ts`) from the numbers
 * below and from nothing else, so every number the verdict reads is in this record. A stored calibration can
 * be judged again later, against stricter gates once device experiment DX8 has replaced the adopted ones, with
 * no other input. `ambiguityRatio`, `viewAngleDeg`, `sessionUnitsPerMetre`, `sizeSource` and `mount` are
 * members of it, not siblings, so the record is whole when it is stored or sent.
 *
 * Every field is a measurement or a fact about the sheet, JSON-safe (a finite number, a string, or null), and
 * none is a default: a fusion that produced no pose produces no evidence.
 *
 * Pure data and no values: no Deno, no DOM, nothing to import (ADR 0002).
 */

/** How the tag is mounted: on a wall, or lying flat (a floor, a table, a plaque). A tilted tag is refused, not recorded. */
export type FiducialMount = 'wall' | 'horizontal'

/**
 * Where the printed size that scaled the pose came from: `'qr'` the sheet's own payload, `'measured'` a size the
 * person measured on the print and entered. A measured size overrides the QR, because a printer set to "fit to page"
 * changes the black square and nothing in the file can see it.
 */
export type FiducialSizeSource = 'qr' | 'measured'

/**
 * Where the session's metre came from: `'runtime-metric'` the runtime's own unit is the metre by contract and the
 * tag was used to check it, `'tag-estimate'` the unit was worked out from the printed size and the camera's travel.
 */
export type FiducialScaleSource = 'runtime-metric' | 'tag-estimate'

export interface FiducialEvidence {
  /** The id decoded from the printed tag. */
  tagId: number
  /** The family (`Dictionary.name`) that decoded it. */
  family: string
  /**
   * The id the Place had registered when this was measured. Null on a Place's first marker calibration, where there
   * is nothing to match against and so nothing that can be verified.
   */
  expectedTagId: number | null
  /** How many of the last `identityWindow` frames read this tag. */
  identityFrames: number
  /** How many frames that window held (at most eight). */
  identityWindow: number
  /** Edge of the black square in millimetres, as printed: the outer edge of the black ring. */
  printedSizeMm: number
  sizeSource: FiducialSizeSource
  mount: FiducialMount

  /** RMS distance of the per-frame tag centres from the fused one, metres (robust). */
  poseSpreadM: number
  /**
   * The same for the heading, degrees (robust: 1.4826 x the median absolute deviation): the bearing of the tag axis the Place frame is built on, a wall tag's
   * outward normal or a horizontal tag's printed up axis. It is the one rotation the frame takes from the tag (roll and pitch come from gravity), so it is
   * what the spread gate judges.
   */
  headingSpreadDeg: number
  /** The same for the whole orientation, degrees, tilt and spin as well as heading (robust). It judges the fit, not the frame, and is gated more loosely. */
  rotationSpreadDeg: number
  /** Median per-frame reprojection error of the corners, pixels. */
  reprojectionRmsPx: number
  /** Median camera-to-tag distance, metres, metric through the printed size. */
  rangeM: number
  /** Frames the fused pose is built from. */
  nFrames: number
  /** First to last frame kept, milliseconds. */
  durationMs: number
  /** How far the camera travelled across those frames, metres. */
  cameraTravelM: number
  /** The largest turn between any two camera orientations across them, degrees. */
  cameraTurnDeg: number
  /** Median (capped at 10) of alternate-solution error over best-solution error, per frame. Near 1 means one frame could not tell the mirror solutions apart. */
  ambiguityRatio: number
  /** Median angle between the tag's normal and the direction to the camera, degrees. 0 is face-on. */
  viewAngleDeg: number
  /** Median side of the detected quad, pixels. */
  sidePx: number
  /** The fastest the camera turned in any frame kept, degrees per second. */
  maxAngularSpeedDegPerS: number

  /** Session units per metre the pose and the frame were converted with. 1 for a metric runtime. */
  sessionUnitsPerMetre: number
  scaleSource: FiducialScaleSource
  /**
   * On a metric runtime: how far the unit the tag implies is from the metre, as a fraction (0.04 is 4 % off). A print
   * at the wrong scale, a wrong focal length and a tracking scale error all show here and cannot be told apart. Null
   * when the runtime is not metric (the unit is then worked out from the print, so it cannot disagree with it) or when
   * the camera did not move enough to estimate it.
   */
  scaleOffFraction: number | null
  /**
   * The camera travel the tag's estimate of the unit rests on (the frames it used), metres. A unit worked out over 0.3 m of travel is less certain than one
   * over a metre, and nothing else in this record says how much. Null when no estimate could be made (the camera did not move far enough), on any runtime.
   */
  scaleBaselineM: number | null
  /**
   * How far the fit of that estimate disagrees with itself, metres (RMS): the tag's position as the camera poses give it against as the tag's own pose gives
   * it, after the unit. It includes the runtime's camera-pose noise. Null when there is no estimate.
   */
  scaleResidualM: number | null
}
