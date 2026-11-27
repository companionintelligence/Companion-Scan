#!/usr/bin/env node
// The spec gate for the world files, their hand-over and the frame generations (registry entry world-hand-over):
// npm run spec:world.
//
//   node spec/quint/check-world.mjs                     the fast gate
//   node spec/quint/check-world.mjs --deep              and bounded Apalache verification (needs Java 21)
//   node spec/quint/check-world.mjs --refresh-fixtures  rewrite spec/quint/traces/{handOver,worldLock,frames}
//
// SPEC_SEED overrides the seed, and QUINT_SERVER_PORT the Apalache port (8846). Every step requires its exit code and
// its result line. Each planted bug must fail, and so must the replay of its traces against the code.

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { commit, declared, Gate, pickFixtures, quintHome, QUINT_VERSION, REPO, scratchDir, specTool } from '../lib/gate.mjs'

const MODEL = 'spec/quint/worldHandOver.qnt'
const TESTS = 'spec/quint/worldHandOverTest.qnt'
const SEED = process.env.SPEC_SEED ?? '0x5ca1ab1e'
const PORT = process.env.QUINT_SERVER_PORT ?? '8846'
const RUN = { samples: 10000, steps: 40 }
const WITNESS = { samples: 100000, steps: 40 }
const TRACES = 300

/**
 * Each model: its main module, the module its definitions live in, its replay, and its planted bugs. `depth` is the
 * Apalache bound for --deep, measured on a laptop: handOver 6 in about 60 s, worldLock 5 in about 50 s (8 did not end
 * in 10 minutes), frames 6 in about 7 s.
 */
const MODELS = [
  {
    main: 'handOver',
    module: 'handOverModel',
    steps: 50,
    depth: 6,
    replay: 'tests/unit/server/world_hand_over_trace.test.ts',
    env: 'HANDOVER_ITF_DIR',
    fixtures: 'handOver',
    bugs: [{ main: 'handOverBug', lines: [/❌ notesAreNeverLost/] }],
    mutant: 'handOverBug',
  },
  {
    main: 'worldLock',
    module: 'worldLockModel',
    steps: 50,
    depth: 5,
    replay: 'tests/unit/server/world_lock_trace.test.ts',
    env: 'LOCK_ITF_DIR',
    fixtures: 'worldLock',
    bugs: [
      { main: 'worldLockTornWrite', lines: [/❌ aReaderNeverSeesAPartlyWrittenWorld/] },
      {
        main: 'worldLockUnlockedHandOver',
        invariants: ['generationsOnlyIncrease', 'aStaleSnapshotNeverOverwritesANewerGeneration'],
        lines: [/❌ (generationsOnlyIncrease|aStaleSnapshotNeverOverwritesANewerGeneration)/],
      },
    ],
    mutant: 'worldLockUnlockedHandOver',
  },
  {
    main: 'frames',
    module: 'frameModel',
    steps: 30,
    depth: 6,
    replay: 'tests/unit/server/frame_generations_trace.test.ts',
    env: 'FRAMES_ITF_DIR',
    fixtures: 'frames',
    bugs: [{ main: 'framesWithoutRevisionCheck', lines: [/❌ aStaleWriteIsNeverStored/] }],
    mutant: 'framesWithoutRevisionCheck',
  },
]

/** The test modules, and the one that must fail: the planted variant that waits for the other world's lock. */
const TEST_MODULES = [
  { main: 'handOverTest', pass: true },
  { main: 'worldLockTest', pass: true },
  { main: 'frameTest', pass: true },
  { main: 'worldLockDeadlockTest', pass: false, failing: 'crossedHandOversDrainTest' },
]

const args = new Set(process.argv.slice(2))
for (const arg of args) if (!['--deep', '--refresh-fixtures'].includes(arg)) {
  console.error(`unknown option ${arg}`)
  process.exit(2)
}
const deep = args.has('--deep')
const refresh = args.has('--refresh-fixtures')
const gate = new Gate('spec:world')

