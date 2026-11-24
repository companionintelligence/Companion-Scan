/**
 * The SenseNova result and the world GLB link the editor now shows (src/viewer/job-results.ts). F-23.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  latestJobOf,
  outputFileNames,
  SENSENOVA_FILES_SHOWN,
  senseNovaFilesLine,
  senseNovaSummary,
  worldExportLink,
} from '../../../src/viewer/job-results.ts'
import type { WorldJob } from '../../../src/world/types.ts'

function job(over: Partial<WorldJob>): WorldJob {
  return {
    jobId: `j-${Math.random()}`,
    worldId: 'w',
    type: 'sensenova-vision',
    status: 'completed',
    scanId: 'scan-a',
    capabilities: [],
    payload: { task: 'bbox_detection' },
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:00:00.000Z',
    ...over,
  }
}

// A placeholder output folder: the shape the server writes, with no real path in it.
const OUT = '/srv/scans/.sensenova/job-1'

Deno.test('latestJobOf: the newest job of a type for a scan', () => {
  const older = job({ jobId: 'old', updatedAt: '2026-11-23T09:00:00.000Z' })
  const newer = job({ jobId: 'new', updatedAt: '2026-11-23T11:00:00.000Z' })
  const other = job({ jobId: 'other-scan', scanId: 'scan-b', updatedAt: '2026-11-23T12:00:00.000Z' })
  assertEquals(latestJobOf([older, newer, other], 'sensenova-vision', 'scan-a')?.jobId, 'new')
  assertEquals(latestJobOf([older, other], 'sensenova-vision', 'scan-c'), null)
})

Deno.test('outputFileNames: names below the output folder, never a server path', () => {
  assertEquals(outputFileNames([`${OUT}/detections.json`, `${OUT}/masks/0001.png`], OUT), ['detections.json', 'masks/0001.png'])
  assertEquals(outputFileNames([`${OUT}/a.json`], `${OUT}/`), ['a.json'], 'a trailing slash on the folder')
  assertEquals(outputFileNames(['/elsewhere/b.png'], OUT), ['b.png'], 'outside the folder: the last segment only')
  assertEquals(outputFileNames(['/elsewhere/c.png'], null), ['c.png'])
  assertEquals(outputFileNames('not a list', OUT), [])
  assertEquals(outputFileNames([7, '', null], OUT), [])
})

Deno.test('senseNovaSummary: every state of the selected scan\'s latest SenseNova job', () => {
  assertEquals(senseNovaSummary([], 'scan-a').state, 'none')
  assertEquals(senseNovaSummary([job({})], null).state, 'none', 'no scan selected')
  assertEquals(senseNovaSummary([job({ status: 'queued' })], 'scan-a').text, 'SenseNova bbox detection is queued.')
  assertEquals(senseNovaSummary([job({ status: 'processing' })], 'scan-a').state, 'processing')
  const failed = senseNovaSummary([job({ status: 'failed', error: 'the worker exited 1' })], 'scan-a')
  assertEquals(failed.state, 'failed')
  assert(failed.text.includes('the worker exited 1'))

  const skipped = senseNovaSummary([job({
    result: 'SenseNova bbox_detection skipped: install the runtime',
    artifacts: [{ type: 'sensenova-skip', label: 'SenseNova runtime setup required', metadata: { remediation: 'install the runtime' } }],
  })], 'scan-a')
  assertEquals(skipped.state, 'skipped')
  assertEquals(skipped.files, [])

  const done = senseNovaSummary([job({
    result: 'SenseNova bbox_detection completed with 2 artifacts.',
    artifacts: [{ type: 'sensenova-output', label: 'x', metadata: { task: 'bbox_detection', files: [`${OUT}/a.json`, `${OUT}/b.png`], outputDir: OUT } }],
  })], 'scan-a')
  assertEquals(done.state, 'completed')
  assertEquals(done.files, ['a.json', 'b.png'])
  assert(done.text.startsWith('SenseNova bbox_detection completed with 2 artifacts.'))
  assert(!done.text.includes(OUT), 'the server path never reaches the screen')
})

Deno.test('senseNovaFilesLine: the first few names, then how many more', () => {
  assertEquals(senseNovaFilesLine([]), '')
  assertEquals(senseNovaFilesLine(['a', 'b']), 'a, b')
  const many = Array.from({ length: SENSENOVA_FILES_SHOWN + 3 }, (_, i) => `f${i}`)
  assertEquals(senseNovaFilesLine(many), `${many.slice(0, SENSENOVA_FILES_SHOWN).join(', ')}, and 3 more`)
})

Deno.test('worldExportLink: shown once an export-world job has completed, on the world route', () => {
  assertEquals(worldExportLink([], 'house'), null)
  assertEquals(worldExportLink([job({ type: 'export-world', status: 'processing', scanId: undefined })], 'house'), null)
  const done = job({
    type: 'export-world',
    scanId: undefined,
    result: 'Exported 2 scans and 3 Things to house.world.glb.',
    artifacts: [{ type: 'world-glb', label: 'x', url: '/worlds/house/export.glb' }],
  })
  assertEquals(worldExportLink([done], 'house'), { path: '/worlds/house/export.glb', detail: 'Exported 2 scans and 3 Things to house.world.glb.' })
  // An artifact URL that is not the world route is not followed; the route by the slug is used instead.
  const odd = job({ ...done, artifacts: [{ type: 'world-glb', label: 'x', url: 'https://elsewhere.example/a.glb' }] })
  assertEquals(worldExportLink([odd], 'my house')?.path, '/worlds/my%20house/export.glb')
})
