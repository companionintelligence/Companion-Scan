/**
 * PhysAg3D driver: one image of a Thing in, a textured, physically interactive 3D asset out.
 *
 * PhysAg3D (https://github.com/Supra-3D/PhysAg3D) turns a single image into an asset with articulated parts and
 * compliant regions. It is not a model this server runs. `execute.py run` starts an agent worker on the operator's own
 * Codex CLI and ChatGPT login, and that worker submits GPU generation over SSH to a Linux host with TRELLIS.2, DINOv3
 * and BiRefNet (at least 28 GiB of free GPU memory). The server box does not have that GPU, and PhysAg3D's runtime config
 * already delegates generation to that host, so `thing-interactive-asset` is the second WorldJob type that delegates
 * rather than computes (`person-4d-reconstruct` is the first, ADR 0006). docs/pipelines/physag3d.md has setup and what
 * leaves the box.
 *
 * The house contract, from server/splat/splat_train.ts and server/person4d/person_4d.ts:
 *
 *  - every knob resolves `opts.x ?? env X ?? default`, once, in `resolveParams()`
 *  - the three argument vectors are pure (`buildPrepareArgs`, `buildPlanArgs`, `buildRunArgs`)
 *  - a `_spawn` seam stands in for the subprocess in tests
 *  - an unconfigured install is `'skipped'` with a remediation, never `'error'`
 *  - it never throws into the server
 *
 * ## The steps
 *
 * `prepare` copies the image into a new case folder, `plan` prints the command `run` will start (logged here), and `run`
 * starts the worker. Neither of the first two calls a model; `run` is where the image leaves the box. Each step has a
 * deadline (run_with_deadline.ts). `run`'s is PhysAg3D's own budget, `max_case_active_seconds` in the case's runtime.json
 * (three hours by default), plus `RUN_MARGIN_MS`, so PhysAg3D's own timeout fires first: it stops the worker and records
 * `controller_timeout`. The server's kill is the backstop for a launcher that hangs, and it stops execute.py only: the
 * worker runs in a session of its own and can outlive it.
 *
 * ## Never twice
 *
 * Boot recovery requeues every job that was in flight (ADR 0003), and the case folder is named by the job id, so a
 * requeued job finds the case its first attempt made. PhysAg3D writes `execution.json` before it starts the worker and
 * does not resume or retry a case that has one. This driver never asks it to: a case with `execution.json` is read and
 * not run again, so a restart cannot send the image a second time.
 *
 * ## The copy of the frame
 *
 * prepare copies the keyframe into the case folder, and the agent's work makes more copies there. Before prepare the
 * driver writes a record of the frame beside the case folder (`<jobId>.source.json`, server/physag3d/asset_files.ts),
 * and every deletion of the session's frames removes the whole case folder first, so no copy outlives its source. The
 * copy is made inside the session's write queue, which those deletions wait in too, and the run holds the session
 * until it ends: a deletion meanwhile is refused and says to try again.
 *
 * ## What is not trusted
 *
 * delivery.json is written by the agent. Every path in it is resolved inside the case folder by real path before
 * anything is read through it, the files the server serves are copies under names it chooses, and the GLB copy must
 * start with the glTF magic. The child gets an allowlisted environment (`CHILD_ENV_NAMES`), so none of the server's
 * tokens reach the worker, which has a shell.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { locateTool, runnerToolLookup } from '../exec_probe.ts'
import { describeBudget, KILL_GRACE_MS, MAX_TIMER_MS, runWithDeadline } from '../run_with_deadline.ts'
import { isServerSessionId, sessionDirPath } from '../session_id.ts'
import { stderrTail } from '../splat/splat_train.ts'
import { KEYFRAME_FILE_RE, queueKeyframeWrite } from '../wp-a-keyframes.ts'
import { CASE_SOURCE_SUFFIX, holdSessionFrames, isAssetId, writeCaseSource } from './asset_files.ts'
import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isNotFound } from '../fs_util.ts'
import type { FileHandle } from 'node:fs/promises'

// ── The request ─────────────────────────────────────────────────────────────

/**
 * The keyframe a request names, as a path in its scan's capture session, or null. Both halves are shape-checked the
 * way GET /sessions/:id/keyframes/:file checks them, so neither can name a path outside the session folder.
 */
export function keyframeImagePath(
  sessionsDir: string,
  sessionId: string | null | undefined,
  keyframe: unknown,
): string | null {
  const dir = sessionDirPath(sessionsDir, sessionId)
  if (!dir || typeof keyframe !== 'string' || !KEYFRAME_FILE_RE.test(keyframe)) return null
  return `${dir}/${keyframe}`
}

