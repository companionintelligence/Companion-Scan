/**
 * memory_push_georef.test.ts: what the Companion Memory event says of where the Place is (ADR 0015).
 * Run: node --test tests/unit/server/memory_push_georef.test.ts
 *
 * The helpers and fixtures are copies of memory_push.test.ts's, except that the scan here stands at a made-up
 * place: these tests are about the shape of the event, and any location reads the same.
 */
import { pushScanToMemory, type MemoryPushConfig } from '../../../server/memory_push.ts'
import type { ScanManifest } from '../../../src/world/types.ts'
import * as fs from 'node:fs/promises'
import { makeTempDir } from '../../../server/fs_util.ts'
import { test } from 'node:test'
import { serveFetch } from './http_server.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function assertEquals<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? 'assertEquals'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

interface Seen {
  uploadAuth?: string | null
  uploadFilename?: string
  uploadBytes?: number
  uploadSkipDescription?: string | null
  /**
   * Every upload in order, not just the last. The splat pipeline can attach a
   * second file, and "exactly one splat encoding was uploaded" is a claim only
   * the full list can settle — `uploadFilename` alone would show the winner and
   * hide however many attempts came before it.
   */
  uploads: Array<{ name: string; bytes: number }>
  eventAuth?: string | null
  eventBody?: {
    events: Array<{
      source_system: string
      source_id: string
      kind: string
      occurred_at: string
      title?: string
      description?: string
      payload: Record<string, unknown>
    }>
  }
}

async function stubServer(opts: {
  uploadStatus?: number
  eventStatus?: number
  duplicate?: boolean
  rejectReason?: string
} = {}) {
  const seen: Seen = { uploads: [] }
  let nextFileId = 0
  const server = await serveFetch(async (req) => {
    const u = new URL(req.url)
    // Path is the API base + route: the gateway strips /api before CI-Server,
    // so the stub accepts either shape.
    if (u.pathname.endsWith('/files/upload') && req.method === 'POST') {
      seen.uploadAuth = req.headers.get('x-api-key')
      if (opts.uploadStatus && opts.uploadStatus >= 400) {
        return new Response('nope', { status: opts.uploadStatus })
      }
      const form = await req.formData()
      const f = form.get('files')
      if (f instanceof File) {
        seen.uploadFilename = f.name
        seen.uploadBytes = (await f.arrayBuffer()).byteLength
        seen.uploads.push({ name: f.name, bytes: seen.uploadBytes })
      }
      seen.uploadSkipDescription = form.get('skipDescription') as string | null
      // Distinct ids per upload: the GLB is always first, so `file-uuid-1`
      // still means the mesh in every test written before splats existed.
      return Response.json([{ id: `file-uuid-${++nextFileId}` }])
    }
    if (u.pathname.endsWith('/v1/events') && req.method === 'POST') {
      seen.eventAuth = req.headers.get('x-api-key')
      seen.eventBody = await req.json()
      if (opts.eventStatus && opts.eventStatus >= 400) {
        return new Response('bad request', { status: opts.eventStatus })
      }
      if (opts.rejectReason) {
        return Response.json({ ingested: 0, duplicate: 0, rejected: [{ index: 0, reason: opts.rejectReason }] })
      }
      return Response.json(
        opts.duplicate ? { ingested: 0, duplicate: 1, rejected: [] } : { ingested: 1, duplicate: 0, rejected: [] },
      )
    }
    return new Response('not found', { status: 404 })
  })
  return { base: `${server.url}/api`, seen, close: () => server.close() }
}

function cfgFor(base: string): MemoryPushConfig {
  return {
    enabled: true,
    baseUrl: base,
    token: 'secret-key',
    sourceSystem: 'companion-scan',
    timeoutMs: 10_000,
    maxUploadBytes: 1024 * 1024,
  }
}

const SCAN: ScanManifest = {
  scanId: 'scan-session-123',
  sessionId: 'session-123',
  filename: 'room.glb',
  name: 'Living Room',
  glbUrl: '/scans/room.glb',
  metadataUrl: '/scans/room.json',
  geoPose: {
    lat: 51.5007,
    lng: -0.1246,
    altitudeM: null,
    bearing: 81.5,
    accuracyM: null,
    fixedAt: '2026-08-01T10:00:00.000Z',
    address: '1 Example Road, Testville',
    displayAddress: 'Testville',
  },
  localToWorld: null,
  accuracyM: null,
  capturedAt: '2026-08-01T10:05:00.000Z',
  pointCount: 1303,
  detectionCount: 0,
  layerIndex: [],
  status: 'ready',
} as unknown as ScanManifest

