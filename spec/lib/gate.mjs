// Shared helpers for the spec gates (spec/quint/check-gimbal.mjs, spec/quint/check-world.mjs).
//
// A tool's exit code alone is not evidence. Every step states the exit code it requires and the lines the tool must
// print, and anything else fails the step. Commands run without a shell, with a timeout, and with stdin closed, so a
// tool that stops to ask a question fails instead of waiting.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SPEC = join(REPO, 'spec')

/** The pinned versions spec/package.json installs, and the ones Quint downloads on first use. */
export const QUINT_VERSION = '0.34.0'
export const EVALUATOR_VERSION = 'v0.8.0'
export const APALACHE_VERSION = '0.62.4'

/** A tool from spec/node_modules/.bin, or null when `npm run spec:install` has not been run. */
export function specTool(name) {
  const path = join(SPEC, 'node_modules', '.bin', name)
  return existsSync(path) ? path : null
}

/** Run a command and return its exit code and output. Never throws. */
export function run(command, args, { cwd = REPO, env = {}, timeoutMs = 180_000 } = {}) {
  const started = Date.now()
  const r = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: r.status,
    signal: r.signal,
    timedOut: r.error?.code === 'ETIMEDOUT',
    error: r.error && r.error.code !== 'ETIMEDOUT' ? String(r.error.message) : undefined,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    ms: Date.now() - started,
  }
}

export class Gate {
  constructor(name) {
    this.name = name
    this.steps = []
  }

  /**
   * Run one step. `expect.code` is the exit code it must end with, `expect.lines` are patterns that must all appear
   * in its output, and `expect.absent` are patterns that must not.
   */
  step(label, command, args, expect, options = {}) {
    const r = run(command, args, options)
    const problems = []
    if (r.error) problems.push(`could not run: ${r.error}`)
    if (r.timedOut) problems.push(`timed out after ${options.timeoutMs ?? 180_000} ms`)
    if (r.code !== expect.code) problems.push(`exit ${r.code ?? r.signal}, expected ${expect.code}`)
    for (const line of expect.lines ?? []) if (!line.test(r.out)) problems.push(`missing ${line}`)
    for (const line of expect.absent ?? []) if (line.test(r.out)) problems.push(`unexpected ${line}`)
    return this.#record(label, problems, r.ms, r.out)
  }

  /** Record a check this script made itself. */
  check(label, ok, detail = '') {
    return this.#record(label, ok ? [] : [detail || 'failed'], 0, '').ok
  }

