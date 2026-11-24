/**
 * Cross-platform "can this path actually be executed?" probe.
 *
 * Extracted from the byte-identical copies that lived in `splat_train.ts`
 * and `splat_detect.ts` (ADR 0001: reuse, don't duplicate — two copies of a
 * predicate is exactly the drift that rule exists to stop; they had already
 * diverged in their comments).
 *
 * Why it isn't just a mode-bit mask: on Windows there is no POSIX exec bit.
 * `stat()` there reports a *synthesized* numeric mode — `0o100666` for
 * an ordinary file, exec bits always clear — rather than the `null` the
 * original code's "unsupported platform" fallback was written against. So
 * masking `mode & 0o111` returned `false` for every binary on Windows,
 * including the runtime's own executable, and every caller concluded its worker was
 * missing. That silently pushed `splat_train`/`splat_detect` down their
 * "skipped" branch, which is why 9 tests failed on Windows dev boxes while
 * passing in Linux CI.
 */
import { REPO_ROOT } from './repo-root.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isNotFound } from './fs_util.ts'

/**
 * Platform string, injectable so both branches are testable from either OS. Windows is `'windows'` here,
 * where Node's `process.platform` says `'win32'`: see `hostPlatform`.
 */
export type ExecPlatform = 'darwin' | 'linux' | 'android' | 'windows' | 'freebsd' | 'netbsd' | 'aix' | 'solaris' | 'illumos'

/** The host's platform, in `ExecPlatform`'s words. */
export function hostPlatform(): ExecPlatform {
  return process.platform === 'win32' ? 'windows' : (process.platform as ExecPlatform)
}

/**
 * The host's CPU, in the words the capability report uses: `x86_64` and `aarch64`, where Node says `x64`
 * and `arm64`. Other CPUs keep Node's name.
 */
export function hostArch(): string {
  return process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
}

/**
 * True when `bin` exists, is a regular file, and — on platforms that model
 * it — carries an executable bit.
 *
 * `platform` defaults to the host and exists so tests can exercise the
 * Windows and POSIX branches regardless of where they run.
 */
export async function isRunnable(
  bin: string,
  platform: ExecPlatform = hostPlatform(),
): Promise<boolean> {
  try {
    const info = await fs.stat(bin)
    if (!info.isFile()) return false

    // Windows: no exec-bit concept. Existence of a regular file is the only
    // meaningful signal, so don't mask a mode that is synthesized anyway.
    if (platform === 'windows') return true

    // POSIX: any exec bit (user/group/other) counts.
    if (typeof info.mode === 'number') return (info.mode & 0o111) !== 0

    // mode genuinely unavailable — fall back to "it exists".
    return true
  } catch {
    return false
  }
}

/** Injection seams for `whichPath`, so both platform branches run from either OS. */
export interface WhichOptions {
  platform?: ExecPlatform
  /** PATH contents. Defaults to the host's; pass a literal to test the other OS. */
  path?: string
  /** Windows PATHEXT contents. Ignored on POSIX. */
  pathExt?: string
  /** Replaces the filesystem probe, so a table of fake paths can stand in. */
  _isRunnable?: (bin: string, platform: ExecPlatform) => Promise<boolean>
}

/** What `cmd.exe` assumes when PATHEXT is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Resolve `bin` to the absolute path PATH would run, or null.
 *
 * Why this and not a spawn of `<bin> -h` (what colmap_poses.ts's PATH probe did before
 * it resolved through `locateTool` below): that answers
 * "does `colmap -h` exit 0", which is enough to decide whether to spawn but
 * throws away the answer to the question that actually cost hours here —
 * *which* binary, at *which* path. A capability report whose only output is a
 * boolean reproduces the failure it exists to prevent (COLMAP was installed
 * the whole time; `which colmap` said no because it lives in a micromamba env
 * that is not on PATH). Spawning is also the wrong primitive for a report that
 * probes eight tools: `-h` is not a universal flag, and a tool that opens a
 * window or blocks on a device would hang the probe.
 *
 * PATH entries are used verbatim. Every real PATH holds absolute directories,
 * and rewriting a relative one against the server's cwd would report a
 * resolution nothing else could reproduce.
 */
