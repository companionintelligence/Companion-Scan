/**
 * `npm run device:preflight` names the host a phone will use from the variables the rest of the
 * repo reads for it: TAILSCALE_HOSTNAME, then VITE_HOSTNAME (server/main.ts, vite.config.ts,
 * scripts/qr.mjs). It had grown a variable of its own, HOST, so it could name a different box from
 * the one `npm run qr` printed a code for, and from the one the server admits origins for.
 *
 * The script runs for real here, with no `tailscale` on its PATH and a closed port to talk to, so
 * only the host line is read: it is printed before any network check runs.
 *
 * Runs with `npm run test:wave` (the wp- prefix), or alone:
 *   node --experimental-strip-types --no-warnings --test tests/unit/node/wp-docs-device-preflight.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directApiTarget, directApiVerdict, ownTailscaleName } from '../../../scripts/lib/preflight-api.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** A port nothing listens on, so every check against it is refused at once. */
function closedPort(): Promise<string> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => done(String(port)))
    })
  })
}

/**
 * The preflight's output with only `env` in its environment (nothing from this shell, which may
 * have TAILSCALE_HOSTNAME set), and an empty directory as PATH, so there is no tailscale CLI to ask.
 */
async function preflight(env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  const emptyBin = mkdtempSync(join(tmpdir(), 'preflight-path-'))
  try {
    const run = spawnSync(process.execPath, ['scripts/device-preflight.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: emptyBin, VITE_PORT: await closedPort(), PORT: await closedPort(), ...env },
    })
    return { status: run.status, out: `${run.stdout}${run.stderr}` }
  } finally {
    rmSync(emptyBin, { recursive: true, force: true })
  }
}

const hostLine = (out: string) => out.match(/^(PASS|FAIL|WARN)\s+host\s+(.*)$/m)

test('the host comes from TAILSCALE_HOSTNAME, the name the server and Vite use', async () => {
  const { out } = await preflight({ TAILSCALE_HOSTNAME: '127.0.0.1' })
  assert.deepEqual(hostLine(out)?.slice(1, 3), ['PASS', '127.0.0.1'], out)
})

test('VITE_HOSTNAME is the second name, as in server/main.ts and vite.config.ts', async () => {
  const { out } = await preflight({ VITE_HOSTNAME: '127.0.0.1' })
  assert.deepEqual(hostLine(out)?.slice(1, 3), ['PASS', '127.0.0.1'], out)
})

test('TAILSCALE_HOSTNAME wins over VITE_HOSTNAME', async () => {
  const { out } = await preflight({ TAILSCALE_HOSTNAME: '127.0.0.1', VITE_HOSTNAME: 'not-this-box.invalid' })
  assert.deepEqual(hostLine(out)?.slice(1, 3), ['PASS', '127.0.0.1'], out)
})

test('HOST is not read: a name only HOST gives is no host, and the message names the variables to set', async () => {
  const { status, out } = await preflight({ HOST: '127.0.0.1' })
  assert.equal(hostLine(out)?.[1], 'FAIL', out)
  assert.match(out, /TAILSCALE_HOSTNAME/, 'the failure says which variable to set')
  assert.doesNotMatch(out, /\bHOST\b/, 'no line still points at HOST')
  assert.equal(status, 1)
})

test('the usage text in the script names TAILSCALE_HOSTNAME, not HOST', () => {
  const source = readFileSync(join(ROOT, 'scripts/device-preflight.mjs'), 'utf8')
  assert.doesNotMatch(source, /\bHOST\b/, 'the script has no HOST variable left')
  assert.match(source.split('*/')[0], /TAILSCALE_HOSTNAME=\S+ npm run device:preflight/, 'the header shows how to name a host')
})

// ── The direct API check, run on the box or from another machine ─────────────

test('the direct check goes to API_URL when it is set, and to this machine\'s API port when it is not', () => {
  assert.deepEqual(directApiTarget({}, '8000'), { url: 'http://localhost:8000/health', explicit: false })
  assert.deepEqual(directApiTarget({ API_URL: 'http://box.example.ts.net:8000/' }, '8000'),
    { url: 'http://box.example.ts.net:8000/health', explicit: true })
  assert.deepEqual(directApiTarget({ API_URL: '  ' }, '8100'), { url: 'http://localhost:8100/health', explicit: false })
})

test('nothing on localhost is a warning only off the box, without API_URL, and with the proxy check passing', () => {
  const offBox = { reached: false, explicit: false, onThisBox: false, proxyHealthy: true }
  assert.equal(directApiVerdict(offBox), 'WARN')
  assert.equal(directApiVerdict({ ...offBox, onThisBox: true }), 'FAIL', 'on the box itself the API must answer')
  assert.equal(directApiVerdict({ ...offBox, proxyHealthy: false }), 'FAIL', 'a proxy that failed too is no evidence the API runs')
  assert.equal(directApiVerdict({ ...offBox, explicit: true }), 'FAIL', 'an API_URL that does not answer is a failure')
  assert.equal(directApiVerdict({ ...offBox, reached: true }), 'PASS')
})

test('this machine\'s Tailscale name is read without its trailing dot', () => {
  assert.equal(ownTailscaleName({ Self: { DNSName: 'box.example.ts.net.' } }), 'box.example.ts.net')
  assert.equal(ownTailscaleName(null), null)
  assert.equal(ownTailscaleName({ Self: {} }), null)
})

/** The preflight run without blocking this process, so a server in it can answer the script. */
async function preflightLive(env: Record<string, string>): Promise<string> {
  const emptyBin = mkdtempSync(join(tmpdir(), 'preflight-path-'))
  try {
    const child = spawn(process.execPath, ['scripts/device-preflight.mjs'], {
      cwd: ROOT,
      env: { PATH: emptyBin, VITE_PORT: await closedPort(), PORT: await closedPort(), ...env },
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    await new Promise((done) => child.on('close', done))
    return out
  } finally {
    rmSync(emptyBin, { recursive: true, force: true })
  }
}

const directLine = (out: string) => out.match(/^(PASS|FAIL|WARN)\s+api server \(direct\)\s+(.*)$/m)

test('API_URL sends the direct check to that address, and a 200 there passes', async () => {
  const api = createHttpServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' })
    res.end('{"status":"ok"}')
  })
  await new Promise<void>((ready) => api.listen(0, '127.0.0.1', () => ready()))
  try {
    const { port } = api.address() as { port: number }
    const out = await preflightLive({ TAILSCALE_HOSTNAME: '127.0.0.1', API_URL: `http://127.0.0.1:${port}` })
    assert.deepEqual(directLine(out)?.slice(1, 3), ['PASS', `200  http://127.0.0.1:${port}/health`], out)
  } finally {
    await new Promise((closed) => api.close(closed))
  }
})

test('off the box with the proxy failing too, nothing on localhost is still a failure', async () => {
  const out = await preflightLive({ TAILSCALE_HOSTNAME: '127.0.0.1' })
  assert.equal(directLine(out)?.[1], 'FAIL', out)
})
