/**
 * One predicate for "this scan is in the Place frame" (F-25).
 *
 * A scan row carries two chips that judge the scan against its Place: the calibration chip's frame warning
 * (src/viewer/scan-calibration-chip.ts) and the frame chip (src/viewer/frame-banner.ts). They used to ask different
 * questions, so a one-point scan in a two-point Place showed "Different frame from this Place" beside "not in Place
 * frame". Both now ask `isInPlaceFrame` (src/world/frame-generations.ts): across every pair of scan tier and Place tier,
 * a row never shows both, and the frame warning appears only on a scan the frame chip counts as in a frame.
 *
 * `isPlaceFrameMethod` (src/world/spatial-frame.ts) is unchanged: which methods a stored frame may carry. The
 * place-register job still asks it, so its choices are unchanged too.
 *
 * frame-banner.ts builds DOM, which Deno's type check has no types for, so the frame chip's rule is used here as that
 * file states it (a Place with a frame and a scan `isInPlaceFrame` rejects: "not in Place frame"), and
 * tests/unit/node/scan_calibration_chip.test.ts runs the same check against `frameChipFor` itself.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { scanCalibrationChip, type ChipScan } from '../../../src/viewer/scan-calibration-chip.ts'
import { isInPlaceFrame } from '../../../src/world/frame-generations.ts'
import { isPlaceFrameMethod, SPATIAL_FRAME_METHODS } from '../../../src/world/spatial-frame.ts'
import { isPlaceCalibrated } from '../../../server/register/place_register.ts'

const TIERS = ['two-point-ground', 'ground-tap-compass', 'known-distance'] as const
const STATUSES = ['verified', 'provisional', 'uncalibrated'] as const

Deno.test('F-25: no scan row shows "Different frame from this Place" beside "not in Place frame"', () => {
  for (const placeMethod of SPATIAL_FRAME_METHODS) {
    for (const calibrationMethod of TIERS) {
      for (const calibrationStatus of STATUSES) {
        for (const outside of [undefined, true] as const) {
          const scan = {
            calibrationMethod,
            calibrationStatus,
            calibrationResidualM: 0,
            calibrationToleranceM: 0.15,
            calibratedAt: '2026-11-02T10:00:00.000Z',
            ...(outside ? { calibrationOutsidePlaceFrame: true } : {}),
          } as ChipScan
          const chip = scanCalibrationChip(scan, placeMethod)
          const label = `${calibrationMethod}/${calibrationStatus}${outside ? '/outside' : ''} in a ${placeMethod} Place`
          // The frame chip says "not in Place frame" exactly for these (frame-banner.ts), and then no warning stands beside it.
          if (!isInPlaceFrame(scan)) assertEquals(chip?.frameWarning ?? null, null, label)
          // The warning is only ever on a scan the one predicate counts as in a frame.
          if (chip?.frameWarning) assert(isInPlaceFrame(scan), label)
        }
      }
    }
  }
})

Deno.test('F-25: a two-point scan in a one-point Place keeps its warning: it is in a Place frame, of another method', () => {
  const scan = { calibrationMethod: 'two-point-ground', calibrationStatus: 'verified', calibrationResidualM: 0.02, calibrationToleranceM: 0.15 } as ChipScan
  assertEquals(isInPlaceFrame(scan), true)
  assertEquals(scanCalibrationChip(scan, 'ground-tap-compass')?.frameWarning, 'Different frame from this Place')
})

Deno.test('F-25: isPlaceFrameMethod keeps its one job, so the place-register job chooses exactly as before', () => {
  // Which methods a stored frame may carry: both tiers. Unchanged.
  assertEquals(isPlaceFrameMethod('two-point-ground'), true)
  assertEquals(isPlaceFrameMethod('ground-tap-compass'), true)
  assertEquals(isPlaceFrameMethod('known-distance'), false)
  // place-register still compares one-point scans, which the editor's chips call "not in Place frame". Moving
  // isPlaceCalibrated onto isInPlaceFrame is server-runners' and the owner's call (see the ticket).
  assertEquals(isPlaceCalibrated({ calibrationMethod: 'ground-tap-compass' }), true)
  assertEquals(isInPlaceFrame({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }), false)
})
