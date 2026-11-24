/**
 * The two fields the 4d-capture contract adds to a take's clips (server/scan_take_clips.ts), asked for by
 * server-runners (wave 14 ticket 0002): the clip's length from its pose track, and the camera's session-to-Place
 * matrix for a member scan in the Place frame. Both are optional and set only when known.
 *
 *   deno test --allow-read --allow-write tests/unit/deno/server_core_take_clips.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { person4dClipExtras } from '../../../server/scan_take_clips.ts'
import type { ScanManifest } from '../../../src/world/types.ts'

const MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 3, 1]

function scan(over: Partial<ScanManifest>): ScanManifest {
  return { scanId: 'scan-a', filename: 'a.glb', localToWorld: MATRIX, ...over } as unknown as ScanManifest
}

Deno.test('take clips: the length comes from the pose track, and the matrix only for a scan in the Place frame', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'server-core-take-' })
  try {
    await Deno.mkdir(`${dir}/sess-a`)
    await Deno.writeTextFile(`${dir}/sess-a/pose-track.json`, JSON.stringify({ version: 1, durationMs: 4200, frames: [] }))
    const placed = scan({ calibrationMethod: 'two-point-ground', calibrationStatus: 'provisional' } as Partial<ScanManifest>)
    assertEquals(await person4dClipExtras(dir, 'sess-a', { poseTrackFile: 'pose-track.json' }, placed), { durationMs: 4200, localToWorld: MATRIX })

    const outside = scan({ calibrationMethod: 'two-point-ground', calibrationStatus: 'provisional', calibrationOutsidePlaceFrame: true } as Partial<ScanManifest>)
    assertEquals(await person4dClipExtras(dir, 'sess-a', { poseTrackFile: 'pose-track.json' }, outside), { durationMs: 4200 })
    const uncalibrated = scan({ calibrationStatus: 'uncalibrated' } as Partial<ScanManifest>)
    assertEquals(await person4dClipExtras(dir, 'sess-a', { poseTrackFile: 'pose-track.json' }, uncalibrated), { durationMs: 4200 })

    // No pose track on the record, or one that is not there or has no length: no length.
    assertEquals(await person4dClipExtras(dir, 'sess-a', {}, undefined), {})
    assertEquals(await person4dClipExtras(dir, 'sess-gone', { poseTrackFile: 'pose-track.json' }, undefined), {})
    await Deno.writeTextFile(`${dir}/sess-a/pose-track.json`, JSON.stringify({ version: 1, frames: [] }))
    assertEquals(await person4dClipExtras(dir, 'sess-a', { poseTrackFile: 'pose-track.json' }, undefined), {})
    // A matrix that is not sixteen finite numbers is not sent.
    const broken = scan({ calibrationMethod: 'two-point-ground', calibrationStatus: 'provisional', localToWorld: [1, 2, 3] } as Partial<ScanManifest>)
    assertEquals(await person4dClipExtras(dir, 'sess-a', {}, broken), {})
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