/**
 * Detections sidecar shapes:
 *   'none'   — no sidecar at all (splat-detect never ran)
 *   'legacy' — the label+position-only shape older sidecars carry, and the only
 *              shape this push understood before extents shipped
 *   'full'   — what splat_analyzer actually writes: an oriented 3D box per
 *              object (position/rotation/scale) plus the per-view frames its
 *              clustering voted over
 */

/**
 * Detections sidecar shapes:
 *   'none'   — no sidecar at all (splat-detect never ran)
 *   'legacy' — the label+position-only shape older sidecars carry, and the only
 *              shape this push understood before extents shipped
 *   'full'   — what splat_analyzer actually writes: an oriented 3D box per
 *              object (position/rotation/scale) plus the per-view frames its
 *              clustering voted over
 */
type DetectFixture = 'none' | 'legacy' | 'full'

/** The real run_local.py shape, down to the per-frame `score` the peak comes from. */

/** The real run_local.py shape, down to the per-frame `score` the peak comes from. */
const FULL_INTERACTIONS = {
  objects: [
    {
      label: 'sofa',
      position: { x: 1, y: 0, z: 2 },
      rotation: { x: 0, y: 0.7071, z: 0, w: 0.7071 },
      scale: { x: 2.05, y: 0.82, z: 0.94 },
      frames: [
        { frame_idx: 3, box: [0, 0, 100, 100], score: 0.31 },
        { frame_idx: 5, box: [4, 4, 90, 90], score: 0.47 },
        { frame_idx: 9, box: [8, 8, 80, 80], score: 0.22 },
      ],
    },
    {
      label: 'plant',
      position: { x: -1, y: 0, z: 0.5 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 0.4, y: 1.104, z: 0.4 },
      frames: [{ frame_idx: 2, box: [0, 0, 30, 60], score: 0.18 }],
    },
    // No frames — an object-level score is the only confidence on offer.
    { label: 'sofa', position: { x: 3, y: 0, z: 1 }, scale: { x: 1.8, y: 0.8, z: 0.9 }, score: 0.19 },
  ],
  frame_annotations: {},
}

/** What splat_detect.ts lands beside the sidecar; thresholds left at the analyzer's defaults. */

/** What splat_detect.ts lands beside the sidecar; thresholds left at the analyzer's defaults. */
const DETECT_MANIFEST = {
  schemaVersion: 1,
  tool: 'splat-analyzer',
  status: 'ok',
  createdAt: '2026-08-01T11:00:00.000Z',
  interactionsPath: 'room.interactions.json',
  objectCount: 3,
  prompt: 'sofa, chair, table, tv, lamp, plant',
  params: {
    python: '/home/ci/.venvs/splat-analyzer/bin/python',
    detectDir: '/home/ci/splat_analyzer',
    hipVisibleDevices: '1',
    pointSplatSize: '6',
    quality: 'medium',
    renderer: 'point',
  },
  sessionId: 'session-123',
  scanId: 'scan-session-123',
}

/** A scans dir containing room.glb (+ optionally detection sidecars). */

