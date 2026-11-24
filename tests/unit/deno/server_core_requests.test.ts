/**
 * What a request may carry and what an answer may say (wave 14 ticket 0001):
 *
 *   F-11 / FN-112  JSON bodies are read under the patches cap (1 MB) on the routes that had none.
 *   F-11           A job request is checked before it is stored: a flat payload of plain values.
 *   F-11 / FN-118  An error answer names no server path: the detail goes to the log.
 *   F-10           The 4D clip contract: with the session guard on, FDANYONE_TOKEN as Bearer opens a take's clip and
 *                  pose track, and nothing else.
 *
 * Needs `deno task test`'s permissions.
 */
import { assert, assertEquals, assertFalse, assertMatch } from 'jsr:@std/assert@^1.0.0'
import {
  JOB_PAYLOAD_MAX_BYTES,
  JOB_PAYLOAD_MAX_KEYS,
  JOB_PAYLOAD_MAX_STRING,
  parseJobRequest,
  REQUEST_ONLY_JOB_TYPES,
  REQUESTABLE_JOB_TYPES,
} from '../../../server/world/job_request.ts'
import { companionSession, defaultWorldTokens, SIGN_IN_ON, startServer } from './server_core_harness.ts'

Deno.test('job request: a flat payload of plain values is kept as sent', () => {
  const parsed = parseJobRequest({
    type: 'splat-detect',
    scanId: 'scan-a',
    payload: { source: 'viewer', prompt: 'chair', minVotes: 3, dryRun: false, note: null },
  })
  assert(parsed.ok)
  assertEquals(parsed.type, 'splat-detect')
  assertEquals(parsed.scanId, 'scan-a')
  assertEquals(parsed.payload, { source: 'viewer', prompt: 'chair', minVotes: 3, dryRun: false, note: null })
  const bare = parseJobRequest({ type: 'export-world' })
  assert(bare.ok)
  assertEquals(bare.payload, undefined)
})

Deno.test('job request: anything else is refused before it reaches the world file', () => {
  const refused: Array<[string, unknown]> = [
    ['no body', null],
    ['an array', [{ type: 'export-world' }]],
    ['no type', { payload: {} }],
    ['an unknown type', { type: 'rm-rf' }],
    ['optimize-scan, which the jobs API never took', { type: 'optimize-scan' }],
    ['a scanId that is a number', { type: 'splat-train', scanId: 7 }],
    ['an empty scanId', { type: 'splat-train', scanId: '' }],
    ['a scanId with a control character', { type: 'splat-train', scanId: 'a\u0000b' }],
    ['a payload that is an array', { type: 'export-world', payload: [1, 2] }],
    ['a payload that is a string', { type: 'export-world', payload: 'x' }],
    ['a nested object', { type: 'export-world', payload: { deep: { a: 1 } } }],
    ['a nested array', { type: 'export-world', payload: { list: [1] } }],
    ['a number that is not finite', { type: 'export-world', payload: { n: Number.NaN } }],
    ['a string over the cap', { type: 'export-world', payload: { s: 'x'.repeat(JOB_PAYLOAD_MAX_STRING + 1) } }],
    ['a key of another shape', { type: 'export-world', payload: { 'a b': 1 } }],
    ['too many keys', { type: 'export-world', payload: Object.fromEntries(Array.from({ length: JOB_PAYLOAD_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i])) }],
    ['over the byte cap', {
      type: 'export-world',
      payload: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(Math.ceil(JOB_PAYLOAD_MAX_BYTES / 8))])),
    }],
  ]
  for (const [label, body] of refused) {
    const parsed = parseJobRequest(body)
    assertFalse(parsed.ok, label)
    if (!parsed.ok) assertEquals(parsed.status, 400, label)
  }
})