const quint = specTool('quint')
const home = quintHome({ needApalache: deep })
if (!gate.check('the pinned quint is installed (npm run spec:install)', quint !== null, 'spec/node_modules/.bin/quint is missing')) gate.finish()
if (!gate.check('QUINT_HOME holds the checked evaluator' + (deep ? ' and Apalache' : ''), !home.error, home.error)) gate.finish()
gate.step(`quint --version is ${QUINT_VERSION}`, quint, ['--version'], { code: 0, lines: [new RegExp(`^${QUINT_VERSION.replaceAll('.', '\\.')}\\s*$`, 'm')] })

gate.step('typecheck the models', quint, ['typecheck', MODEL], { code: 0, absent: [/error/i] })
gate.step('typecheck the tests', quint, ['typecheck', TESTS], { code: 0, absent: [/error/i] })

for (const t of TEST_MODULES) {
  const names = declared(join(REPO, TESTS), 'run', t.main)
  gate.check(`${t.main} declares tests`, names.length > 0)
  const run = ['test', '--main', t.main, TESTS, '--seed', SEED, '--max-samples', '500', '--verbosity', '2']
  if (t.pass) {
    gate.step(`quint test ${t.main}: ${names.length} tests`, quint, run, {
      code: 0, lines: [new RegExp(`\\b${names.length} passing\\b`), ...names.map((name) => new RegExp(`ok ${name} passed`))], absent: [/failing/, /\bfailed\b/],
    })
  } else {
    gate.step(`quint test ${t.main} fails, as the planted deadlock must`, quint, run, {
      code: 1, lines: [/1 failed/, new RegExp(`\\d\\) ${t.failing}:`), /QNT513/],
    })
  }
}

