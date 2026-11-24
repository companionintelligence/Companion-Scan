/**
 * What the 4d-capture contract (wave 14: server/person4d/person_4d.ts and subsystems/4d-capture/) adds to each clip of
 * a take, beyond its URL, type, pose track and sync record. Both fields are optional and set only when known:
 *
 *   - `durationMs`: the clip's length, from the pose track recorded beside it (src/capture/pose-track.ts writes it);
 *   - `localToWorld`: the member camera's session-to-Place matrix (column-major, the scan row's `localToWorld`), only
 *     for a member scan in the Place frame (`isInPlaceFrame`, ADR 0011). Without it the service densifies a
 *     multi-clip take instead of placing its cameras.
 *
 * main.ts's person-4d-reconstruct runner calls this for each member. It lives apart from main.ts, which serves at
 * import, so it can be tested.
 */
import type { ScanManifest } from '../src/world/types.ts'
import { isInPlaceFrame } from '../src/world/frame-generations.ts'
import { sessionDirPath } from './session_id.ts'
import * as fs from 'node:fs/promises'

export type Person4DClipExtras = { durationMs?: number; localToWorld?: number[] }

export async function person4dClipExtras(
  sessionsDir: string,
  sessionId: string,
  record: Record<string, unknown>,
  memberScan: ScanManifest | undefined,
): Promise<Person4DClipExtras> {
  const extras: Person4DClipExtras = {}
  const dir = sessionDirPath(sessionsDir, sessionId)
  if (dir && record['poseTrackFile']) {
    try {
      const track = JSON.parse(await fs.readFile(`${dir}/pose-track.json`, 'utf8')) as { durationMs?: unknown } | null
      if (typeof track?.durationMs === 'number' && Number.isFinite(track.durationMs) && track.durationMs > 0) {
        extras.durationMs = track.durationMs
      }
    } catch { /* no readable track: the length is not sent */ }
  }
  const matrix = memberScan?.localToWorld
  if (memberScan && isInPlaceFrame(memberScan) && Array.isArray(matrix) && matrix.length === 16 && matrix.every(Number.isFinite)) {
    extras.localToWorld = [...matrix]
  }
  return extras
}
