/**
 * The grounding-dino inference engine (server/grounding_dino.ts): the Scan server's client for the detection
 * service's POST /detect (scripts/grounding_dino_server.py), the INFERENCE_MODE reading it shares with the capability
 * report, and the report's row for it. No network: every request goes to a fake fetch.
 *
 *   node --test tests/unit/server/inference_grounding_dino.test.ts
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from './assert.ts'
import {
  detectionsFromReply,
  detectRequestBody,
  detectWithGroundingDino,
  GROUNDING_DINO_PROMPT,
  groundingDinoConfigFromEnv,
  groundingDinoHealth,
} from '../../../server/grounding_dino.ts'
import type { GroundingDinoConfig } from '../../../server/grounding_dino.ts'
import { inferenceModeFrom } from '../../../server/inference_mode.ts'
import { InferenceEngine } from '../../../server/inference.ts'
import { CORE_LABELS } from '../../../server/prompt.ts'
import { probeCapabilities } from '../../../server/capabilities.ts'
import { test } from 'node:test'

const CONFIG: GroundingDinoConfig = { url: 'https://gpu.example.ts.net:8010', token: null }
const envOf = (vars: Record<string, string>) => (name: string): string | undefined => vars[name]

/** A fake fetch that records each request and answers from `route`. */
function fakeFetch(route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, init })
    return Promise.resolve(route(url, init))
  }) as typeof fetch
  return { impl, seen }
}

/** The service's reply for a 1000 x 500 frame. */
function reply(detections: Array<{ label: string; confidence: number; bbox: number[] }>) {
  return { frame_width: 1000, frame_height: 500, detections, model: 'IDEA-Research/grounding-dino-base', inference_ms: 90 }
}

test('INFERENCE_MODE: grounding-dino is an engine; unset and unknown values stay ollama', () => {
  assertEquals(inferenceModeFrom('grounding-dino'), 'grounding-dino')
  assertEquals(inferenceModeFrom('onnx'), 'onnx')
  assertEquals(inferenceModeFrom('mock'), 'mock')
  assertEquals(inferenceModeFrom(undefined), 'ollama')
  assertEquals(inferenceModeFrom('gdino'), 'ollama')
})

test('config: GDINO_URL is required, must be http(s) and carries no credentials; GDINO_TOKEN is optional', () => {
  const none = groundingDinoConfigFromEnv(envOf({}))
  assertEquals(none.config, null)
  assertStringIncludes(none.problem ?? '', 'GDINO_URL')
  assertEquals(groundingDinoConfigFromEnv(envOf({ GDINO_URL: 'ftp://gpu:8010' })).config, null)
  assertEquals(groundingDinoConfigFromEnv(envOf({ GDINO_URL: 'not a url' })).config, null)
  const withUser = groundingDinoConfigFromEnv(envOf({ GDINO_URL: 'https://user:secret@gpu:8010' }))
  assertEquals(withUser.config, null)
  assertStringIncludes(withUser.problem ?? '', 'GDINO_TOKEN')
  assertEquals(groundingDinoConfigFromEnv(envOf({ GDINO_URL: ' https://gpu.example.ts.net:8010/ ' })).config,
    { url: 'https://gpu.example.ts.net:8010', token: null })
  assertEquals(groundingDinoConfigFromEnv(envOf({ GDINO_URL: 'https://gpu:8010', GDINO_TOKEN: 'tok' })).config?.token, 'tok')
})

test('the request: the scanner\'s own vocabulary as the prompt, and the frame as base64', () => {
  assertEquals(GROUNDING_DINO_PROMPT, CORE_LABELS.join(', '))
  const body = JSON.parse(detectRequestBody(new Uint8Array([0xff, 0xd8, 0xff, 0x00])))
  assertEquals(Object.keys(body).sort(), ['image_base64', 'prompt'])
  assertEquals(body.prompt, GROUNDING_DINO_PROMPT)
  assertEquals(body.image_base64, '/9j/AA==')
})

