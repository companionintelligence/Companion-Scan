/**
 * Wave 14-0002 (F-29, FN-134, FN-135): the capability report's new rows.
 *
 * splat-finish (node and splat-transform), sensenova-vision, the 4d-capture
 * host, Companion Memory and the inference engine had no probe. The services
 * are rows of kind `service`: `found` means an address is configured, and
 * whether it answered is `reachable`, measured only with versions on, since the
 * browser fetches `?versions=0` and that must stay free of network calls. No
 * token value ever reaches the report.
 *
 * Run: node --test tests/unit/server/wp-runners-capabilities.test.ts
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from './assert.ts'
import {
  type CapabilityProbeOptions,
  formatCapabilityReport,
  probeCapabilities,
  serviceOrigin,
  type ToolCapability,
} from '../../../server/capabilities.ts'
import { test } from 'node:test'

function probe(env: Record<string, string>, opts: Partial<CapabilityProbeOptions> = {}) {
  return probeCapabilities({
    platform: 'linux',
    arch: 'x86_64',
    nodeVersion: '0.0.0-test',
    home: '/home/t',
    env: (name) => env[name],
    versions: false,
    _isRunnable: () => Promise.resolve(false),
    _isDir: () => Promise.resolve(false),
    _isFile: () => Promise.resolve(false),
    _listDir: () => Promise.resolve([]),
    _whichPath: () => Promise.resolve(null),
    _run: () => Promise.resolve(null),
    ...opts,
  })
}

function row(report: { tools: ToolCapability[] }, id: string): ToolCapability {
  const t = report.tools.find((x) => x.id === id)
  assert(t, `no row for ${id}`)
  return t
}

test('capabilities: splat-finish, sensenova and the three services each have a row and a stage', async () => {
  const report = await probe({})
  for (const id of [
    'splat-finish-node',
    'splat-transform-cli',
    'sensenova-bash',
    'sensenova-dir',
    'sensenova-model',
    'fdanyone-host',
    'companion-memory',
    'inference-engine',
  ]) {
    const t = row(report, id)
    assertEquals(t.found, false, id)
    assert((t.remediation ?? '').length > 20, `${id} has no actionable remediation`)
  }
  for (const stage of ['splat-finish', 'sensenova-vision', 'person-4d-reconstruct', 'memory-push', 'capture-inference']) {
    const p = report.pipelines.find((x) => x.id === stage)
    assert(p, `no stage ${stage}`)
    assertEquals(p.status, 'blocked', stage)
  }
})

test('capabilities: the ingest stage no longer claims /ingest-photos needs ffmpeg', async () => {
  const report = await probe({})
  assertFalse(row(report, 'ffmpeg').usedBy.includes('ingest-photos'))
  assertFalse((report.pipelines.find((p) => p.id === 'ingest-video')?.label ?? '').includes('photos'))
})

test('capabilities: versions off makes no network request, even with every service configured', async () => {
  let fetched = 0
  const report = await probe(
    { FDANYONE_HOST: 'http://gpu.example:9040', FDANYONE_TOKEN: 'secret', CI_SERVER_URL: 'https://mem.example/api', CI_SERVER_TOKEN: 't', OLLAMA_HOST: '127.0.0.1:11434' },
    { _fetch: () => { fetched++; return Promise.reject(new Error('no network in this test')) } },
  )
  assertEquals(fetched, 0)
  assertEquals(row(report, 'fdanyone-host').found, true)
  assertEquals(row(report, 'fdanyone-host').reachable, undefined)
  assertEquals(row(report, 'companion-memory').found, true)
  assertEquals(row(report, 'inference-engine').found, true)
})

test('capabilities: a service row carries an origin only, never a path, a user or a token', async () => {
  const report = await probe({
    FDANYONE_HOST: 'http://user:pw@gpu.example:9040/base/',
    FDANYONE_TOKEN: 'the-secret-token',
    CI_SERVER_URL: 'https://mem.example/api',
    CI_SERVER_TOKEN: 'the-memory-key',
  })
  assertEquals(row(report, 'fdanyone-host').path, 'http://gpu.example:9040')
  assertEquals(row(report, 'companion-memory').path, 'https://mem.example')
  const text = JSON.stringify(report) + formatCapabilityReport(report)
  for (const secret of ['the-secret-token', 'the-memory-key', 'pw@']) assertFalse(text.includes(secret), secret)
})

test('capabilities: with versions on, the 4d-capture host is asked /health with the bearer token', async () => {
  const seen: Array<{ url: string; auth: string | null }> = []
  const report = await probe(
    { FDANYONE_HOST: 'http://gpu.example:9040/', FDANYONE_TOKEN: 'tok', OLLAMA_HOST: 'http://127.0.0.1:11434' },
    {
      versions: true,
      _fetch: (input, init) => {
        const url = String(input)
        seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
        if (url.endsWith('/health')) return Promise.resolve(Response.json({ ok: true, stub: true }))
        return Promise.resolve(new Response('down', { status: 503 }))
      },
    },
  )
  assertEquals(seen.find((s) => s.url === 'http://gpu.example:9040/health')?.auth, 'Bearer tok')
  const fd = row(report, 'fdanyone-host')
  assertEquals(fd.reachable, true)
  assertStringIncludes(fd.detail ?? '', 'stub')
  // A configured Ollama that answers 503 is found (configured) and unreachable, which warns its stage.
  const engine = row(report, 'inference-engine')
  assertEquals([engine.found, engine.reachable], [true, false])
  const stage = report.pipelines.find((p) => p.id === 'capture-inference')!
  assertEquals(stage.status, 'ready')
  assert(stage.warnings.some((w) => w.includes('did not answer')), stage.warnings.join(' | '))
})

test('capabilities: the default Ollama address is not found until something answers there', async () => {
  // An unmeasured default is nobody's statement: a versions=0 report must not call it ok.
  const off = await probe({})
  assertEquals(row(off, 'inference-engine').found, false)
  assertStringIncludes(row(off, 'inference-engine').remediation ?? '', 'not probed')
  const on = await probe({}, {
    versions: true,
    _fetch: () => Promise.resolve(Response.json({ models: [{ name: 'm' }] })),
  })
  const engine = row(on, 'inference-engine')
  assertEquals([engine.found, engine.reachable, engine.via], [true, true, 'fallback'])
})

test('capabilities: INFERENCE_MODE=onnx is found when its model directory exists', async () => {
  const missing = await probe({ INFERENCE_MODE: 'onnx', MODEL_DIR: '/models/onnx/' })
  assertEquals(row(missing, 'inference-engine').found, false)
  const present = await probe({ INFERENCE_MODE: 'onnx', MODEL_DIR: '/models/onnx/' }, {
    _isDir: (p) => Promise.resolve(p === '/models/onnx/'),
  })
  assertEquals(row(present, 'inference-engine').found, true)
})

test('serviceOrigin: only http(s) URLs have an origin', () => {
  assertEquals(serviceOrigin('https://a.example:1/x?y'), 'https://a.example:1')
  assertEquals(serviceOrigin('gpu.example:9040'), null)
  assertEquals(serviceOrigin('file:///etc/passwd'), null)
})
