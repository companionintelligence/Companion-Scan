/**
 * The photo method of place-register is wired into the pages and the server it runs in.
 *
 * Neither `src/viewer/viewer.ts` nor `server/main.ts` can be imported here (three.js and the DOM; a server that listens at import), so, like
 * wp-15a-register-proposal-wiring.test.ts, these read the sources and are named "source shape:". They claim no behaviour: that the
 * method runs is tests/unit/server/place_register_sfm_job.test.ts, and that it runs inside the real server's pump is
 * place_register_server.test.ts. What they hold is the part a rename or a moved line silently breaks: the request the card's button
 * sends, a class the card draws that the page has no rule for, the host the job is given, and the two sweeps that remove what a killed
 * run left (at boot, and when every scan is cleared).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b2-register-wiring.test.ts
 * `npm run test:wave` runs every wp-*.test.ts here: the name is what wires it in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('source shape: the card\'s "Check with photos" queues the same job with the method in its payload, through the editor\'s own request helpers', () => {
  const viewer = read('src/viewer/viewer.ts')
  const host = viewer.slice(viewer.indexOf('queuePhotoCheck: async (scanId: string) =>'))
  const body = host.slice(0, host.indexOf('\n  },\n'))
  assert.match(body, /withAccessToken\(`\/worlds\/\$\{encodeURIComponent\(world\.shareSlug\)\}\/jobs`\)/)
  // One token per request (F-10): it rides in the query, as every editor request's does, and the request sets no header of its own.
  assert.match(body, /headers: \{ 'Content-Type': 'application\/json' \}/)
  assert.doesNotMatch(body, /accessHeaders|Authorization/)
  assert.match(body, /type: 'place-register', scanId, payload: \{ method: 'sfm'/)
  // The answer is added to the editor's job list and polled, as the Advanced queue does, so the new card appears when the job is done.
  assert.match(body, /world\.jobs\.unshift\(job\)/)
  assert.match(body, /refreshJobs\(\)/)
  // And handed back to the card, which says when the server answered a request with a check that was already waiting.
  assert.match(body, /\n    return job$/)
})

test('source shape: the classes the card styles have rules in the page, and no rule is left for a class the card no longer draws', () => {
  const card = read('src/viewer/register-proposal.ts')
  const page = read('viewer.html')
  // The classes that carry a look of their own. The others (`register-title`, `register-note`, `register-agreement`) ride on the
  // editor's `job-title` and `layer-meta` and are hooks, not styles.
  const styled = ['register-card', 'register-headline', 'register-actions', 'register-method', 'register-method-title', 'register-disagree', 'register-caveat']
  for (const name of styled) {
    assert.match(page, new RegExp(`^\\s*\\.${name}[ {:]`, 'm'), `viewer.html has no rule for .${name}`)
    assert.match(card, new RegExp(`\\b${name}\\b`), `the card no longer draws .${name}`)
  }
  const ruled = new Set([...page.matchAll(/^\s*\.(register-[a-z][a-z-]*)[ {:]/gm)].map((match) => match[1]!))
  for (const name of ruled) assert.match(card, new RegExp(`\\b${name}\\b`), `viewer.html styles .${name} and the card never draws it`)
  assert.match(page, /\.register-actions \{ display: flex; flex-wrap: wrap;/, 'two buttons a method and an ask-for-photos button wrap on a phone')
  // The button rule is one selector list; a rule written into the middle of it restyles the Copy button.
  assert.match(page, /\.copy-link-btn,\s*\.job-btn,\s*\.transform-btn \{/)
})

test('source shape: the job is given the photo method\'s host, and that host is the server\'s own readers and switch', () => {
  const server = read('server/main.ts')
  const run = server.slice(server.indexOf('function _runPlaceRegisterJob('))
  assert.match(run.slice(0, run.indexOf('\n}\n')), /sfm: placeRegisterSfmHost\(\),/)
  const host = server.slice(server.indexOf('function placeRegisterSfmHost()'))
  const body = host.slice(0, host.indexOf('\n}\n'))
  // Off unless PLACE_REGISTER_SFM=1, read from the environment each time the job runs.
  assert.match(body, /enabled: sfmEnabled\(\(name\) => process\.env\[name\]\)/)
  assert.match(body, /sessionsDir: SESSIONS_DIR/)
  // The working folder is the Place's own data directory, which removing the Place removes whole.
  assert.match(body, /projectMediaDirPath\(PROJECT_MEDIA_DIR, projectId\)/)
  assert.match(body, /`\$\{dir\}\/\$\{WORK_ROOT_DIR\}`/)
  // The server's own sidecar reader, not a second one.
  assert.match(body, /readScanMeta: async \(filename\) => readScanMeta\(filename, await loadSessionIndex\(SESSIONS_DIR\)\)/)
  assert.match(body, /placeFrameId: async \(projectId\) =>/)
})

test('source shape: what a killed run left is swept at boot, before the queue is recovered, and when every scan is cleared', () => {
  const server = read('server/main.ts')
  const boot = server.indexOf('await sweepAllWorkDirs(PROJECT_MEDIA_DIR)')
  assert.ok(boot > 0, 'a boot sweep')
  assert.ok(boot < server.indexOf('await recoverWorldJobsOnBoot()', boot - 1), 'it runs before a job left processing is requeued, so a requeued run starts on a clean folder')
  const clearAll = server.slice(server.indexOf("app.delete('/scans', async (c) =>"))
  assert.match(clearAll.slice(0, clearAll.indexOf('\n})\n')), /dropDerivedWork: \(\) => sweepAllWorkDirs\(PROJECT_MEDIA_DIR\)/)
})

test('source shape: the hook edits in the server entry stay small: one host function and four one-line hooks', () => {
  const server = read('server/main.ts')
  const host = server.slice(server.indexOf('function placeRegisterSfmHost()'))
  const lines = host.slice(0, host.indexOf('\n}\n') + 3).split('\n').length
  assert.ok(lines <= 20, `the host function is ${lines} lines`)
  // The viewer's hook is the request and one line: the rule about its answer is in the card's module.
  const viewer = read('src/viewer/viewer.ts')
  const hook = viewer.slice(viewer.indexOf('queuePhotoCheck: async (scanId: string) =>'))
  assert.ok(hook.slice(0, hook.indexOf('\n  },\n')).split('\n').length <= 16, 'the viewer hook stays small')
  // Everything else is in modules of its own.
  for (const name of ['place_register_sfm.ts', 'sfm_workspace.ts']) assert.match(server, new RegExp(`from './register/${name.replace('.', '\\.')}'`))
  assert.doesNotMatch(server, /colmap_reference/, 'the COLMAP steps are not reached from the server entry')
})