export async function whichPath(bin: string, opts: WhichOptions = {}): Promise<string | null> {
  const platform = opts.platform ?? hostPlatform()
  const probe = opts._isRunnable ?? isRunnable
  const dirSep = platform === 'windows' ? '\\' : '/'

  // A name carrying a separator is already a path; PATH is not consulted for
  // it, the same way every shell treats `./foo` and `foo` differently.
  if (bin.includes('/') || (platform === 'windows' && bin.includes('\\'))) {
    return (await probe(bin, platform)) ? bin : null
  }

  const raw = opts.path ?? envOr('PATH', '')
  const exts = extensionCandidates(bin, platform, opts.pathExt)
  for (const dir of raw.split(platform === 'windows' ? ';' : ':')) {
    // An empty PATH entry means "the current directory" on POSIX. Skipped on
    // purpose: a capability report that resolved a tool out of whatever
    // directory the server happened to start in would be reporting something
    // no one else can reproduce.
    if (dir === '') continue
    const base = dir.endsWith(dirSep) ? dir.slice(0, -1) : dir
    for (const ext of exts) {
      const candidate = `${base}${dirSep}${bin}${ext}`
      if (await probe(candidate, platform)) return candidate
    }
  }
  return null
}

/**
 * Suffixes to try for a bare name.
 *
 * POSIX has none. On Windows the PATHEXT suffixes come *first* and the bare
 * name last, because `isRunnable` on Windows can only ask "is this a regular
 * file" — so a stray extensionless `colmap` sitting next to the real
 * `colmap.exe` would otherwise win and then fail to launch.
 */
function extensionCandidates(bin: string, platform: ExecPlatform, pathExt?: string): string[] {
  if (platform !== 'windows') return ['']
  if (bin.includes('.')) return ['']
  const exts = (pathExt ?? envOr('PATHEXT', DEFAULT_PATHEXT))
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  return [...exts, '']
}

/** The environment's value of `name`, or `fallback` when it is unset. */
function envOr(name: string, fallback: string): string {
  return readEnv(name) ?? fallback
}

// ── Tool resolution: one convention, one table ──────────────────────────────
//
// Every runner and the capability report (server/capabilities.ts) resolve their
// external tools here, so the report and the job cannot disagree about where a
// tool is. They used to: the report looked on PATH for Brush and Spirula, the
// runners did not, and a trainer the report called "ok" made its job skip.
//
// The convention is docs/operations/PLATFORM_SUPPORT.md's: an explicit option or
// env var always wins and is only probed, then PATH, then the documented no-sudo
// install path. An env var that names nothing is reported missing. It is never
// replaced by a fallback, because an operator whose override has a typo needs
// to be told.

/** How a tool is looked for: an executable, an interpreter, a checkout dir, a data file, or either of the last two. */
export type ToolKind = 'binary' | 'python' | 'dir' | 'file' | 'path'

/** Which of the three resolution steps produced the path. An explicit runner option counts as the env var. */
export type ResolvedVia = 'env' | 'path' | 'fallback'

/** One row of the resolution table: where a tool is looked for, and what fixes its absence. */
export interface ToolLookup {
  id: RunnerToolId
  kind: ToolKind
  /** The env var a runner reads. Never a new one. */
  envVar?: string
  /** Bare name to look for on PATH. Absent for things PATH never holds. */
  pathName?: string
  /** Documented install locations, in the order they are tried. */
  fallbacks: string[]
  /**
   * What fixes a missing tool, in the voice of a skip. The capability report
   * prints it and the runner's skip carries it, so the two say the same thing.
   */
  remediation: string
}

