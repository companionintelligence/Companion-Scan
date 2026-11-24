/**
 * What the scanner says during and after a marker calibration. Pure text from numbers, so it can be tested without a DOM and so
 * each sentence sits next to the measurement that makes it true (the style of `src/ar/alignment-status.ts`, which writes
 * the same kind of thing for the two-point tier).
 *
 * ## The rule every sentence here obeys (ADR 0005 rule 3)
 *
 * A sentence says only what a measurement in the `FiducialEvidence` or the session state backs, and names what was not checked.
 *
 * - **"Same marker as this Place's"** is said only for `'verified'`: the tag decoded is the one the Place registered, in at
 *   least five of the last eight frames, with every pose gate met. It is never said of the PLACE, the frame or the room.
 * - **What it does not say is said with it:** that nobody has moved the sheet (a sheet on another wall still decodes as the
 *   same tag, and the frame moves with it) is never checked, and the print's size is checked only on a runtime whose unit is
 *   the metre by contract and only if the camera moved enough.
 * - **A spread is a spread.** The figures are the scatter of one frame's reading about the fused one (`poseSpreadM`,
 *   `headingSpreadDeg`, `rotationSpreadDeg`): how much the frames disagreed, not how far the result is from the truth, which
 *   nothing here measures. They are written "spread", never "accurate to" or "within". The heading is the bearing of the tag
 *   axis the Place frame is built on, and is called heading only for that.
 * - A first calibration is `'provisional'` and says there was nothing to match. A quality badge (`good`, `fair`, `poor`) says
 *   how the frames fitted, which is what it is derived from.
 * - A number that does not exist prints no figure, never "NaN cm".
 *
 * Every sentence a person can be shown is listed in the WP-14b report for the owner's approval (owner decision 7a-1), and
 * `tests/unit/node/fiducial_tag_session.test.ts` enumerates them to hold these rules.
 *
 * Browser-safe (ADR 0002), no DOM.
 */
import type { CameraFrameUnsupportedReason } from '../camera-frame-feed.ts'
import type { FiducialEvidence } from '../../world/fiducial-evidence.ts'
import { MIN_SCALE_BASELINE_M } from './tag-pose.ts'
import { DEFAULT_FIDUCIAL_GATES, FALLBACK_TO_TAPS_MS, type FiducialGates, type FiducialQuality, type FiducialVerdict, type FiducialVerdictReason, type TagHint } from './tag-session.ts'
import { TAG_HEIGHT_MAX_M } from './tag-frame.ts'

/** Why marker reading is not offered at all, as far as the person is concerned: the feed's reasons, and a view that is cropped. */
export type TagUnavailableReason = CameraFrameUnsupportedReason | 'cover-fit'

const finite = (n: number): boolean => Number.isFinite(n)

/** One decimal, or null for a number that does not exist. */
function one(n: number): string | null {
  return finite(n) ? n.toFixed(1) : null
}

/** Centimetres from metres, one decimal. */
function cm(metres: number): string | null {
  return one(metres * 100)
}

/** Two decimals, or null for a number that does not exist. */
function two(n: number): string | null {
  return finite(n) ? n.toFixed(2) : null
}

function whole(n: number): string | null {
  return finite(n) ? String(Math.round(n)) : null
}

/** A figure with its unit, or `fallback` when the number does not exist. */
function figure(text: string | null, unit: string, fallback: string): string {
  return text === null ? fallback : `${text}${unit}`
}

// -------------------------------------------------------------------------------------------
// While reading
// -------------------------------------------------------------------------------------------

/**
 * The line for what the person is asked to do now. First line a short statement, then at most one bullet; the status line takes
 * that shape (`alignmentStatusText` writes the same).
 */
