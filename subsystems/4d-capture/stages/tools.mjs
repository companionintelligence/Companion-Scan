/**
 * Where each external tool is, by the appliance's convention.
 *
 * The same order the main repo's runners and its capability report use
 * (`locateTool` in server/exec_probe.ts, docs/operations/PLATFORM_SUPPORT.md):
 * the env var always wins and is only probed, then PATH, then the documented
 * install path. An env var that names nothing is reported missing, never
 * replaced by a fallback. This subsystem runs on another machine with its own
 * package.json, outside both builds, so it keeps this small copy rather than
 * importing the TypeScript one.
 *
 * A missing tool is a `skipped` take with the tool's remediation: the appliance
 * maps that to a green job with a hint, the same contract every optional GPU
 * tool in the system keeps.
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'

/** HOME, then USERPROFILE, then `~`: the appliance's rule for expanding install paths. */
export function homeOf(env = process.env) {
  return env.HOME ?? env.USERPROFILE ?? '~'
}

/** The tools a real (non-stub) take may need, as data. */
export function toolTable(env = process.env) {
  const home = homeOf(env)
  return {
    ffmpeg: {
      label: 'ffmpeg',
      envVar: 'FFMPEG_BIN',
      pathName: 'ffmpeg',
      fallbacks: [],
      remediation: 'Install ffmpeg (`apt install ffmpeg` / `brew install ffmpeg`) or set FFMPEG_BIN — it extracts the frames each timestep trains on.',
    },
    ffprobe: {
      label: 'ffprobe',
      envVar: 'FFPROBE_BIN',
      pathName: 'ffprobe',
      fallbacks: [],
      remediation: 'ffprobe ships with ffmpeg; install the full package or set FFPROBE_BIN.',
    },
    brush: {
      label: 'Brush (brush-cli)',
      envVar: 'BRUSH_BIN',
      pathName: 'brush-cli',
      // The same documented install path the appliance's splat-train uses.
      fallbacks: [`${home}/brush/target/release/brush-cli`],
      remediation:
        'Build Brush (`git clone https://github.com/ArthurBrussee/brush ~/brush && ' +
        'cd ~/brush && cargo build --release -p brush-cli`) or set BRUSH_BIN to an existing brush-cli.',
    },
    python: {
      label: '4DAnyone interpreter',
      envVar: 'FDANYONE_PYTHON',
      pathName: 'python3',
      fallbacks: [],
      remediation: "Set FDANYONE_PYTHON to the 4DAnyone environment's python (see README — Setup).",
    },
  }
}

/**
 * A regular file with an exec bit, the same test as the appliance's
 * `isRunnable` (server/exec_probe.ts). Windows has no exec bit, so a file is
 * enough there. Mode bits rather than `access(X_OK)`, which needs the process's
 * uid and so a permission Deno's test runner does not grant.
 */
export async function isExecutable(file) {
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    if (process.platform === 'win32') return true
    return (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** The first runnable `name` on `pathList`, or null. Empty PATH entries are skipped, never read as the cwd. */
export async function whichOnPath(name, pathList = process.env.PATH ?? '') {
  for (const dir of pathList.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * Resolve one tool. Returns `{ found, path, via, searched }`; `path` is the
 * explicit value or the first documented place when nothing was found, so a
 * skip can name somewhere to put it.
 */
export async function resolveTool(tool, env = process.env) {
  const searched = []
  const explicit = tool.envVar ? env[tool.envVar] : undefined
  if (explicit) {
    // A bare name is looked up on PATH, as the spawn would; a path is only probed.
    if (!explicit.includes('/') && !explicit.includes('\\')) {
      searched.push(`PATH:${explicit}`)
      const hit = await whichOnPath(explicit, env.PATH ?? '')
      return hit ? { found: true, path: hit, via: 'env', searched } : { found: false, path: explicit, via: 'env', searched }
    }
    searched.push(explicit)
    return { found: await isExecutable(explicit), path: explicit, via: 'env', searched }
  }
  if (tool.pathName) {
    searched.push(`PATH:${tool.pathName}`)
    const hit = await whichOnPath(tool.pathName, env.PATH ?? '')
    if (hit) return { found: true, path: hit, via: 'path', searched }
  }
  for (const candidate of tool.fallbacks ?? []) {
    searched.push(candidate)
    if (await isExecutable(candidate)) return { found: true, path: candidate, via: 'fallback', searched }
  }
  return { found: false, path: tool.fallbacks?.[0] ?? tool.pathName, searched }
}

/** The `skipped` result for a tool that is not there. */
export function missingTool(tool, location) {
  const where = location.via === 'env' ? location.path : location.searched.join(', ')
  return {
    status: 'skipped',
    skippedReason: `${tool.label} not found (${where || 'nowhere to look'})`,
    remediation: tool.remediation,
  }
}