export type RunnerToolId =
  | 'ffmpeg'
  | 'ffprobe'
  | 'colmap'
  | 'brush'
  | 'spirula'
  | 'panoptic-python'
  | 'panoptic-worker'
  | 'splat-detect-python'
  | 'splat-detect-dir'
  | 'lingbot-map-python'
  | 'lingbot-map-model'
  | 'physag3d-python'
  | 'physag3d-dir'
  | 'physag3d-config'
  | 'splat-finish-node'
  | 'splat-transform-cli'
  | 'sensenova-bash'
  | 'sensenova-dir'
  | 'sensenova-model'

export type EnvReader = (name: string) => string | undefined

/** The server's environment, as an injectable reader. */
export const readEnv: EnvReader = (name) => process.env[name]

/**
 * Home directory for expanding the documented fallback paths.
 *
 * `HOME ?? '~'` is the idiom the runners used; USERPROFILE is added because the
 * capability report must not silently mis-describe a Windows box, where `~/...`
 * resolves to nothing at all.
 */
export function resolveHome(env: EnvReader = readEnv): string {
  return env('HOME') ?? env('USERPROFILE') ?? '~'
}

/** The checkout this server runs from, as a filesystem path with a trailing separator. */
function repoRootPath(): string {
  // fileURLToPath, not `.pathname`: the latter yields "/C:/…" on Windows.
  return fileURLToPath(REPO_ROOT)
}

/**
 * Every external tool a runner resolves, as data. The capability report adds
 * labels, version probes and the stages that need each one; the runners use the
 * rows as they are.
 */
