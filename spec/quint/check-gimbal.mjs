#!/usr/bin/env node
// The spec gate for the gimbal interlock (registry entry gimbal-interlock): npm run spec:gimbal.
//
//   node spec/quint/check-gimbal.mjs                     the fast gate, a minute or less
//   node spec/quint/check-gimbal.mjs --deep              and bounded Apalache verification (needs Java 21)
//   node spec/quint/check-gimbal.mjs --refresh-fixtures  rewrite spec/quint/traces/gimbal from a seeded run
//
// SPEC_SEED overrides the seed, and QUINT_SERVER_PORT the Apalache port (8846). Every step requires its exit code
// and its result line; the planted bug (module gimbalInterlockBug) must fail.

import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { commit, declared, Gate, pickFixtures, quintHome, QUINT_VERSION, REPO, scratchDir, specTool } from '../lib/gate.mjs'

const MODEL = 'spec/quint/gimbalInterlock.qnt'
const TESTS = 'spec/quint/gimbalInterlockTest.qnt'
const REPLAY = 'tests/unit/node/gimbal_interlock_trace.test.ts'
const FIXTURES = join(REPO, 'spec', 'quint', 'traces', 'gimbal')
const SEED = process.env.SPEC_SEED ?? '0x5ca1ab1e'
const PORT = process.env.QUINT_SERVER_PORT ?? '8846'
const RUN = { samples: 20000, steps: 40 }
const WITNESS = { samples: 100000, steps: 40 }
const MBT = { traces: 300, steps: 60 }
/** Apalache depths: every invariant to 6 (about 70 s on a laptop); the planted bug needs 8 steps, so 9 (about 16 s). */
const DEPTH = 6
const BUG_DEPTH = 9

const args = new Set(process.argv.slice(2))
for (const arg of args) if (!['--deep', '--refresh-fixtures'].includes(arg)) {
  console.error(`unknown option ${arg}`)
  process.exit(2)
}
const deep = args.has('--deep')
const refresh = args.has('--refresh-fixtures')
const gate = new Gate('spec:gimbal')

const quint = specTool('quint')
const home = quintHome({ needApalache: deep })
if (!gate.check('the pinned quint is installed (npm run spec:install)', quint !== null, 'spec/node_modules/.bin/quint is missing')) gate.finish()
if (!gate.check('QUINT_HOME holds the checked evaluator' + (deep ? ' and Apalache' : ''), !home.error, home.error)) gate.finish()
gate.step(`quint --version is ${QUINT_VERSION}`, quint, ['--version'], { code: 0, lines: [new RegExp(`^${QUINT_VERSION.replaceAll('.', '\\.')}\\s*$`, 'm')] })

const invariants = declared(join(REPO, MODEL), 'invariant')
const observations = declared(join(REPO, MODEL), 'observation')
const tests = [...readFileSync(join(REPO, TESTS), 'utf8').matchAll(/^\s*run\s+(\w+Test)\s*=/gm)].map((m) => m[1])
gate.check(`the model declares invariants (${invariants.length}) and witnesses (${observations.length})`, invariants.length > 0 && observations.length > 0)

gate.step('typecheck the model', quint, ['typecheck', MODEL], { code: 0, absent: [/error/i] })
gate.step('typecheck the tests', quint, ['typecheck', TESTS], { code: 0, absent: [/error/i] })

gate.step(`quint test: ${tests.length} tests, seed ${SEED}`, quint, ['test', TESTS, '--seed', SEED, '--max-samples', '500', '--verbosity', '2'], {
  code: 0,
  lines: [new RegExp(`\\b${tests.length} passing\\b`), ...tests.map((name) => new RegExp(`ok ${name} passed`))],
  absent: [/failing/, /\bfailed\b/],
})

const checked = gate.step(`quint run: every invariant, ${RUN.samples} traces of ${RUN.steps} steps`, quint, [
  'run', '--main', 'gimbalInterlock', MODEL, '--seed', SEED, '--max-samples', String(RUN.samples), '--max-steps', String(RUN.steps), '--verbosity', '2',
], { code: 0, lines: [/No violation found/, /Checked invariants: /], absent: [/\[violation\]/] })
if (checked.ok) {
  const line = checked.out.split('\n').find((l) => l.startsWith('Checked invariants: ')) ?? ''
  const listed = new Set(line.slice('Checked invariants: '.length).split(',').map((name) => name.trim()))
  const missing = invariants.filter((name) => !listed.has(name))
  gate.check('the run checked every declared invariant', missing.length === 0, `not checked: ${missing.join(', ')}`)
}

for (const name of observations) {
  gate.step(`witness ${name}`, quint, [
    'run', '--main', 'gimbalInterlock', MODEL, '--observation', name, '--seed', SEED, '--max-samples', String(WITNESS.samples), '--max-steps', String(WITNESS.steps), '--verbosity', '1',
  ], { code: 0, lines: [new RegExp(`\\[observed\\] Observed ${name}\\b`)] })
}