export function tagHintText(hint: TagHint): string {
  switch (hint.code) {
    case 'no-tag':
      return 'Point the camera at the printed marker'
    case 'move-closer':
      return `Move closer to the marker\n• ${figure(whole(hint.sidePx), ' px', 'Its size is not known')} across, ${whole(hint.neededPx)} px needed`
    case 'keep-uncovered':
      return 'Keep the whole marker in view and uncovered\n• Its edges did not fit cleanly in this frame'
    case 'too-fast':
      return hint.degPerS === null
        ? `Move more slowly\n• The turning speed is not known; frames are used below ${whole(hint.limitDegPerS)}°/s`
        : `Move more slowly\n• The camera turned ${figure(whole(hint.degPerS), '°/s', 'fast')}; frames are used below ${whole(hint.limitDegPerS)}°/s`
    case 'ambiguous-view':
      return 'Ambiguous view: two tilts of the marker fit equally well\n• Step to one side, then sweep sideways'
    case 'sweep':
      // 40° to one side is a wall marker's advice (a wall tag's heading is the poorly fixed axis, and a view from the side fixes it); a flat one is not asked for it.
      return hint.mount === 'horizontal'
        ? 'Sweep sideways\n• Move slowly across with the marker in view'
        : 'Sweep sideways\n• Stand 1.5–2.5 m from the marker, about 40° to one side, then move slowly across'
    case 'move-for-scale':
      // What is worked out from the marker is the session's unit; what is checked, on a runtime whose unit is the metre, is the print's size. Neither is the marker's size, which is an input.
      return hint.purpose === 'print-check'
        ? `Move sideways a little\n• The print's size can be checked once the camera has moved about ${whole(MIN_SCALE_BASELINE_M * 100)} cm`
        : `Move sideways a little\n• The room's scale can be worked out from the marker once the camera has moved about ${whole(MIN_SCALE_BASELINE_M * 100)} cm`
    case 'spread': {
      // The figures that are over their own gate, and only those (the session fills in the rest as null).
      const figures: string[] = []
      const pos = hint.poseSpreadM === null ? null : cm(hint.poseSpreadM)
      const head = hint.headingSpreadDeg === null ? null : one(hint.headingSpreadDeg)
      const rot = hint.rotationSpreadDeg === null ? null : one(hint.rotationSpreadDeg)
      if (pos !== null) figures.push(`${pos} cm`)
      if (head !== null) figures.push(`${head}° in heading`)
      if (rot !== null) figures.push(`${rot}° in orientation`)
      return figures.length > 0
        ? `Readings still disagree\n• ${figures.join(', ')} between frames; keep the marker in view and move slowly`
        : 'Readings still disagree\n• Keep the marker in view and move slowly'
    }
    case 'steep-view':
      return `Look at the marker more squarely\n• It is seen ${figure(whole(hint.viewAngleDeg), '°', 'at a steep angle')} off its face; ${whole(hint.limitDeg)}° is the most that is used`
    case 'range':
      // The range is the printed size and the pixels speaking, so a range that is not believable is as likely the size entered as the distance.
      if (hint.rangeM < hint.minM) return `The marker reads too close\n• ${whole(hint.rangeM * 100)} cm away; at least ${whole(hint.minM * 100)} cm is needed. If it is farther, the size entered is too small`
      if (hint.rangeM > hint.maxM) return `The marker reads too far\n• ${one(hint.rangeM)} m away; at most ${whole(hint.maxM)} m is used. If it is nearer, the size entered is too large`
      return "The marker's distance is not known\n• Check the size entered"
    case 'poor-fit': {
      const off = two(hint.rmsPx)
      return `The marker's corners do not fit a flat square\n• ${off === null ? 'How far off is not known' : `${off} px off`}; up to ${two(hint.limitPx)} px is used. Keep the sheet flat and hold the camera steady`
    }
    case 'reading':
      return `Reading the marker\n• ${hint.accepted} of ${hint.needed} frames`
    case 'bad-intrinsics':
      return "Cannot read the marker with this camera view\n• The camera's field of view and the image size disagree"
    case 'frame-shifted':
      return 'Tracking moved: reading the marker again from the start'
    case 'other-tag':
      return `That is marker ${hint.tagId}, not this Place's marker\n• Look for the one registered for this Place`
    case 'tilted': {
      const tilt = finite(hint.normalY) ? Math.round((Math.asin(Math.min(1, Math.abs(hint.normalY))) * 180) / Math.PI) : null
      return `The marker is neither upright nor flat\n• ${tilt === null ? 'Its face is tilted' : `Its face is tilted ${tilt}° from a wall`}; mount it upright on a wall or lay it flat`
    }
    case 'mount-mismatch':
      return hint.expected === 'wall'
        ? 'The marker is not upright on a wall\n• The sheet says wall, but it was read lying flat'
        : 'The marker is not lying flat\n• The sheet says flat, but it was read upright'
    case 'bad-height':
      return `The mounting height does not fit\n• It put the marker below the floor or more than ${whole(TAG_HEIGHT_MAX_M)} m above it: check the height entered`
    case 'need-floor':
      return "No floor height yet\n• Enter the marker's height above the floor, or scan the floor first"
    default: {
      const exhaustive: never = hint
      return String(exhaustive)
    }
  }
}