export function runnerToolLookups(
  home: string = resolveHome(),
  repoRoot: string = repoRootPath(),
): Record<RunnerToolId, ToolLookup> {
  const root = repoRoot.endsWith('/') || repoRoot.endsWith('\\') ? repoRoot : `${repoRoot}/`
  return {
    ffmpeg: {
      id: 'ffmpeg',
      kind: 'binary',
      // No env var on purpose: scripts/ingest-video.mjs spawns the bare name, so an
      // override here would describe a resolution the ingest path cannot make.
      pathName: 'ffmpeg',
      fallbacks: [],
      remediation:
        'Install ffmpeg (`apt install ffmpeg` / `brew install ffmpeg`), or drop a static build ' +
        '(https://johnvansickle.com/ffmpeg/) somewhere already on PATH, e.g. ~/.local/bin. ' +
        'Already installed? Restart the server — it resolves ffmpeg from the PATH it started with.',
    },
    ffprobe: {
      id: 'ffprobe',
      kind: 'binary',
      pathName: 'ffprobe',
      fallbacks: [],
      remediation:
        'ffprobe ships with ffmpeg — install the full package rather than a single binary, ' +
        'or put the ffprobe from the same static build on PATH beside ffmpeg.',
    },
    colmap: {
      id: 'colmap',
      kind: 'binary',
      envVar: 'COLMAP_BIN',
      pathName: 'colmap',
      // The sudo-less micromamba env docs/operations/COLMAP_SETUP.md creates, which is not on PATH unless activated.
      fallbacks: [`${home}/.local/micromamba/envs/colmap/bin/colmap`],
      remediation: 'Install COLMAP (`brew install colmap` / `apt install colmap`) or set COLMAP_BIN.',
    },
    brush: {
      id: 'brush',
      kind: 'binary',
      envVar: 'BRUSH_BIN',
      pathName: 'brush-cli',
      fallbacks: [`${home}/brush/target/release/brush-cli`],
      // Names the command: `--bin brush-cli`, the obvious guess, fails on Brush's workspace; it needs `-p`.
      remediation:
        'Build Brush (`git clone https://github.com/ArthurBrussee/brush ~/brush && ' +
        'cd ~/brush && cargo build --release -p brush-cli`) or set BRUSH_BIN to an existing brush-cli. ' +
        'Needs a Vulkan/Metal-capable GPU; see docs/pipelines/splat-train.md — Setup.',
    },
    spirula: {
      id: 'spirula',
      kind: 'binary',
      envVar: 'SPIRULA_BIN',
      pathName: 'spirula',
      fallbacks: [`${home}/opt/spirula/spirula`, `${home}/.local/bin/spirula`, '/usr/local/bin/spirula'],
      // The download, never a build: this repo may only invoke a prebuilt Spirula as a separate process.
      remediation:
        'Download a prebuilt Spirula Studio release (https://github.com/harry7557558/spirula-studio/releases — ' +
        'the ubuntu-vulkan-x86_64 zip), unzip it to ~/opt/spirula/spirula, and `chmod +x` it; ' +
        'or set SPIRULA_BIN to an existing binary. Needs a Vulkan-capable GPU. ' +
        'SPLAT_BACKEND=brush switches back to Brush; see docs/pipelines/splat-train.md — Backends.',
    },
    'panoptic-python': {
      id: 'panoptic-python',
      kind: 'python',
      envVar: 'PANOPTIC_PYTHON',
      fallbacks: [`${home}/.venvs/panoptic/bin/python`],
      remediation: 'Create the venv and set PANOPTIC_PYTHON (see docs/pipelines/panoptic-scan.md — Setup).',
    },
    'panoptic-worker': {
      id: 'panoptic-worker',
      kind: 'dir',
      envVar: 'PANOPTIC_DIR',
      fallbacks: [`${home}/panoptic`],
      remediation: 'Install the worker and set PANOPTIC_DIR (see docs/pipelines/panoptic-scan.md — Setup).',
    },
    'splat-detect-python': {
      id: 'splat-detect-python',
      kind: 'python',
      envVar: 'SPLAT_DETECT_PYTHON',
      fallbacks: [`${home}/.venvs/splat-analyzer/bin/python`],
      remediation: 'Create the venv and set SPLAT_DETECT_PYTHON (see docs/splat-detect.md — Setup).',
    },
    'splat-detect-dir': {
      id: 'splat-detect-dir',
      kind: 'dir',
      envVar: 'SPLAT_DETECT_DIR',
      fallbacks: [`${home}/splat_analyzer`],
      remediation: 'Clone splat_analyzer and set SPLAT_DETECT_DIR (see docs/splat-detect.md — Setup).',
    },
    'lingbot-map-python': {
      id: 'lingbot-map-python',
      kind: 'python',
      envVar: 'LINGBOT_MAP_PYTHON',
      // The bare default is resolved from PATH, and is why the report's torch block
      // matters: ADR 0007 measured a bare python3 with no torch.
      pathName: 'python3',
      fallbacks: [],
      remediation:
        'Point LINGBOT_MAP_PYTHON at an interpreter with torch installed ' +
        '(see README — `LingBot-Map server processing`).',
    },
    'lingbot-map-model': {
      id: 'lingbot-map-model',
      kind: 'file',
      envVar: 'LINGBOT_MAP_MODEL_PATH',
      // No documented default path: the runner passes '' and the worker skips.
      fallbacks: [],
      remediation:
        'Download the checkpoint and set LINGBOT_MAP_MODEL_PATH (see README — `LingBot-Map server processing`).',
    },
    'physag3d-python': {
      id: 'physag3d-python',
      // 'binary', not 'python': execute.py needs only the standard library, so a torch probe would report a
      // missing torch that nothing here wants.
      kind: 'binary',
      envVar: 'PHYSAG3D_PYTHON',
      pathName: 'python3',
      fallbacks: [],
      remediation:
        "Point PHYSAG3D_PYTHON at the PhysAg3D checkout's venv interpreter, Python 3.11 or later " +
        '(see docs/pipelines/physag3d.md — Setup).',
    },
    'physag3d-dir': {
      id: 'physag3d-dir',
      kind: 'dir',
      envVar: 'PHYSAG3D_DIR',
      // No default: the job runs only where an operator has named a checkout, because a run sends the image off the box.
      fallbacks: [],
      remediation:
        'Clone PhysAg3D (https://github.com/Supra-3D/PhysAg3D) and set PHYSAG3D_DIR to the checkout ' +
        '(see docs/pipelines/physag3d.md — Setup).',
    },
    'physag3d-config': {
      id: 'physag3d-config',
      kind: 'file',
      envVar: 'PHYSAG3D_CONFIG',
      fallbacks: [],
      remediation:
        "Write a runtime config from the checkout's examples/ and set PHYSAG3D_CONFIG to it " +
        '(see docs/pipelines/physag3d.md — Setup).',
    },
    'splat-finish-node': {
      id: 'splat-finish-node',
      kind: 'binary',
      envVar: 'SPLAT_FINISH_NODE',
      pathName: 'node',
      fallbacks: [],
      remediation:
        'Install Node.js 22 or later (the `npm ci` that installs splat-transform needs it too), ' +
        'or set SPLAT_FINISH_NODE to a node binary.',
    },
    'splat-transform-cli': {
      id: 'splat-transform-cli',
      kind: 'file',
      envVar: 'SPLAT_TRANSFORM_CLI',
      // The devDependency's own CLI, in this checkout's node_modules.
      fallbacks: [`${root}node_modules/@playcanvas/splat-transform/bin/cli.mjs`],
      remediation: 'npm install (or set SPLAT_TRANSFORM_CLI to a @playcanvas/splat-transform bin/cli.mjs).',
    },
    'sensenova-bash': {
      id: 'sensenova-bash',
      kind: 'binary',
      envVar: 'SENSENOVA_BASH',
      pathName: 'bash',
      fallbacks: [],
      remediation:
        'SenseNova runs its launcher with bash. Install it, or set SENSENOVA_BASH to its full path ' +
        '(wsl.exe on a Windows host).',
    },
    'sensenova-dir': {
      id: 'sensenova-dir',
      kind: 'dir',
      envVar: 'SENSENOVA_DIR',
      fallbacks: [],
      remediation: 'Set SENSENOVA_DIR and SENSENOVA_MODEL_PATH, then install the SenseNova-Vision runtime.',
    },
    'sensenova-model': {
      id: 'sensenova-model',
      // A checkpoint directory or a single file: either is a model path.
      kind: 'path',
      envVar: 'SENSENOVA_MODEL_PATH',
      fallbacks: [],
      remediation: 'Set SENSENOVA_DIR and SENSENOVA_MODEL_PATH, then install the SenseNova-Vision runtime.',
    },
  }
}

