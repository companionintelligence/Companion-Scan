/**
 * What the marker-reading worker does with a message, apart from owning a Worker: so the same code runs in a real worker
 * (`tag-worker.ts`) and in a test, and so nothing in it needs a browser. It turns `init` into a detector and a runner,
 * `frame` into a `TagRunner` pass over the transferred bytes and an answer, and anything it cannot do into an `error`.
 *
 * Browser-safe (ADR 0002), no DOM.
 */
import { FiducialDetector } from './detector.ts'
import { tagFamilyByName } from './families.ts'
import { TagRunner } from './tag-runner.ts'
import type { TagWorkerRequest, TagWorkerResponse } from './tag-worker-protocol.ts'

/**
 * A handler for the page's messages. `post` sends an answer back; `now` is a millisecond clock (`performance.now()` by default).
 * A message before `init`, or a family that is not registered, is answered with an `error`, never thrown: a throw inside a
 * worker ends it silently from the page's side.
 */
export function createTagWorkerHandler(post: (message: TagWorkerResponse) => void, now: () => number = () => performance.now()): (message: TagWorkerRequest) => void {
  let runner: TagRunner | null = null

  return (message: TagWorkerRequest): void => {
    try {
      switch (message.type) {
        case 'init': {
          const family = tagFamilyByName(message.family)
          if (!family) {
            post({ type: 'error', seq: null, message: `unknown tag family "${message.family}"` })
            return
          }
          runner = new TagRunner(new FiducialDetector(family.dictionary, message.detector), { roi: message.roi, now })
          post({ type: 'ready' })
          return
        }
        case 'reset':
          runner?.reset()
          return
        case 'frame': {
          if (!runner) {
            post({ type: 'error', seq: message.seq, message: 'a frame arrived before init' })
            return
          }
          const t0 = now()
          const data = new Uint8Array(message.buffer)
          const result = runner.run({ data, width: message.width, height: message.height, channels: message.channels, rowBytes: message.rowBytes })
          post({
            type: 'result',
            seq: message.seq,
            detections: result.detections,
            stats: result.stats,
            roi: result.roi,
            roiMissed: result.roiMissed,
            passes: result.passes,
            detectMs: result.detectMs,
            workerMs: now() - t0,
          })
          return
        }
        default: {
          const exhaustive: never = message
          post({ type: 'error', seq: null, message: `unknown message ${JSON.stringify(exhaustive)}` })
        }
      }
    } catch (error) {
      post({ type: 'error', seq: message.type === 'frame' ? message.seq : null, message: error instanceof Error ? error.message : String(error) })
    }
  }
}
