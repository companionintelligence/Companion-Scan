/**
 * The page's side of marker reading: hands camera frames to the worker by transfer, takes the answers, and falls back to doing
 * the same work on the main thread when it has to.
 *
 * ## One frame at a time, and the rest are dropped
 *
 * The worker reads one frame while the next waits for nobody: a frame that arrives while the last is still being read is dropped
 * and counted (`droppedBusy`), not queued. A queue would answer old frames late, against poses that are no longer the ones
 * they were taken with, and would only grow when the phone is too slow for the rate asked of it. At 5 to 10 Hz a worker that
 * keeps up never drops one.
 *
 * ## Transfer, not copy
 *
 * `CameraFrame.pixels` is a copy the receiver owns (`camera-frame-feed.ts`), so it is moved into the worker with the transfer list
 * and the page can no longer read it. Nothing here reads a frame's pixels after sending them; what the page keeps of a frame is its
 * metadata (the pose, the projection, the epoch), returned with the answer.
 *
 * ## Fallback
 *
 * It reads on the main thread, at no more than `MAIN_THREAD_MIN_INTERVAL_MS` apart, when
 *
 * - there is no Worker, or making one throws (`'no-worker'`);
 * - sending a frame throws, as a browser that cannot transfer an `ArrayBuffer` does (`'transfer-failed'`; the frame is then read here);
 * - the worker reports an error loading or running (`'worker-error'`, `'init-failed'`);
 * - the worker has not answered a frame in `WORKER_STALL_MS` (`'stalled'`: checked when the next frame arrives, so no timer is needed).
 *
 * The main-thread detector is loaded on demand (`import()` of `detector.ts`), so a page whose worker works never loads a second copy of
 * it. `stats.fallbackReason` says why, and `mode` says where frames are read now; a flow that wants to lower its rate can read both.
 *
 * Browser-safe (ADR 0002): no DOM beyond `Worker`, which is found at run time and may be absent.
 */
import type { CameraFrame } from '../camera-frame-feed.ts'
import type { DetectorOptions, DetectorStats } from './detector.ts'
import type { RoiRect, TagRunner, TagRunResult } from './tag-runner.ts'
import type { TagWorkerRequest, TagWorkerResponse } from './tag-worker-protocol.ts'
import type { FiducialDetection } from './types.ts'

/** How long a worker may sit on a frame before it is taken to be dead, milliseconds. Adopted, not measured (ADR 0005 rule 5): far above the tens of milliseconds a read takes, far below a person's patience. */
export const WORKER_STALL_MS = 5000
/** Closest two frames may be read on the main thread, milliseconds: 5 Hz. A read there blocks the page's frame loop for as long as it takes, so it is slower than the worker's rate. Adopted, not measured. */
export const MAIN_THREAD_MIN_INTERVAL_MS = 200

/** What the client needs of a Web Worker: the browser's `Worker` has all of it. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type TagFallbackReason = 'no-worker' | 'worker-error' | 'transfer-failed' | 'init-failed' | 'stalled'
export type TagWorkerMode = 'worker' | 'main-thread' | 'closed'

/** What a frame carries besides its pixels. */
export type FrameMeta = Omit<CameraFrame, 'pixels'>

export interface TagFrameResult {
  /** The client's count of this frame. */
  seq: number
  frame: FrameMeta
  detections: FiducialDetection[]
  stats: DetectorStats
  roi: RoiRect | null
  roiMissed: boolean
  passes: number
  /** Milliseconds in the detector. */
  detectMs: number
  /** Milliseconds the worker (or the main-thread read) took in all. */
  workerMs: number
  /** Milliseconds from the frame being handed over to the answer: the age the answer's pose has gained. */
  roundTripMs: number
  mode: 'worker' | 'main-thread'
}

export interface TagWorkerClientStats {
  /** Frames sent for reading. */
  submitted: number
  /** Answers received. */
  completed: number
  /** Frames dropped because the last was still being read. */
  droppedBusy: number
  /** Frames dropped on the main thread for coming faster than `MAIN_THREAD_MIN_INTERVAL_MS`. */
  droppedRate: number
  /** Frames that were in a worker when it failed. */
  lost: number
  errors: number
  fallbackReason: TagFallbackReason | null
}

export type SubmitOutcome = 'sent' | 'dropped-busy' | 'dropped-rate' | 'closed'