/** One tool's row, for a runner that needs only its own. */
export function runnerToolLookup(id: RunnerToolId, home: string = resolveHome()): ToolLookup {
  return runnerToolLookups(home)[id]
}

/** Where a tool was found, or every place it was looked for. */
export interface ToolLocation {
  found: boolean
  /** The path that answered, or the explicit value that did not. Absent when nothing was named or found. */
  path?: string
  via?: ResolvedVia
  /** Every candidate tried, in order. A false negative has to be debuggable. */
  searched: string[]
}

/** Injection seams for `locateTool`. Every one defaults to the host. */
export interface LocateDeps {
  platform?: ExecPlatform
  env?: EnvReader
  /** A runner's own option (`opts.brushBin`), which wins over the env var. */
  explicit?: string
  isRunnable?: (bin: string, platform: ExecPlatform) => Promise<boolean>
  which?: (bin: string, platform: ExecPlatform) => Promise<string | null>
  isDir?: (path: string) => Promise<boolean>
  isFile?: (path: string) => Promise<boolean>
  /**
   * A second check on a PATH hit, for a tool whose presence on PATH is not proof
   * it runs (COLMAP answers `-h`). Returning false moves on to the fallbacks.
   */
  acceptPathHit?: (path: string) => Promise<boolean>
}

