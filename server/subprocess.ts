/**
 * Child processes for the server, on `node:child_process` (ADR 0016).
 *
 * Every runner reaches a child through here: `runWithDeadline` (run_with_deadline.ts) builds on
 * `spawnCommand`, and so does the capability report's `runCapture` through it (ADR 0001: one path,
 * not one per caller). The shape is the one the runners were written against, so their success and
 * failure handling reads the same:
 *
 * - A child inherits the server's environment with `env` laid over it. `clearEnv: true` gives it
 *   `env` alone. `child_process.spawn` on its own replaces the environment whenever `env` is
 *   passed, so a runner that set one variable would lose `PATH`, and with it every tool found by
 *   name.
 * - A child that a signal stopped reports `code` 128 + the signal's number beside the signal's
 *   name: 137 for SIGKILL, 143 for SIGTERM. `child_process` reports `code: null` instead, and the
 *   callers compare codes.
 * - `stdin`, `stdout` and `stderr` each take `'piped'`, `'inherit'` or `'null'`. `stdin` inherits
 *   unless told otherwise. `stdout` and `stderr` are piped for `runCommand` and inherited for
 *   `spawnCommand`.
 * - A binary that cannot start (missing, not executable, a missing `cwd`) makes `spawnCommand` and
 *   `runCommand` throw, with the `ENOENT` or `EACCES` error `child_process` reports.
 * - Output is a plain `Uint8Array` of exactly the bytes written, not a `Buffer`.
 * - `signal`, when it fires, sends the child SIGTERM. The run then ends as any SIGTERM does
 *   (code 143), rather than rejecting.
 */
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { constants } from 'node:os'
import { Readable, Writable } from 'node:stream'

export type Stdio = 'piped' | 'inherit' | 'null'

export interface CommandOptions {
  args?: string[]
  cwd?: string | URL
  /** Laid over the server's environment, unless `clearEnv` is set. An undefined value is left out. */
  env?: Record<string, string | undefined>
  /** Start the child with `env` alone, not the server's environment. */
  clearEnv?: boolean
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  /** Sends the child SIGTERM when it fires. */
  signal?: AbortSignal
}

export interface CommandStatus {
  success: boolean
  /** The exit code, or 128 + the signal's number when a signal stopped the child. */
  code: number
  signal: NodeJS.Signals | null
}

export interface CommandOutput extends CommandStatus {
  /** What the child wrote, when stdout was piped; empty otherwise. */
  stdout: Uint8Array<ArrayBuffer>
  /** What the child wrote, when stderr was piped; empty otherwise. */
  stderr: Uint8Array<ArrayBuffer>
}

/** A running child. */
export interface SpawnedCommand {
  readonly pid: number
  /** Settles when the child exits. Its pipes may still be open (a grandchild can hold them). */
  readonly status: Promise<CommandStatus>
  /** The child's stdin, when piped. Throws otherwise. */
  readonly stdin: WritableStream<Uint8Array>
  /** The child's stdout, when piped. Throws otherwise. Not to be read beside `output()`. */
  readonly stdout: ReadableStream<Uint8Array>
  /** The child's stderr, when piped. Throws otherwise. Not to be read beside `output()`. */
  readonly stderr: ReadableStream<Uint8Array>
  /** Waits for the child to exit and its pipes to close, and returns what it wrote. */
  output(): Promise<CommandOutput>
  /** Sends `signal` (SIGTERM by default). A child that has already exited is left alone. */
  kill(signal?: NodeJS.Signals | number): void
  /** Lets the server exit while the child runs. */
  unref(): void
  ref(): void
}

function stdioOf(mode: Stdio | undefined, fallback: Stdio): 'pipe' | 'inherit' | 'ignore' {
  const chosen = mode ?? fallback
  return chosen === 'piped' ? 'pipe' : chosen === 'null' ? 'ignore' : 'inherit'
}

function environmentOf(opts: CommandOptions): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = opts.clearEnv ? {} : { ...process.env }
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (value !== undefined) merged[name] = value
  }
  return merged
}

/** The status a finished child reports, with a signal's stop folded into the code. */
export function statusOf(code: number | null, signal: NodeJS.Signals | null): CommandStatus {
  if (code !== null) return { success: code === 0, code, signal: null }
  const number = signal ? constants.signals[signal] : undefined
  return { success: false, code: typeof number === 'number' ? 128 + number : 1, signal }
}

/** Exactly the bytes in `chunks`, in one plain `Uint8Array` with a buffer of its own. */
function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0
  for (const chunk of chunks) length += chunk.byteLength
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function collect(stream: Readable | null): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return Promise.resolve(new Uint8Array())
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    stream.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    stream.once('error', reject)
    stream.once('close', () => resolve(concatBytes(chunks)))
  })
}

class Spawned implements SpawnedCommand {
  readonly status: Promise<CommandStatus>
  private readonly closed: Promise<CommandStatus>
  private webStdout: ReadableStream<Uint8Array> | null = null
  private webStderr: ReadableStream<Uint8Array> | null = null
  private webStdin: WritableStream<Uint8Array> | null = null
  private collected: Promise<[Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>]> | null = null
  private readonly child: ChildProcess

