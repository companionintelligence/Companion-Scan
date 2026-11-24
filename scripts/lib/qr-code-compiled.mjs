/**
 * The share-link QR renderer (`src/ui/qr-code.ts`) and the encoder under it, compiled for Node.
 *
 * The encoder is vendored source (`src/third-party/qrcodegen/qrcodegen.ts`, edited by no hand: see its
 * README) written with TypeScript namespaces and parameter properties. Node 26 runs TypeScript by
 * stripping its types, and has no mode that transforms what cannot be stripped, so neither file can be
 * imported by Node as it is. The bundle compiles them; this compiles them the same way, with the
 * TypeScript compiler the repo already has, into a temporary folder, imports them from there, and
 * removes the folder. `rewriteRelativeImportExtensions` turns the renderer's import of
 * `qrcodegen.ts` into one of the compiled file, so the two are the pair the bundle has.
 *
 * Used by `scripts/print-fiducial.mjs` and by `tests/unit/server/qr_code.test.ts` (ADR 0016).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const SRC = new URL('../../src/', import.meta.url)
const FILES = ['ui/qr-code.ts', 'third-party/qrcodegen/qrcodegen.ts']

let loaded = null

/**
 * `{ qrCodeSvg, qrcodegen }`: the renderer's `qrCodeSvg(value, options)` and the encoder's namespace.
 * Compiled once per process.
 */
export function loadCompiledQrCode() {
  loaded ??= compile()
  return loaded
}

async function compile() {
  const dir = await mkdtemp(join(tmpdir(), 'qr-code-compiled-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
    for (const rel of FILES) {
      const source = await readFile(new URL(rel, SRC), 'utf8')
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true },
      })
      const out = join(dir, rel.replace(/\.ts$/, '.js'))
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, outputText)
    }
    const renderer = await import(pathToFileURL(join(dir, 'ui/qr-code.js')).href)
    const encoder = await import(pathToFileURL(join(dir, 'third-party/qrcodegen/qrcodegen.js')).href)
    return { qrCodeSvg: renderer.qrCodeSvg, qrcodegen: encoder.qrcodegen }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