/**
 * Resolve one tool: explicit option or env var, then PATH, then the documented
 * install paths. Never throws.
 *
 * An explicit executable with no separator in it is a name, looked up on PATH
 * the way a shell (and the runner's spawn) would. One with a separator is a path
 * and is only probed.
 */
export async function locateTool(lookup: ToolLookup, deps: LocateDeps = {}): Promise<ToolLocation> {
  const platform = deps.platform ?? hostPlatform()
  const env = deps.env ?? readEnv
  const probeRunnable = deps.isRunnable ?? isRunnable
  const which = deps.which ?? ((bin: string, p: ExecPlatform) => whichPath(bin, { platform: p }))
  const isDir = deps.isDir ?? ((p: string) => statIs(p, 'dir'))
  const isFile = deps.isFile ?? ((p: string) => statIs(p, 'file'))
  const executable = lookup.kind === 'binary' || lookup.kind === 'python'
  const searched: string[] = []

  const exists = async (candidate: string): Promise<boolean> => {
    searched.push(candidate)
    if (lookup.kind === 'dir') return await isDir(candidate)
    if (lookup.kind === 'file') return await isFile(candidate)
    if (lookup.kind === 'path') return (await isFile(candidate)) || (await isDir(candidate))
    return await probeRunnable(candidate, platform)
  }

  const explicit = deps.explicit || (lookup.envVar ? env(lookup.envVar) : undefined) || undefined
  if (explicit) {
    if (executable && !hasSeparator(explicit, platform)) {
      searched.push(`PATH:${explicit}`)
      const hit = await which(explicit, platform)
      return hit ? { found: true, path: hit, via: 'env', searched } : { found: false, path: explicit, via: 'env', searched }
    }
    return { found: await exists(explicit), path: explicit, via: 'env', searched }
  }

  if (lookup.pathName && executable) {
    searched.push(`PATH:${lookup.pathName}`)
    const hit = await which(lookup.pathName, platform)
    if (hit && (!deps.acceptPathHit || (await deps.acceptPathHit(hit)))) {
      return { found: true, path: hit, via: 'path', searched }
    }
  }

  for (const candidate of lookup.fallbacks) {
    if (await exists(candidate)) return { found: true, path: candidate, via: 'fallback', searched }
  }
  return { found: false, searched }
}

/**
 * The skip a runner reports for a tool it could not find. `noun` is the runner's
 * own name for the thing ("Brush binary"); the remediation is the table's, so
 * the job's hint and the capability report's are the same sentence.
 */
export function toolSkip(
  lookup: ToolLookup,
  location: ToolLocation,
  noun: string,
): { skippedReason: string; remediation: string } {
  const where = location.path ?? location.searched.map((s) => s.replace(/^PATH:/, 'PATH ')).join(', ')
  return {
    skippedReason: location.path
      ? `${noun} not found or not executable: ${location.path}`
      : `${noun} not found (looked in: ${where || 'nowhere'})`,
    remediation: lookup.remediation,
  }
}

/** The path a runner records when nothing was found: the explicit value, else the first place looked. */
export function displayPathOf(lookup: ToolLookup, location: ToolLocation): string {
  return location.path ?? lookup.fallbacks[0] ?? lookup.pathName ?? lookup.id
}

/** True when a spawn failed because the program is not there, as opposed to failing once it started. */
export function isNotFoundSpawnError(err: unknown): boolean {
  return isNotFound(err) ||
    (err instanceof Error && /\bENOENT\b|No such file or directory|\(os error 2\)/.test(err.message))
}

function hasSeparator(name: string, platform: ExecPlatform): boolean {
  return name.includes('/') || (platform === 'windows' && name.includes('\\'))
}

async function statIs(path: string, want: 'dir' | 'file'): Promise<boolean> {
  try {
    const info = await fs.stat(path)
    return want === 'dir' ? info.isDirectory() : info.isFile()
  } catch {
    return false
  }
}
