/**
 * Deno/onnxruntime-node implementation of the LFM2.5-VL driver port
 * (src/inference/lfm-driver.ts).
 *
 * This is the runtime-specific half the port exists to isolate: session
 * creation via onnxruntime-node, tokenizer JSON via `Deno.readTextFile`, and
 * image decode via Jimp. Everything else — the loop, the KV cache, the
 * patchify maths — lives in the driver and is not duplicated here.
 *
 * `MODEL_DIR` / `TOKENIZER_DIR` moved here unchanged from inference.ts; they
 * still read the same env vars with the same defaults (.env.example:64-65).
 */
import { fromFileUrl } from '@std/path'
import { REPO_ROOT } from './repo-root.ts'
import type { LfmPort } from '../src/inference/lfm-driver.ts'

/**
 * Where the ONNX model and its tokenizer are read from: MODEL_DIR and
 * TOKENIZER_DIR, resolved against the repo root. A function of the env reader
 * so server/capabilities.ts can report the same directory this driver opens.
 *
 * fromFileUrl, not `.pathname`: the latter yields "/C:/…" on Windows, which
 * onnxruntime/Jimp then fail to open.
 */
export function onnxModelPaths(
  env: (name: string) => string | undefined = (name) => {
    // A process without --allow-env (the capability CLI, run bare) takes the defaults rather than throwing at load.
    try {
      return Deno.env.get(name)
    } catch {
      return undefined
    }
  },
): { modelDir: string; tokenizerDir: string } {
  return {
    modelDir: fromFileUrl(new URL(env('MODEL_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/onnx/', REPO_ROOT)),
    tokenizerDir: fromFileUrl(new URL(env('TOKENIZER_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/', REPO_ROOT)),
  }
}

const { modelDir: MODEL_DIR, tokenizerDir: TOKENIZER_DIR } = onnxModelPaths()

/**
 * Build the Deno-side `LfmPort`. `ort` and `Jimp` are handed in rather than
 * imported here because both are loaded dynamically by the caller (to avoid
 * load errors when INFERENCE_MODE isn't 'onnx') — this file stays a pure
 * factory over whatever modules already got loaded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDenoOnnxPort(ort: any, Jimp: any): LfmPort {
  return {
    async createSession(name, opts) {
      return await ort.InferenceSession.create(`${MODEL_DIR}${name}`, opts)
    },
    async readJson(name) {
      return JSON.parse(await Deno.readTextFile(`${TOKENIZER_DIR}${name}`))
    },
    async decodeImage(bytes, width, height) {
      const image = await Jimp.fromBuffer(bytes.buffer as ArrayBuffer)
      image.resize({ w: width, h: height })
      return { data: new Uint8Array(image.bitmap.data.buffer), width, height }
    },
    Tensor: ort.Tensor,
  }
}