const traceDirs = []
for (const m of MODELS) {
  const invariants = declared(join(REPO, MODEL), 'invariant', m.module)
  const observations = declared(join(REPO, MODEL), 'observation', m.module)
  gate.check(`${m.main}: declares invariants (${invariants.length}) and witnesses (${observations.length})`, invariants.length > 0 && observations.length > 0)

  const checked = gate.step(`${m.main}: quint run, every invariant, ${RUN.samples} traces of ${RUN.steps} steps`, quint, [
    'run', '--main', m.main, MODEL, '--seed', SEED, '--max-samples', String(RUN.samples), '--max-steps', String(RUN.steps), '--verbosity', '2',
  ], { code: 0, lines: [/No violation found/, /Checked invariants: /], absent: [/\[violation\]/] })
  if (checked.ok) {
    const line = checked.out.split('\n').find((l) => l.startsWith('Checked invariants: ')) ?? ''
    const listed = new Set(line.slice('Checked invariants: '.length).split(',').map((name) => name.trim()))
    const missing = invariants.filter((name) => !listed.has(name))
    gate.check(`${m.main}: the run checked every declared invariant`, missing.length === 0, `not checked: ${missing.join(', ')}`)
  }

  for (const name of observations) {
    gate.step(`${m.main}: witness ${name}`, quint, [
      'run', '--main', m.main, MODEL, '--observation', name, '--seed', SEED, '--max-samples', String(WITNESS.samples), '--max-steps', String(WITNESS.steps), '--verbosity', '1',
    ], { code: 0, lines: [new RegExp(`\\[observed\\] Observed ${name}\\b`)] })
  }

  for (const bug of m.bugs) {
    gate.step(`${m.main}: the planted bug ${bug.main} is caught`, quint, [
      'run', '--main', bug.main, MODEL, ...(bug.invariants ? ['--invariants', ...bug.invariants] : []),
      '--seed', SEED, '--max-samples', String(RUN.samples), '--max-steps', String(RUN.steps), '--verbosity', '1',
    ], { code: 1, lines: [/\[violation\]/, ...bug.lines] })
  }

  // Seeded traces of the model, replayed against the code; then traces of the planted bug, which the code must refuse.
  const traces = scratchDir(`${m.main}-itf`)
  traceDirs.push(traces)
  const mbt = gate.step(`${m.main}: quint run --mbt, ${TRACES} traces of ${m.steps} steps`, quint, [
    'run', '--main', m.main, MODEL, '--mbt', '--seed', SEED, '--max-samples', String(TRACES), '--n-traces', String(TRACES), '--max-steps', String(m.steps),
    '--out-itf', join(traces, 't_{seq}.itf.json'), '--verbosity', '1',
  ], { code: 0, lines: [/No violation found/] })
  if (mbt.ok) {
    const written = readdirSync(traces).filter((name) => name.endsWith('.itf.json')).length
    gate.check(`${m.main}: ${TRACES} traces written`, written === TRACES, `${written} written`)
  }
  const tally = join(traces, 'tally.json')
  gate.step(`${m.main}: replay the traces against the code`, process.execPath, ['--test', m.replay], {
    code: 0, lines: [/ℹ pass 1\b/, /ℹ fail 0\b/],
  }, { env: { [m.env]: traces, ITF_TALLY: tally } })

  const mutants = scratchDir(`${m.mutant}-itf`)
  traceDirs.push(mutants)
  gate.step(`${m.main}: traces of ${m.mutant}`, quint, [
    'run', '--main', m.mutant, MODEL, '--mbt', '--invariant', 'true', '--seed', SEED, '--max-samples', String(TRACES), '--n-traces', String(TRACES),
    '--max-steps', String(m.steps), '--out-itf', join(mutants, 't_{seq}.itf.json'), '--verbosity', '1',
  ], { code: 0, lines: [/No violation found/] })
  gate.step(`${m.main}: the replay refuses ${m.mutant}'s traces`, process.execPath, ['--test', m.replay], {
    code: 1, lines: [/ℹ fail 1\b/, /AssertionError/],
  }, { env: { [m.env]: mutants } })

  if (refresh) {
    // The fewest trace prefixes that still check every case the replay requires, written compact.
    const { written, uncovered } = pickFixtures(tally, traces, join(REPO, 'spec', 'quint', 'traces', m.fixtures), SEED)
    gate.check(`${m.main}: wrote ${written} fixture traces to spec/quint/traces/${m.fixtures}, covering every case`, written > 0 && uncovered.length === 0, `uncovered: ${uncovered.join(', ')}`)
    gate.step(`${m.main}: replay the committed fixtures alone`, process.execPath, ['--test', m.replay], { code: 0, lines: [/ℹ pass 1\b/, /ℹ fail 0\b/] })
  }
}

if (deep) {
  // Apalache writes _apalache-out/ into its working directory, so it runs in a scratch one.
  const cwd = scratchDir('world-apalache')
  for (const m of MODELS) {
    gate.step(`${m.main}: quint verify (Apalache), every invariant to depth ${m.depth}, port ${PORT}`, quint, [
      'verify', '--main', m.main, join(REPO, MODEL), '--max-steps', String(m.depth), `--server-endpoint=localhost:${PORT}`, '--verbosity', '1',
    ], { code: 0, lines: [/\[ok\] No violation found/] }, { cwd, timeoutMs: 900_000 })
  }
  rmSync(cwd, { recursive: true, force: true })
}
for (const dir of traceDirs) rmSync(dir, { recursive: true, force: true })

gate.finish([
  `verification: world-hand-over at ${commit()}; quint ${QUINT_VERSION}, rust backend, seed ${SEED}; `
    + `run ${RUN.samples} x ${RUN.steps} steps per model; witnesses up to ${WITNESS.samples} x ${WITNESS.steps}; `
    + `replay of ${TRACES} traces per model${deep ? `; Apalache depth ${MODELS.map((m) => `${m.main} ${m.depth}`).join(', ')}` : ''}`,
])
