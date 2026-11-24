/**
 * Deadline-bounded subprocess runs for the WorldJob runners.
 *
 * Nothing bounds a runner's child today. The single-flight pump awaits one job
 * at a time, so a stage that awaits a child's output with no limit holds
 * the only job slot for as long as its child stays alive: one wedged GPU run
 * stops every queued job in every world until the process restarts.
 *
 * This is the deadline form of `runCapture` in capabilities.ts (ADR 0001: reuse,
 * do not duplicate). It has the same shape, a SIGKILL on a timer, but it returns
 * the child's real output and status, so each runner keeps its own success and
 * failure handling and only gains a timeout reason.
 *
 * SIGKILL stops only the process it is sent to. A launcher's own children (a
 * bash script running python, say) keep the stdout pipe open, so `output()` can
 * outlive the kill. The helper stops waiting KILL_GRACE_MS after the kill. If the
 * child's output has arrived by then, it is returned with the timeout reason. If
 * the pipes are still open, the helper returns empty stdout and stderr, exit code
 * 137 and the same timeout reason, so anything the child wrote before the kill is
 * lost. Keeping that partial output would mean reading the pipes as they arrive,
 * which this helper does not do.
 */
import { isServerSessionId } from '../src/shared/session-id.ts'
import * as fs from 'node:fs/promises'
import { type CommandOptions, spawnCommand, type CommandOutput } from './subprocess.ts'

/** How long a killed child's pipes get to close before the helper stops waiting for them. */
export const KILL_GRACE_MS = 5_000

/** The longest delay a timer accepts; anything longer fires at once. */
export const MAX_TIMER_MS = 2_147_483_647

const EXPIRED = Symbol('deadline-expired')

export interface DeadlineOutput extends CommandOutput {
  /**
   * `timed out after 3 h` when the deadline fired and the child was killed,
   * `aborted by its job (…)` when the caller's signal did, null when it
   * finished on its own. Check this before the exit code: a killed child's code
   * and output are whatever the kill left behind.
   */
  timeoutReason: string | null
}

/**
 * The reason text for a run its caller's signal stopped. The job pump aborts a
 * job whose own deadline (WORLD_JOB_DEADLINE_MS) passed, so the child must not
 * keep running beside the next job.
 */
export function abortReasonOf(signal: AbortSignal): string {
  const reason = signal.reason
  const text = typeof reason === 'string'
    ? reason
    : reason instanceof Error && reason.message
    ? reason.message
    : ''
  return text ? `aborted by its job (${text})` : 'aborted by its job'
}

const ABORTED = Symbol('caller-aborted')

/** The output of a run that never started because its signal had already fired. */
function notStarted(timeoutReason: string): DeadlineOutput {
  return {
    code: 137,
    signal: null,
    success: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    timeoutReason,
  }
}

/**
 * Run `bin` with `options` and wait at most `deadlineMs` for it to exit.
 *
 * `signal`, when given, stops the child the same way the deadline does: the
 * job pump passes its job's signal, so a job it has given up on does not leave
 * its child running. A signal that has already fired spawns nothing.
 *
 * Throws only when `bin` cannot be spawned, which `output()` does too, so a
 * caller's existing spawn-failure handling still applies.
 */
export async function runWithDeadline(
  bin: string,
  options: CommandOptions,
  deadlineMs: number,
  killGraceMs: number = KILL_GRACE_MS,
  signal?: AbortSignal,
): Promise<DeadlineOutput> {
  if (signal?.aborted) return notStarted(abortReasonOf(signal))
  const child = await spawnCommand(bin, options)
  const exited = child.output()

  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), deadlineMs)
  })
  let onAbort: (() => void) | undefined
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (!signal) return
    onAbort = () => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  let first: CommandOutput | typeof EXPIRED | typeof ABORTED
  try {
    first = await Promise.race([exited, expired, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
  if (first !== EXPIRED && first !== ABORTED) return withTimeoutReason(first, null)

  const timeoutReason = first === ABORTED && signal
    ? abortReasonOf(signal)
    : `timed out after ${describeBudget(deadlineMs)}`
  try {
    child.kill('SIGKILL')
  } catch {
    // Already exited between the timer firing and this line.
  }
  const late = await within(exited.catch(() => null), killGraceMs, null)
  if (late) return withTimeoutReason(late, timeoutReason)
  // The pipes never closed within the grace period, so there is no output to return.
  return {
    code: 137,
    signal: 'SIGKILL',
    success: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    timeoutReason,
  }
}

/** A finished child's output with the timeout reason added. A pipe that was not piped reads as empty. */
function withTimeoutReason(out: CommandOutput, timeoutReason: string | null): DeadlineOutput {
  return {
    code: out.code,
    signal: out.signal,
    success: out.success,
    stdout: out.stdout,
    stderr: out.stderr,
    timeoutReason,
  }
}

/**
 * `promise`'s value if it settles within `ms`, otherwise `fallback`. The timer
 * is cleared on either path, so a settled race leaves nothing running.
 */
export async function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cutoff = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, cutoff])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A budget in words a reader can act on: "3 h", "30 min", "90 s", "200 ms". */
export function describeBudget(ms: number): string {
  if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(1)} h`
  if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)} min`
  if (ms >= 1_000) return `${+(ms / 1_000).toFixed(1)} s`
  return `${ms} ms`
}

