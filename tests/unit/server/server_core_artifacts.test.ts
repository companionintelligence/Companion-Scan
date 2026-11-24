/**
 * F-22 (server half): the files the editor asks for are served, and go with their scan.
 *
 *   - `/sessions/<id>/colmap-poses.manifest.json` (src/viewer/reconstruction-quality.ts) and `colmap.poses.json`
 *     (the colmap-poses job's artifact) through the session artifact allowlist.
 *   - `/scans/<base>.panoptic-lift.manifest.json` and `/scans/<base>.panoptic.detections.json`
 *     (src/viewer/panoptic-layer.ts) through the scan artifact allowlist, which deletion also takes.
 *   - A served JSON file has the server paths its runner wrote cut to file names.
 */
import { assert, assertEquals, assertFalse } from './assert.ts'
import { removeScanFiles } from '../../../server/scan_deletion.ts'
import { filesUnder, startServer } from './server_core_harness.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'
import { makeTempDir } from '../../../server/fs_util.ts'

const SESSION = 'sess-artifacts-0001'
const BASE = '1700000000000_room'

function glb(): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }))
  const padded = new Uint8Array(json.length + ((4 - (json.length % 4)) % 4)).fill(0x20)
  padded.set(json)
  const bytes = new Uint8Array(20 + padded.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546C67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.length, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, 0x4E4F534A, true)
  bytes.set(padded, 20)
  return bytes
}

test('scan deletion takes panoptic-lift\'s two files whatever suffixes it is given', async () => {
  const dir = await makeTempDir({ prefix: 'server-core-artifacts-' })
  try {
    await fs.writeFile(`${dir}/${BASE}.glb`, glb())
    await fs.writeFile(`${dir}/${BASE}.panoptic.detections.json`, '[]')
    await fs.writeFile(`${dir}/${BASE}.panoptic-lift.manifest.json`, '{}')
    const removed = await removeScanFiles({ scansDir: dir, filename: `${BASE}.glb`, splatSuffixes: [] })
    assertEquals(removed.failed, 0)
    assertEquals(removed.derived, 2)
    assertEquals(await filesUnder(dir), [])
  } finally {
    await fs.rm(dir, { recursive: true })
  }
})

test('the COLMAP manifest and poses, and the panoptic-lift sidecars, are served; the sidecars go with the scan', async (t) => {
  let root = ''
  const server = await startServer({}, async ({ root: r, scansDir, sessionsDir }) => {
    root = r
    await fs.mkdir(`${sessionsDir}/${SESSION}`, { recursive: true })
    await fs.writeFile(`${sessionsDir}/${SESSION}/session.json`, JSON.stringify({ sessionId: SESSION }))
    await fs.writeFile(`${sessionsDir}/${SESSION}/colmap-poses.manifest.json`, JSON.stringify({
      status: 'ok',
      registeredImages: 32,
      frameCount: 32,
      posesPath: 'colmap.poses.json',
      glbPath: `${scansDir}/${BASE}.glb`,
    }))
    await fs.writeFile(`${sessionsDir}/${SESSION}/colmap.poses.json`, '{"frames":[{"file":"kf-00000.jpg"}]}')
    await fs.writeFile(`${sessionsDir}/${SESSION}/colmap.point-cloud.ply`, 'ply')
    await fs.writeFile(`${scansDir}/${BASE}.glb`, glb())
    await fs.writeFile(`${scansDir}/${BASE}.panoptic.detections.json`, '[{"label":"chair"}]')
    await fs.writeFile(`${scansDir}/${BASE}.panoptic-lift.manifest.json`, JSON.stringify({
      status: 'ok',
      confidentCount: 1,
      detectionsPath: `${scansDir}/${BASE}.panoptic.detections.json`,
      url: `/scans/${BASE}.panoptic.detections.json`,
    }))
  })
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    await t.test('the COLMAP manifest is served, with no server path in it', async () => {
      const reply = await server.get(`/sessions/${SESSION}/colmap-poses.manifest.json`)
      assertEquals(reply.status, 200, why('colmap-poses.manifest.json'))
      assertEquals(reply.headers.get('content-type'), 'application/json')
      const manifest = reply.json<Record<string, unknown>>()
      assertEquals(manifest.registeredImages, 32)
      assertEquals(manifest.glbPath, `${BASE}.glb`, 'the path the solver wrote is cut to the file name')
      assertFalse(reply.text.includes(root), 'no server path')
      const poses = await server.get(`/sessions/${SESSION}/colmap.poses.json`)
      assertEquals(poses.status, 200, why('colmap.poses.json'))
      assertEquals(poses.text, '{"frames":[{"file":"kf-00000.jpg"}]}', 'a file with no path is served as written')
      assert((await server.get(`/sessions/${SESSION}/colmap.point-cloud.ply`)).status >= 400, 'the seed cloud is not on the list')
      assertEquals((await server.get('/sessions/sess-not-there/colmap-poses.manifest.json')).status, 404)
    })

    await t.test('the panoptic-lift sidecars are served, and a link into the API in them is kept whole', async () => {
      const detections = await server.get(`/scans/${BASE}.panoptic.detections.json`)
      assertEquals(detections.status, 200, why('panoptic.detections.json'))
      assertEquals(detections.json(), [{ label: 'chair' }])
      const manifest = await server.get(`/scans/${BASE}.panoptic-lift.manifest.json`)
      assertEquals(manifest.status, 200, why('panoptic-lift.manifest.json'))
      const body = manifest.json<Record<string, unknown>>()
      assertEquals(body.detectionsPath, `${BASE}.panoptic.detections.json`)
      assertEquals(body.url, `/scans/${BASE}.panoptic.detections.json`, 'an API link is not a server path')
      assertFalse(manifest.text.includes(root))
    })

    await t.test('deleting the scan takes both sidecars', async () => {
      const deleted = await server.request('DELETE', `/scans/${BASE}.glb`)
      assertEquals(deleted.status, 200, why('DELETE /scans'))
      const left = await filesUnder(server.scansDir)
      assertFalse(left.some((name) => name.startsWith(`${BASE}.panoptic`)), `left: ${left}`)
      assertEquals((await server.get(`/scans/${BASE}.panoptic-lift.manifest.json`)).status, 404)
    })
  } finally {
    await server.stop()
  }
})