  constructor(child: ChildProcess, signal: AbortSignal | undefined) {
    this.child = child
    const failed = new Promise<never>((_, reject) => child.once('error', reject))
    // A failure after the start (a kill that fails, say) must not go unhandled.
    failed.catch(() => {})
    this.status = Promise.race([
      new Promise<CommandStatus>((resolve) => child.once('exit', (code, sig) => resolve(statusOf(code, sig)))),
      failed,
    ])
    this.closed = Promise.race([
      new Promise<CommandStatus>((resolve) => child.once('close', (code, sig) => resolve(statusOf(code, sig)))),
      failed,
    ])
    // A caller may await only one of the two. The other must not turn a failed start into an
    // unhandled rejection, which would end the server.
    this.status.catch(() => {})
    this.closed.catch(() => {})
    if (signal) {
      const stop = () => this.kill('SIGTERM')
      signal.addEventListener('abort', stop, { once: true })
      void this.status.catch(() => {}).finally(() => signal.removeEventListener('abort', stop))
    }
  }

  get pid(): number {
    return this.child.pid ?? 0
  }

  get stdin(): WritableStream<Uint8Array> {
    if (!this.child.stdin) throw new TypeError('stdin is not piped')
    this.webStdin ??= Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>
    return this.webStdin
  }

  get stdout(): ReadableStream<Uint8Array> {
    if (!this.child.stdout) throw new TypeError('stdout is not piped')
    this.webStdout ??= Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    return this.webStdout
  }

  get stderr(): ReadableStream<Uint8Array> {
    if (!this.child.stderr) throw new TypeError('stderr is not piped')
    this.webStderr ??= Readable.toWeb(this.child.stderr) as ReadableStream<Uint8Array>
    return this.webStderr
  }

  /** Starts reading both pipes at once, so a child that fills one while the other is read never blocks. */
  startCollecting(): void {
    this.collected ??= Promise.all([collect(this.child.stdout), collect(this.child.stderr)])
  }

  async output(): Promise<CommandOutput> {
    this.startCollecting()
    const [status, [stdout, stderr]] = await Promise.all([this.closed, this.collected!])
    return { ...status, stdout, stderr }
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill(signal)
  }

  unref(): void {
    this.child.unref()
  }

  ref(): void {
    this.child.ref()
  }
}

function startChild(bin: string, opts: CommandOptions, fallbackOut: Stdio): ChildProcess {
  const stdio: StdioOptions = [
    stdioOf(opts.stdin, 'inherit'),
    stdioOf(opts.stdout, fallbackOut),
    stdioOf(opts.stderr, fallbackOut),
  ]
  return spawn(bin, opts.args ?? [], { cwd: opts.cwd, env: environmentOf(opts), stdio })
}

/**
 * Start `bin`, and resolve once it is running. Throws (rejects) when it cannot start.
 * stdout and stderr are inherited unless `opts` pipes them.
 */
export async function spawnCommand(bin: string, opts: CommandOptions = {}): Promise<SpawnedCommand> {
  const child = startChild(bin, opts, 'inherit')
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError)
      resolve()
    }
    const onError = (error: Error) => {
      child.off('spawn', onSpawn)
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
  const spawned = new Spawned(child, opts.signal)
  if (opts.signal?.aborted) spawned.kill('SIGTERM')
  return spawned
}

/** Run `bin` to its end and return what it wrote. stdout and stderr are piped unless `opts` says otherwise. */
export async function runCommand(bin: string, opts: CommandOptions = {}): Promise<CommandOutput> {
  const piped: CommandOptions = { ...opts, stdout: opts.stdout ?? 'piped', stderr: opts.stderr ?? 'piped' }
  const child = startChild(bin, piped, 'piped')
  const spawned = new Spawned(child, opts.signal)
  // Read the pipes from the first byte: a child that fills a pipe nobody reads stops writing.
  spawned.startCollecting()
  if (opts.signal?.aborted) spawned.kill('SIGTERM')
  return await spawned.output()
}

/** `runCommand`, blocking. For scripts and tests; the server itself never blocks on a child. */
export function runCommandSync(bin: string, opts: CommandOptions = {}): CommandOutput {
  const result = spawnSync(bin, opts.args ?? [], {
    cwd: opts.cwd,
    env: environmentOf(opts),
    stdio: [stdioOf(opts.stdin, 'inherit'), stdioOf(opts.stdout, 'piped'), stdioOf(opts.stderr, 'piped')],
    maxBuffer: Number.MAX_SAFE_INTEGER,
  })
  if (result.error) throw result.error
  const bytes = (b: Uint8Array | null | undefined) => (b ? concatBytes([b]) : new Uint8Array())
  return { ...statusOf(result.status, result.signal), stdout: bytes(result.stdout), stderr: bytes(result.stderr) }
}
