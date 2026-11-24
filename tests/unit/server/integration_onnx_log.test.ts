/**
 * F-07, the ONNX half: the in-process driver logs counts only, never the text the model generated.
 *
 * The generated text describes what a phone saw in someone's room. The ollama path's log is driven for real in
 * server_core_inference_log.test.ts; the ONNX driver needs the model weights to run, so this reads its source:
 * no log line in src/inference/lfm-driver.ts may print the decoded reply.
 *
 *   node --test tests/unit/server/integration_onnx_log.test.ts
 */
import { assert, assertMatch } from './assert.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

const source = await fs.readFile(new URL('../../../src/inference/lfm-driver.ts', import.meta.url), 'utf8')

test('onnx driver: no log line prints the generated text (F-07)', () => {
  const logLines = source.split('\n').filter((line) => /console\.(log|info|debug|warn|error)\(/.test(line))
  for (const line of logLines) {
    assert(!/generatedText|decodeIds\(|idToVocabStr/.test(line), `a log line prints the reply: ${line.trim()}`)
  }
  assertMatch(source, /ONNX inference finished: \$\{detections\.length\} detection\(s\)/, 'the counts-only line is there')
})