/**
 * What is wrong with a thing-interactive-asset request, in words for the job's error, or null. Pure: it runs inside
 * the world lock (`jobFailureReason` in main.ts, ADR 0004), so whether the keyframe is on disk is the driver's question.
 */
export function interactiveAssetRequestProblem(
  payload: Record<string, unknown> | undefined,
  scanSessionId: string | null | undefined,
  thingIds: ReadonlySet<string>,
): string | null {
  if (!isServerSessionId(scanSessionId)) {
    return 'thing-interactive-asset needs a scan with streamed keyframes, and this scan has no capture session.'
  }
  const keyframe = payload?.['keyframe']
  if (typeof keyframe !== 'string' || !KEYFRAME_FILE_RE.test(keyframe)) {
    return "thing-interactive-asset needs payload.keyframe: the file name of one of the scan's keyframes, such as kf-00012.jpg."
  }
  const thingId = payload?.['thingId']
  if (thingId !== undefined && thingId !== null && (typeof thingId !== 'string' || !thingIds.has(thingId))) {
    return 'payload.thingId names no Thing in this Place.'
  }
  return null
}

// ── Configuration ───────────────────────────────────────────────────────────

/** Reads one environment variable; the seam tests use instead of the process environment. */
export type EnvReader = (name: string) => string | undefined

/** The process environment, with a read the process may not make taken as unset, as `budgetFromEnv` takes it. */
const processEnv: EnvReader = (name) => {
  try {
    return process.env[name]
  } catch {
    return undefined
  }
}

/** The interpreter for execute.py when PHYSAG3D_PYTHON is unset: python3 on PATH, which capabilities.ts probes too. */
const DEFAULT_PYTHON = 'python3'

export interface PhysAg3DParams {
  /** The PhysAg3D checkout, holding execute.py. Empty when unset. */
  checkoutDir: string
  /** The interpreter for execute.py: a path, or a name looked up on PATH. */
  python: string
  /** PhysAg3D's runtime config. Empty when unset. */
  configPath: string
  /** Where case folders go. Null: inside the scan's asset folder. */
  runsDir: string | null
}

/** Resolve every knob in one place, `opts ?? env ?? default`. An empty value counts as unset. */
export function resolveParams(
  opts: { checkoutDir?: string; python?: string; configPath?: string; runsDir?: string },
  env: EnvReader = processEnv,
): PhysAg3DParams {
  const read = (name: string): string | undefined => {
    const value = env(name)?.trim()
    return value ? value : undefined
  }
  return {
    checkoutDir: opts.checkoutDir ?? read('PHYSAG3D_DIR') ?? '',
    python: opts.python ?? read('PHYSAG3D_PYTHON') ?? DEFAULT_PYTHON,
    configPath: opts.configPath ?? read('PHYSAG3D_CONFIG') ?? '',
    runsDir: opts.runsDir ?? read('PHYSAG3D_RUNS_DIR') ?? null,
  }
}

/** Where a job's case folder goes: `<runsDir>/<jobId>` when a runs folder is set, else `<assetDir>/<jobId>`. */
export function caseDirFor(params: PhysAg3DParams, assetDir: string, assetId: string): string {
  return resolve(params.runsDir ?? assetDir, assetId)
}

/**
 * The environment names the child is given, from the server's own values. Nothing else reaches it. The server's
 * environment holds tokens (CI_SERVER_TOKEN, FDANYONE_TOKEN, ANDROID_MCP_TOKEN_*, the sign-in secrets), the worker
 * PhysAg3D starts has a shell, and execute.py's own filter (`clean_env`) passes any name it does not recognise.
 */
export const CHILD_ENV_NAMES = [
  // Where programs are, whose files these are, and how text is encoded.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
  // The operator's SSH agent, for the generation host, and the Codex CLI's home, for its login.
  'SSH_AUTH_SOCK', 'CODEX_HOME',
  // How this box reaches the network and whose certificates it trusts: the worker talks to the agent service over
  // HTTPS. The real-server tests pass the same names to the server they start.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  // What Python and the tools need to start on Windows, where PhysAg3D's own example controller runs.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
] as const

/** The child's whole environment: the allowlisted names that are set, and nothing else. */
export function childEnv(env: EnvReader = processEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of CHILD_ENV_NAMES) {
    const value = env(name)
    if (value) out[name] = value
  }
  return out
}

// ── The three steps ─────────────────────────────────────────────────────────

/** `execute.py prepare`: copy the image into a new, empty case folder. No model call. */
export function buildPrepareArgs(script: string, imagePath: string, configPath: string, caseDir: string): string[] {
  return [script, 'prepare', '--image', imagePath, '--config', configPath, '--out', caseDir]
}

