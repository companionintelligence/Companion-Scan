/**
 * The gimbal CLI (subsystems/osmo-ble/server/cli.mjs), run for real as a child process against a
 * fake backend on a loopback port. Inventory findings FN-180, FN-182 and FN-194:
 *
 * - Ctrl-C stops the run on the backend, not just the client.
 * - There is a `stop` command.
 * - Without --pans, grid posts a centre/span, so the backend probes the reach at each station.
 *   It never did for CLI runs, which made --no-probe-arc a no-op.
 * - The default pan step clears the scanner's 20-degree keyframe threshold.
 * - --no-probe-arc and stop are in the help.
 * - The token is sent, and never printed.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/gimbal_cli.test.ts
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../../subsystems/osmo-ble/server/cli.mjs', import.meta.url))
const TOKEN = 'gimbal-cli-test-token-0123456789'
/** A port nothing listens on, so a dry run with no backend falls back at once. */
const NOWHERE = 'http://127.0.0.1:9'

type Seen = { method: string, url: string, headers: http.IncomingHttpHeaders, body: string }

/**
 * A stand-in for server/backend.mjs. It answers status with `arc`. A grid capture streams a start
 * event, and then a done event either at once or only after a grid-stop arrives (`holdUntilStop`).
 */
async function fakeBackend({ arc = { startDeg: 82, endDeg: -100, source: 'default' }, holdUntilStop = false } = {}) {
  const seen: Seen[] = []
  let releaseGrid: (() => void) | null = null
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ panArc: arc }))
        return
      }
      if (req.url === '/api/grid-stop') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ stopped: true, note: 'Scan will stop after the current position.' }))
        releaseGrid?.()
        return
      }
      if (req.url === '/api/grid-capture') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.write(JSON.stringify({ phase: 'start', total: 14, perStation: 14, stationsPlanned: 1, prefix: 'grid-test', plan: {} }) + '\n')
        const finish = (stopped: boolean) => {
          res.end(JSON.stringify({
            phase: 'done', total: 14, perStation: 14, converged: 0, captured: 0, stations: [], complete: false,
            usable: false, stationsUsable: 0, stationsPlanned: 1, framesConverged: 0,
            reason: stopped ? 'Stopped by request.' : 'test run', incompleteReason: stopped ? 'Stopped by request.' : null,
          }) + '\n')
        }
        if (holdUntilStop) releaseGrid = () => finish(true)
        else finish(false)
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `No route for ${req.method} ${req.url}` }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

type Run = { code: number | null, stdout: string, stderr: string }
function runCli(args: string[], env: Record<string, string> = {}, onSpawn?: (child: ReturnType<typeof spawn>) => void): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, OSMO_BACKEND_TOKEN: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    onSpawn?.(child)
  })
}