test('the reply: pixel [x, y, w, h] become fractional corners, strongest first, in the engines\' one shape', () => {
  const out = detectionsFromReply(reply([
    { label: 'chair', confidence: 0.55, bbox: [100, 50, 200, 250] },
    { label: 'couch', confidence: 0.9, bbox: [0, 0, 500, 250] },
  ]))
  assertEquals(out.length, 2)
  // Strongest first; "couch" folds to the scanner's "sofa", as a VLM's reply does.
  assertEquals(out[0].label, 'sofa')
  assertEquals(out[0].bbox, [0, 0, 0.5, 0.5])
  assertEquals(out[1].label, 'chair')
  assertEquals(out[1].bbox, [0.1, 0.1, 0.3, 0.6])
  assertEquals(out[1].confidence, 0.55)
  // The detector gives no description, and none is made up.
  assertEquals(out[1].description, 'A chair')
})

test('the reply: the engines\' confidence floor, de-duplication and cap apply; malformed entries are dropped', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `thing${i}`, confidence: 0.5 + i * 0.01, bbox: [i * 60, 10, 50, 50] }))
  const out = detectionsFromReply(reply([
    ...many,
    { label: 'lamp', confidence: 0.3, bbox: [10, 10, 100, 100] }, // under the floor
    { label: 'lamp', confidence: 0.9, bbox: [10, 10, 0, 100] }, // no width
    { label: 'lamp', confidence: 0.9, bbox: [10, 10, 100] }, // not a box
    { label: 7, confidence: 0.9, bbox: [10, 10, 100, 100] } as never,
  ]))
  assertEquals(out.length, 8)
  assertEquals(out[0].label, 'thing11')
  assert(out.every((d) => d.label !== 'lamp'))
  assertEquals(detectionsFromReply({ detections: [] }), [])
  assertEquals(detectionsFromReply({ frame_width: 0, frame_height: 10, detections: [] }), [])
  assertEquals(detectionsFromReply(null), [])
})

test('detect: POST /detect with the token, and the reply turned into detections', async () => {
  const { impl, seen } = fakeFetch(() => Response.json(reply([{ label: 'table', confidence: 0.7, bbox: [250, 125, 500, 250] }])))
  const out = await detectWithGroundingDino(new Uint8Array([1, 2, 3]), { ...CONFIG, token: 'tok' }, impl)
  assertEquals(out.map((d) => [d.label, d.bbox]), [['table', [0.25, 0.25, 0.75, 0.75]]])
  assertEquals(seen.length, 1)
  assertEquals(seen[0].url, 'https://gpu.example.ts.net:8010/detect')
  assertEquals(seen[0].init?.method, 'POST')
  assertEquals(new Headers(seen[0].init?.headers).get('authorization'), 'Bearer tok')
  // With no token, no Authorization header at all.
  const { impl: open, seen: seenOpen } = fakeFetch(() => Response.json(reply([])))
  await detectWithGroundingDino(new Uint8Array([1]), CONFIG, open)
  assertEquals(new Headers(seenOpen[0].init?.headers).get('authorization'), null)
})

test('detect: each failure says what to do about it', async () => {
  const bytes = new Uint8Array([1])
  const refused = fakeFetch(() => new Response('{"error": "unauthorized"}', { status: 401 })).impl
  await assertRejects(() => detectWithGroundingDino(bytes, CONFIG, refused), Error, 'check GDINO_TOKEN')
  const loading = fakeFetch(() => new Response('{"error": "model loading"}', { status: 503 })).impl
  await assertRejects(() => detectWithGroundingDino(bytes, CONFIG, loading), Error, 'not ready (HTTP 503)')
  const broken = fakeFetch(() => new Response('oops', { status: 500 })).impl
  await assertRejects(() => detectWithGroundingDino(bytes, CONFIG, broken), Error, 'HTTP 500')
  const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
  await assertRejects(() => detectWithGroundingDino(bytes, CONFIG, down), Error, 'unreachable')
})