/** What the screen says when the session gave up looking, `fallbackAfterMs` of frame time after the first frame. */
export function tagTimeoutText(fallbackAfterMs: number = FALLBACK_TO_TAPS_MS): string {
  return `The marker was not read in ${whole(fallbackAfterMs / 1000)} s\n• Use two taps instead`
}

/** Why marker reading is not available here, in a line and one bullet. */
export function tagUnavailableText(reason: TagUnavailableReason): string {
  switch (reason) {
    case 'webxr-no-camera-access':
      return 'This browser does not give the app the camera image\n• The printed marker cannot be read here; use two taps'
    case 'no-frame-feed':
      return 'This camera mode cannot supply frames for reading the marker\n• Use two taps'
    case 'cover-fit':
      return 'Marker reading needs the whole camera view\n• The view is cropped (camerafit=cover); remove it or use two taps'
    default: {
      const exhaustive: never = reason
      return String(exhaustive)
    }
  }
}

// -------------------------------------------------------------------------------------------
// After reading
// -------------------------------------------------------------------------------------------

/** The badge on a marker read: how the frames fitted. */
export function tagQualityText(quality: FiducialQuality): string {
  return `Marker read: ${quality}`
}

/** One reason a marker calibration is provisional, as a clause. */
export function tagVerdictReasonText(reason: FiducialVerdictReason, evidence: FiducialEvidence, gates: Readonly<FiducialGates> = DEFAULT_FIDUCIAL_GATES): string {
  switch (reason) {
    case 'first-calibration':
      return "First marker for this Place: nothing to match, so it stays provisional"
    case 'identity-mismatch':
      return `Read marker ${evidence.tagId}; this Place's is ${evidence.expectedTagId ?? 'not recorded'}`
    case 'identity-unconfirmed':
      return `The marker was read in ${evidence.identityFrames} of the last ${evidence.identityWindow} frames; ${gates.identityMinFrames} are needed`
    case 'too-few-frames':
      return `Only ${evidence.nFrames} frames; ${gates.minFrames} are needed`
    case 'too-short':
      return `Read over ${figure(one(evidence.durationMs / 1000), ' s', 'an unknown time')}; ${one(gates.minDurationMs / 1000)} s is needed`
    case 'too-little-motion':
      return `The camera moved ${figure(whole(evidence.cameraTravelM * 100), ' cm', 'an unknown distance')} and turned ${figure(whole(evidence.cameraTurnDeg), '°', 'an unknown angle')}; ${whole(gates.minTravelM * 100)} cm or ${whole(gates.minTurnDeg)}° is needed`
    case 'too-fast':
      return `The camera turned up to ${figure(whole(evidence.maxAngularSpeedDegPerS), '°/s', 'fast')}; under ${whole(gates.maxAngularSpeedDegPerS)}°/s is needed`
    case 'spread':
      return `Position spread between frames ${figure(cm(evidence.poseSpreadM), ' cm', 'is not known')}; ${cm(gates.maxPoseSpreadM)} cm is allowed`
    case 'heading-spread':
      return `Heading spread between frames ${figure(one(evidence.headingSpreadDeg), '°', 'is not known')}; ${one(gates.maxHeadingSpreadDeg)}° is allowed`
    case 'rotation-spread':
      return `Orientation spread between frames ${figure(one(evidence.rotationSpreadDeg), '°', 'is not known')}; ${one(gates.maxRotationSpreadDeg)}° is allowed`
    case 'reprojection':
      return `Corners fit to ${figure(one(evidence.reprojectionRmsPx), ' px', 'an unknown error')}; ${one(gates.maxReprojectionRmsPx)} px is allowed`
    case 'scale-mismatch': {
      const pct = evidence.scaleOffFraction === null ? null : one(Math.abs(evidence.scaleOffFraction) * 100)
      return `The print's size puts the runtime's metre ${figure(pct, '%', 'far')} off (more than ${whole(gates.maxScaleOffFraction * 100)}% is flagged): the print scale, the lens or tracking is off`
    }
    case 'scale-unchecked':
      return `The print's size was not checked: that needs the camera to move about ${whole(MIN_SCALE_BASELINE_M * 100)} cm, and it moved ${figure(whole(evidence.cameraTravelM * 100), ' cm', 'less')}`
    default: {
      const exhaustive: never = reason
      return String(exhaustive)
    }
  }
}