const tmp = mkdtempSync(path.join(tmpdir(), 'gimbal-cli-test-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

test('help lists stop, --no-probe-arc, the 25-degree default and the token variable', async () => {
  const { stdout, code } = await runCli(['help'])
  assert.equal(code, 0)
  assert.match(stdout, /^\s+stop\s+Stop a running capture/m)
  assert.match(stdout, /--no-probe-arc/)
  assert.match(stdout, /at a 25° step \(7 columns\)/)
  assert.match(stdout, /OSMO_BACKEND_TOKEN/)
  assert.match(stdout, /Ctrl-C during a run stops it on the backend/)
})

test('dry run with no backend: 7 columns x 2 rows at a 25-degree step, on the built-in fallback', async () => {
  const { stdout, stderr, code } = await runCli(['grid', '--dry-run'], { OSMO_BACKEND_URL: NOWHERE })
  assert.equal(code, 0)
  const positions = stdout.split('\n').filter((l) => /^\s+\d+: pan=/.test(l))
  assert.equal(positions.length, 14)
  assert.match(stderr, /1 station\(s\) x 14 positions/)
  assert.match(stderr, /at a 25° step, all inside the built-in fallback/)
  assert.match(stderr, /The backend measures the reach at each station/)
})

test('dry run plans against the arc the backend reports, measured from where the tripod stands', async () => {
  const backend = await fakeBackend({ arc: { startDeg: -60, endDeg: 100, source: 'measured', measuredAt: 1 } })
  try {
    const { stdout, stderr } = await runCli(['grid', '--dry-run'], { OSMO_BACKEND_URL: backend.url })
    const pans = [...stdout.matchAll(/pan=(-?[\d.]+)/g)].map((m) => Number(m[1]))
    assert.ok(pans.every((p) => p >= -60 && p <= 100), `every column inside the measured arc: ${pans}`)
    assert.match(stderr, /all inside the backend's measured arc/)
  } finally {
    await backend.close()
  }
})

test('grid without --pans posts a centre/span with the 25-degree step, with the token and no Origin', async () => {
  const backend = await fakeBackend()
  try {
    const out = path.join(tmp, 'centre-span')
    const run = await runCli(['grid', '--movement-only', '--yes', '--out', out], { OSMO_BACKEND_URL: backend.url, OSMO_BACKEND_TOKEN: TOKEN })
    const grid = backend.seen.find((s) => s.url === '/api/grid-capture')!
    const body = JSON.parse(grid.body)
    assert.equal(body.pans, undefined, 'the columns are the backend\'s to re-plan per station')
    assert.equal(body.panStepDeg, 25)
    assert.equal(body.capturePhotos, false)
    assert.equal(body.probeArc, undefined, 'the backend decides: on for a centre/span plan')
    assert.equal(grid.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(grid.headers.origin, undefined, 'Node fetch sends no Origin, so the origin rule never refuses the CLI')
    assert.ok(!(run.stdout + run.stderr).includes(TOKEN), 'the token is never printed')
  } finally {
    await backend.close()
  }
})

test('--no-probe-arc now has something to turn off, and --pans still posts explicit columns', async () => {
  const backend = await fakeBackend()
  try {
    await runCli(['grid', '--movement-only', '--yes', '--no-probe-arc', '--out', path.join(tmp, 'no-probe')], { OSMO_BACKEND_URL: backend.url })
    await runCli(['grid', '--movement-only', '--yes', '--pans', '120,150', '--out', path.join(tmp, 'pans')], { OSMO_BACKEND_URL: backend.url })
    const [noProbe, explicit] = backend.seen.filter((s) => s.url === '/api/grid-capture').map((s) => JSON.parse(s.body))
    assert.equal(noProbe.probeArc, false)
    assert.equal(noProbe.panStepDeg, 25)
    assert.deepEqual(explicit.pans, [120, 150])
    assert.equal(explicit.panStepDeg, undefined)
  } finally {
    await backend.close()
  }
})

test('--pans in the dead zone of the arc in use is refused before anything is posted', async () => {
  const backend = await fakeBackend()
  try {
    const run = await runCli(['grid', '--pans', '0,30', '--out', path.join(tmp, 'dead')], { OSMO_BACKEND_URL: backend.url })
    assert.equal(run.code, 1)
    assert.match(run.stderr, /dead zone/)
    assert.equal(backend.seen.some((s) => s.url === '/api/grid-capture'), false)
  } finally {
    await backend.close()
  }
})

test('stop posts /api/grid-stop and prints the backend\'s answer', async () => {
  const backend = await fakeBackend()
  try {
    const run = await runCli(['stop'], { OSMO_BACKEND_URL: backend.url, OSMO_BACKEND_TOKEN: TOKEN })
    assert.equal(run.code, 0)
    const stop = backend.seen.find((s) => s.url === '/api/grid-stop')!
    assert.equal(stop.method, 'POST')
    assert.equal(stop.headers.authorization, `Bearer ${TOKEN}`)
    assert.match(run.stdout, /"stopped": true/)
  } finally {
    await backend.close()
  }
})

test('Ctrl-C during a run stops it on the backend and waits for it to end, so the manifest is complete', { timeout: 20000 }, async () => {
  const backend = await fakeBackend({ holdUntilStop: true })
  const out = path.join(tmp, 'interrupted')
  try {
    const run = await runCli(['grid', '--movement-only', '--yes', '--out', out], { OSMO_BACKEND_URL: backend.url }, (child) => {
      // Interrupt once the run is under way: the manifest names the run once the start event is in,
      // and by then the CLI's interrupt handler is installed.
      const poll = setInterval(() => {
        const file = path.join(out, 'manifest.json')
        if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).prefix === 'grid-test') {
          clearInterval(poll)
          child.kill('SIGINT')
        }
      }, 25)
    })
    assert.equal(backend.seen.filter((s) => s.url === '/api/grid-stop').length, 1, 'one stop reached the backend')
    assert.match(run.stderr, /SIGINT: asking the backend to stop the capture/)
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    assert.ok(manifest.finishedAt, 'the CLI read on to the backend\'s done event and finalised the manifest')
    assert.equal(manifest.complete, false)
    assert.equal(run.code, 1, 'a stopped run is not the capture that was asked for')
  } finally {
    await backend.close()
  }
})