Deno.test('job rules: the jobs API takes every type it took before, and says which are request-only', () => {
  const before = [
    'ingest', 'extract-layers', 'align-scan', 'merge-points', 'semantic-pass', 'depth-reconstruct', 'thing-correspondence',
    'lingbot-map-reconstruct', 'colmap-poses', 'splat-train', 'splat-align', 'splat-detect', 'splat-finish', 'sensenova-vision',
    'panoptic-scan', 'panoptic-lift', 'person-4d-reconstruct', 'thing-interactive-asset', 'memory-push', 'export-world',
    'place-register', 'keyframe-purge',
    // Added since: the floor plan from a LingBot-Map cloud (PR #273's port).
    'floor-plan',
  ]
  assertEquals([...REQUESTABLE_JOB_TYPES].sort(), [...before].sort())
  for (const type of ['panoptic-scan', 'person-4d-reconstruct', 'thing-interactive-asset', 'memory-push', 'sensenova-vision']) {
    assert(REQUEST_ONLY_JOB_TYPES.includes(type as never), `${type} is request-only`)
  }
  for (const type of ['panoptic-lift', 'splat-finish', 'splat-align', 'lingbot-map-reconstruct', 'keyframe-purge', 'optimize-scan', 'floor-plan']) {
    assertFalse(REQUEST_ONLY_JOB_TYPES.includes(type as never), `${type} has a starter in the server`)
  }
})

Deno.test('requests and answers, an install open by design', async (t) => {
  const server = await startServer({}, async ({ worldsDir }) => {
    // A world file the server cannot read: a folder where the file should be, so a read fails with an error that names it.
    await Deno.mkdir(`${worldsDir}/unreadable.json`, { recursive: true })
  })
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    const tokens = await defaultWorldTokens(server)

    await t.step('F-11: a job payload that is not flat is refused, and nothing is queued', async () => {
      const before = (await server.get('/worlds/default/jobs')).json<unknown[]>().length
      const nested = await server.post('/worlds/default/jobs', { type: 'export-world', payload: { deep: { a: 1 } } })
      assertEquals(nested.status, 400, why('nested payload'))
      assertMatch(nested.json<{ error: string }>().error, /payload\.deep/)
      assertEquals((await server.post('/worlds/default/jobs', { type: 'export-world', payload: [1] })).status, 400)
      assertEquals((await server.post('/worlds/default/jobs', { type: 'export-world', scanId: 7 })).status, 400)
      assertEquals((await server.get('/worlds/default/jobs')).json<unknown[]>().length, before, 'nothing was stored')
      assertEquals((await server.post('/worlds/default/jobs', { type: 'export-world', payload: { source: 'test' } })).status, 202)
    })

    await t.step('FN-112: the routes that read JSON with no cap now answer 413 past 1 MB', async () => {
      const big = JSON.stringify({ name: 'x'.repeat(1_100_000) })
      const routes: Array<[string, string]> = [
        ['POST', '/sessions'],
        ['POST', '/worlds'],
        ['POST', '/worlds/default/comments'],
        ['POST', '/worlds/default/jobs'],
        ['POST', '/process-scan'],
        ['POST', '/takes/take-0001/sync'],
        ['PATCH', '/projects/proj-default/scans/scan-x'],
        ['POST', '/projects/proj-default/merge'],
      ]
      for (const [method, path] of routes) {
        const reply = await server.request(method, path, { body: big, headers: { 'Content-Type': 'application/json' }, token: tokens.editor })
        assertEquals(reply.status, 413, why(`${method} ${path}`))
      }
      // Under the cap the routes answer as they always did.
      const session = await server.post('/sessions', {})
      assertEquals(session.status, 201, why('POST /sessions'))
      const sessionId = session.json<{ sessionId: string }>().sessionId
      for (const path of [`/sessions/${sessionId}/finalize`, `/sessions/${sessionId}/known-distances`, `/sessions/${sessionId}/station-capture`]) {
        const reply = await server.request('POST', path, { body: big, headers: { 'Content-Type': 'application/json' } })
        assertEquals(reply.status, 413, why(`POST ${path}`))
      }
      assertEquals((await server.post(`/sessions/${sessionId}/finalize`, {})).status, 200, why('finalize under the cap'))
      // A body that is not JSON still reads as an empty one.
      const notJson = await server.request('POST', '/worlds/default/jobs', { body: 'not json', headers: { 'Content-Type': 'application/json' } })
      assertEquals(notJson.status, 400)
      assertMatch(notJson.json<{ error: string }>().error, /type must be one of/)
    })

    await t.step('FN-118: an error answer is generic, and the path stays in the log', async () => {
      const reply = await server.get('/worlds/unreadable')
      assertEquals(reply.status, 500, why('a world file that cannot be read'))
      assertEquals(reply.json<{ error: string }>(), { error: 'Internal server error' })
      assertFalse(reply.text.includes(server.root), 'no server path in the answer')
      assert(server.log().includes('[server-error]'), 'the detail is logged')
    })
  } finally {
    await server.stop()
  }
})

