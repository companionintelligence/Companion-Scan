/**
 * The marker-reading Web Worker: runs the detector on frames the page hands over by transfer, so that reading a tag costs the
 * page's frame loop nothing.
 *
 * It is a module worker, built the way the repo builds its other one (`src/inference/router.ts` starts `webgpu.worker.ts`
 * with `new Worker(new URL('./webgpu.worker.ts', import.meta.url), { type: 'module' })`, and Vite bundles anything written that
 * way with `worker.format: 'es'` already set in vite.config.ts): `tag-worker-client.ts` starts this file in the same form, and no
 * configuration or dependency was added. All the work is in `tag-worker-core.ts`; this file only connects it to the worker's port.
 * The messages are in `tag-worker-protocol.ts`.
 */
import { createTagWorkerHandler } from './tag-worker-core.ts'
import type { TagWorkerRequest, TagWorkerResponse } from './tag-worker-protocol.ts'

const handle = createTagWorkerHandler((message: TagWorkerResponse) => {
  self.postMessage(message)
})

self.addEventListener('message', (event: MessageEvent<TagWorkerRequest>) => {
  handle(event.data)
})
