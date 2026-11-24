/**
 * What the scanner says during and after a marker calibration (`src/ar/fiducial/tag-copy.ts`): every sentence it can produce is true of
 * what was measured, and names what was not checked (ADR 0005 rule 3).
 *
 * The first half pins sentences to the numbers they are made from. The second enumerates every string the module can write, over every
 * hint code, every verdict reason, every reason a marker cannot be read, and verdicts of every status, and holds rules over the whole list: no
 * figure that does not exist ("NaN cm"), nothing longer than a status line takes, no claim of accuracy or of a verified frame, and the
 * clause about what was not checked in every verified read.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_tag_copy.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tagHintText,
  tagQualityText,
  tagTimeoutText,
  tagUnavailableText,
  tagVerdictReasonText,
  tagVerdictText,
  type TagUnavailableReason,
} from '../../../src/ar/fiducial/tag-copy.ts'
import { DEFAULT_FIDUCIAL_GATES, fiducialVerdict, type FiducialVerdictReason, type TagHint } from '../../../src/ar/fiducial/tag-session.ts'
import { MIN_SCALE_BASELINE_M } from '../../../src/ar/fiducial/tag-pose.ts'
import { TAG_HEIGHT_MAX_M } from '../../../src/ar/fiducial/tag-frame.ts'
import type { FiducialEvidence } from '../../../src/world/fiducial-evidence.ts'

function evidence(over: Partial<FiducialEvidence> = {}): FiducialEvidence {
  return {
    tagId: 7,
    family: 'cscan-6x6-v1',
    expectedTagId: 7,
    identityFrames: 8,
    identityWindow: 8,
    printedSizeMm: 200,
    sizeSource: 'qr',
    mount: 'wall',
    poseSpreadM: 0.0123,
    headingSpreadDeg: 0.31,
    rotationSpreadDeg: 0.44,
    reprojectionRmsPx: 0.31,
    rangeM: 2.2,
    nFrames: 14,
    durationMs: 3000,
    cameraTravelM: 0.5,
    cameraTurnDeg: 20,
    ambiguityRatio: 4,
    viewAngleDeg: 35,
    sidePx: 55,
    maxAngularSpeedDegPerS: 6,
    sessionUnitsPerMetre: 1,
    scaleSource: 'runtime-metric',
    scaleOffFraction: 0.013,
    scaleBaselineM: 0.52,
    scaleResidualM: 0.006,
    ...over,
  }
}

test('hints say what to do and quote the numbers that make it true', () => {
  assert.equal(tagHintText({ code: 'no-tag' }), 'Point the camera at the printed marker')
  assert.equal(tagHintText({ code: 'move-closer', sidePx: 31.4, neededPx: 40 }), 'Move closer to the marker\n• 31 px across, 40 px needed')
  assert.equal(tagHintText({ code: 'too-fast', degPerS: 14.6, limitDegPerS: 10 }), 'Move more slowly\n• The camera turned 15°/s; frames are used below 10°/s')
  assert.equal(tagHintText({ code: 'too-fast', degPerS: null, limitDegPerS: 10 }), 'Move more slowly\n• The turning speed is not known; frames are used below 10°/s')
  assert.equal(tagHintText({ code: 'reading', accepted: 7, needed: 12 }), 'Reading the marker\n• 7 of 12 frames')
  // Only the figures the session found over their own gate are written, each named for what it is.
  assert.equal(tagHintText({ code: 'spread', poseSpreadM: 0.0234, headingSpreadDeg: null, rotationSpreadDeg: null }), 'Readings still disagree\n• 2.3 cm between frames; keep the marker in view and move slowly')
  assert.equal(tagHintText({ code: 'spread', poseSpreadM: null, headingSpreadDeg: 1.26, rotationSpreadDeg: null }), 'Readings still disagree\n• 1.3° in heading between frames; keep the marker in view and move slowly')
  assert.equal(tagHintText({ code: 'spread', poseSpreadM: null, headingSpreadDeg: null, rotationSpreadDeg: 3.4 }), 'Readings still disagree\n• 3.4° in orientation between frames; keep the marker in view and move slowly')
  assert.equal(tagHintText({ code: 'spread', poseSpreadM: 0.0234, headingSpreadDeg: 1.26, rotationSpreadDeg: 3.4 }), 'Readings still disagree\n• 2.3 cm, 1.3° in heading, 3.4° in orientation between frames; keep the marker in view and move slowly')
  assert.equal(tagHintText({ code: 'spread', poseSpreadM: null, headingSpreadDeg: null, rotationSpreadDeg: null }), 'Readings still disagree\n• Keep the marker in view and move slowly')
  assert.equal(tagHintText({ code: 'other-tag', tagId: 12 }), "That is marker 12, not this Place's marker\n• Look for the one registered for this Place")
  assert.equal(tagHintText({ code: 'frame-shifted' }), 'Tracking moved: reading the marker again from the start')
  // The advice that the spec names, and the numbers it is built on.
  assert.equal(tagHintText({ code: 'sweep', mount: 'wall' }), 'Sweep sideways\n• Stand 1.5–2.5 m from the marker, about 40° to one side, then move slowly across')
  assert.equal(tagHintText({ code: 'sweep', mount: null }), tagHintText({ code: 'sweep', mount: 'wall' }), 'a mount nobody has stated is given the wall marker\'s advice')
  // A flat marker is not asked to be seen from 40 degrees to one side: that is how a wall marker\'s weak axis is helped.
  assert.equal(tagHintText({ code: 'sweep', mount: 'horizontal' }), 'Sweep sideways\n• Move slowly across with the marker in view')
  assert.match(tagHintText({ code: 'ambiguous-view' }), /Step to one side, then sweep sideways/)
  // What is asked for is movement, and what it is for is said as what it is: the unit worked out, or the print's size checked. The marker's size is an input, and is never "worked out".
  const cm30 = new RegExp(`${Math.round(MIN_SCALE_BASELINE_M * 100)} cm`)
  assert.equal(tagHintText({ code: 'move-for-scale', purpose: 'unit' }), 'Move sideways a little\n• The room\'s scale can be worked out from the marker once the camera has moved about 30 cm')
  assert.equal(tagHintText({ code: 'move-for-scale', purpose: 'print-check' }), 'Move sideways a little\n• The print\'s size can be checked once the camera has moved about 30 cm')
  for (const purpose of ['unit', 'print-check'] as const) {
    assert.match(tagHintText({ code: 'move-for-scale', purpose }), cm30)
    assert.doesNotMatch(tagHintText({ code: 'move-for-scale', purpose }), /marker's size/)
  }
  // The pose limits a frame is held to are said with the figure that failed.
  assert.equal(tagHintText({ code: 'steep-view', viewAngleDeg: 74.4, limitDeg: 70 }), 'Look at the marker more squarely\n• It is seen 74° off its face; 70° is the most that is used')
  assert.equal(
    tagHintText({ code: 'range', rangeM: 0.21, minM: 0.3, maxM: 10 }),
    'The marker reads too close\n• 21 cm away; at least 30 cm is needed. If it is farther, the size entered is too small',
  )
  assert.equal(
    tagHintText({ code: 'range', rangeM: 20.04, minM: 0.3, maxM: 10 }),
    'The marker reads too far\n• 20.0 m away; at most 10 m is used. If it is nearer, the size entered is too large',
  )
  assert.equal(tagHintText({ code: 'range', rangeM: Number.NaN, minM: 0.3, maxM: 10 }), "The marker's distance is not known\n• Check the size entered")
  assert.equal(
    tagHintText({ code: 'poor-fit', rmsPx: 1.234, limitPx: 0.8 }),
    "The marker's corners do not fit a flat square\n• 1.23 px off; up to 0.80 px is used. Keep the sheet flat and hold the camera steady",
  )
  assert.match(tagHintText({ code: 'bad-height' }), new RegExp(`${TAG_HEIGHT_MAX_M} m`))
  // The tilt of a mount is the angle its normal makes with the horizontal: 0.5 up is 30 degrees from a wall.
  assert.match(tagHintText({ code: 'tilted', normalY: 0.5 }), /tilted 30° from a wall/)
  assert.match(tagHintText({ code: 'tilted', normalY: -0.5 }), /tilted 30° from a wall/)
  assert.match(tagHintText({ code: 'tilted', normalY: Number.NaN }), /Its face is tilted;/)
  assert.match(tagHintText({ code: 'mount-mismatch', expected: 'wall' }), /says wall, but it was read lying flat/)
  assert.match(tagHintText({ code: 'mount-mismatch', expected: 'horizontal' }), /says flat, but it was read upright/)
})

test('a size or a speed that does not exist prints no figure, never "NaN"', () => {
  assert.equal(tagHintText({ code: 'move-closer', sidePx: Number.NaN, neededPx: 40 }), 'Move closer to the marker\n• Its size is not known across, 40 px needed')
  assert.ok(!/NaN/.test(tagHintText({ code: 'too-fast', degPerS: Number.NaN, limitDegPerS: 10 })))
  assert.equal(tagHintText({ code: 'spread', poseSpreadM: Number.NaN, headingSpreadDeg: Number.NaN, rotationSpreadDeg: Number.NaN }), 'Readings still disagree\n• Keep the marker in view and move slowly')
  assert.equal(tagHintText({ code: 'spread', poseSpreadM: Number.NaN, headingSpreadDeg: 1.4, rotationSpreadDeg: null }), 'Readings still disagree\n• 1.4° in heading between frames; keep the marker in view and move slowly')
  assert.ok(!/NaN/.test(tagHintText({ code: 'steep-view', viewAngleDeg: Number.NaN, limitDeg: 70 })))
  assert.ok(!/NaN/.test(tagHintText({ code: 'poor-fit', rmsPx: Number.NaN, limitPx: 0.8 })))
})

test('when marker reading is not available it says why in plain words and offers taps; when it times out it says how long it looked', () => {
  const reasons: TagUnavailableReason[] = ['webxr-no-camera-access', 'no-frame-feed', 'cover-fit']
  for (const r of reasons) {
    const text = tagUnavailableText(r)
    assert.ok(text.includes('\n• '), r)
    assert.match(text, /two taps|use two taps|remove it/, r)
  }
  assert.match(tagUnavailableText('webxr-no-camera-access'), /does not give the app the camera image/)
  assert.match(tagUnavailableText('cover-fit'), /camerafit=cover/)
  assert.equal(tagTimeoutText(), 'The marker was not read in 30 s\n• Use two taps instead')
  assert.equal(tagTimeoutText(12_000), 'The marker was not read in 12 s\n• Use two taps instead')
})

test('a verified read says which marker, the spread between frames, what the print size is known by, and that whether the marker has moved was not checked', () => {
  const e = evidence()
  const v = fiducialVerdict(e)
  assert.equal(v.status, 'verified')
  assert.equal(
    tagVerdictText(v, e),
    ["✓ Same marker as this Place's (tag 7)", "• Spread between frames: 1.2 cm, 0.3° in heading; print size is 1.3% off the runtime's metres", '• Not checked: whether the marker has been moved'].join('\n'),
  )
  // On a runtime whose unit came from the print, the size is taken as stated and the line says it was not checked, naming where it came from.
  const est = evidence({ scaleSource: 'tag-estimate', scaleOffFraction: null, sessionUnitsPerMetre: 1.6 })
  assert.match(tagVerdictText(fiducialVerdict(est), est), /print size taken as 200 mm \(from the sheet\), not checked/)
  const measured = evidence({ scaleSource: 'tag-estimate', scaleOffFraction: null, sessionUnitsPerMetre: 1.6, sizeSource: 'measured', printedSizeMm: 197 })
  assert.match(tagVerdictText(fiducialVerdict(measured), measured), /print size taken as 197 mm \(measured\), not checked/)
})

test('a first calibration is provisional and says there was nothing to match, with the badge; a poor read is marked as one', () => {
  const first = evidence({ expectedTagId: null })
  assert.equal(
    tagVerdictText(fiducialVerdict(first), first),
    ['Marker read: good', '• First marker for this Place: nothing to match, so it stays provisional', "• Spread between frames: 1.2 cm, 0.3° in heading; print size is 1.3% off the runtime's metres"].join('\n'),
  )
  assert.equal(tagQualityText('fair'), 'Marker read: fair')
  const poor = evidence({ expectedTagId: null, poseSpreadM: 0.05 })
  const text = tagVerdictText(fiducialVerdict(poor), poor)
  assert.match(text, /^⚠ Marker read: poor\n/)
  assert.match(text, /Position spread between frames 5\.0 cm; 2\.0 cm is allowed/)
})

test('a marker that is not the Place\'s says so and quotes nothing of its reading; one seen too seldom says how seldom', () => {
  const other = evidence({ tagId: 3 })
  const t = tagVerdictText(fiducialVerdict(other), other)
  assert.equal(t, "⚠ Not this Place's marker\n• Read marker 3; this Place's is 7")
  assert.ok(!/Spread/.test(t), 'the figures of another marker say nothing about this Place')
  const seldom = evidence({ identityFrames: 3 })
  assert.equal(tagVerdictText(fiducialVerdict(seldom), seldom).split('\n')[0], '⚠ Marker not confirmed')
  assert.match(tagVerdictText(fiducialVerdict(seldom), seldom), /read in 3 of the last 8 frames; 5 are needed/)
  assert.ok(tagVerdictReasonText('identity-mismatch', evidence({ tagId: 3, expectedTagId: null })).includes('not recorded'), 'a Place with no marker recorded is not named by an id it does not have')
})

test('a read that fails several gates shows the first reason in full and counts the rest, so that it still fits a status card; two reasons are shown in full', () => {
  // Five gates failed: the first reason is quoted, the other four are counted, and the measurements are still there.
  const many = evidence({ expectedTagId: null, nFrames: 9, durationMs: 700, cameraTravelM: 0.1, cameraTurnDeg: 5, poseSpreadM: 0.05, headingSpreadDeg: 1.5, rotationSpreadDeg: 2 })
  const v = fiducialVerdict(many)
  assert.ok(v.reasons.length >= 5, `${v.reasons.join(', ')}`)
  const lines = tagVerdictText(v, many).split('\n')
  assert.equal(lines.length, 4)
  assert.equal(lines[1], `• ${tagVerdictReasonText(v.reasons[0]!, many)}`)
  assert.equal(lines[2], `• and ${v.reasons.length - 1} more reasons`)
  assert.match(lines[3]!, /^• Spread between frames/)
  // Exactly two reasons: both in full, nothing counted.
  const two = evidence({ nFrames: 9, durationMs: 700 })
  const v2 = fiducialVerdict(two)
  assert.deepEqual([...v2.reasons], ['too-few-frames', 'too-short'])
  const t2 = tagVerdictText(v2, two).split('\n')
  assert.equal(t2[1], `• ${tagVerdictReasonText('too-few-frames', two)}`)
  assert.equal(t2[2], `• ${tagVerdictReasonText('too-short', two)}`)
  assert.ok(!t2.some((l) => /more reasons/.test(l)))
  // Three: the first and a count of two.
  const three = evidence({ nFrames: 9, durationMs: 700, poseSpreadM: 0.05 })
  const v3 = fiducialVerdict(three)
  assert.equal(v3.reasons.length, 3)
  assert.equal(tagVerdictText(v3, three).split('\n')[2], '• and 2 more reasons')
})

test('each reason a read is provisional quotes the measured figure and the limit it was held to', () => {
  const g = DEFAULT_FIDUCIAL_GATES
  const cases: Array<[FiducialVerdictReason, Partial<FiducialEvidence>, RegExp]> = [
    ['too-few-frames', { nFrames: 9 }, /Only 9 frames; 12 are needed/],
    ['too-short', { durationMs: 740 }, /Read over 0\.7 s; 1\.0 s is needed/],
    ['too-little-motion', { cameraTravelM: 0.12, cameraTurnDeg: 6 }, /moved 12 cm and turned 6°; 20 cm or 15° is needed/],
    ['too-fast', { maxAngularSpeedDegPerS: 13 }, /turned up to 13°\/s; under 10°\/s is needed/],
    ['spread', { poseSpreadM: 0.034 }, /Position spread between frames 3\.4 cm; 2\.0 cm is allowed/],
    ['heading-spread', { headingSpreadDeg: 1.7 }, /Heading spread between frames 1\.7°; 1\.0° is allowed/],
    ['rotation-spread', { rotationSpreadDeg: 3.4 }, /Orientation spread between frames 3\.4°; 3\.0° is allowed/],
    ['reprojection', { reprojectionRmsPx: 0.93 }, /Corners fit to 0\.9 px; 0\.8 px is allowed/],
    ['scale-mismatch', { scaleOffFraction: -0.052 }, /puts the runtime's metre 5\.2% off \(more than 3% is flagged\)/],
    ['scale-unchecked', { scaleOffFraction: null, cameraTravelM: 0.27 }, /The print's size was not checked: that needs the camera to move about 30 cm, and it moved 27 cm/],
  ]
  for (const [reason, over, expected] of cases) assert.match(tagVerdictReasonText(reason, evidence(over), g), expected, reason)
  // With other gates, the limits quoted are those gates'.
  assert.match(tagVerdictReasonText('too-few-frames', evidence({ nFrames: 9 }), { ...g, minFrames: 20 }), /Only 9 frames; 20 are needed/)
})

// ===============================================================================================
// Every string
// ===============================================================================================

function everyString(): Array<{ label: string; text: string; verified: boolean }> {
  const out: Array<{ label: string; text: string; verified: boolean }> = []
  const hints: TagHint[] = [
    { code: 'no-tag' },
    { code: 'move-closer', sidePx: 31, neededPx: 40 },
    { code: 'move-closer', sidePx: Number.NaN, neededPx: 40 },
    { code: 'keep-uncovered' },
    { code: 'too-fast', degPerS: 14, limitDegPerS: 10 },
    { code: 'too-fast', degPerS: null, limitDegPerS: 10 },
    { code: 'ambiguous-view' },
    { code: 'sweep', mount: null },
    { code: 'sweep', mount: 'wall' },
    { code: 'sweep', mount: 'horizontal' },
    { code: 'move-for-scale', purpose: 'unit' },
    { code: 'move-for-scale', purpose: 'print-check' },
    { code: 'spread', poseSpreadM: 0.03, headingSpreadDeg: 1.5, rotationSpreadDeg: 4 },
    { code: 'spread', poseSpreadM: null, headingSpreadDeg: 1.5, rotationSpreadDeg: null },
    { code: 'spread', poseSpreadM: null, headingSpreadDeg: null, rotationSpreadDeg: null },
    { code: 'steep-view', viewAngleDeg: 74, limitDeg: 70 },
    { code: 'steep-view', viewAngleDeg: Number.NaN, limitDeg: 70 },
    { code: 'range', rangeM: 0.2, minM: 0.3, maxM: 10 },
    { code: 'range', rangeM: 20, minM: 0.3, maxM: 10 },
    { code: 'range', rangeM: Number.NaN, minM: 0.3, maxM: 10 },
    { code: 'poor-fit', rmsPx: 1.2, limitPx: 0.8 },
    { code: 'poor-fit', rmsPx: Number.NaN, limitPx: 0.8 },
    { code: 'reading', accepted: 3, needed: 12 },
    { code: 'bad-intrinsics' },
    { code: 'frame-shifted' },
    { code: 'other-tag', tagId: 4 },
    { code: 'tilted', normalY: 0.6 },
    { code: 'tilted', normalY: Number.NaN },
    { code: 'mount-mismatch', expected: 'wall' },
    { code: 'mount-mismatch', expected: 'horizontal' },
    { code: 'bad-height' },
    { code: 'need-floor' },
  ]
  for (const h of hints) out.push({ label: `hint ${h.code}`, text: tagHintText(h), verified: false })
  for (const r of ['webxr-no-camera-access', 'no-frame-feed', 'cover-fit'] as const) out.push({ label: `unavailable ${r}`, text: tagUnavailableText(r), verified: false })
  out.push({ label: 'timeout', text: tagTimeoutText(), verified: false })
  for (const q of ['good', 'fair', 'poor'] as const) out.push({ label: `quality ${q}`, text: tagQualityText(q), verified: false })
  const reasons: FiducialVerdictReason[] = ['first-calibration', 'identity-mismatch', 'identity-unconfirmed', 'too-few-frames', 'too-short', 'too-little-motion', 'too-fast', 'spread', 'heading-spread', 'rotation-spread', 'reprojection', 'scale-mismatch', 'scale-unchecked']
  const bad = evidence({ poseSpreadM: Number.NaN, headingSpreadDeg: Number.NaN, rotationSpreadDeg: Number.NaN, reprojectionRmsPx: Number.NaN, durationMs: Number.NaN, cameraTravelM: Number.NaN, cameraTurnDeg: Number.NaN, maxAngularSpeedDegPerS: Number.NaN, scaleOffFraction: Number.NaN })
  for (const r of reasons) {
    out.push({ label: `reason ${r}`, text: tagVerdictReasonText(r, evidence({ scaleOffFraction: 0.07, expectedTagId: null, identityFrames: 2 })), verified: false })
    out.push({ label: `reason ${r} (numbers that do not exist)`, text: tagVerdictReasonText(r, bad), verified: false })
  }
  const evidences: Array<[string, FiducialEvidence]> = [
    ['good registered', evidence()],
    ['good first', evidence({ expectedTagId: null })],
    ['estimated size, sheet', evidence({ scaleSource: 'tag-estimate', scaleOffFraction: null })],
    ['estimated size, measured', evidence({ scaleSource: 'tag-estimate', scaleOffFraction: null, sizeSource: 'measured' })],
    ['unchecked scale', evidence({ scaleOffFraction: null })],
    ['mismatched scale', evidence({ scaleOffFraction: 0.08 })],
    ['other marker', evidence({ tagId: 3 })],
    ['unconfirmed', evidence({ identityFrames: 2 })],
    ['poor', evidence({ expectedTagId: null, nFrames: 4, poseSpreadM: 0.06, headingSpreadDeg: 2.5, rotationSpreadDeg: 3, reprojectionRmsPx: 1.2, durationMs: 400, cameraTravelM: 0, cameraTurnDeg: 0, maxAngularSpeedDegPerS: 30 })],
    ['not finite', bad],
  ]
  for (const [name, e] of evidences) {
    const v = fiducialVerdict(e)
    out.push({ label: `verdict ${name}`, text: tagVerdictText(v, e), verified: v.status === 'verified' })
  }
  return out
}

test('over every string it can write: no figure that does not exist, no line longer than a status line, at most a headline and three bullets', () => {
  const strings = everyString()
  assert.ok(strings.length > 60, `${strings.length} strings enumerated`)
  for (const { label, text } of strings) {
    assert.ok(text.length > 0, label)
    assert.ok(!/NaN|undefined|null|\[object|Infinity/.test(text), `${label}: ${text}`)
    const lines = text.split('\n')
    assert.ok(lines.length <= 4, `${label}: ${lines.length} lines`)
    for (const line of lines) assert.ok(line.length <= 140, `${label}: a line of ${line.length} characters: ${line}`)
    assert.ok(!/ {2}|\t/.test(text), `${label}: stray spacing`)
  }
})

test('over every string: nothing claims what was not measured — no verified frame, no alignment, no accuracy — and a verified read always says what was not checked', () => {
  for (const { label, text, verified } of everyString()) {
    assert.ok(!/\b(verified|aligned|alignment|accurate|accurately|exact|exactly|precise|precisely|guaranteed|perfect)\b/i.test(text), `${label}: ${text}`)
    if (verified) {
      assert.match(text, /^✓ Same marker as this Place's \(tag \d+\)\n/, label)
      assert.match(text, /• Not checked: whether the marker has been moved$/, label)
      assert.match(text, /print size/, `${label}: a verified read says what is known of the print size`)
    } else {
      assert.ok(!/^✓/.test(text), `${label}: only a verified read gets the tick`)
      assert.ok(!/Same marker as this Place's/.test(text), `${label}: only a verified read says the marker is the Place's`)
    }
  }
  // The only strings with a tick are verdicts that came out verified.
  const ticked = everyString().filter((s) => s.text.startsWith('✓'))
  assert.ok(ticked.length >= 1 && ticked.every((s) => s.verified))
})
