#!/usr/bin/env node
// The spec gate for the gimbal correction's sign convention (registry entry gimbal-correction-sign): npm run spec:sign.
//
// DAFNY names the Dafny 4.11.0 binary (default: `dafny` on PATH): the release zip checked against its sha256 (CI-Agent-Sync
// integrations/verification/toolchains.yaml). DOTNET_CLI_TELEMETRY_OPTOUT is set for every run.
//
// A proof that verifies nothing exits 0, so this checks more than the exit code: lemmascript.json makes a misread
// annotation an error; LemmaScript-files.txt lists every proved file and every file it imports, with no timeout or flags
// column; no .dfy file has an include, and dafny audit finds nothing in any of them; every //@ verify function has its
// function and its ensures lemma in the proof, and Dafny counts at least two conditions each; the committed generated
// files are what lsc generates; a planted bug fails; and the property test runs the shipped control.mjs against it.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { commit, Gate, REPO, specTool } from '../lib/gate.mjs'

const HERE = join(REPO, 'spec', 'lemmascript')
const PROPERTY_TEST = 'tests/unit/node/gimbal_control_sign.test.ts'
const gate = new Gate('spec:sign')

const lsc = specTool('lsc')
if (!gate.check('lsc is installed (npm run spec:install)', lsc !== null, 'spec/node_modules/.bin/lsc is missing')) gate.finish()
gate.step('lsc is 0.6.14', lsc, ['version'], { code: 0, lines: [/^0\.6\.14\s*$/m] })
const dafny = process.env.DAFNY ? resolve(process.env.DAFNY) : 'dafny'
const env = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', PATH: `${process.env.DAFNY ? dirname(dafny) : ''}:${process.env.PATH}` }
if (!gate.step('dafny is 4.11.0', dafny, ['--version'], { code: 0, lines: [/^4\.11\.0\+/m] }, { env }).ok) gate.finish()

// What could make a proof pass on nothing.
const config = JSON.parse(readFileSync(join(HERE, 'lemmascript.json'), 'utf8'))
gate.check('lemmascript.json sets unread-annotations to error', config['unread-annotations'] === 'error', JSON.stringify(config['unread-annotations']))
const proofDir = join(HERE, config['proof-dir'] ?? '.')
const lines = readFileSync(join(HERE, 'LemmaScript-files.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
gate.check('LemmaScript-files.txt lists files with no timeout or flags column', lines.length > 0 && lines.every((l) => !/\s/.test(l)), lines.join(' | '))
const listed = lines.map((l) => join(HERE, l))
gate.check('every listed file exists', listed.every((f) => existsSync(f)))
const imported = listed.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/^\s*import\s+(?!type\b)[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)]
  .map((m) => resolve(dirname(f), m[1].replace(/\.js$/, '.ts'))))
gate.check('every file a listed file imports is listed', imported.every((f) => listed.includes(f)), imported.filter((f) => !listed.includes(f)).map((f) => relative(REPO, f)).join(', '))

const dfy = existsSync(proofDir) ? readdirSync(proofDir).filter((n) => n.endsWith('.dfy')).map((n) => join(proofDir, n)) : []
const expected = listed.map((f) => join(proofDir, `${relative(HERE, f).replace(/\.ts$/, '')}.dfy`))
gate.check('every listed file has its proof, and every proof a listed file', expected.every((p) => dfy.includes(p)) && dfy.every((p) => expected.includes(p)), dfy.map((p) => relative(REPO, p)).join(', '))
gate.check('no .dfy file has an include', dfy.every((p) => !/^\s*include\b/m.test(readFileSync(p, 'utf8'))))
for (const p of dfy) {
  gate.step(`dafny audit ${relative(REPO, p)}`, dafny, ['audit', p], { code: 0, lines: [/Dafny auditor completed with 0 findings/] }, { env })
}

// Every //@ verify function is in the proof with its ensures lemma.
let functions = 0
for (const f of listed) {
  const source = readFileSync(f, 'utf8')
  const names = [...source.matchAll(/export function (\w+)\([^)]*\)[^{]*\{\s*\/\/@ verify/g)].map((m) => m[1])
  functions += names.length
  const proof = readFileSync(join(proofDir, `${relative(HERE, f).replace(/\.ts$/, '')}.dfy`), 'utf8')
  const missing = names.filter((n) => !new RegExp(`^function ${n}\\(`, 'm').test(proof) || !new RegExp(`^lemma ${n}_ensures\\(`, 'm').test(proof))
  gate.check(`${relative(REPO, f)}: ${names.length} verified functions, each with its ensures lemma`, names.length > 0 && missing.length === 0, missing.join(', '))
}

// The proofs, in one batch. The committed generated files must be what lsc generates now.
const generated = readdirSync(proofDir).filter((n) => n.endsWith('.dfy') || n.endsWith('.dfy.gen')).sort()
const before = new Map(generated.map((n) => [n, readFileSync(join(proofDir, n), 'utf8')]))
const proved = gate.step('lsc check --backend=dafny', lsc, ['check', '--backend=dafny'], {
  code: 0, lines: [/Dafny program verifier finished with \d+ verified, 0 errors/],
}, { cwd: HERE, env, timeoutMs: 300_000 })
const count = Number(proved.out.match(/finished with (\d+) verified/)?.[1] ?? 0)
gate.check(`at least two verification conditions per verified function (${count} for ${functions})`, count >= 2 * functions, `${count}`)
const changed = generated.filter((n) => readFileSync(join(proofDir, n), 'utf8') !== before.get(n))
gate.check('the committed proofs are what lsc generates', changed.length === 0, `regenerated: ${changed.join(', ')}`)

// The planted bug: shouldFlip without its same-side check flips on an overshoot, the 2026-08-26 double reversal.
const scratch = mkdtempSync(join(tmpdir(), 'sign-bug-'))
for (const name of ['lemmascript.json', 'LemmaScript-files.txt', 'controlSign.ts']) cpSync(join(HERE, name), join(scratch, name))
const source = readFileSync(join(scratch, 'controlSign.ts'), 'utf8')
const planted = source.replace('  if (side !== prevSide) return false\n', '')
gate.check('the planted bug applies', planted !== source)
writeFileSync(join(scratch, 'controlSign.ts'), planted)
gate.step('the planted bug fails its proof', lsc, ['check', '--backend=dafny'], {
  code: 1, lines: [/could not be proved/, /Dafny program verifier finished with \d+ verified, [1-9]\d* errors?/],
}, { cwd: scratch, env, timeoutMs: 300_000 })
rmSync(scratch, { recursive: true, force: true })

// The proof is about integers; the property test runs the shipped doubles against it.
gate.step('the property test: control.mjs against the proved functions', process.execPath, ['--test', PROPERTY_TEST], {
  code: 0, lines: [/ℹ pass 4\b/, /ℹ fail 0\b/],
})

gate.finish([`verification: gimbal-correction-sign at ${commit()}; lemmascript 0.6.14, Dafny 4.11.0; ${count} verification conditions; property test seed 0x5ca1ab1e, 20000 runs each`])