const FOUR_D_TOKEN = 'fdanyone-test-token-0123456789'
const SESSION = 'sess-clip-test'
const CLIP = new TextEncoder().encode('not really an mp4, but the bytes the service fetches')

Deno.test('F-10: with sign-in on, FDANYONE_TOKEN opens a take\'s clip and pose track, and nothing else', async () => {
  const server = await startServer({ ...SIGN_IN_ON, FDANYONE_TOKEN: FOUR_D_TOKEN }, async ({ sessionsDir }) => {
    await Deno.mkdir(`${sessionsDir}/${SESSION}`, { recursive: true })
    await Deno.writeFile(`${sessionsDir}/${SESSION}/clip.mp4`, CLIP)
    await Deno.writeTextFile(`${sessionsDir}/${SESSION}/pose-track.json`, '{"frames":[]}')
    await Deno.writeTextFile(`${sessionsDir}/${SESSION}/session.json`, JSON.stringify({ sessionId: SESSION }))
    await Deno.writeFile(`${sessionsDir}/${SESSION}/kf-00000.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
  })
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    const clip = `/sessions/${SESSION}/clip/clip.mp4`
    const track = `/sessions/${SESSION}/pose-track.json`
    const served = await server.get(clip, { bearer: FOUR_D_TOKEN })
    assertEquals(served.status, 200, why('the clip with the 4D token'))
    assertEquals(served.body, CLIP)
    assertEquals((await server.get(track, { bearer: FOUR_D_TOKEN })).status, 200, why('the pose track with the 4D token'))
    const ranged = await server.get(clip, { bearer: FOUR_D_TOKEN, headers: { Range: 'bytes=0-3' } })
    assertEquals(ranged.status, 206, why('a ranged read, as the downloader follows Content-Range'))

    // Without it, or with anything else, the guard answers as always.
    for (const opts of [{}, { bearer: 'wrong-token' }, { bearer: `${FOUR_D_TOKEN}x` }, { token: FOUR_D_TOKEN }]) {
      assertEquals((await server.get(clip, opts)).status, 401, why(`clip, ${JSON.stringify(opts)}`))
      assertEquals((await server.get(track, opts)).status, 401, why(`track, ${JSON.stringify(opts)}`))
    }
    // The token opens those two routes and no other.
    for (const path of [`/sessions/${SESSION}`, `/sessions/${SESSION}/keyframes/kf-00000.jpg`, '/sessions', '/scans', '/capabilities']) {
      assertEquals((await server.get(path, { bearer: FOUR_D_TOKEN })).status, 401, why(`${path} with the 4D token`))
    }
    assertEquals((await server.post('/sessions', {}, { bearer: FOUR_D_TOKEN })).status, 401, 'no write either')
    // A signed-in person still reaches the clip with a session.
    assertEquals((await server.get(clip, { bearer: await companionSession() })).status, 200, why('a Companion session'))
  } finally {
    await server.stop()
  }
})

Deno.test('F-10: with no FDANYONE_TOKEN set, no Bearer opens the clip', async () => {
  const server = await startServer({ ...SIGN_IN_ON }, async ({ sessionsDir }) => {
    await Deno.mkdir(`${sessionsDir}/${SESSION}`, { recursive: true })
    await Deno.writeFile(`${sessionsDir}/${SESSION}/clip.mp4`, CLIP)
  })
  try {
    for (const bearer of ['', ' ', 'undefined', 'null']) {
      assertEquals((await server.get(`/sessions/${SESSION}/clip/clip.mp4`, { bearer, headers: bearer ? {} : { Authorization: 'Bearer ' } })).status, 401)
    }
  } finally {
    await server.stop()
  }
})