/** Most bullets of reasons a verdict text shows. */
const MAX_REASON_BULLETS = 2

/** The measurement summary a marker read carries: the spread between frames, and what is known of the print size. */
function measurementLine(evidence: FiducialEvidence): string {
  const spread = `Spread between frames: ${figure(cm(evidence.poseSpreadM), ' cm', 'not known')}, ${figure(one(evidence.headingSpreadDeg), '° in heading', 'not known')}`
  if (evidence.scaleSource === 'runtime-metric') {
    if (evidence.scaleOffFraction === null) return `${spread}; print size not checked`
    return `${spread}; print size is ${figure(one(Math.abs(evidence.scaleOffFraction) * 100), '%', 'an unknown amount')} off the runtime's metres`
  }
  return `${spread}; print size taken as ${evidence.printedSizeMm} mm (${evidence.sizeSource === 'measured' ? 'measured' : 'from the sheet'}), not checked`
}

/**
 * The text for a finished marker read. `'verified'` says the tag is the Place's registered one and what was measured, and
 * names what was not checked. Anything else leads with why it is not.
 */
export function tagVerdictText(verdict: FiducialVerdict, evidence: FiducialEvidence, gates: Readonly<FiducialGates> = DEFAULT_FIDUCIAL_GATES): string {
  if (verdict.status === 'verified') {
    return [`✓ Same marker as this Place's (tag ${evidence.tagId})`, `• ${measurementLine(evidence)}`, '• Not checked: whether the marker has been moved'].join('\n')
  }
  const identityProblem = verdict.reasons.includes('identity-mismatch')
    ? "⚠ Not this Place's marker"
    : verdict.reasons.includes('identity-unconfirmed')
      ? '⚠ Marker not confirmed'
      : `${verdict.quality === 'poor' ? '⚠ ' : ''}${tagQualityText(verdict.quality)}`
  // At most two bullets of reasons: the first reason in full and a count of the rest, so a read that failed every gate still fits a status card.
  const reasons = verdict.reasons.length <= MAX_REASON_BULLETS
    ? verdict.reasons.map((r) => `• ${tagVerdictReasonText(r, evidence, gates)}`)
    : [`• ${tagVerdictReasonText(verdict.reasons[0]!, evidence, gates)}`, `• and ${verdict.reasons.length - 1} more reasons`]
  // The measurements belong on a read that was made: not on one for a different marker, whose numbers say nothing about this Place's.
  const lines = [identityProblem, ...reasons]
  if (!verdict.reasons.includes('identity-mismatch')) lines.push(`• ${measurementLine(evidence)}`)
  return lines.join('\n')
}