/** A scans dir containing room.glb (+ optionally detection sidecars). */
async function tempScans(
  detections: DetectFixture,
  opts: {
    detectManifest?: boolean
    interactions?: unknown
    /**
     * Extra binary artifacts beside the mesh: filename -> byte length. Sizes
     * matter more than contents here — `discoverSplatArtifacts` stats the file
     * and the upload cap compares against what stat reported.
     */
    files?: Record<string, number>
    /**
     * Extra JSON sidecars: filename -> value, written verbatim. Verbatim so a
     * value like `[]` can be tested: an array is a thing a sidecar can hold and
     * a manifest reader must reject.
     */
    sidecars?: Record<string, unknown>
  } = {},
): Promise<string> {
  const dir = await makeTempDir({ prefix: 'memory-push-test-' })
  await fs.writeFile(`${dir}/room.glb`, new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]))
  if (opts.interactions !== undefined) {
    await fs.writeFile(`${dir}/room.interactions.json`, JSON.stringify(opts.interactions))
  } else if (detections === 'full') {
    await fs.writeFile(`${dir}/room.interactions.json`, JSON.stringify(FULL_INTERACTIONS))
  } else if (detections === 'legacy') {
    await fs.writeFile(`${dir}/room.interactions.json`, JSON.stringify({
        objects: [
          { label: 'sofa', position: { x: 1, y: 0, z: 2 } },
          { label: 'plant', position: { x: -1, y: 0, z: 0.5 } },
          { label: 'sofa', position: { x: 3, y: 0, z: 1 } },
        ],
      }))
  }
  if (opts.detectManifest) {
    await fs.writeFile(`${dir}/room.splat-detect.manifest.json`, JSON.stringify(DETECT_MANIFEST))
  }
  for (const [name, size] of Object.entries(opts.files ?? {})) {
    await fs.writeFile(`${dir}/${name}`, new Uint8Array(size))
  }
  for (const [name, value] of Object.entries(opts.sidecars ?? {})) {
    await fs.writeFile(`${dir}/${name}`, JSON.stringify(value))
  }
  return dir
}

/** Narrow one wire object out of the event payload. */

function payloadOf(seen: Seen): Record<string, unknown> {
  return seen.eventBody!.events[0].payload
}

/** A real two-point scan as a real server served it before the tier passed through: status and separation, no method. */
const TWO_POINT_BEFORE: ScanManifest = {
  ...SCAN,
  calibrationStatus: 'verified',
  calibrationSeparationM: 2.80178514522438,
}

/** The same scan now: the sidecar's `calibration.method` reaches the manifest. */

/** The same scan now: the sidecar's `calibration.method` reaches the manifest. */
const TWO_POINT_NOW: ScanManifest = { ...TWO_POINT_BEFORE, calibrationMethod: 'two-point-ground' }

/** Push `scan` to a stub CI-Server and hand back the event payload it received, and the push result. */

// ── Where the Place is on Earth (ADR 0015) ────────────────────────────────────
//
// Two changes, pinned exactly so a later change to either is a decision and not a side effect.
//
//  1. `location.bearing` was the phone's compass heading when the scan was exported, read by consumers as the scan's heading. It is
//     magnetic and it is not the heading of the scan or of its frame. It is now `device_heading_at_export` with `northReference:
//     'magnetic'`, and the old key stays, with the same number, marked deprecated, so a consumer still reading it does not break.
//  2. `spatial_frame.georeference` carries where the Place's frame is on Earth (or an explicit null) when the caller says which Place
//     this is. Absent that, `spatial_frame` is exactly what it was.

/** A georeference as a map click makes one: London, a long wall, imagery-limited accuracy, confirmed. */
const GEOREFERENCE = {
  origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 3.5 },
  heightDatum: 'unknown' as const,
  bearingDeg: 30,
  bearingAccuracyDeg: 1,
  convention: 2 as const,
  datum: 'WGS84' as const,
  source: 'map-click' as const,
  registeredAt: '2026-11-17T10:00:00.000Z',
  confirmedAt: '2026-11-17T10:00:00.000Z',
  anchorRef: 'frame-1',
}

async function pushedFor(scan: ScanManifest, place?: { georeference: typeof GEOREFERENCE | null; georefVersion: number }) {
  const srv = await stubServer()
  const dir = await tempScans('none')
  try {
    await pushScanToMemory(cfgFor(srv.base), scan, { scansDir: dir, ...(place ? { place } : {}) })
    return payloadOf(srv.seen)
  } finally {
    await srv.close()
    await fs.rm(dir, { recursive: true })
  }
}

