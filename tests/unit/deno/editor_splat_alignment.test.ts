/**
 * Whether a trained splat is shown at real-world size, and the sentence that says so (src/viewer/splat-layer.ts:
 * `resolveSplatAlignment`, `formatAlignmentStatus`). FN-094 found no test of either; the matrix check in the first now
 * reads the shared `isMatrix16` (src/world/mat4.ts, F-41).
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { formatAlignmentStatus, resolveSplatAlignment } from '../../../src/viewer/splat-layer.ts'

type Align = NonNullable<Parameters<typeof resolveSplatAlignment>[0]>

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function align(over: Partial<Align> = {}): Align {
  return {
    status: 'ok',
    projectTransform: IDENTITY,
    scale: 0.5,
    residualM: 0.02,
    correspondenceCount: 12,
    params: { maxResidualM: 0.1, minCorrespondences: 6 },
    ...over,
  } as Align
}

Deno.test('a fit that measured everything is aligned, and its sentence quotes the measurement', () => {
  const alignment = resolveSplatAlignment(align({ calibrationMethod: 'two-point-ground' } as Partial<Align>))
  assertEquals(alignment.state, 'aligned')
  const sentence = formatAlignmentStatus(alignment)
  assert(sentence.startsWith('Aligned to project space at metric scale'), sentence)
  assert(sentence.includes('over 12 cameras'), sentence)
  assert(sentence.includes('via two-point-ground calibration'), sentence)
})

Deno.test('every way a fit can fail to count is unaligned, with its reason', () => {
  const cases: Array<[Align | undefined, RegExp]> = [
    [undefined, /no splat-align manifest available/],
    [align({ status: 'skipped', skippedReason: 'no poses' } as Partial<Align>), /skipped: no poses/],
    [align({ status: 'error', error: 'boom' } as Partial<Align>), /failed: boom/],
    [align({ projectTransform: [1, 2, 3] }), /no usable 4x4 projectTransform/],
    [align({ projectTransform: [...IDENTITY.slice(0, 15), Number.NaN] }), /no usable 4x4 projectTransform/],
    [align({ projectTransform: new Array(16) as number[] }), /no usable 4x4 projectTransform/],
    [align({ scale: 0 }), /no usable metric scale/],
    [align({ residualM: undefined as unknown as number }), /never measured a fit residual/],
    [align({ residualM: 0.5 }), /exceeds splat-align's own/],
    [align({ correspondenceCount: 2 }), /below splat-align's own minimum of 6/],
    [align({ tool: 'known-distance' } as Partial<Align>), /never recorded which axes/],
  ]
  for (const [input, reason] of cases) {
    const alignment = resolveSplatAlignment(input)
    assertEquals(alignment.state, 'unaligned', String(reason))
    if (alignment.state === 'unaligned') assert(reason.test(alignment.reason), `${alignment.reason} ~ ${reason}`)
    assert(formatAlignmentStatus(alignment).startsWith('Unaligned — arbitrary SfM scale'))
  }
})

Deno.test('a fit that fixed the size but not the heading or origin says only that', () => {
  const alignment = resolveSplatAlignment(align({ determined: { scale: true, up: true, heading: false, origin: false } } as Partial<Align>))
  assertEquals(alignment.state, 'aligned')
  const sentence = formatAlignmentStatus(alignment)
  assert(sentence.startsWith('Shown at real-world size'), sentence)
  assert(sentence.includes('Which way it faces and where it sits are not set yet.'), sentence)
  assertEquals(formatAlignmentStatus(undefined), '')
})
