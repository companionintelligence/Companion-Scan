/**
 * The service's own routes (F-12, FN-188): the token is checked on every route,
 * a take id is validated before it names a directory, submission is idempotent
 * except after an error or a skip, and the five routes answer as documented.
 * The pipeline is injected, so this needs no GPU and no tools.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bearerMatches, configFromEnv, createService, TAKE_ID_RE } from '../server/service.mjs'

async function withService(config, fn) {
  const workDir = await mkdtemp(path.join(tmpdir(), '4d-service-'))
  const service = createService({ port: 0, host: '127.0.0.1', workDir, token: null, stub: false, env: {}, ...config })
  const { port } = await service.listen()
  try {
    await fn(`http://127.0.0.1:${port}`, service, workDir)
  } finally {
    await service.close()
    await rm(workDir, { recursive: true, force: true })
  }
}

const take = (takeId = 'take-abc') => ({ takeId, clips: [{ url: 'http://appliance/clip.mp4' }] })
const post = (base, body, headers = {}) =>
  fetch(`${base}/takes`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('the bearer check is exact, and open only when no token is set', () => {
  assert.equal(bearerMatches(undefined, null), true)
  assert.equal(bearerMatches('Bearer s3cret', 's3cret'), true)
  assert.equal(bearerMatches('bearer s3cret', 's3cret'), true)
  assert.equal(bearerMatches('Bearer s3cre', 's3cret'), false)
  assert.equal(bearerMatches('Basic s3cret', 's3cret'), false)
  assert.equal(bearerMatches(undefined, 's3cret'), false)
})

test('with a token set, every route refuses a request without it', async () => {
  await withService({ token: 'tok', runTake: async () => ({ status: 'ok' }) }, async (base) => {
    for (const [method, route] of [['GET', '/health'], ['GET', '/takes/take-abc'], ['GET', '/takes/take-abc/sequence'], ['GET', '/takes/take-abc/frames/frame-00000.ply']]) {
      const res = await fetch(`${base}${route}`, { method })
      assert.equal(res.status, 401, `${method} ${route}`)
      await res.body?.cancel()
    }
    assert.equal((await post(base, take())).status, 401)
    assert.equal((await post(base, take(), { Authorization: 'Bearer nope' })).status, 401)
    const ok = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer tok' } })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).ok, true)
  })
})

test('without a token the routes stay open, as they always were', async () => {
  await withService({ runTake: async () => ({ status: 'ok' }) }, async (base) => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    await res.body?.cancel()
  })
})

test('a take id that could name a path outside WORK_DIR is refused', async () => {
  let ran = 0
  await withService({ runTake: async () => { ran++; return { status: 'ok' } } }, async (base) => {
    for (const bad of ['../evil', 'a/b', '.hidden', '', 'x'.repeat(200)]) {
      const res = await post(base, take(bad))
      assert.equal(res.status, 400, JSON.stringify(bad))
      await res.body?.cancel()
    }
    assert.equal(ran, 0)
  })
  assert.ok(TAKE_ID_RE.test('take-solo-scan-1a2b3c'))
})

test('submission re-attaches to a running or finished take, and retries one that errored or skipped', async () => {
  const results = [{ status: 'error', error: 'brush exited 1' }, { status: 'ok', sequenceDir: '/nowhere' }]
  let runs = 0
  await withService({ runTake: async () => results[runs++] }, async (base) => {
    const first = await (await post(base, take())).json()
    assert.equal(first.attached, false)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal((await (await fetch(`${base}/takes/take-abc`)).json()).status, 'error')
    const retry = await (await post(base, take())).json()
    assert.equal(retry.attached, false)
    assert.equal(retry.retried, true)
    await new Promise((r) => setTimeout(r, 20))
    const again = await (await post(base, take())).json()
    assert.equal(again.attached, true, 'a finished take must not start a second GPU run')
    assert.equal(runs, 2)
  })
})

test('a finished take lists its frames and serves them, and nothing else', async () => {
  await withService({}, async (base, service, workDir) => {
    const sequenceDir = path.join(workDir, 'take-abc', 'sequence')
    await mkdir(sequenceDir, { recursive: true })
    await writeFile(path.join(sequenceDir, 'frame-00000.ply'), 'ply-0')
    await writeFile(path.join(sequenceDir, 'frame-00001.ply'), 'ply-1')
    await writeFile(path.join(sequenceDir, 'notes.txt'), 'not a frame')
    service.takes.set('take-abc', { takeId: 'take-abc', status: 'ok', sequenceDir })
    const seq = await (await fetch(`${base}/takes/take-abc/sequence`)).json()
    assert.deepEqual(seq.frames, ['frame-00000.ply', 'frame-00001.ply'])
    assert.equal(await (await fetch(`${base}/takes/take-abc/frames/frame-00001.ply`)).text(), 'ply-1')
    const bad = await fetch(`${base}/takes/take-abc/frames/notes.txt`)
    assert.equal(bad.status, 404)
    await bad.body?.cancel()
  })
})

test('LISTEN_HOST and FDANYONE_TOKEN configure the service; unset keeps today\'s defaults', () => {
  const open = configFromEnv({}, ['node', 'service.mjs'])
  assert.equal(open.host, undefined, 'unset binds every interface, as before')
  assert.equal(open.token, null)
  assert.equal(open.port, 9040)
  const set = configFromEnv({ LISTEN_HOST: '127.0.0.1', FDANYONE_TOKEN: 't', PORT: '9041' }, ['node', 'service.mjs', '--stub'])
  assert.deepEqual([set.host, set.token, set.port, set.stub], ['127.0.0.1', 't', 9041, true])
})

test('the real entry point listens: `node server/service.mjs --stub` answers /health and finishes a stub take', async () => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const workDir = await mkdtemp(path.join(tmpdir(), '4d-entry-'))
  const entry = fileURLToPath(new URL('../server/service.mjs', import.meta.url))
  // Port 0 is not reachable from outside the child, so pick a free one first.
  const { createServer } = await import('node:net')
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
  })
  const child = spawn(process.execPath, [entry, '--stub'], {
    env: { ...process.env, NODE_ENV: '', PORT: String(port), LISTEN_HOST: '127.0.0.1', WORK_DIR: workDir, FDANYONE_TOKEN: 'entry-tok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the service did not say it was listening')), 10_000)
      child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve() } })
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the service exited ${code} before listening`)) })
    })
    const base = `http://127.0.0.1:${port}`
    const auth = { Authorization: 'Bearer entry-tok' }
    const health = await (await fetch(`${base}/health`, { headers: auth })).json()
    assert.deepEqual([health.ok, health.stub], [true, true])
    await post(base, take('take-entry'), auth)
    let status
    for (let i = 0; i < 100; i++) {
      status = await (await fetch(`${base}/takes/take-entry`, { headers: auth })).json()
      if (status.status !== 'running') break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(status.status, 'ok')
    const seq = await (await fetch(`${base}/takes/take-entry/sequence`, { headers: auth })).json()
    assert.equal(seq.frames[0], 'frame-00000.ply')
  } finally {
    child.kill()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('isMainModule compares real paths, so a symlinked checkout still starts', async () => {
  const { isMainModule } = await import('../server/service.mjs')
  const { symlink } = await import('node:fs/promises')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const dir = await mkdtemp(path.join(tmpdir(), '4d-link-'))
  try {
    const real = fileURLToPath(new URL('../server/service.mjs', import.meta.url))
    const link = path.join(dir, 'service.mjs')
    await symlink(real, link)
    assert.equal(isMainModule(link, pathToFileURL(real).href), true)
    assert.equal(isMainModule(path.join(dir, 'other.mjs'), pathToFileURL(real).href), false)
    assert.equal(isMainModule(undefined, pathToFileURL(real).href), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
