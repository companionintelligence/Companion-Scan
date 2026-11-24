/**
 * The editor's Floor plan section (src/viewer/floor-plan-layer.ts): the URLs it reads, the job it queues, and what it
 * says for each answer a read can give (src/viewer/artifact-read.ts). The responses are the ones the Scan server gives:
 * a JSON 404 from the artifact route for a plan that is not there, Hono's text 404 for a path no route matches.
 *
 * And where the section sits: in the Layers tab, as a tool of its own, while the View menu keeps its six layers. The
 * plan is not scene geometry, so it is not a seventh layer (the module's header says why).
 */
import { assert, assertEquals, assertStringIncludes } from './assert.ts'

import {
  buildFloorPlanJobRequest,
  FLOOR_PLAN_READY_TEXT,
  floorPlanDownloadName,
  floorPlanJsonUrl,
  floorPlanManifestUrl,
  floorPlanPanelView,
  floorPlanStatsText,
  floorPlanSvgUrl,
  readFloorPlanManifest,
} from '../../../src/viewer/floor-plan-layer.ts'
import type { FloorPlanManifest, ScanManifest } from '../../../src/world/types.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

const scan = { scanId: 'scan-a', name: 'Kitchen', filename: '1700000000000_kitchen #2.glb' } as ScanManifest
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const answer = (response: Response) => () => Promise.resolve(response)

function manifest(over: Partial<FloorPlanManifest> = {}): FloorPlanManifest {
  return {
    schemaVersion: 1,
    tool: 'floor-plan-worker',
    status: 'ok',
    createdAt: '2026-11-24T10:00:00.000Z',
    planPath: '1700000000000_kitchen #2.floor-plan.json',
    svgPath: '1700000000000_kitchen #2.floor-plan.svg',
    areaM2: 12,
    wallCount: 4,
    roomCount: 1,
    ceilingHeightM: 2.5,
    disclaimer: 'derived, not survey-grade; in the point cloud\'s own units',
    params: { python: 'python3', workerPath: 'floor_plan_worker.py', minWallM: 0.5 },
    ...over,
  }
}

test('the three URLs are the scan\'s base on the artifact route, encoded; a version busts the five-minute copy', () => {
  assertEquals(floorPlanManifestUrl(scan), '/scans/1700000000000_kitchen%20%232.floor-plan.manifest.json')
  assertEquals(floorPlanSvgUrl(scan), '/scans/1700000000000_kitchen%20%232.floor-plan.svg')
  assertEquals(floorPlanJsonUrl(scan), '/scans/1700000000000_kitchen%20%232.floor-plan.json')
  assertEquals(
    floorPlanSvgUrl(scan, '2026-11-24T10:00:00.000Z'),
    '/scans/1700000000000_kitchen%20%232.floor-plan.svg?v=2026-11-24T10%3A00%3A00.000Z',
  )
  assertEquals(floorPlanDownloadName(scan, 'svg'), 'Kitchen.floor-plan.svg')
  assertEquals(floorPlanDownloadName({ ...scan, name: '' }, 'json'), 'scan-a.floor-plan.json')
})

test('Generate queues a floor-plan job for the selected scan', () => {
  const request = buildFloorPlanJobRequest('scan-a')
  assertEquals(request.type, 'floor-plan')
  assertEquals(request.scanId, 'scan-a')
  assertEquals(request.payload?.['source'], 'viewer-floor-plan')
})

test('readFloorPlanManifest: a plan, none yet, no route, and a file that is not a manifest', async () => {
  assertEquals((await readFloorPlanManifest(scan, answer(json(manifest())))).state, 'found')
  assertEquals(await readFloorPlanManifest(scan, answer(json({ error: 'Splat artifact not found' }, 404))), { state: 'not-run' })
  assertEquals(
    await readFloorPlanManifest(scan, answer(new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }))),
    { state: 'not-served', status: 404 },
  )
  const noStatus = await readFloorPlanManifest(scan, answer(json({ areaM2: 12 })))
  assertEquals(noStatus.state, 'error')
  let asked = ''
  await readFloorPlanManifest(scan, (url) => {
    asked = url
    return Promise.resolve(json(manifest()))
  })
  assertEquals(asked, floorPlanManifestUrl(scan))
})

