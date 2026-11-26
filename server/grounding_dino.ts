/**
 * The `grounding-dino` inference engine: the Scan server's client for the detection service,
 * `scripts/grounding_dino_server.py` (POST /detect, GET /health; docs/operations/GPU_BACKENDS.md).
 *
 * It sends a capture frame and the scanner's own vocabulary (CORE_LABELS, the nouns the VLM prompt offers) and turns
 * the service's boxes into the RawDetection[] every engine returns. The boxes then go through normalizeDetections,
 * the same label folding, clamping, confidence floor, de-duplication and cap that the Ollama engine's replies take,
 * so /infer answers in one shape whichever engine runs.
 *
 * Configuration, all read once at start (ADR 0001: no new connection type, one new variable):
 * - GDINO_URL: the service's base URL, for example https://<host>.<tailnet>.ts.net:8010. Required: the service's own
 *   GDINO_HOST is a bind address, and its certificate names the box's Tailscale host, so no address can be guessed
 *   from it.
 * - GDINO_TOKEN: the bearer token, the same variable the service reads (deploy/cscan.env.example). Optional.
 *
 * Like the Ollama engine, it logs counts and timing, never what was found: a frame is the inside of someone's room.
 */
import { Buffer } from 'node:buffer'
import { CORE_LABELS, normalizeDetections } from './prompt.ts'
import type { RawDetection } from './prompt.ts'

/** Phrases sent as the service's `prompt`, comma-separated: the scanner's own vocabulary. */
export const GROUNDING_DINO_PROMPT = CORE_LABELS.join(', ')

/**
 * The longest one POST /detect may take. The service answers in about 0.25 s once warm (2026-11-25, beta-glass);
 * the bound only keeps a hung service from holding /infer, whose own cap is 60 s. Untuned.
 */
export const GROUNDING_DINO_TIMEOUT_MS = 30_000

/** The longest a start-up health check may take. Untuned. */
export const GROUNDING_DINO_HEALTH_TIMEOUT_MS = 5_000

export interface GroundingDinoConfig {
  /** Base URL with no trailing slash. */
  url: string
  token: string | null
}

/** The configuration, or why there is none. */
export function groundingDinoConfigFromEnv(
  env: (name: string) => string | undefined,
): { config: GroundingDinoConfig; problem: null } | { config: null; problem: string } {
  const raw = (env('GDINO_URL') ?? '').trim()
  if (!raw) {
    return {
      config: null,
      problem: 'INFERENCE_MODE=grounding-dino needs GDINO_URL, the detection service\'s address, for example ' +
        'https://<host>.<tailnet>.ts.net:8010 (docs/operations/GPU_BACKENDS.md).',
    }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { config: null, problem: 'GDINO_URL is not a URL. Set it to the detection service\'s http(s) address.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { config: null, problem: 'GDINO_URL must be an http(s) address.' }
  }
  if (url.username || url.password || url.search || url.hash) {
    return { config: null, problem: 'GDINO_URL must not carry a user, password, query or fragment. Put the token in GDINO_TOKEN.' }
  }
  const token = (env('GDINO_TOKEN') ?? '').trim()
  return { config: { url: url.href.replace(/\/+$/, ''), token: token || null }, problem: null }
}

/** The JSON body of one POST /detect: the request shape the service documents. */
export function detectRequestBody(imageBytes: Uint8Array): string {
  return JSON.stringify({ prompt: GROUNDING_DINO_PROMPT, image_base64: Buffer.from(imageBytes).toString('base64') })
}

/**
 * The service's reply as RawDetection[]. The service gives `bbox` as [x, y, w, h] in pixels of the frame it was sent,
 * from the top left; a RawDetection's is [x_min, y_min, x_max, y_max] as fractions of the frame. Strongest first, so
 * normalizeDetections' cap keeps the best boxes. Anything malformed is dropped, never guessed at.
 */
export function detectionsFromReply(reply: unknown): RawDetection[] {
  if (typeof reply !== 'object' || reply === null) return []
  const { frame_width: fw, frame_height: fh, detections } = reply as Record<string, unknown>
  if (typeof fw !== 'number' || typeof fh !== 'number' || !(fw > 0) || !(fh > 0) || !Array.isArray(detections)) return []
  const boxes: Array<{ label: string; confidence: number; bbox: [number, number, number, number] }> = []
  for (const item of detections) {
    if (typeof item !== 'object' || item === null) continue
    const { label, confidence, bbox } = item as Record<string, unknown>
    if (typeof label !== 'string' || typeof confidence !== 'number' || !Array.isArray(bbox) || bbox.length !== 4) continue
    const [x, y, w, h] = bbox.map(Number)
    if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) continue
    boxes.push({ label, confidence, bbox: [x / fw, y / fh, (x + w) / fw, (y + h) / fh] })
  }
  boxes.sort((a, b) => b.confidence - a.confidence)
  // No description: the detector gives none, and normalizeDetections writes its plain "A <label>" rather than one
  // being made up here.
  return normalizeDetections(boxes)
}

/** What GET /health said. */
export interface GroundingDinoHealth {
  ready: boolean
  state: string
  model: string | null
}

/** GET /health, bounded. Throws when the service does not answer, or answers with an error. */
export async function groundingDinoHealth(
  config: GroundingDinoConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GroundingDinoHealth> {
  const res = await fetchImpl(`${config.url}/health`, { signal: AbortSignal.timeout(GROUNDING_DINO_HEALTH_TIMEOUT_MS) })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`HTTP ${res.status}`)
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  return {
    ready: body?.ready === true,
    state: typeof body?.state === 'string' ? body.state : 'unknown',
    model: typeof body?.model === 'string' ? body.model : null,
  }
}

/** One frame through POST /detect. Throws with a reason a person can act on. */
export async function detectWithGroundingDino(
  imageBytes: Uint8Array,
  config: GroundingDinoConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawDetection[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.token) headers.Authorization = `Bearer ${config.token}`
  const started = Date.now()
  let res: Response
  try {
    res = await fetchImpl(`${config.url}/detect`, {
      method: 'POST',
      headers,
      body: detectRequestBody(imageBytes),
      signal: AbortSignal.timeout(GROUNDING_DINO_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`The detection service did not answer within ${GROUNDING_DINO_TIMEOUT_MS / 1000}s`)
    }
    throw new Error(`The detection service is unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    // The service's error text names a request problem or its own state, never the frame, so it is safe to pass on.
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The detection service refused the request (HTTP ${res.status}): check GDINO_TOKEN`)
    }
    if (res.status === 503) {
      throw new Error(`The detection service is not ready (HTTP 503): its model is loading or failed to load. ${detail}`.trim())
    }
    throw new Error(`The detection service answered HTTP ${res.status}. ${detail}`.trim())
  }
  const detections = detectionsFromReply(await res.json().catch(() => null))
  console.log(`[engine] Grounding DINO finished in ${((Date.now() - started) / 1000).toFixed(2)}s: ${detections.length} detection(s)`)
  return detections
}