/** `execute.py plan`: print the command `run` will start. No model call. */
export function buildPlanArgs(script: string, caseDir: string): string[] {
  return [script, 'plan', caseDir]
}

/** `execute.py run`: start the agent worker. This is the step that sends the image. */
export function buildRunArgs(script: string, caseDir: string): string[] {
  return [script, 'run', caseDir]
}

/** PhysAg3D's case budget when its config sets none: `max_case_active_seconds`, 10800 s. */
export const DEFAULT_CASE_BUDGET_S = 10_800

/**
 * How much longer than PhysAg3D's budget the server waits for `run`. Before the worker starts, `run` checks the
 * environment (`doctor --native`, up to 120 s, and checks of 30 s each) and the login (30 s); after the budget it stops
 * the worker and waits 30 s for it. Fifteen minutes covers that with room. Untuned.
 */
export const RUN_MARGIN_MS = 15 * 60 * 1000

/** prepare and plan check and copy files and print JSON. Ten minutes is a hang. Untuned. */
export const STEP_DEADLINE_MS = 10 * 60 * 1000

/** The case budget in seconds from a case's runtime.json, by PhysAg3D's own rule: a whole number above 0, else 10800. */
export function caseBudgetSeconds(runtime: unknown): number {
  const value = runtime && typeof runtime === 'object'
    ? (runtime as Record<string, unknown>)['max_case_active_seconds']
    : undefined
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_CASE_BUDGET_S
}

/** The server's deadline for `run`: the case budget plus the margin, held to the longest timer (a longer one fires at once). */
export function runDeadlineMs(budgetSeconds: number): number {
  return Math.min(budgetSeconds * 1000 + RUN_MARGIN_MS, MAX_TIMER_MS)
}

// ── The case folder ─────────────────────────────────────────────────────────

/**
 * How far a case folder got. `'new'`: absent or empty, ready for prepare. `'prepared'`: prepare wrote identity.json and
 * run never wrote execution.json, so the worker never started. `'attempted'`: execution.json exists, so the worker may
 * have started, and PhysAg3D does not run the case again. `'unknown'`: something else is there.
 */
export type CaseState = 'new' | 'prepared' | 'attempted' | 'unknown'

export async function inspectCase(caseDir: string): Promise<CaseState> {
  let info: Stats
  try {
    info = await fs.lstat(caseDir)
  } catch (err) {
    return isNotFound(err) ? 'new' : 'unknown'
  }
  if (!info.isDirectory()) return 'unknown'
  const names = new Set<string>()
  for (const entry of await fs.readdir(caseDir, { withFileTypes: true })) names.add(entry.name)
  if (names.size === 0) return 'new'
  if (names.has('execution.json')) return 'attempted'
  if (names.has('identity.json')) return 'prepared'
  return 'unknown'
}

/** Why a file delivery.json names was not used. */
export type CaseFileProblem = 'not listed' | 'absent' | 'outside the case folder' | 'not a file'

/**
 * A file delivery.json names, resolved inside the case folder, or why not. The agent wrote the path: it is resolved
 * against the case folder and both are taken to their real paths, so `..`, an absolute path elsewhere and a link out of
 * the folder are all refused, as is the folder itself.
 */
export async function resolveCaseFile(
  caseDir: string,
  listed: string | undefined,
): Promise<{ ok: true; path: string } | { ok: false; problem: CaseFileProblem }> {
  if (!listed) return { ok: false, problem: 'not listed' }
  if (listed.includes('\u0000')) return { ok: false, problem: 'outside the case folder' }
  let root: string
  let real: string
  try {
    root = await fs.realpath(caseDir)
    real = await fs.realpath(isAbsolute(listed) ? listed : join(root, listed))
  } catch {
    return { ok: false, problem: 'absent' }
  }
  const rel = relative(root, real)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, problem: 'outside the case folder' }
  }
  const info = await fs.stat(real).catch(() => null)
  if (!info?.isFile()) return { ok: false, problem: 'not a file' }
  return { ok: true, path: real }
}

// ── delivery.json ───────────────────────────────────────────────────────────

/** The path fields of PhysAg3D's delivery contract (method/WORKER_PROMPT.md, "Artifact contract"). */
export const DELIVERY_PATH_KEYS = [
  'model', 'blend', 'simulator', 'video', 'native_render', 'refined_render', 'page', 'physics_report',
] as const
export type DeliveryPathKey = typeof DELIVERY_PATH_KEYS[number]