/**
 * A per-stage budget from the environment, in milliseconds.
 *
 * An unset, unparseable or infinite value takes the default, and so does one
 * below 1 ms once it is rounded down (0.5 counts as 0).
 */
export function budgetFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name]
  const ms = Math.floor(raw ? Number(raw) : Number.NaN)
  // Rounded down before the test: a zero-length timer fires at once, so a budget
  // that floors to 0 would kill its stage immediately. setTimeout also fires at
  // once for a delay past 2^31 - 1 ms, which would turn a very large budget into
  // an immediate kill. Capped at the longest timer.
  return Number.isFinite(ms) && ms >= 1 ? Math.min(ms, MAX_TIMER_MS) : fallbackMs
}

// ── Runner helpers ──────────────────────────────────────────────────────────
//
// Each of these used to be copied into five runners (ADR 0001). The integer
// rule is `budgetFromEnv`'s, without the timer cap.

/** The environment's value of `name`. */
function envValue(name: string): string | undefined {
  return process.env[name]
}

/**
 * A whole-number knob from the environment, at least 1.
 *
 * One rule for every runner: the value is rounded down first and then kept
 * only when it is finite and at least 1, so 0.5 takes the default rather than
 * passing a `> 0` test and becoming 0. Text that is not a number (`12abc`)
 * takes the default too; `parseInt` used to read it as 12. Unset and empty
 * take the default.
 */
export function intFromEnv(name: string, fallback: number): number {
  const raw = envValue(name)?.trim()
  if (!raw) return fallback
  const whole = Math.floor(Number(raw))
  return Number.isFinite(whole) && whole >= 1 ? whole : fallback
}

/**
 * A fractional knob from the environment that may be zero: COLMAP's 0.6
 * thresholds, and `COLMAP_MIN_POINTS3D=0`, the documented way to turn that
 * gate off. Negative, non-numeric, empty and unset take the default.
 */
export function numFromEnv(name: string, fallback: number): number {
  const raw = envValue(name)?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Whether a path's last segment is a server-minted session id. Delegates to the
 * shared `SESSION_ID_RE` (src/shared/session-id.ts): five runners used to carry
 * this check, and one of them once kept accepting the retired client-minted
 * `session-*` shape after every other copy had moved on.
 */
export function isValidSessionDir(sessionDir: string): boolean {
  const base = sessionDir.split('/').filter(Boolean).pop() ?? ''
  return isServerSessionId(base)
}

/**
 * Write a runner's manifest, best effort.
 *
 * A manifest that cannot be written is not a reason to fail the job: the result
 * still reaches the coordinator in memory. So this logs under `tag` and returns.
 * The directory is created only when `mkdir` is asked for. A runner that writes
 * into a session dir must not ask: a session deleted mid-run would come back as
 * a directory holding one manifest.
 */
export async function writeRunnerManifest(
  path: string,
  manifest: unknown,
  tag: string,
  opts: { mkdir?: boolean } = {},
): Promise<void> {
  try {
    if (opts.mkdir) {
      const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      if (slash > 0) await fs.mkdir(path.slice(0, slash), { recursive: true })
    }
    await fs.writeFile(path, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn(`[${tag}] failed to write manifest:`, e)
  }
}

/** The `{ status, manifest, log, exitCode }` a runner returns, after its manifest is written. */
export async function finishRun<M extends { status: string }>(
  manifestPath: string,
  manifest: M,
  exitCode: number,
  log: string,
  tag: string,
): Promise<{ status: M['status']; manifest: M; log: string; exitCode: number }> {
  await writeRunnerManifest(manifestPath, manifest, tag)
  return { status: manifest.status, manifest, log, exitCode }
}
