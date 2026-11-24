/**
 * Uploaded session summaries: where one is kept, and how it goes (F-08).
 *
 * The scanner's "Export Summary" downloads a Markdown summary of a capture session and uploads a copy to
 * POST /upload-summary (src/export/summary.ts). The copy carries the session's detections and, when the phone had a
 * fix, its street address and a map link. Nothing reads it back. It used to be written loose into SUMMARIES_DIR, named
 * by its upload time, so nothing could tell whose it was, and nothing deleted it: not with its session, not with its
 * scan, not when every scan was cleared.
 *
 * ## The index is the folder
 *
 * A summary is kept under the capture session it describes: `SUMMARIES_DIR/<sessionId>/<time>_<name>.md`. The upload
 * names the session (`sessionId`, a server session id: `SESSION_ID_RE`). A plain export made with no keyframe session
 * names none (the scanner sends no client-local id), and is kept apart, in `SUMMARIES_DIR/unlinked/`, as it was always
 * accepted: nothing ties it to a scan, so only clear-all removes it. Refusing such an upload instead is the owner's
 * call (wave 14 ticket 0001, owner decision 4). Deleting a session's summaries is removing one folder, so they go wherever the
 * session's frames go: main.ts passes `removeSessionSummaries` in the hook every removal of a session already runs
 * (`RemoveSessionCopies`, server/session_deletion.ts), which covers DELETE /sessions/:id, DELETE /scans/:filename (the
 * sessions only that scan names) and the retention purge. DELETE /scans?confirm=delete-all removes every summary
 * (`removeAllSummaries`), the loose ones an earlier build wrote among them.
 *
 * A file a reply names is the summary's own file name, never a path.
 */
import { SESSION_ID_RE } from './session_id.ts'

/** The folder the summaries that name no server session are kept in. No session id can be this name (`sess-…`). */
export const UNLINKED_SUMMARIES = 'unlinked'

/** The folder a session's summaries are kept in, or null when `sessionId` is not a server session id. */
export function summaryFolderFor(summariesDir: string, sessionId: unknown): string | null {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? `${summariesDir}/${sessionId}` : null
}

/** A summary's file name: the upload time and a name of safe characters that ends in `.md`. */
export function summaryFileName(originalName: string, now: number = Date.now()): string {
  const rawName = (originalName || 'summary')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.\./g, '__')
    .replace(/^[._-]+/, '')
  const safeName = rawName.endsWith('.md') ? rawName : `${rawName}.md`
  return `${now}_${safeName}`
}

/**
 * Writes a summary under its session's folder, or under `unlinked/` when `sessionId` is not a server session id, and
 * returns its file name and the session it was kept with (null for `unlinked/`).
 */
export async function storeSummary(opts: {
  summariesDir: string
  sessionId: unknown
  originalName: string
  text: string
  now?: number
}): Promise<{ filename: string; sessionId: string | null }> {
  const sessionFolder = summaryFolderFor(opts.summariesDir, opts.sessionId)
  const folder = sessionFolder ?? `${opts.summariesDir}/${UNLINKED_SUMMARIES}`
  await Deno.mkdir(folder, { recursive: true })
  const filename = summaryFileName(opts.originalName, opts.now)
  await Deno.writeTextFile(`${folder}/${filename}`, opts.text)
  return { filename, sessionId: sessionFolder ? opts.sessionId as string : null }
}

/**
 * Removes every summary of one session and resolves how many files went. A session with none is 0. Throws when the
 * folder is there and cannot be removed, so the caller keeps the session and says it failed, as it does for any part
 * of a session that would not go.
 */
export async function removeSessionSummaries(summariesDir: string, sessionId: string): Promise<number> {
  const folder = summaryFolderFor(summariesDir, sessionId)
  if (!folder) return 0
  let count = 0
  try {
    for await (const entry of Deno.readDir(folder)) if (entry.isFile) count += 1
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0
    throw error
  }
  await Deno.remove(folder, { recursive: true })
  return count
}

/**
 * Removes every summary: each session's folder, `unlinked/`, and any file an earlier build left loose in SUMMARIES_DIR.
 * The folder itself stays. Never throws: what could not be removed is counted.
 */
export async function removeAllSummaries(summariesDir: string): Promise<{ removed: number; failed: number }> {
  const result = { removed: 0, failed: 0 }
  const names: Array<{ name: string; isDirectory: boolean }> = []
  try {
    for await (const entry of Deno.readDir(summariesDir)) names.push({ name: entry.name, isDirectory: entry.isDirectory })
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return result
    console.error(`[summaries] could not list the summaries (${error instanceof Error ? error.name : 'Error'})`)
    result.failed += 1
    return result
  }
  for (const { name, isDirectory } of names) {
    try {
      await Deno.remove(`${summariesDir}/${name}`, { recursive: isDirectory })
      result.removed += 1
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue
      console.error(`[summaries] could not remove a summary (${error instanceof Error ? error.name : 'Error'})`)
      result.failed += 1
    }
  }
  return result
}