/** What delivery.json says, read field by field. Text is trimmed and capped; anything of the wrong type is null. */
export interface PhysAg3DDelivery {
  title: string | null
  /** `delivered`, `delivered_with_limitations`, `native_only`, `blocked` or `failed`, verbatim. */
  status: string | null
  /** `simulated_replay`, `kinematic_parameter_animation` or `static_only`, verbatim. */
  motionKind: string | null
  /** `bound_motion_verified`, `partial` or `static_only`, verbatim. */
  interactionStatus: string | null
  /** `passed`, `failed`, `partial` or `not_tested`, verbatim. */
  physicsStatus: string | null
  limitations: string[]
  /** Present when status is `blocked`: what stopped the run. */
  blocker: string | null
  repairRounds: number | null
  acceptancePasses: number | null
  /** The paths as delivery.json gave them, relative to the case folder. Checked by `resolveCaseFile` before any use. */
  paths: Partial<Record<DeliveryPathKey, string>>
}

/**
 * How far a delivery got, from PhysAg3D's own `status`: `delivered` is complete, `delivered_with_limitations` and
 * `native_only` are partial, and `blocked`, `failed`, a status the contract does not define or none at all is failed.
 * The worker's exit says nothing about the asset (PhysAg3D's README), so it is not read here.
 */
export type DeliveryOutcome = 'complete' | 'partial' | 'failed'

export function deliveryOutcome(status: string | null): DeliveryOutcome {
  if (status === 'delivered') return 'complete'
  if (status === 'delivered_with_limitations' || status === 'native_only') return 'partial'
  return 'failed'
}

const MAX_TEXT = 300
const MAX_VERDICT = 64
const MAX_LIMITATIONS = 20
const MAX_PATH = 1024

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!clean) return null
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Parse delivery.json. Never throws; a file that is not a JSON object is a reason, not an exception. */
export function parseDelivery(raw: string): { ok: true; delivery: PhysAg3DDelivery } | { ok: false; reason: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'delivery.json is not JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'delivery.json is not a JSON object' }
  }
  const d = parsed as Record<string, unknown>
  const paths: Partial<Record<DeliveryPathKey, string>> = {}
  for (const key of DELIVERY_PATH_KEYS) {
    const value = d[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH) paths[key] = value
  }
  const listed = Array.isArray(d['limitations']) ? d['limitations'] : [d['limitations']]
  const all = listed.map((entry) => text(entry, MAX_TEXT)).filter((entry): entry is string => entry !== null)
  const limitations = all.length > MAX_LIMITATIONS
    ? [...all.slice(0, MAX_LIMITATIONS), `… and ${all.length - MAX_LIMITATIONS} more in the case folder's delivery.json`]
    : all
  return {
    ok: true,
    delivery: {
      title: text(d['title'], MAX_TEXT),
      status: text(d['status'], MAX_VERDICT),
      motionKind: text(d['motion_kind'], MAX_VERDICT),
      interactionStatus: text(d['interaction_status'], MAX_VERDICT),
      physicsStatus: text(d['physics_status'], MAX_VERDICT),
      limitations,
      blocker: text(d['blocker'], MAX_TEXT),
      repairRounds: count(d['repair_rounds']),
      acceptancePasses: count(d['acceptance_passes']),
      paths,
    },
  }
}

/** One sentence for the job's result: the outcome, with PhysAg3D's three verdicts verbatim so none is read into it. */
export function deliveryResultText(delivery: PhysAg3DDelivery, outcome: DeliveryOutcome): string {
  const name = delivery.title ? `"${delivery.title}"` : 'the asset'
  const verdicts = `motion ${delivery.motionKind ?? 'not stated'}, interaction ${delivery.interactionStatus ?? 'not stated'}, ` +
    `physics ${delivery.physicsStatus ?? 'not stated'}`
  const limits = delivery.limitations.length > 0
    ? ` ${delivery.limitations.length} limitation(s) are listed in the delivery report.`
    : ''
  if (outcome === 'complete') return `PhysAg3D delivered ${name} (${verdicts}).${limits}`
  if (outcome === 'partial') return `PhysAg3D delivered ${name} as ${delivery.status} (${verdicts}).${limits}`
  const blocker = delivery.blocker ? `: ${delivery.blocker}` : ''
  return `PhysAg3D did not deliver ${name} (status ${delivery.status ?? 'missing'}${blocker}).${limits}`
}

/** The delivery report the server writes beside the GLB: what it read, and what it did with it. No paths. */
export interface PhysAg3DReport {
  schemaVersion: 1
  tool: 'physag3d'
  assetId: string
  writtenAt: string
  outcome: DeliveryOutcome
  /** How PhysAg3D's worker ended (execution.json). Not the asset's verdict: that is `delivery`. */
  execution: { state: string | null; exitCode: number | null }
  delivery: Omit<PhysAg3DDelivery, 'paths'> | null
  /** Why `delivery` is null. */
  deliveryError?: string
  glb: { landed: true; bytes: number } | { landed: false; reason: string }
  /** For each output delivery.json lists, whether that file is in the case folder. */
  caseOutputs: Partial<Record<DeliveryPathKey, 'present' | CaseFileProblem>>
}