test('push: the phone\'s heading is device_heading_at_export, from magnetic north, and the old key is the same number marked deprecated', async () => {
  const payload = await pushedFor(SCAN)
  const loc = payload.location as Record<string, unknown>
  assertEquals(loc.device_heading_at_export, 81.5, 'the heading the phone had at export')
  assertEquals(loc.northReference, 'magnetic', 'a web compass is magnetic on every platform')
  // The old key is still there, readable, with the same value, and says what to read instead.
  assertEquals(loc.bearing, 81.5)
  assertEquals(JSON.stringify(loc.deprecated_keys), JSON.stringify({ bearing: 'device_heading_at_export' }))
  // Everything else about the location is as it was: the scan's own fix, read from the fixture rather than repeated here.
  assertEquals(loc.lat, SCAN.geoPose?.lat)
  assertEquals(loc.lon, SCAN.geoPose?.lng)
  assertEquals(loc.accuracy_m, null)
  assertEquals(
    Object.keys(loc).sort().join(','),
    ['accuracy_m', 'address', 'bearing', 'deprecated_keys', 'device_heading_at_export', 'display_address', 'lat', 'lon', 'northReference'].join(','),
  )
  // No compass reading is no heading, never 0.
  const none = await pushedFor({ ...SCAN, geoPose: { ...SCAN.geoPose, bearing: null } })
  const noneLoc = none.location as Record<string, unknown>
  assertEquals(noneLoc.device_heading_at_export, null)
  assertEquals(noneLoc.bearing, null)
  assertEquals(noneLoc.northReference, 'magnetic')
})

test('push: spatial_frame carries the Place\'s georeference, or an explicit null, when the caller says which Place this is', async () => {
  const withRecord = await pushedFor(TWO_POINT_NOW, { georeference: GEOREFERENCE, georefVersion: 3 })
  const frame = withRecord.spatial_frame as Record<string, unknown>
  const block = frame.georeference as Record<string, unknown>
  assertEquals(JSON.stringify(block.origin), JSON.stringify({ lat: 51.5007, lng: -0.1246, altitudeM: null }))
  assertEquals(block.crs, 'WGS84')
  assertEquals(block.bearingDeg, 30)
  assertEquals(JSON.stringify(block.accuracy), JSON.stringify({ positionM: 3.5, bearingDeg: 1 }))
  assertEquals(block.source, 'map-click')
  assertEquals(block.confirmedAt, '2026-11-17T10:00:00.000Z')
  assertEquals(block.georefVersion, 3)
  assertEquals(block.anchorRef, 'frame-1')
  assert(String(block.convention).includes('true bearing') && String(block.convention).includes('x east, y up, z south'), 'it says what the bearing is the bearing of and what the axes are')
  assert(String(frame.caveat).includes('georeference'), 'the caveat mentions it')

  // A Place with no georeference says so: an explicit null, so a consumer can tell "none" from "this build does not say".
  const noRecord = await pushedFor(TWO_POINT_NOW, { georeference: null, georefVersion: 0 })
  const noFrame = noRecord.spatial_frame as Record<string, unknown>
  assertEquals('georeference' in noFrame, true)
  assertEquals(noFrame.georeference, null)

  // Without the Place, spatial_frame is exactly what it was: no key.
  const unknown = await pushedFor(TWO_POINT_NOW)
  assertEquals('georeference' in (unknown.spatial_frame as Record<string, unknown>), false)
  // An unconfirmed seed says so.
  const seed = await pushedFor(TWO_POINT_NOW, { georeference: { ...GEOREFERENCE, source: 'gps-compass' as never, confirmedAt: undefined as never }, georefVersion: 1 })
  assertEquals(((seed.spatial_frame as Record<string, unknown>).georeference as Record<string, unknown>).confirmedAt, null)
})

test('push: a georeferenced Place ships spatial_frame even for a scan with no calibration and no fit, and an unreferenced one does not', async () => {
  const georeferenced = await pushedFor(SCAN, { georeference: GEOREFERENCE, georefVersion: 1 })
  assertEquals('spatial_frame' in georeferenced, true, 'where the Place is on Earth is something to say')
  const frame = georeferenced.spatial_frame as Record<string, unknown>
  assertEquals(frame.metric, false, 'and it claims no metric fit')
  assertEquals(frame.scale, null)
  // No georeference, no calibration, no fit: nothing to say, as before.
  const plain = await pushedFor(SCAN, { georeference: null, georefVersion: 0 })
  assertEquals('spatial_frame' in plain, false)
  assertEquals('spatial_frame' in (await pushedFor(SCAN)), false)
})
