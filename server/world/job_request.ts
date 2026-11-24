/**
 * What a `WorldJob` type needs, who starts it, and what a request to queue one may carry.
 *
 * ## The rules table
 *
 * `WORLD_JOB_RULES` is a `Record` over `WorldJobType`, so a new type does not compile until it says whether it reads a
 * scan and who queues it (ADR 0003: one job system; ADR 0001: one place that says this, not three lists in main.ts).
 *
 *   - `needsScan`: the job reads one scan. Queued without a `scanId` that names one, it fails at once with
 *     "<type> requires a selected scan.", never with a TypeError from deep in a runner (F-24).
 *   - `startedBy`: who queues it.
 *       `jobs-api`      POST /worlds/:slug/jobs: the editor's buttons, or a direct API call
 *       `upload`        an upload or ingest route queues it on arrival
 *       `scan-route`    POST /scans/:filename/optimize
 *       `chain`         another job's success queues it
 *       `timer`         the keyframe retention timer
 *       `process-scan`  the legacy POST /process-scan bridge (a placeholder per action)
 *     A type whose only starter is `jobs-api` is **request-only**: nothing in the server queues it on its own (F-28).
 *     That is deliberate for the ones that send data off the box or run for hours (thing-interactive-asset,
 *     memory-push, person-4d-reconstruct), and for the rest it is what the editor or a script must do.
 *   - `dedupe`: what makes two waiting jobs the same job. `target` is the scan or the file (ADR 0003 "Dedupe");
 *     `world` is one per world, for the jobs that work on the whole world whatever scan the editor had selected
 *     (FN-148).
 *
 * ## A request
 *
 * `parseJobRequest` checks the body of POST /worlds/:slug/jobs before anything is stored: the payload is kept in the
 * world file, which every read of the world parses, so it is a small flat object of plain values and nothing else.
 *
 * ## Jobs that need a credential on an open install
 *
 * With strict world auth off, a request with no token may queue a job, as it always could. The jobs that send data
 * off this server or delete it are the exception (F-04): `jobNeedsCredential`.
 */
import type { WorldJob, WorldJobType } from '../../src/world/types.ts'
import { worldJobTarget } from './world_job_pump.ts'

export type JobStarter = 'jobs-api' | 'upload' | 'scan-route' | 'chain' | 'timer' | 'process-scan'

export interface JobRule {
  needsScan: boolean
  startedBy: readonly JobStarter[]
  dedupe: 'target' | 'world'
}

export const WORLD_JOB_RULES: Record<WorldJobType, JobRule> = {
  // The six placeholders (src/shared/placeholder-jobs.ts): they compute nothing and report "No-op:".
  'ingest': { needsScan: false, startedBy: ['jobs-api'], dedupe: 'target' },
  'extract-layers': { needsScan: true, startedBy: ['jobs-api', 'process-scan'], dedupe: 'target' },
  'align-scan': { needsScan: true, startedBy: ['jobs-api', 'process-scan'], dedupe: 'target' },
  'merge-points': { needsScan: false, startedBy: ['jobs-api', 'process-scan'], dedupe: 'target' },
  'semantic-pass': { needsScan: true, startedBy: ['jobs-api', 'process-scan'], dedupe: 'target' },
  'depth-reconstruct': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  // Whole-world jobs: the editor sends its selected scan with them, which says nothing about what they work on.
  'thing-correspondence': { needsScan: false, startedBy: ['jobs-api'], dedupe: 'world' },
  'export-world': { needsScan: false, startedBy: ['jobs-api'], dedupe: 'world' },
  // Reconstruction. An ingest queues the first stage; each stage's success queues the next where there is one.
  'lingbot-map-reconstruct': { needsScan: true, startedBy: ['jobs-api', 'upload'], dedupe: 'target' },
  'colmap-poses': { needsScan: true, startedBy: ['jobs-api', 'upload'], dedupe: 'target' },
  'splat-train': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  'splat-align': { needsScan: true, startedBy: ['jobs-api', 'chain'], dedupe: 'target' },
  'splat-detect': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  'splat-finish': { needsScan: true, startedBy: ['jobs-api', 'chain'], dedupe: 'target' },
  'sensenova-vision': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  'panoptic-scan': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  // After a panoptic-scan that found objects, and after a splat-align when segments are on disk.
  'panoptic-lift': { needsScan: true, startedBy: ['jobs-api', 'chain'], dedupe: 'target' },
  // Delegates to the off-box 4d-capture service (ADR 0006). Request-only: a take is complete when a person says so.
  'person-4d-reconstruct': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  // Sends a keyframe to the PhysAg3D agent service. Request-only, and needs a credential on an open install.
  'thing-interactive-asset': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  // Sends the scan to Companion Memory. Request-only, and needs a credential on an open install.
  'memory-push': { needsScan: true, startedBy: ['jobs-api'], dedupe: 'target' },
  'place-register': { needsScan: true, startedBy: ['jobs-api', 'upload'], dedupe: 'target' },
  // The whole server's camera frames, queued in the default world. A real one needs a credential on an open install.
  'keyframe-purge': { needsScan: false, startedBy: ['jobs-api', 'timer'], dedupe: 'world' },
  // Not requestable through the jobs API: an upload queues it, and POST /scans/:filename/optimize queues it again.
  'optimize-scan': { needsScan: false, startedBy: ['upload', 'scan-route'], dedupe: 'target' },
}