// ── Running it ──────────────────────────────────────────────────────────────

export interface PhysAg3DSpawnResult {
  code: number
  stdout: string
  stderr: string
  /** Set when the deadline stopped the child (run_with_deadline.ts). */
  timeoutReason?: string | null
}

/** Runs `bin args` with exactly `env` as its environment and waits at most `deadlineMs`. */
export type PhysAg3DSpawn = (
  bin: string,
  args: string[],
  env: Record<string, string>,
  deadlineMs: number,
) => Promise<PhysAg3DSpawnResult>

export interface PhysAg3DRunOptions {
  /**
   * The image: a keyframe the server holds, by the names it keeps it under. The session folder is spelled as the
   * server spells it (`sessionsDir/sessionId`), because that string keys the session's write queue, which the copy
   * shares with every removal of the session (server/wp-a-keyframes.ts, server/session_deletion.ts).
   */
  keyframe: { sessionsDir: string; sessionId: string; file: string }
  /** The scan's asset folder, where the two landed files go, and by default the case folder. */
  assetDir: string
  /** The job id. It names the landed files and the case folder. */
  assetId: string
  /** The largest GLB the server will land: the scan upload cap, UPLOAD_MAX_SCAN_BYTES, in main.ts. */
  maxGlbBytes: number
  /** PhysAg3D checkout. Falls back to env PHYSAG3D_DIR. */
  checkoutDir?: string
  /** Interpreter for execute.py. Falls back to env PHYSAG3D_PYTHON, then python3 on PATH. */
  python?: string
  /** Runtime config. Falls back to env PHYSAG3D_CONFIG. */
  configPath?: string
  /** Where case folders go. Falls back to env PHYSAG3D_RUNS_DIR, then the asset folder. */
  runsDir?: string
  /** Stage callback. The runner commits it to the job. */
  onProgress?: (fraction: number, stage: string) => void
  /** Where the plan and the start of a run are logged. Default: the server log. */
  log?: (line: string) => void
  /** Injected for tests: the environment the knobs and the child's allowlist are read from. */
  env?: EnvReader
  /** Injected for tests: stands in for execute.py. */
  _spawn?: PhysAg3DSpawn
  /**
   * Stops the run when it fires: the job pump passes its job's signal, so a job
   * it has given up on does not leave its child running (F-27).
   */
  signal?: AbortSignal
}

export interface PhysAg3DResult {
  status: 'ok' | 'skipped' | 'error'
  skippedReason?: string
  remediation?: string
  error?: string
  /** True once PhysAg3D's run may have started the worker: from then on the image may have left the box. */
  runAttempted: boolean
  /** The case folder's name: the job id. */
  caseId?: string
  delivery?: PhysAg3DDelivery
  outcome?: DeliveryOutcome
  /** Absolute paths of the landed files. */
  glbPath?: string
  glbBytes?: number
  reportPath?: string
  /** Trailing stderr of the last step, for the operator. */
  log: string
}

const SETUP_REMEDIATION =
  'Set PHYSAG3D_DIR to a PhysAg3D checkout and PHYSAG3D_CONFIG to its runtime config, and PHYSAG3D_PYTHON to the ' +
  "checkout's venv interpreter when python3 on PATH is older than 3.11. See docs/pipelines/physag3d.md."

/**
 * Make an interactive asset from one image. Never throws: every failure is a `PhysAg3DResult`.
 */
export async function runPhysAg3D(opts: PhysAg3DRunOptions): Promise<PhysAg3DResult> {
  const progress = { runAttempted: false }
  // For the whole run, a deletion of the session's frames is refused rather than run under the worker's feet: the case
  // folder holds a copy of one of them (server/physag3d/asset_files.ts, `removeSessionCaseCopies`).
  const release = holdSessionFrames(opts.keyframe.sessionId)
  try {
    return await runSteps(opts, progress)
  } catch (err) {
    return {
      status: 'error',
      error: `PhysAg3D driver failed: ${err instanceof Error ? err.message : String(err)}`,
      runAttempted: progress.runAttempted,
      log: '',
    }
  } finally {
    release()
  }
}

