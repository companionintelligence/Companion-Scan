/**
 * The engines INFERENCE_MODE can name, and the one reading of it. The inference engine (server/inference.ts) and the
 * capability report (server/capabilities.ts) both use it, so the report cannot describe one engine while another runs.
 */
export type InferenceMode = 'ollama' | 'onnx' | 'mock' | 'grounding-dino'

/** Unset, or any value that names no engine, is the default, `ollama`. */
export function inferenceModeFrom(raw: string | undefined): InferenceMode {
  return raw === 'onnx' || raw === 'mock' || raw === 'grounding-dino' ? raw : 'ollama'
}