test('health: ready, state and model, read from GET /health', async () => {
  const { impl, seen } = fakeFetch(() => Response.json({ status: 'ok', ready: false, state: 'loading', model: 'IDEA-Research/grounding-dino-base' }))
  assertEquals(await groundingDinoHealth(CONFIG, impl), { ready: false, state: 'loading', model: 'IDEA-Research/grounding-dino-base' })
  assertEquals(seen[0].url, 'https://gpu.example.ts.net:8010/health')
  const failing = fakeFetch(() => new Response('', { status: 502 })).impl
  await assertRejects(() => groundingDinoHealth(CONFIG, failing), Error, 'HTTP 502')
})

test('the engine: INFERENCE_MODE=grounding-dino loads against /health, names the model, and infers through /detect', async () => {
  const { impl, seen } = fakeFetch((url) => url.endsWith('/health')
    ? Response.json({ ready: true, state: 'ready', model: 'IDEA-Research/grounding-dino-base' })
    : Response.json(reply([{ label: 'plant', confidence: 0.8, bbox: [0, 0, 100, 100] }])))
  const engine = new InferenceEngine({ env: envOf({ INFERENCE_MODE: 'grounding-dino', GDINO_URL: CONFIG.url }), fetch: impl })
  assertEquals(engine.mode, 'grounding-dino')
  await engine.load()
  assertEquals(engine.modelId, 'GroundingDINO/IDEA-Research/grounding-dino-base')
  const out = await engine.infer(new Uint8Array([0xff, 0xd8, 0xff]))
  assertEquals(out.map((d) => d.label), ['plant'])
  assertEquals(seen.map((s) => s.url), [`${CONFIG.url}/health`, `${CONFIG.url}/detect`])
  assert(engine.lastInferMs !== null)
})

test('the engine: no GDINO_URL, or a service that does not answer, fails the load with the reason', async () => {
  const unset = new InferenceEngine({ env: envOf({ INFERENCE_MODE: 'grounding-dino' }) })
  await assertRejects(() => unset.load(), Error, 'GDINO_URL')
  const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
  const unreachable = new InferenceEngine({ env: envOf({ INFERENCE_MODE: 'grounding-dino', GDINO_URL: CONFIG.url }), fetch: down })
  await assertRejects(() => unreachable.load(), Error, 'unreachable')
})

test('capabilities: the grounding-dino engine is found when GDINO_URL is set, and its health says whether the model is ready', async () => {
  const report = (env: Record<string, string>, fetchImpl?: typeof fetch) => probeCapabilities({
    platform: 'linux',
    arch: 'x86_64',
    nodeVersion: '0.0.0-test',
    home: '/home/t',
    env: envOf(env),
    versions: fetchImpl !== undefined,
    ...(fetchImpl ? { _fetch: fetchImpl } : {}),
    _isRunnable: () => Promise.resolve(false),
    _isDir: () => Promise.resolve(false),
    _isFile: () => Promise.resolve(false),
    _listDir: () => Promise.resolve([]),
    _whichPath: () => Promise.resolve(null),
    _run: () => Promise.resolve(null),
  })
  const row = async (r: ReturnType<typeof report>) => (await r).tools.find((t) => t.id === 'inference-engine')!
  const unset = await row(report({ INFERENCE_MODE: 'grounding-dino' }))
  assertEquals([unset.found, unset.envVar], [false, 'GDINO_URL'])
  assertStringIncludes(unset.remediation ?? '', 'GDINO_URL')
  const { impl, seen } = fakeFetch(() => Response.json({ ready: true, state: 'ready' }))
  const set = await row(report({ INFERENCE_MODE: 'grounding-dino', GDINO_URL: `${CONFIG.url}/`, GDINO_TOKEN: 'tok-s3cret-1' }, impl))
  assertEquals([set.found, set.reachable, set.path], [true, true, CONFIG.url])
  assertStringIncludes(set.detail ?? '', 'model ready')
  // The health request needs no credentials, so none are sent, and the token is nowhere in the row.
  assertEquals(new Headers(seen[0].init?.headers).get('authorization'), null)
  assert(!JSON.stringify(set).includes('tok-s3cret-1'))
})