async function runSteps(opts: PhysAg3DRunOptions, progress: { runAttempted: boolean }): Promise<PhysAg3DResult> {
  const env = opts.env ?? processEnv
  const params = resolveParams(opts, env)
  const log = opts.log ?? ((line: string) => console.log(line))
  const spawn: PhysAg3DSpawn = opts._spawn ??
    ((bin, args, env, deadlineMs) => defaultSpawn(bin, args, env, deadlineMs, opts.signal))
  const skip = (skippedReason: string): PhysAg3DResult => ({
    status: 'skipped',
    skippedReason,
    remediation: SETUP_REMEDIATION,
    runAttempted: false,
    log: '',
  })

  // 1. Configured? Every miss is a skip with a hint, never an error. The reasons name the variable, not the path.
  if (!params.checkoutDir) return skip('PHYSAG3D_DIR is not set')
  if (!params.configPath) return skip('PHYSAG3D_CONFIG is not set')
  const script = join(resolve(params.checkoutDir), 'execute.py')
  if (!(await isFile(script))) return skip('PHYSAG3D_DIR does not hold execute.py')
  const configPath = resolve(params.configPath)
  if (!(await isFile(configPath))) return skip('PHYSAG3D_CONFIG names no file')
  // The shared resolver (server/exec_probe.ts), the one GET /capabilities uses: a bare name is looked up on PATH.
  const pythonLocation = await locateTool(runnerToolLookup('physag3d-python'), { explicit: params.python })
  const python = pythonLocation.found ? pythonLocation.path ?? null : null
  if (!python) return skip('PHYSAG3D_PYTHON (python3 on PATH when unset) is not a runnable interpreter')

  if (!isAssetId(opts.assetId)) {
    return { status: 'error', error: 'an interactive asset is named by its job id, and this is not one', runAttempted: false, log: '' }
  }
  const { sessionsDir, sessionId, file } = opts.keyframe
  const sessionDir = sessionDirPath(sessionsDir, sessionId)
  const keyframePath = keyframeImagePath(sessionsDir, sessionId, file)
  if (!sessionDir || !keyframePath) {
    return { status: 'error', error: 'the keyframe this job names is not one the server keeps', runAttempted: false, log: '' }
  }
  const assetDir = resolve(opts.assetDir)
  const caseDir = caseDirFor(params, assetDir, opts.assetId)
  const caseParent = dirOf(caseDir)
  const imagePath = resolve(keyframePath)
  const childEnvironment = childEnv(env)
  const run = (args: string[], deadlineMs: number) => spawn(python, args, childEnvironment, deadlineMs)
  const fail = (error: string, out?: PhysAg3DSpawnResult): PhysAg3DResult => ({
    status: 'error',
    error,
    runAttempted: progress.runAttempted,
    caseId: opts.assetId,
    log: out ? stderrTail(out.stderr) : '',
  })

  // 2. Where the case is. A requeued job finds the case its first attempt made (see "Never twice" above).
  const state = await inspectCase(caseDir)
  if (state === 'unknown') {
    return fail('The case folder for this job holds something that is not a PhysAg3D case, so nothing was run. Queue a new job.')
  }
  // A case from an earlier attempt has the record written before its prepare. One without gets it now, so that a later
  // deletion of the session's frames finds the copy.
  if (state !== 'new' && !(await isFile(`${caseParent}/${opts.assetId}${CASE_SOURCE_SUFFIX}`))) {
    await writeCaseSource(caseParent, opts.assetId, { sessionId, keyframe: file })
  }
  let runOutput: PhysAg3DSpawnResult | null = null
  if (state === 'attempted') {
    progress.runAttempted = true
  } else {
    if (state === 'new') {
      // In the session's write queue, which every removal of the session waits in too: a removal that got there first
      // has taken the keyframe (so nothing is copied), and one that comes after finds this run holding the session.
      const prepared = await queueKeyframeWrite(sessionDir, async () => {
        // The keyframe can be gone since the request: the retention purge, or a deleted session.
        const image = await fs.lstat(imagePath).catch(() => null)
        if (!image?.isFile() || image.isSymbolicLink()) return null
        await writeCaseSource(caseParent, opts.assetId, { sessionId, keyframe: file })
        return await run(buildPrepareArgs(script, imagePath, configPath, caseDir), STEP_DEADLINE_MS)
      })
      if (!prepared) {
        return fail('The keyframe this job names is not on the server any more (purged, or deleted with its session).')
      }
      if (prepared.code !== 0) return fail(`PhysAg3D prepare ${cliProblem(prepared)}`, prepared)
      opts.onProgress?.(0.4, 'prepared')
    }

    const planned = await run(buildPlanArgs(script, caseDir), STEP_DEADLINE_MS)
    if (planned.code !== 0) return fail(`PhysAg3D plan ${cliProblem(planned)}`, planned)
    const plan = planCommand(planned.stdout)
    log(`[physag3d] ${opts.assetId} plan: ${plan ? JSON.stringify(plan) : planned.stdout.trim()}`)
    opts.onProgress?.(0.45, 'planned')

    const budgetSeconds = caseBudgetSeconds(await readJson(join(caseDir, 'runtime.json')))
    const deadlineMs = runDeadlineMs(budgetSeconds)
    log(
      `[physag3d] ${opts.assetId} run: the image goes to the agent service the runtime config names; ` +
        `budget ${describeBudget(budgetSeconds * 1000)}, stopped after ${describeBudget(deadlineMs)}`,
    )
    opts.onProgress?.(0.5, 'running')
    runOutput = await run(buildRunArgs(script, caseDir), deadlineMs)
    // From here the worker may have started. execution.json, read below, settles whether it did.
    progress.runAttempted = true
  }

  // 3. What the run left. execution.json is written before the worker starts; delivery.json when it delivers.
  const executionPath = join(caseDir, 'execution.json')
  if (!(await isFile(executionPath))) {
    if (runOutput) {
      // PhysAg3D stopped before it started the worker (its checksum, preflight or login check), so the image never left.
      progress.runAttempted = false
      return fail(`PhysAg3D run ${cliProblem(runOutput)}`, runOutput)
    }
    return fail("The case's execution record is not a file, so it was not run again. Queue a new job.")
  }
  const execution = await readJson(executionPath)
  const said = execution && typeof execution === 'object' ? execution as Record<string, unknown> : {}
  const executionRecord = {
    state: text(said['state'], MAX_VERDICT),
    exitCode: typeof said['exit_code'] === 'number' ? said['exit_code'] : null,
  }

  const deliveryRaw = await fs.readFile(join(caseDir, 'delivery.json'), 'utf8').catch(() => null)
  const parsed = deliveryRaw === null ? null : parseDelivery(deliveryRaw)
  if (!parsed?.ok) {
    const why = parsed
      ? parsed.reason
      : runOutput === null
      ? "PhysAg3D's run was already attempted for this case before the server restarted, and it does not resume or " +
        'retry a case. The case left no delivery.json. Queue a new job to try again'
      : runOutput.timeoutReason
      ? `PhysAg3D ${runOutput.timeoutReason} and was stopped, with no delivery.json. Its worker may still be running: ` +
        "the case's execution.json names its process"
      : runOutput.code !== 0
      ? `PhysAg3D's worker started, and then run ${cliProblem(runOutput)}; it left no delivery.json`
      : `PhysAg3D's worker ended (${executionRecord.state ?? 'state not recorded'}) without writing delivery.json`
    const reportPath = await writeReport(assetDir, opts.assetId, {
      outcome: 'failed',
      execution: executionRecord,
      delivery: null,
      deliveryError: why,
      glb: { landed: false, reason: 'no delivery' },
      caseOutputs: {},
    })
    return { ...fail(`${why}.`, runOutput ?? undefined), reportPath }
  }

  // 4. Land what was delivered.
  const delivery = parsed.delivery
  const caseOutputs: PhysAg3DReport['caseOutputs'] = {}
  for (const key of DELIVERY_PATH_KEYS) {
    if (!delivery.paths[key]) continue
    const found = await resolveCaseFile(caseDir, delivery.paths[key])
    caseOutputs[key] = found.ok ? 'present' : found.problem
  }
  let outcome = deliveryOutcome(delivery.status)
  let glb: PhysAg3DReport['glb'] = { landed: false, reason: `not landed: status ${delivery.status ?? 'missing'}` }
  let glbPath: string | undefined
  let landingError: string | undefined
  if (outcome !== 'failed') {
    const model = await resolveCaseFile(caseDir, delivery.paths.model)
    const landed = model.ok
      ? await landGlb(model.path, join(assetDir, `${opts.assetId}.glb`), opts.maxGlbBytes)
      : { ok: false as const, reason: `its model is ${model.problem}` }
    if (landed.ok) {
      glb = { landed: true, bytes: landed.bytes }
      glbPath = join(assetDir, `${opts.assetId}.glb`)
    } else {
      glb = { landed: false, reason: landed.reason }
      landingError = `delivery.json says ${delivery.status}, but ${landed.reason}, so no GLB was landed`
      outcome = 'failed'
    }
  }
  const { paths: _paths, ...shown } = delivery
  const reportPath = await writeReport(assetDir, opts.assetId, {
    outcome,
    execution: executionRecord,
    delivery: shown,
    glb,
    caseOutputs,
  })

  if (outcome === 'failed') {
    return {
      ...fail(landingError ? `PhysAg3D: ${landingError}.` : deliveryResultText(delivery, outcome), runOutput ?? undefined),
      delivery,
      outcome,
      reportPath,
    }
  }
  return {
    status: 'ok',
    runAttempted: true,
    caseId: opts.assetId,
    delivery,
    outcome,
    glbPath,
    glbBytes: glb.landed ? glb.bytes : undefined,
    reportPath,
    log: runOutput ? stderrTail(runOutput.stderr) : '',
  }
}

