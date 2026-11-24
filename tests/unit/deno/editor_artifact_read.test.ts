/**
 * Reading an artifact with the four answers the editor tells apart (src/viewer/artifact-read.ts), and how the
 * reconstruction-quality line and the Placed objects panel word them (F-22). The responses below are the ones the
 * Scan server gives today: a JSON 404 from an artifact route for a missing file, Hono's text 404 for a path no route
 * matches, and the generic `/scans/:filename` route's JSON 400 for a name that is not a .glb.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { artifactProblemText, readArtifact } from '../../../src/viewer/artifact-read.ts'
import { readReconstructionQuality, reconstructionVerdictFor } from '../../../src/viewer/reconstruction-quality.ts'
import { placementVerdictForRead, placementVerdictOf, readScanPanopticLayer } from '../../../src/viewer/panoptic-layer.ts'
import type { ScanManifest } from '../../../src/world/types.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const text = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } })
const html = (status = 200) => new Response('<!doctype html><title>x</title>', { status, headers: { 'Content-Type': 'text/html' } })
const answer = (response: Response) => () => Promise.resolve(response)

Deno.test('readArtifact: the four answers', async () => {
  assertEquals(await readArtifact('/a', answer(json({ status: 'ok' }))), { state: 'found', value: { status: 'ok' } })
  assertEquals(await readArtifact('/a', answer(json({ error: 'Artifact not found' }, 404))), { state: 'not-run' })
  assertEquals(await readArtifact('/a', answer(text('404 Not Found', 404))), { state: 'not-served', status: 404 })
  assertEquals(await readArtifact('/a', answer(json({ error: 'Only .glb files are served' }, 400))), { state: 'not-served', status: 400 })
  assertEquals(await readArtifact('/a', answer(html(200))), { state: 'not-served', status: 200 }, 'a static host answering with a page')
  assertEquals((await readArtifact('/a', answer(json({ error: 'Sign in' }, 401)))).state, 'error')
  assertEquals((await readArtifact('/a', answer(json({ error: 'boom' }, 500)))).state, 'error')
  const failed = await readArtifact('/a', () => Promise.reject(new TypeError('Failed to fetch')))
  assertEquals(failed, { state: 'error', status: null, message: 'Failed to fetch' })
  const cut = await readArtifact('/a', answer(new Response('{"status":', { status: 200, headers: { 'Content-Type': 'application/json' } })))
  assertEquals(cut.state, 'error', 'a JSON file cut short is a failed read, not a missing route')
})

Deno.test('readArtifact asks for the path it is given', async () => {
  const asked: string[] = []
  await readArtifact('/sessions/s1/colmap-poses.manifest.json', (url) => { asked.push(url); return Promise.resolve(json({})) })
  assertEquals(asked, ['/sessions/s1/colmap-poses.manifest.json'])
})

Deno.test('artifactProblemText: words for the answers that cannot say whether the step ran', () => {
  assertEquals(artifactProblemText({ state: 'not-run' }, 'x'), null)
  assertEquals(artifactProblemText({ state: 'found', value: 1 }, 'x'), null)
  assert(artifactProblemText({ state: 'not-served', status: 404 }, 'the report')!.includes('does not serve the report'))
  assert(artifactProblemText({ state: 'error', status: 403, message: 'no' }, 'the report')!.includes('not allowed'))
  assert(artifactProblemText({ state: 'error', status: null, message: 'Failed to fetch' }, 'the report')!.includes('Failed to fetch'))
})

Deno.test('the reconstruction line: hidden when the solver never ran, a not-known line when the report cannot be read', async () => {
  const notRun = await readReconstructionQuality('s1', answer(json({ error: 'Artifact not found' }, 404)))
  assertEquals(reconstructionVerdictFor(notRun), null, 'a scan whose poses came from the device has no line')
  // Today no route serves this manifest, so the server answers with its text 404.
  const notServed = await readReconstructionQuality('s1', answer(text('404 Not Found', 404)))
  const verdict = reconstructionVerdictFor(notServed)
  assertEquals(verdict?.tone, 'unrated')
  assert(verdict!.detail.includes('does not serve'))
  const failed = reconstructionVerdictFor(await readReconstructionQuality('s1', () => Promise.reject(new TypeError('Failed to fetch'))))
  assertEquals(failed?.tone, 'unrated')
  const found = reconstructionVerdictFor(await readReconstructionQuality('s1', answer(json({ status: 'skipped', skippedReason: 'no keyframes' }))))
  assertEquals(found?.tone, 'blocked', 'a manifest that was read keeps its own verdict')
})

const SCAN = { scanId: 'scan-a', filename: 'scan-a.glb' } as ScanManifest

Deno.test('the Placed objects verdict: not run reads "nothing has looked yet"; not served and errors read "not known"', async () => {
  const asked: string[] = []
  const notRun = await readScanPanopticLayer(SCAN, (url) => { asked.push(url); return Promise.resolve(json({ error: 'Artifact not found' }, 404)) })
  assertEquals(asked, ['/scans/scan-a.panoptic-lift.manifest.json'])
  assertEquals(notRun.state, 'not-run')
  assertEquals(placementVerdictForRead(notRun), placementVerdictOf(null))
  assertEquals(placementVerdictForRead(notRun)?.block, 'not-attempted')

  // Today the generic /scans/:filename route answers this name with a JSON 400.
  const notServed = await readScanPanopticLayer(SCAN, answer(json({ error: 'Only .glb files are served' }, 400)))
  assertEquals(notServed.state, 'not-served')
  const unknown = placementVerdictForRead(notServed)
  assertEquals(unknown?.block, 'unreadable')
  assert(!/Nothing has looked/.test(unknown!.headline), 'a server that cannot answer is not a scan nobody looked at')

  const refused = placementVerdictForRead(await readScanPanopticLayer(SCAN, answer(json({ error: 'Sign in' }, 401))))
  assertEquals(refused?.block, 'unreadable')
})

Deno.test('a read panoptic manifest still builds its layer', async () => {
  const read = await readScanPanopticLayer(SCAN, (url) => Promise.resolve(url.endsWith('.manifest.json')
    ? json({ status: 'skipped', pointCount: 0 })
    : json({ error: 'Artifact not found' }, 404)))
  assertEquals(read.state, 'found')
  if (read.state !== 'found') return
  assertEquals(read.value.placedCount, 0)
  assertEquals(placementVerdictForRead(read)?.block, 'thin-geometry')
})