gate.step('the planted bug (gimbalInterlockBug) is caught', quint, [
  'run', '--main', 'gimbalInterlockBug', MODEL, '--seed', SEED, '--max-samples', String(RUN.samples), '--max-steps', String(RUN.steps), '--verbosity', '1',
], { code: 1, lines: [/\[violation\]/, /❌ (parkedScanHasAtMostOneOutsideDriver|parkedOutsideDriveIsAlone)/] })

// Seeded traces with the action and picks of every step, replayed against the code.
const traces = scratchDir('gimbal-itf')
const mbt = gate.step(`quint run --mbt: ${MBT.traces} traces of ${MBT.steps} steps`, quint, [
  'run', '--main', 'gimbalInterlock', MODEL, '--mbt', '--seed', SEED, '--max-samples', String(MBT.traces), '--n-traces', String(MBT.traces), '--max-steps', String(MBT.steps),
  '--out-itf', join(traces, 't_{seq}.itf.json'), '--verbosity', '1',
], { code: 0, lines: [/No violation found/] })
if (mbt.ok) {
  const written = readdirSync(traces).filter((name) => name.endsWith('.itf.json')).length
  gate.check(`${MBT.traces} traces written`, written === MBT.traces, `${written} written`)
}
const tally = join(traces, 'tally.json')
gate.step('replay the traces against motion_gate.mjs and link_state.mjs', process.execPath, ['--test', REPLAY], {
  code: 0, lines: [/ℹ pass 2\b/, /ℹ fail 0\b/],
}, { env: { GIMBAL_ITF_DIR: traces, ITF_TALLY: tally } })

// The replay is not a pass by construction: traces of the planted bug must be refused by the code.
const mutants = scratchDir('gimbal-bug-itf')
gate.step('traces of gimbalInterlockBug', quint, [
  'run', '--main', 'gimbalInterlockBug', MODEL, '--mbt', '--invariant', 'true', '--seed', SEED, '--max-samples', String(MBT.traces), '--n-traces', String(MBT.traces),
  '--max-steps', String(MBT.steps), '--out-itf', join(mutants, 't_{seq}.itf.json'), '--verbosity', '1',
], { code: 0, lines: [/No violation found/] })
gate.step('the replay refuses the planted bug\'s traces', process.execPath, ['--test', REPLAY], {
  code: 1, lines: [/ℹ fail 1\b/, /AssertionError/],
}, { env: { GIMBAL_ITF_DIR: mutants } })
rmSync(mutants, { recursive: true, force: true })

if (refresh) {
  // The fewest trace prefixes that still check every decision both ways, written compact.
  const { written, uncovered } = pickFixtures(tally, traces, FIXTURES, SEED)
  gate.check(`wrote ${written} fixture traces to spec/quint/traces/gimbal, covering every decision`, written > 0 && uncovered.length === 0, `uncovered: ${uncovered.join(', ')}`)
  gate.step('replay the committed fixtures alone', process.execPath, ['--test', REPLAY], { code: 0, lines: [/ℹ pass 2\b/, /ℹ fail 0\b/] })
}

if (deep) {
  // Apalache writes _apalache-out/ into its working directory, so it runs in a scratch one.
  const cwd = scratchDir('gimbal-apalache')
  gate.step(`quint verify (Apalache): every invariant to depth ${DEPTH}, port ${PORT}`, quint, [
    'verify', '--main', 'gimbalInterlock', join(REPO, MODEL), '--max-steps', String(DEPTH), `--server-endpoint=localhost:${PORT}`, '--verbosity', '1',
  ], { code: 0, lines: [/\[ok\] No violation found/] }, { cwd, timeoutMs: 900_000 })
  gate.step(`quint verify (Apalache): the planted bug is found by depth ${BUG_DEPTH}`, quint, [
    'verify', '--main', 'gimbalInterlockBug', join(REPO, MODEL), '--max-steps', String(BUG_DEPTH), '--invariant', 'parkedScanHasAtMostOneOutsideDriver', `--server-endpoint=localhost:${PORT}`, '--verbosity', '1',
  ], { code: 1, lines: [/\[violation\]/, /❌ parkedScanHasAtMostOneOutsideDriver/] }, { cwd, timeoutMs: 900_000 })
  rmSync(cwd, { recursive: true, force: true })
}
rmSync(traces, { recursive: true, force: true })

gate.finish([
  `verification: gimbal-interlock at ${commit()}; quint ${QUINT_VERSION}, rust backend, seed ${SEED}; `
    + `run ${RUN.samples} x ${RUN.steps} steps; witnesses up to ${WITNESS.samples} x ${WITNESS.steps}; `
    + `replay of ${MBT.traces} traces x ${MBT.steps} steps${deep ? `; Apalache depth ${DEPTH}, planted bug by ${BUG_DEPTH}` : ''}`,
])