/**
 * What a failed execute.py step said: its `{"error", "message"}` line on stderr when it printed one (a refusal it
 * handled), else the tail of its stderr (a traceback, such as a Python older than 3.11 gives).
 */
export function cliProblem(out: PhysAg3DSpawnResult): string {
  if (out.timeoutReason) return `${out.timeoutReason} and was stopped`
  const lines = out.stderr.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const said = JSON.parse(lines[i]) as { error?: unknown; message?: unknown } | null
      if (said && typeof said.message === 'string') {
        const message = typeof said.error === 'string' ? `${said.error}: ${said.message}` : said.message
        return `failed: ${message.length > 600 ? `${message.slice(0, 599)}…` : message}`
      }
    } catch {
      // Not the JSON line.
    }
  }
  const tail = stderrTail(out.stderr)
  return tail ? `exited ${out.code}: ${tail}` : `exited ${out.code}`
}

/** The `command` array `plan` prints, or null when its output is not that JSON. */
export function planCommand(stdout: string): string[] | null {
  try {
    const said = JSON.parse(stdout) as { command?: unknown } | null
    const command = said?.command
    return Array.isArray(command) && command.every((part) => typeof part === 'string') ? command : null
  } catch {
    return null
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await fs.stat(path).catch(() => null))?.isFile() === true
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 'glTF', the first four bytes of every binary glTF file. */
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]

