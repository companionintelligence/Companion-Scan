/**
 * The clip downloader against the appliance's range contract: at most N bytes
 * per 206, Content-Range followed to the end, streamed to disk, and the token
 * on every request.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadToFile, fetchJson, FetchError, parseContentRange } from '../stages/fetch.mjs'
import { fakeAppliance } from './helpers.mjs'

test('Content-Range parses, and a backwards range is refused', () => {
  assert.deepEqual(parseContentRange('bytes 0-999/2500'), { start: 0, end: 999, total: 2500 })
  assert.deepEqual(parseContentRange('bytes 10-19/*'), { start: 10, end: 19, total: null })
  assert.equal(parseContentRange('bytes 9-3/20'), null)
  assert.equal(parseContentRange(null), null)
})

test('a clip larger than one range arrives whole, in order, with the token on every request', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), '4d-fetch-'))
  try {
    const clip = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251))
    const { fetchFn, seen } = fakeAppliance({ 'http://appliance/sessions/s/clip/clip.mp4': clip }, { token: 'tok', chunk: 1000 })
    const dest = path.join(dir, 'clip.mp4')
    const bytes = await downloadToFile('http://appliance/sessions/s/clip/clip.mp4', dest, { token: 'tok', fetchFn })
    assert.equal(bytes, 2500)
    assert.ok((await readFile(dest)).equals(clip))
    assert.deepEqual(seen.map((s) => s.range), ['bytes=0-', 'bytes=1000-', 'bytes=2000-'])
    assert.ok(seen.every((s) => s.auth === 'Bearer tok'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a server that ignores Range and answers 200 is accepted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), '4d-fetch-'))
  try {
    const clip = Buffer.from('whole body')
    const fetchFn = async () => new Response(clip, { status: 200 })
    const dest = path.join(dir, 'clip.mp4')
    assert.equal(await downloadToFile('http://x/clip.mp4', dest, { fetchFn }), clip.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a refused token is an error that names the fix, and leaves no partial file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), '4d-fetch-'))
  try {
    const { fetchFn } = fakeAppliance({ 'http://a/c.mp4': Buffer.alloc(10) }, { token: 'right' })
    const dest = path.join(dir, 'c.mp4')
    await assert.rejects(
      downloadToFile('http://a/c.mp4', dest, { token: 'wrong', fetchFn }),
      (err) => err instanceof FetchError && err.status === 401 && /FDANYONE_TOKEN/.test(err.message),
    )
    await assert.rejects(stat(dest))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the pose track is fetched as JSON with the token', async () => {
  const { fetchFn, seen } = fakeAppliance({ 'http://a/p.json': { version: 1, frames: [] } }, { token: 't' })
  assert.deepEqual(await fetchJson('http://a/p.json', { token: 't', fetchFn }), { version: 1, frames: [] })
  assert.equal(seen[0].auth, 'Bearer t')
})