export interface TagWorkerClientOptions {
  /** The family to read, by `Dictionary.name`. */
  family: string
  detector?: DetectorOptions
  /** Search around the last tag found. Default true. */
  roi?: boolean
  /** Makes a worker, or returns null (or throws) when there is none. Default: a module worker on `./tag-worker.ts`, if `Worker` exists. */
  createWorker?: () => WorkerLike | null
  /** Makes the runner for the main-thread fallback. Default: loads `detector.ts` on demand. */
  loadRunner?: (family: string, detector: DetectorOptions, roi: boolean) => Promise<TagRunner>
  /** A millisecond clock. Default `performance.now()`. */
  now?: () => number
  /** Told when the client moves to the main thread. */
  onFallback?: (reason: TagFallbackReason) => void
}

/** The worker the page starts: a module worker, written in the form Vite bundles (see `tag-worker.ts`), or null where there is no `Worker`. */
function defaultCreateWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./tag-worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}

async function defaultLoadRunner(family: string, detector: DetectorOptions, roi: boolean): Promise<TagRunner> {
  const [{ FiducialDetector }, { TagRunner: Runner }, { tagFamilyByName }] = await Promise.all([import('./detector.ts'), import('./tag-runner.ts'), import('./families.ts')])
  const found = tagFamilyByName(family)
  if (!found) throw new Error(`unknown tag family "${family}"`)
  return new Runner(new FiducialDetector(found.dictionary, detector), { roi })
}

function metaOf(frame: CameraFrame): FrameMeta {
  const { pixels: _pixels, ...meta } = frame
  return meta
}

export class TagWorkerClient {
  private readonly options: TagWorkerClientOptions
  private readonly now: () => number
  private worker: WorkerLike | null = null
  private currentMode: TagWorkerMode = 'worker'
  private seq = 0
  private pending: { seq: number; sentAtMs: number; frame: FrameMeta } | null = null
  private listeners: Array<(result: TagFrameResult) => void> = []
  private runner: Promise<TagRunner> | null = null
  private mainBusy = false
  private lastMainRunAtMs = -Infinity
  readonly stats: TagWorkerClientStats = { submitted: 0, completed: 0, droppedBusy: 0, droppedRate: 0, lost: 0, errors: 0, fallbackReason: null }

  constructor(options: TagWorkerClientOptions) {
    this.options = options
    this.now = options.now ?? (() => performance.now())
    let worker: WorkerLike | null = null
    try {
      worker = (options.createWorker ?? defaultCreateWorker)()
    } catch {
      worker = null
    }
    if (!worker) {
      this.fallBack('no-worker')
      return
    }
    this.worker = worker
    worker.onmessage = (event) => this.onMessage(event.data as TagWorkerResponse)
    worker.onerror = () => this.onWorkerError()
    this.send({ type: 'init', family: options.family, detector: options.detector ?? {}, roi: options.roi ?? true })
  }

  /** Where frames are read now. */
  get mode(): TagWorkerMode {
    return this.currentMode
  }

  /** Whether a frame is being read (a new one would be dropped). */
  get busy(): boolean {
    return this.currentMode === 'worker' ? this.pending !== null : this.mainBusy
  }