async function startsWithGlbMagic(path: string): Promise<boolean> {
  let file: FileHandle | undefined
  try {
    file = await fs.open(path, 'r')
    const head = new Uint8Array(GLB_MAGIC.length)
    let got = 0
    while (got < head.length) {
      const { bytesRead } = await file.read(head, got, head.length - got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return got === head.length && GLB_MAGIC.every((byte, i) => head[i] === byte)
  } catch {
    return false
  } finally {
    await file?.close()
  }
}

/**
 * Copy the refined GLB to `dest`. The copy is judged, not the agent's file, so nothing can change what was checked: its
 * size against the cap and its first bytes against the glTF magic. A copy that fails either is removed.
 */
async function landGlb(
  source: string,
  dest: string,
  maxBytes: number,
): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  if (!/\.glb$/i.test(source)) return { ok: false, reason: 'its model is not a .glb file' }
  const size = (await fs.stat(source)).size
  if (size > maxBytes) return { ok: false, reason: `its model is ${size} bytes, over the ${maxBytes}-byte cap` }
  await fs.mkdir(dirOf(dest), { recursive: true })
  const partial = `${dest}.part`
  await fs.copyFile(source, partial)
  const copied = (await fs.stat(partial)).size
  const magic = await startsWithGlbMagic(partial)
  if (copied > maxBytes || !magic) {
    await fs.rm(partial).catch(() => undefined)
    return { ok: false, reason: magic ? `its model is over the ${maxBytes}-byte cap` : 'its model is not a binary glTF file' }
  }
  await fs.rename(partial, dest)
  return { ok: true, bytes: copied }
}

async function writeReport(
  assetDir: string,
  assetId: string,
  body: Omit<PhysAg3DReport, 'schemaVersion' | 'tool' | 'assetId' | 'writtenAt'>,
): Promise<string> {
  const report: PhysAg3DReport = { schemaVersion: 1, tool: 'physag3d', assetId, writtenAt: new Date().toISOString(), ...body }
  const path = join(assetDir, `${assetId}.delivery.json`)
  await fs.mkdir(assetDir, { recursive: true })
  await fs.writeFile(`${path}.part`, JSON.stringify(report, null, 2))
  await fs.rename(`${path}.part`, path)
  return path
}

function dirOf(path: string): string {
  return resolve(path, '..')
}

async function defaultSpawn(
  bin: string,
  args: string[],
  env: Record<string, string>,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<PhysAg3DSpawnResult> {
  const output = await runWithDeadline(
    bin,
    { args, env, clearEnv: true, stdin: 'null', stdout: 'piped', stderr: 'piped' },
    deadlineMs,
    KILL_GRACE_MS,
    signal,
  )
  const decoder = new TextDecoder()
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    timeoutReason: output.timeoutReason,
  }
}
