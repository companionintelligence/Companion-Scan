/**
 * The server's onnxruntime-node implementation of the LFM2.5-VL driver port
 * (src/inference/lfm-driver.ts).
 *
 * This is the runtime-specific half the port exists to isolate: session
 * creation via onnxruntime-node, tokenizer JSON via `fs.readFile`, and
 * image decode via Jimp. Everything else — the loop, the KV cache, the
 * patchify maths — lives in the driver and is not duplicated here.
 *
 * `MODEL_DIR` / `TOKENIZER_DIR` moved here unchanged from inference.ts; they
 * still read the same env vars with the same defaults (.env.example:64-65).
 */
import { REPO_ROOT } from './repo-root.ts'
import type { LfmPort } from '../src/inference/lfm-driver.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Where the ONNX model and its tokenizer are read from: MODEL_DIR and
 * TOKENIZER_DIR, resolved against the repo root. A function of the env reader
 * so server/capabilities.ts can report the same directory this driver opens.
 *
 * fileURLToPath, not `.pathname`: the latter yields "/C:/…" on Windows, which
 * onnxruntime/Jimp then fail to open.
 */
export function onnxModelPaths(
  env: (name: string) => string | undefined = (name) => process.env[name],
): { modelDir: string; tokenizerDir: string } {
  return {
    modelDir: fileURLToPath(new URL(env('MODEL_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/onnx/', REPO_ROOT)),
    tokenizerDir: fileURLToPath(new URL(env('TOKENIZER_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/', REPO_ROOT)),
  }
}

const { modelDir: MODEL_DIR, tokenizerDir: TOKENIZER_DIR } = onnxModelPaths()

/**
 * Build the server-side `LfmPort`. `ort` and `Jimp` are handed in rather than
 * imported here because both are loaded dynamically by the caller (to avoid
 * load errors when INFERENCE_MODE isn't 'onnx') — this file stays a pure
 * factory over whatever modules already got loaded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createNodeOnnxPort(ort: any, Jimp: any): LfmPort {
  return {
    async createSession(name, opts) {
      return await ort.InferenceSession.create(`${MODEL_DIR}${name}`, opts)
    },
    async readJson(name) {
      return JSON.parse(await fs.readFile(`${TOKENIZER_DIR}${name}`, 'utf8'))
    },
    async decodeImage(bytes, width, height) {
      const image = await Jimp.fromBuffer(bytes.buffer as ArrayBuffer)
      image.resize({ w: width, h: height })
      return { data: new Uint8Array(image.bitmap.data.buffer), width, height }
    },
    Tensor: ort.Tensor,
  }
}