const ALL_JOB_TYPES = Object.keys(WORLD_JOB_RULES) as WorldJobType[]

/** The types POST /worlds/:slug/jobs accepts, in the table's order. */
export const REQUESTABLE_JOB_TYPES: ReadonlySet<WorldJobType> = new Set(
  ALL_JOB_TYPES.filter((type) => WORLD_JOB_RULES[type].startedBy.includes('jobs-api')),
)

/** The types nothing in the server queues on its own (F-28). */
export const REQUEST_ONLY_JOB_TYPES: readonly WorldJobType[] = ALL_JOB_TYPES.filter((type) => {
  const startedBy = WORLD_JOB_RULES[type].startedBy
  return startedBy.length === 1 && startedBy[0] === 'jobs-api'
})

/** Whether a job of this type reads one scan, and so cannot run without one (F-24). */
export function jobNeedsScan(type: WorldJobType): boolean {
  return WORLD_JOB_RULES[type]?.needsScan ?? false
}

/**
 * The key two waiting jobs share when they are the same job, or undefined when a job has nothing to be the same as
 * (ADR 0003: a job with no target is never deduped). A whole-world type is one per world; a keyframe purge is one per
 * world for a real pass and one for a dry run, so a dry run never stands in for the purge that deletes (FN-148).
 */
export function dedupeKeyFor(job: Pick<WorldJob, 'type' | 'scanId' | 'payload'>): string | undefined {
  const rule = WORLD_JOB_RULES[job.type]
  if (!rule || rule.dedupe === 'target') {
    // The scan, or the file for a job with no scan (worldJobTarget, ADR 0003 "Dedupe").
    const target = worldJobTarget(job)
    return target === undefined ? undefined : `target:${target}`
  }
  if (job.type === 'keyframe-purge') return job.payload?.['dryRun'] === false ? 'world:purge' : 'world:purge-dry-run'
  return 'world'
}

// ── Chains ───────────────────────────────────────────────────────────────────

/**
 * Whether a finished panoptic-scan queues a panoptic-lift (F-28): when it succeeded and found at least one object
 * segment. The lift places object segments, so a scan that found only surfaces, or none, has nothing to lift.
 */
export function panopticLiftFollowsScan(result: { status: string; thingCount?: number | null }): boolean {
  return result.status === 'ok' && (result.thingCount ?? 0) > 0
}

// ── A request to queue a job ─────────────────────────────────────────────────

/** The largest payload kept, as JSON. A real one is a few hundred bytes (a source, a time, a prompt). */
export const JOB_PAYLOAD_MAX_BYTES = 16 * 1024
/** Keys one payload may carry. */
export const JOB_PAYLOAD_MAX_KEYS = 32
/** Characters one payload string may carry. A detection prompt is the longest real one. */
export const JOB_PAYLOAD_MAX_STRING = 4000
const KEY_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export type JobPayloadValue = string | number | boolean | null

