/**
 * What the editor shows of two job results that used to reach no screen (F-23).
 *
 *  - **SenseNova Vision.** The job writes a result sentence and an artifact listing its output files
 *    (`sensenova-output`, or `sensenova-skip` when the runtime is not installed). Run SenseNova only ever wrote
 *    "Queued SenseNova …". This reads the selected scan's latest SenseNova job back: its state, its sentence and the
 *    names of its files. The files themselves stay on the server, and no route serves them, so they are named and
 *    not linked. A name is the path below the job's output folder, never the server path the artifact holds.
 *  - **The world GLB.** export-world writes one `.world.glb` for the Place, served at `GET /worlds/:slug/export.glb`,
 *    and nothing linked to it. This gives the link once an export has completed.
 *
 * Pure: it reads `WorldJob`s (src/world/types.ts) and returns words and paths.
 */
import type { WorldJob } from '../world/types.ts'

/** The newest job of `type`, for `scanId` when one is given. Newest by `updatedAt`, then `createdAt`. */
export function latestJobOf(jobs: readonly WorldJob[] | null | undefined, type: WorldJob['type'], scanId?: string | null): WorldJob | null {
  let newest: WorldJob | null = null
  for (const job of jobs ?? []) {
    if (job.type !== type) continue
    if (scanId !== undefined && scanId !== null && job.scanId !== scanId) continue
    if (!newest || stamp(job) > stamp(newest)) newest = job
  }
  return newest
}

function stamp(job: WorldJob): string {
  return `${job.updatedAt ?? ''}\u0000${job.createdAt ?? ''}`
}

/**
 * The names of a job's output files, relative to its output folder. A path outside that folder, or one that cannot
 * be read, is named by its last segment only, so no server path reaches the screen.
 */
export function outputFileNames(files: unknown, outputDir: unknown): string[] {
  if (!Array.isArray(files)) return []
  const dir = typeof outputDir === 'string' && outputDir.length > 0 ? outputDir.replace(/[\\/]+$/, '') : null
  const names: string[] = []
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0) continue
    const relative = dir && file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file.split(/[\\/]/).pop() ?? ''
    if (relative) names.push(relative)
  }
  return names
}

export type SenseNovaState = 'none' | 'queued' | 'processing' | 'completed' | 'skipped' | 'failed'

export interface SenseNovaSummary {
  state: SenseNovaState
  /** One sentence for the panel's status line. Empty for `'none'`, where the panel keeps its idle text. */
  text: string
  /** Output file names, for a completed run. */
  files: string[]
}

/** How many file names the panel lists before it says how many more there are. */
export const SENSENOVA_FILES_SHOWN = 6

/** What the SenseNova panel says about the selected scan's latest SenseNova job. */
export function senseNovaSummary(jobs: readonly WorldJob[] | null | undefined, scanId: string | null): SenseNovaSummary {
  if (!scanId) return { state: 'none', text: '', files: [] }
  const job = latestJobOf(jobs, 'sensenova-vision', scanId)
  if (!job) return { state: 'none', text: '', files: [] }
  const task = typeof job.payload?.['task'] === 'string' ? (job.payload['task'] as string).replace(/_/g, ' ') : 'task'
  if (job.status === 'queued') return { state: 'queued', text: `SenseNova ${task} is queued.`, files: [] }
  if (job.status === 'processing') return { state: 'processing', text: `SenseNova ${task} is running.`, files: [] }
  if (job.status === 'failed') {
    return { state: 'failed', text: `SenseNova ${task} failed: ${job.error || job.result || 'no reason was recorded'}.`, files: [] }
  }
  const skipped = (job.artifacts ?? []).find((artifact) => artifact.type === 'sensenova-skip')
  if (skipped) return { state: 'skipped', text: job.result || `SenseNova ${task} was skipped.`, files: [] }
  const output = (job.artifacts ?? []).find((artifact) => artifact.type === 'sensenova-output')
  const files = outputFileNames(output?.metadata?.['files'], output?.metadata?.['outputDir'])
  const kept = files.length === 0
    ? ''
    : ' The files are kept on the server, which has no route to open them from the editor yet.'
  return { state: 'completed', text: `${job.result || `SenseNova ${task} completed.`}${kept}`, files }
}

/** The file list line: the first {@link SENSENOVA_FILES_SHOWN} names, then how many more. */
export function senseNovaFilesLine(files: readonly string[]): string {
  if (files.length === 0) return ''
  const shown = files.slice(0, SENSENOVA_FILES_SHOWN).join(', ')
  const more = files.length - SENSENOVA_FILES_SHOWN
  return more > 0 ? `${shown}, and ${more} more` : shown
}

/** The world GLB to link, once an export-world job has completed, or null. */
export interface WorldExportLink {
  /** A served path on `/worlds/`: the job's own artifact URL, or the route by the world's slug. */
  path: string
  /** The completed job's result sentence, for the line under the link. */
  detail: string
}

export function worldExportLink(jobs: readonly WorldJob[] | null | undefined, shareSlug: string): WorldExportLink | null {
  let newest: WorldJob | null = null
  for (const job of jobs ?? []) {
    if (job.type !== 'export-world' || job.status !== 'completed') continue
    if (!newest || stamp(job) > stamp(newest)) newest = job
  }
  if (!newest) return null
  const artifact = (newest.artifacts ?? []).find((item) => item.type === 'world-glb')
  const own = typeof artifact?.url === 'string' && artifact.url.startsWith('/worlds/') && !artifact.url.startsWith('//')
    ? artifact.url
    : null
  return {
    path: own ?? `/worlds/${encodeURIComponent(shareSlug)}/export.glb`,
    detail: newest.result ?? '',
  }
}