  /** Be told of every answer. Returns the function that stops it. */
  onResult(cb: (result: TagFrameResult) => void): () => void {
    this.listeners.push(cb)
    return () => {
      const at = this.listeners.indexOf(cb)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  /**
   * Hand over a frame to be read. In a worker its pixels are moved and are gone from the caller; on the main thread they are read
   * where they are. `'sent'` means an answer will come through `onResult` (or the frame is counted lost if the worker dies).
   */
  submit(frame: CameraFrame): SubmitOutcome {
    if (this.currentMode === 'closed') return 'closed'
    const nowMs = this.now()
    if (this.currentMode === 'worker') {
      if (this.pending) {
        if (nowMs - this.pending.sentAtMs > WORKER_STALL_MS) {
          this.stats.lost++
          this.pending = null
          this.fallBack('stalled')
        } else {
          this.stats.droppedBusy++
          return 'dropped-busy'
        }
      }
    }
    if (this.currentMode === 'worker') {
      const seq = ++this.seq
      // The feed hands over an exact buffer; a view onto part of a bigger one would send the rest of it too.
      const buffer = frame.pixels.byteOffset === 0 && frame.pixels.byteLength === frame.pixels.buffer.byteLength ? (frame.pixels.buffer as ArrayBuffer) : (frame.pixels.slice().buffer as ArrayBuffer)
      try {
        this.worker!.postMessage({ type: 'frame', seq, buffer, width: frame.width, height: frame.height, rowBytes: frame.rowBytes, channels: frame.channels } satisfies TagWorkerRequest, [buffer])
        this.pending = { seq, sentAtMs: nowMs, frame: metaOf(frame) }
        this.stats.submitted++
        return 'sent'
      } catch {
        // A browser that cannot transfer: the frame was not sent (a failed transfer leaves the buffer where it was), so it is read here.
        this.fallBack('transfer-failed')
      }
    }
    return this.readOnMainThread(frame, nowMs)
  }

  /** Forget where the tag was: the next frame is searched whole. */
  reset(): void {
    if (this.currentMode === 'worker') this.send({ type: 'reset' })
    else void this.runner?.then((r) => r.reset())
  }

  /** Stop the worker and refuse further frames. */
  close(): void {
    this.worker?.terminate()
    this.worker = null
    this.pending = null
    this.currentMode = 'closed'
  }

  private send(message: TagWorkerRequest): void {
    try {
      this.worker?.postMessage(message)
    } catch {
      this.fallBack('worker-error')
    }
  }

  private fallBack(reason: TagFallbackReason): void {
    if (this.currentMode === 'closed' || this.currentMode === 'main-thread') return
    this.worker?.terminate()
    this.worker = null
    this.currentMode = 'main-thread'
    this.stats.fallbackReason = reason
    this.options.onFallback?.(reason)
  }

  private onMessage(message: TagWorkerResponse): void {
    switch (message.type) {
      case 'ready':
        return
      case 'error':
        this.stats.errors++
        if (message.seq === null) {
          // Nothing was ever read: the worker cannot do what it was asked.
          if (this.pending) this.stats.lost++
          this.pending = null
          this.fallBack('init-failed')
        } else if (this.pending?.seq === message.seq) {
          this.pending = null
        }
        return
      case 'result': {
        const pending = this.pending
        if (!pending || pending.seq !== message.seq) return
        this.pending = null
        this.stats.completed++
        this.deliver({
          seq: message.seq,
          frame: pending.frame,
          detections: message.detections,
          stats: message.stats,
          roi: message.roi,
          roiMissed: message.roiMissed,
          passes: message.passes,
          detectMs: message.detectMs,
          workerMs: message.workerMs,
          roundTripMs: this.now() - pending.sentAtMs,
          mode: 'worker',
        })
        return
      }
    }
  }

  private onWorkerError(): void {
    if (this.pending) this.stats.lost++
    this.pending = null
    this.stats.errors++
    this.fallBack('worker-error')
  }

  private readOnMainThread(frame: CameraFrame, nowMs: number): SubmitOutcome {
    if (this.mainBusy) {
      this.stats.droppedBusy++
      return 'dropped-busy'
    }
    if (nowMs - this.lastMainRunAtMs < MAIN_THREAD_MIN_INTERVAL_MS) {
      this.stats.droppedRate++
      return 'dropped-rate'
    }
    this.mainBusy = true
    this.lastMainRunAtMs = nowMs
    const seq = ++this.seq
    const meta = metaOf(frame)
    this.stats.submitted++
    this.runner ??= (this.options.loadRunner ?? defaultLoadRunner)(this.options.family, this.options.detector ?? {}, this.options.roi ?? true)
    this.runner
      .then((runner) => {
        const t0 = this.now()
        const result: TagRunResult = runner.run({ data: frame.pixels, width: frame.width, height: frame.height, channels: frame.channels, rowBytes: frame.rowBytes })
        const done = this.now()
        this.stats.completed++
        this.deliver({
          seq,
          frame: meta,
          detections: result.detections,
          stats: result.stats,
          roi: result.roi,
          roiMissed: result.roiMissed,
          passes: result.passes,
          detectMs: result.detectMs,
          workerMs: done - t0,
          roundTripMs: done - nowMs,
          mode: 'main-thread',
        })
      })
      .catch(() => {
        this.stats.errors++
      })
      .finally(() => {
        this.mainBusy = false
      })
    return 'sent'
  }

  private deliver(result: TagFrameResult): void {
    for (const cb of this.listeners.slice()) {
      try {
        cb(result)
      } catch (error) {
        console.warn('[tag-worker-client] a listener threw:', error)
      }
    }
  }
}