export type ParsedJobRequest =
  | { ok: true; type: WorldJobType; scanId: string | undefined; payload: Record<string, JobPayloadValue> | undefined }
  | { ok: false; status: 400; error: string }

function refuse(error: string): ParsedJobRequest {
  return { ok: false, status: 400, error }
}

/**
 * Checks the body of POST /worlds/:slug/jobs. `type` must be one the route accepts; `scanId`, when present, a short
 * string; `payload`, when present, a flat object of at most `JOB_PAYLOAD_MAX_KEYS` plain values (strings, finite
 * numbers, booleans, null), no larger than `JOB_PAYLOAD_MAX_BYTES` as JSON. Nested objects and arrays are refused: no
 * job type reads one, and the world file keeps whatever is stored here.
 */
export function parseJobRequest(body: unknown): ParsedJobRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('The request must be a JSON object.')
  const record = body as Record<string, unknown>
  const type = record['type']
  if (typeof type !== 'string' || !REQUESTABLE_JOB_TYPES.has(type as WorldJobType)) {
    return refuse(`type must be one of ${[...REQUESTABLE_JOB_TYPES].join(', ')}`)
  }
  const scanIdRaw = record['scanId']
  let scanId: string | undefined
  if (scanIdRaw !== undefined && scanIdRaw !== null) {
    if (typeof scanIdRaw !== 'string' || scanIdRaw.length === 0 || scanIdRaw.length > 256 || CONTROL.test(scanIdRaw)) {
      return refuse('scanId must be a scan id of at most 256 characters.')
    }
    scanId = scanIdRaw
  }
  const payloadRaw = record['payload']
  if (payloadRaw === undefined || payloadRaw === null) return { ok: true, type: type as WorldJobType, scanId, payload: undefined }
  if (typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) return refuse('payload must be a JSON object.')
  const entries = Object.entries(payloadRaw as Record<string, unknown>)
  if (entries.length > JOB_PAYLOAD_MAX_KEYS) return refuse(`payload may carry at most ${JOB_PAYLOAD_MAX_KEYS} keys.`)
  const payload: Record<string, JobPayloadValue> = {}
  for (const [key, value] of entries) {
    if (!KEY_SHAPE.test(key)) return refuse('payload keys are letters, digits, ".", "_" or "-", at most 64 characters.')
    if (value === null || typeof value === 'boolean') payload[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) payload[key] = value
    else if (typeof value === 'string' && value.length <= JOB_PAYLOAD_MAX_STRING) payload[key] = value
    else {
      return refuse(
        `payload.${key} must be a string of at most ${JOB_PAYLOAD_MAX_STRING} characters, a finite number, true, false or null.`,
      )
    }
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > JOB_PAYLOAD_MAX_BYTES) {
    return refuse(`payload is over ${JOB_PAYLOAD_MAX_BYTES} bytes.`)
  }
  return { ok: true, type: type as WorldJobType, scanId, payload }
}

// ── F-04 ─────────────────────────────────────────────────────────────────────

/**
 * Whether a request for this job sends data off this server or deletes it: a PhysAg3D asset (a keyframe goes to the
 * agent service), a memory push (the scan goes to Companion Memory), and a keyframe purge that is not a dry run (only an
 * explicit `dryRun: false` deletes, server/keyframe_retention.ts). On an install without strict world auth these need
 * an editor-or-better member token or a Companion session; every other type keeps the open default.
 */
export function jobNeedsCredential(type: WorldJobType, payload: Record<string, unknown> | undefined): boolean {
  if (type === 'thing-interactive-asset' || type === 'memory-push') return true
  return type === 'keyframe-purge' && payload?.['dryRun'] === false
}

/** The 401 such a request gets without one, in words that say what to do. */
export function credentialRequiredMessage(type: WorldJobType): string {
  const what = type === 'keyframe-purge'
    ? 'deletes camera frames'
    : type === 'memory-push'
    ? 'sends this scan to Companion Memory, off this server'
    : 'sends a keyframe to the PhysAg3D service, off this server'
  return `${type} ${what}, so it needs an editor token (open the editor from its share link) or a Companion sign-in.`
}
