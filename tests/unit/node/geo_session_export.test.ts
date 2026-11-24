/**
 * The upload sidecar and the GLB extras carry the session record when the walk recorded one (`geoSession`,
 * src/world/geo-session.ts), and carry nothing new when it did not.
 *
 * The phone writes the record, the server reads the sidecar by key and ignores keys it does not know, so what matters is that the
 * record gets across whole (the server's reader, `parseGeoSession`, reads back what the phone sent), that the flat `geo*` fields keep
 * holding the fix they always held, and that a caller with no record sends exactly the keys it always sent: a sidecar that gained a
 * `geoSession: null` would be a new key on every old caller (tests/unit/node/frame_epoch_sidecar.test.ts pins the key set).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/geo_session_export.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportToGLB } from '../../../src/export/gltf.ts'
import type { GeoFix } from '../../../src/geo/geo-tracker.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import { type GeoSession, parseGeoSession } from '../../../src/world/geo-session.ts'

// ─── Shims: exportToGLB runs in node with FileReader and an upload fetch ───

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = buf
        this.onloadend?.()
      },
      (err) => this.onerror?.(err),
    )
  }
}
;(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader

let lastGlb: Uint8Array | null = null
let lastMetadata: Record<string, unknown> | null = null
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const body = init?.body as FormData | undefined
  const file = body?.get('file')
  if (file instanceof Blob) lastGlb = new Uint8Array(await file.arrayBuffer())
  const metadata = body?.get('metadata')
  if (typeof metadata === 'string') lastMetadata = JSON.parse(metadata) as Record<string, unknown>
  return new Response(JSON.stringify({ filename: 'stored.glb' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// ─── Fixture ───────────────────────────────────────────────────────────────

const store = { sessionId: 'sess-geo-session', detections: new Map(), currentRunDetections: () => new Map(), serverSessionOfThisRun: null } as unknown as DetectionStore

const cloud = {
  count: 24,
  toFloat32Array: () => Float32Array.from({ length: 72 }, (_, i) => (i % 3 === 1 ? 0.05 * Math.floor(i / 3) : 0.1 * Math.floor(i / 3))),
  boundingBox: () => ({ min: { x: 0, y: 0, z: -2.3 }, max: { x: 2.3, y: 1.15, z: 0 } }),
  estimateFloorY: () => 0.11,
} as unknown as PointCloud

const pose: Pose = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

const SESSION: GeoSession = {
  v: 1,
  startedAt: '2026-11-17T10:00:00.000Z',
  fix: { offsetS: 12.5, sessionX: 0.4, sessionZ: -0.2 },
  bearing: { deg: 200.5, spreadDeg: 6, sigmaDeg: 15, samples: 30, spanS: 9.5, source: 'android-absolute' },
  declination: { deg: 1.2, model: 'WMM2025', year: 2026.88 },
}

const FIX: GeoFix = {
  lat: 51.5007,
  lng: -0.1246,
  accuracy: 6,
  altitudeM: 12.5,
  bearing: 123,
  fixedAt: '2026-11-17T10:00:12.500Z',
  address: null,
  displayAddress: null,
  addressComponents: null,
}

/** The GLB's JSON chunk, the way the viewer and the server's optimize pass read it. */
function glbJson(glb: Uint8Array): { scenes?: Array<{ extras?: Record<string, unknown> }> } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as { scenes?: Array<{ extras?: Record<string, unknown> }> }
}

async function exportWith(extra: { geoFix?: GeoFix; geoSession?: GeoSession | null }): Promise<{ metadata: Record<string, unknown>; extras: Record<string, unknown> }> {
  lastGlb = null
  lastMetadata = null
  await exportToGLB({ store, pointCloud: cloud, poseHistory: [pose, pose], ...extra }, { download: false, upload: true })
  assert.ok(lastGlb && lastMetadata, 'the upload did not carry a GLB and its metadata')
  return { metadata: lastMetadata, extras: glbJson(lastGlb).scenes?.[0]?.extras ?? {} }
}

// ─── The record, when there is one ─────────────────────────────────────────

test('a session record goes into the sidecar and the GLB extras whole, and the server\'s reader reads back what the phone sent', async () => {
  const { metadata, extras } = await exportWith({ geoFix: FIX, geoSession: SESSION })
  assert.deepEqual(metadata['geoSession'], SESSION)
  assert.deepEqual(extras['geoSession'], SESSION)
  assert.deepEqual(parseGeoSession(metadata['geoSession']), SESSION, 'the reader that places the scan reads it back')
  // The flat fields keep holding the fix: the position is where it always was, and the record holds what they have no room for.
  assert.deepEqual([metadata['geoLat'], metadata['geoLng'], metadata['geoAccuracy'], metadata['geoAltitudeM'], metadata['geoFixedAt']], [51.5007, -0.1246, 6, 12.5, '2026-11-17T10:00:12.500Z'])
})

// ─── No record: nothing new ────────────────────────────────────────────────

test('a caller that recorded no session sends no geoSession key, in the sidecar or the extras, whether it passes nothing or null', async () => {
  for (const extra of [{ geoFix: FIX }, { geoFix: FIX, geoSession: null }, {}]) {
    const { metadata, extras } = await exportWith(extra)
    assert.equal('geoSession' in metadata, false, `sidecar, ${JSON.stringify(Object.keys(extra))}`)
    assert.equal('geoSession' in extras, false, `extras, ${JSON.stringify(Object.keys(extra))}`)
  }
})
