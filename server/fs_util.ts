/**
 * File helpers the server and its tests share (ADR 0016). Everything else uses `node:fs/promises`
 * directly, as `fs`.
 *
 * - `readBytes` returns a plain `Uint8Array`, as `Deno.readFile` did. `fs.readFile` returns a
 *   `Buffer`, whose `slice()` is a view rather than a copy, and which compares unequal to a
 *   `Uint8Array` of the same bytes.
 * - `makeTempDir` makes a fresh directory under the system temp folder, or under `dir`, named
 *   `prefix` plus random characters.
 * - `isNotFound` and its siblings read an error's `code`. They stand for the
 *   `Deno.errors.NotFound`, `AlreadyExists`, `PermissionDenied` and `IsADirectory` classes.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

function plainBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  // A buffer that owns its whole ArrayBuffer is viewed as is. A pooled one (a small read) is copied, so the
  // result's .buffer holds exactly the file. fs.readFile never hands back a SharedArrayBuffer.
  return buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
    ? new Uint8Array(buffer.buffer as ArrayBuffer, 0, buffer.byteLength)
    : new Uint8Array(buffer)
}

/** The file's bytes, as a plain `Uint8Array`. */
export async function readBytes(path: string | URL, options: { signal?: AbortSignal } = {}): Promise<Uint8Array<ArrayBuffer>> {
  return plainBytes(await fs.readFile(path, options))
}

/** `readBytes`, blocking. */
export function readBytesSync(path: string | URL): Uint8Array<ArrayBuffer> {
  return plainBytes(readFileSync(path))
}

export interface TempDirOptions {
  /** The start of the new directory's name. */
  prefix?: string
  /** Where to make it. The system temp folder by default. */
  dir?: string
}

function templateOf(opts: TempDirOptions): string {
  const base = opts.dir ?? tmpdir()
  // mkdtemp appends six random characters to its argument, so an empty prefix needs the separator itself.
  return opts.prefix ? join(base, opts.prefix) : `${base}${sep}`
}

/** Make a new, empty directory and return its path. */
export function makeTempDir(opts: TempDirOptions = {}): Promise<string> {
  return fs.mkdtemp(templateOf(opts))
}

/** `makeTempDir`, blocking. */
export function makeTempDirSync(opts: TempDirOptions = {}): string {
  return mkdtempSync(templateOf(opts))
}

/** The system error code an error carries (`ENOENT`, `EEXIST`, …), if any. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * What kind of error this was, for a log line that must not carry the message (a message can hold a path): the
 * system code (`EACCES`, `ENOENT`, …) when there is one, else the error's name, else `Error`.
 */
export function errorKind(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.name : 'Error')
}

/** True when the path does not exist (`ENOENT`). */
export function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

/** True when the path already exists (`EEXIST`). */
export function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST'
}

/** True when the operating system refused the operation (`EACCES`, `EPERM`). */
export function isPermissionDenied(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'EACCES' || code === 'EPERM'
}

/** True when a file operation met a directory (`EISDIR`). */
export function isADirectory(error: unknown): boolean {
  return errorCode(error) === 'EISDIR'
}