  #record(label, problems, ms, out) {
    const ok = problems.length === 0
    this.steps.push({ label, ok, ms, problems })
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${ms ? ` (${ms} ms)` : ''}\n`)
    if (!ok) {
      for (const problem of problems) process.stdout.write(`       ${problem}\n`)
      const tail = out.trim().split('\n').slice(-25).join('\n       ')
      if (tail) process.stdout.write(`       --- last lines of output ---\n       ${tail}\n`)
    }
    return { ok, out }
  }

  /** Print the summary and exit 0 only when every step passed. */
  finish(extra = []) {
    const failed = this.steps.filter((s) => !s.ok)
    const total = this.steps.reduce((sum, s) => sum + s.ms, 0)
    for (const line of extra) process.stdout.write(`${line}\n`)
    process.stdout.write(
      `${this.name}: ${this.steps.length - failed.length} of ${this.steps.length} steps passed in ${(total / 1000).toFixed(1)} s`
        + (failed.length ? `; failed: ${failed.map((s) => s.label).join(', ')}` : '') + '\n',
    )
    process.exit(failed.length === 0 ? 0 : 1)
  }
}

/**
 * QUINT_HOME, checked before anything runs. Quint downloads its evaluator and Apalache on first use without checking a
 * checksum, so the gate never lets it: QUINT_HOME must already hold the archives CI-Agent-Sync's toolchains.yaml lists,
 * checked against their sha256 and unpacked there.
 */
export function quintHome({ needApalache = false } = {}) {
  const home = process.env.QUINT_HOME
  const seed = 'Seed it from the checksummed archives in CI-Agent-Sync integrations/verification/toolchains.yaml (the quint entry), then set QUINT_HOME.'
  if (!home) return { error: `QUINT_HOME is not set, so Quint would download its evaluator into ~/.quint unchecked. ${seed}` }
  const evaluator = join(home, `rust-evaluator-${EVALUATOR_VERSION}`, process.platform === 'win32' ? 'quint_evaluator.exe' : 'quint_evaluator')
  if (!existsSync(evaluator)) return { error: `${evaluator} is missing. ${seed}` }
  if (needApalache) {
    const apalache = join(home, `apalache-dist-${APALACHE_VERSION}`, 'apalache', 'bin', 'apalache-mc')
    if (!existsSync(apalache)) return { error: `${apalache} is missing. ${seed}` }
  }
  return { home }
}

/**
 * The names a Quint file declares with `invariant`, `observation` or `run` (a test), in file order. With `module`,
 * only those inside `module <name> { ... }`, which runs from its line to the next line that starts a module.
 */
export function declared(file, qualifier, module) {
  let text = readFileSync(file, 'utf8')
  if (module !== undefined) {
    const start = text.search(new RegExp(`^module\\s+${module}\\s*\\{`, 'm'))
    if (start < 0) throw new Error(`${file} has no module ${module}`)
    const rest = text.slice(start + 1)
    const end = rest.search(/^module\s+\w+\s*\{/m)
    text = text.slice(start, end < 0 ? undefined : start + 1 + end)
  }
  return [...text.matchAll(new RegExp(`^\\s*${qualifier}\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=`, 'gm'))].map((m) => m[1])
}

/** The commit being checked, for the verification block. */
export function commit() {
  const head = run('git', ['rev-parse', '--short', 'HEAD']).out.trim()
  const dirty = run('git', ['status', '--porcelain', '--', 'spec', 'subsystems/osmo-ble/protocol', 'subsystems/osmo-ble/server', 'server/world', 'tests/unit', '.agent-configs']).out.trim()
  return `${head}${dirty ? ' (with uncommitted changes)' : ''}`
}

/**
 * Rewrite a fixtures directory from a replay's tally (the replay writes one when ITF_TALLY names a file): the fewest
 * prefixes of the traces under `from` that still reach every case the replay requires, written compact. Returns how
 * many were written and the cases no trace reached.
 */
export function pickFixtures(tallyFile, from, dir, seed) {
  const tally = JSON.parse(readFileSync(tallyFile, 'utf8'))
  const coverage = tally.coverage
  const perTrace = tally.perTrace.filter((entry) => entry.file.startsWith(`${from}/`))
  const uncovered = new Set(coverage)
  const chosen = []
  while (uncovered.size > 0) {
    let best = null
    for (const entry of perTrace) {
      const adds = [...uncovered].filter((key) => key in entry.firstSeen)
      if (adds.length === 0) continue
      const upTo = Math.max(...adds.map((key) => entry.firstSeen[key]))
      if (!best || adds.length > best.adds.length || (adds.length === best.adds.length && upTo < best.upTo)) best = { entry, adds, upTo }
    }
    if (!best) break
    chosen.push(best)
    for (const key of best.adds) uncovered.delete(key)
  }
  const prefixes = chosen.map(({ entry, upTo }) => {
    const trace = JSON.parse(readFileSync(entry.file, 'utf8'))
    trace.states = trace.states.slice(0, upTo + 1)
    return trace
  })
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  prefixes.forEach((trace, index) => {
    writeFileSync(join(dir, `seed-${seed}-${String(index + 1).padStart(2, '0')}.itf.json`), `${JSON.stringify(trace)}\n`)
  })
  return { written: chosen.length, uncovered: [...uncovered] }
}

/** A temporary directory under the OS's, for traces a run writes and the replay reads. */
export function scratchDir(prefix) {
  const r = run('mktemp', ['-d', '-t', prefix])
  if (r.code !== 0) throw new Error(`mktemp failed: ${r.out}`)
  return r.out.trim()
}
