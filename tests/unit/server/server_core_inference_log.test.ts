/**
 * F-07: the ollama engine logs counts and timing, never the model's reply.
 *
 * The reply describes what a phone saw in someone's room. /infer has always promised to log counts and timing only
 * (server/main.ts), while `_inferOllama` printed the whole reply. This drives the real engine against a stubbed
 * Ollama (no network, no model) and reads what it logged.
 *
 *   node --test tests/unit/server/server_core_inference_log.test.ts
 */
import { assert, assertEquals, assertMatch } from './assert.ts'
import { InferenceEngine } from '../../../server/inference.ts'
import { test } from 'node:test'

const PRIVATE_WORDS = ['heirloom-clock', 'medicine-cabinet', 'passport-on-desk']

test('ollama engine: the log has the count and the time, and none of the reply', async () => {
  const reply = JSON.stringify([
    { label: PRIVATE_WORDS[0], confidence: 0.9, description: 'brass, on the mantel', bbox: [0.1, 0.1, 0.3, 0.4] },
    { label: PRIVATE_WORDS[1], confidence: 0.8, description: `beside the ${PRIVATE_WORDS[2]}`, bbox: [0.5, 0.2, 0.7, 0.6] },
  ])
  const realFetch = globalThis.fetch
  const realLog = console.log
  const lines: string[] = []
  const previousMode = process.env.INFERENCE_MODE
  delete process.env.INFERENCE_MODE
  globalThis.fetch = ((input: string | URL | Request) => {
    assert(String(input).endsWith('/api/generate'), `only the generate call is made: ${input}`)
    return Promise.resolve(Response.json({ response: reply }))
  }) as typeof fetch
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  try {
    const engine = new InferenceEngine()
    assertEquals(engine.mode, 'ollama')
    const detections = await engine.infer(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    assertEquals(detections.length, 2, 'the detections still reach the caller')
  } finally {
    globalThis.fetch = realFetch
    console.log = realLog
    if (previousMode !== undefined) process.env.INFERENCE_MODE = previousMode
  }
  const log = lines.join('\n')
  for (const word of PRIVATE_WORDS) assert(!log.includes(word), `the log names "${word}":\n${log}`)
  assert(!log.includes('brass'), 'no description')
  assertMatch(log, /Ollama inference finished in \d+\.\d{2}s: 2 detection\(s\) from a \d+-character reply/)
})
