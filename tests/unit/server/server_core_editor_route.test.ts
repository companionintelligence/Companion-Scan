/**
 * FN-070: `/editor/?…` reaches the editor on `vite dev` as it does on the server's static handler.
 *
 * Both servers ask server/wp-a-static.ts. The Vite middleware used to compare the whole `req.url` (path and query)
 * and knew only `/editor`, `/editor/` and `/editor?…`, so a share link written as `/editor/?world=…` fell through to
 * the scanner start screen in dev.
 *
 *   node --test tests/unit/server/server_core_editor_route.test.ts
 */
import { assert, assertEquals } from './assert.ts'
import { rewriteEditorPath } from '../../../server/wp-a-static.ts'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('editor route: the four editor forms reach viewer.html with their query', () => {
  assertEquals(rewriteEditorPath('/editor'), '/viewer.html')
  assertEquals(rewriteEditorPath('/editor/'), '/viewer.html')
  assertEquals(rewriteEditorPath('/editor?world=a'), '/viewer.html?world=a')
  assertEquals(rewriteEditorPath('/editor/?world=a&token=t'), '/viewer.html?world=a&token=t')
})

test('editor route: anything else is not the editor', () => {
  for (const path of ['/', '/editorx', '/editor/x', '/viewer.html', '/x/editor', '/editor.html']) {
    assertEquals(rewriteEditorPath(path), null, path)
  }
})

test('editor route: main.ts asks the rule, and vite.config.ts keeps the same body', async () => {
  const read = (rel: string) => fs.readFile(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8')
  const [main, vite, rule] = await Promise.all([read('server/main.ts'), read('vite.config.ts'), read('server/wp-a-static.ts')])
  assert(main.includes('rewriteEditorPath(p)'), 'the server static handler')
  assert(vite.includes('rewriteEditorPath(req.url'), 'the Vite dev middleware')
  // vite.config.ts cannot import server/ (the Docker stage that builds the bundle has none), so it keeps a copy.
  assert(!/from '\.\/server\//.test(vite), 'vite.config.ts imports nothing from server/')
  const body = (text: string) => {
    const start = text.indexOf('function rewriteEditorPath(pathWithQuery: string): string | null {')
    assert(start !== -1, 'the function is there')
    return text.slice(start, text.indexOf('\n}\n', start)).replace(/\s+/g, ' ')
  }
  assertEquals(body(vite), body(rule), 'the two copies of the rule are the same')
})