test('a plan that is there says what its numbers are, and offers the drawing', () => {
  const view = floorPlanPanelView({ state: 'found', value: manifest() })
  assertEquals(view.status, FLOOR_PLAN_READY_TEXT)
  assertStringIncludes(view.status, 'not surveyed')
  assertStringIncludes(view.status, 'metres only if it was metric')
  assertEquals(view.stats, '4 walls · 1 room · area 12.0 · ceiling 2.50 (point-cloud units)')
  assertEquals(view.planVersion, '2026-11-24T10:00:00.000Z')
})

test('the numbers line claims no unit, and leaves out what was not measured', () => {
  assertEquals(floorPlanStatsText(manifest({ wallCount: 1, roomCount: 0, areaM2: 0, ceilingHeightM: 0 })), '1 wall (point-cloud units)')
  assertEquals(floorPlanStatsText(manifest({ wallCount: 7, roomCount: 1, areaM2: 3408.4 })), '7 walls · 1 room · area 3408.4 · ceiling 2.50 (point-cloud units)')
  assert(!/m²| m\b/.test(floorPlanStatsText(manifest())), 'no metre symbol')
})

test('no plan, a skip, a failure and an unreadable answer each say so, and offer no drawing', () => {
  const none = floorPlanPanelView({ state: 'not-run' })
  assertStringIncludes(none.status, 'No floor plan for this scan yet')
  assertEquals(none.planVersion, null)

  const skipped = floorPlanPanelView({
    state: 'found',
    value: manifest({
      status: 'skipped',
      skippedReason: 'no point cloud: the scan\'s session has no lingbot-map.point-cloud.ply',
      remediation: 'Run lingbot-map-reconstruct on this scan first.',
    }),
  })
  assertEquals(
    skipped.status,
    'Floor plan skipped: no point cloud: the scan\'s session has no lingbot-map.point-cloud.ply. Run lingbot-map-reconstruct on this scan first.',
  )
  assertEquals(skipped.planVersion, null)
  assertEquals(skipped.stats, '')

  const failed = floorPlanPanelView({ state: 'found', value: manifest({ status: 'error', error: 'floor-plan worker exited 2' }) })
  assertEquals(failed.status, 'Floor plan failed: floor-plan worker exited 2')
  assertEquals(failed.planVersion, null)

  const unserved = floorPlanPanelView({ state: 'not-served', status: 404 })
  assertStringIncludes(unserved.status, 'does not serve this scan\'s floor plan')
  const denied = floorPlanPanelView({ state: 'error', status: 403, message: 'the server answered 403' })
  assertStringIncludes(denied.status, 'not allowed to read this scan\'s floor plan')
})

test('the section is a tool in the Layers tab, and the View menu keeps its six layers', async () => {
  const html = await fs.readFile(new URL('../../../viewer.html', import.meta.url), 'utf8')
  const layersTab = html.slice(html.indexOf('id="tab-layers"'), html.indexOf('id="tab-edit"'))
  const section = layersTab.slice(layersTab.indexOf('id="floor-plan-section"'))
  assert(layersTab.includes('<details class="layer-tool" id="floor-plan-section">'), 'a layer-tool section in the Layers tab')
  for (const id of ['floor-plan-status', 'floor-plan-stats', 'floor-plan-preview-img', 'btn-floor-plan', 'floor-plan-download-svg', 'floor-plan-download-json']) {
    assert(section.includes(`id="${id}"`), `#${id} is in the section`)
  }
  const viewLayers = [...html.matchAll(/data-view-layer="([a-zA-Z]+)"/g)].map((m) => m[1])
  assertEquals(viewLayers, ['cameraTrail', 'scannedImages', 'detectedObjects', 'hitPoints', 'planes', 'splats'])
})
