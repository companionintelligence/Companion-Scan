/**
 * How the editors put a credential on a request (src/shared/access-token.ts, src/shared/api-base.ts). F-10, FN-069, FN-088.
 *
 * The server reads the FIRST `token` parameter only (Hono's `query('token')`), so a URL that carried the world token and
 * then the shell's session token sent a session nobody read. These pin:
 *
 *  - one `token` per URL, whatever the URL already held;
 *  - the credential each kind of URL carries: the access token on a fetch, and on an element-loaded URL the one its route
 *    checks (the world token on `/worlds/...`, the shell's session elsewhere);
 *  - that an absolute URL, which is not a path the page built, gets no credential at all;
 *  - that the editors no longer set an Authorization header of their own, which kept a native shell from adding its
 *    session Bearer (src/shared/shell-sign-in.ts).
 */
import { assertEquals } from './assert.ts'
import { accessTokenFrom, accessTokenHeaders, addAccessToken, mediaUrl } from '../../../src/shared/access-token.ts'
import { withSessionToken, withTokenParameter } from '../../../src/shared/api-base.ts'
import * as fs from 'node:fs/promises'
import { test } from 'node:test'

function tokens(url: string): string[] {
  return new URL(url, 'https://scan.invalid').searchParams.getAll('token')
}

test('accessTokenFrom: the page query token, or empty', () => {
  assertEquals(accessTokenFrom('?world=default&token=abc'), 'abc')
  assertEquals(accessTokenFrom('?world=default'), '')
  assertEquals(accessTokenFrom(''), '')
})

test('withTokenParameter: sets one token, replacing any, keeping the rest of the query and the fragment', () => {
  assertEquals(withTokenParameter('/scans/a.glb', 'T'), '/scans/a.glb?token=T')
  assertEquals(withTokenParameter('/scans/a.glb?x=1', 'T'), '/scans/a.glb?x=1&token=T')
  assertEquals(withTokenParameter('/scans/a.glb?token=OLD&x=1', 'T'), '/scans/a.glb?x=1&token=T')
  assertEquals(withTokenParameter('/scans/a.glb?token=A&token=B', 'T'), '/scans/a.glb?token=T')
  assertEquals(withTokenParameter('/scans/a.glb?x=1#frag', 'T'), '/scans/a.glb?x=1&token=T#frag')
  assertEquals(withTokenParameter('wss://scan.invalid/events', 'T'), 'wss://scan.invalid/events?token=T')
  assertEquals(withTokenParameter('/scans/a.glb?token=OLD', ''), '/scans/a.glb?token=OLD', 'no token leaves the URL alone')
  assertEquals(withTokenParameter('/scans/a.glb', null), '/scans/a.glb')
  // A parameter whose name only starts with "token" is someone else's and stays.
  assertEquals(withTokenParameter('/x?tokenizer=1', 'T'), '/x?tokenizer=1&token=T')
})

test('withSessionToken: what the scanner and sockets used keeps its output, and never adds a second token', () => {
  assertEquals(withSessionToken('wss://scan.example/events', null), 'wss://scan.example/events')
  assertEquals(withSessionToken('wss://scan.example/events', 'abc'), 'wss://scan.example/events?token=abc')
  assertEquals(withSessionToken('/rtc-signal?role=phone&room=r1', 'a+b/c'), '/rtc-signal?role=phone&room=r1&token=a%2Bb%2Fc')
  const both = withSessionToken(addAccessToken('/scans/a/frame-1.jpg', 'ACCESS'), 'SESSION')
  assertEquals(tokens(both), ['SESSION'], 'the old stacked call now carries one token')
})

test('addAccessToken: a server path gets the access token once; an absolute URL gets nothing', () => {
  assertEquals(addAccessToken('/worlds/default', 'T'), '/worlds/default?token=T')
  assertEquals(addAccessToken('/worlds/default?x=1&token=OLD', 'T'), '/worlds/default?x=1&token=T')
  assertEquals(addAccessToken('/scans/a.glb', ''), '/scans/a.glb')
  assertEquals(addAccessToken('https://splats.example/scene.spz', 'T'), 'https://splats.example/scene.spz', 'a third-party URL is never handed the token')
  assertEquals(addAccessToken('//splats.example/scene.spz', 'T'), '//splats.example/scene.spz')
})

test('mediaUrl: one token, the one the route checks', () => {
  // A browser: no shell session, so the access token everywhere.
  assertEquals(tokens(mediaUrl('/scans/a/frame-1.jpg', 'ACCESS', null)), ['ACCESS'])
  assertEquals(tokens(mediaUrl('/worlds/w/export.glb', 'ACCESS', null)), ['ACCESS'])
  // A shell with a session: the session guard reads it from the query on a session route, and the world route keeps the
  // world's token.
  assertEquals(tokens(mediaUrl('/scans/a/frame-1.jpg', 'ACCESS', 'SESSION')), ['SESSION'])
  assertEquals(tokens(mediaUrl('/scans/a.splat.ply', '', 'SESSION')), ['SESSION'])
  assertEquals(tokens(mediaUrl('/worlds/w/export.glb', 'ACCESS', 'SESSION')), ['ACCESS'])
  // Nothing to add: unchanged.
  assertEquals(mediaUrl('/scans/a.splat.ply', '', null), '/scans/a.splat.ply')
  // An absolute URL is not built by the page and gets nothing.
  assertEquals(mediaUrl('https://elsewhere.example/a.jpg', 'ACCESS', 'SESSION'), 'https://elsewhere.example/a.jpg')
})

test('accessTokenHeaders keeps its old meaning for any importer, and the editors no longer call it', async () => {
  assertEquals(accessTokenHeaders('T', { 'Content-Type': 'application/json' }), { 'Content-Type': 'application/json', Authorization: 'Bearer T' })
  assertEquals(accessTokenHeaders('', { a: '1' }), { a: '1' })
  for (const file of ['src/viewer/viewer.ts', 'src/viewer/xr-world.ts', 'src/viewer/places.ts']) {
    const source = await fs.readFile(new URL(`../../../${file}`, import.meta.url), 'utf8')
    assertEquals(/accessTokenHeaders\(|accessHeaders\(/.test(source), false, `${file} sets no Authorization of its own`)
  }
})

test('no editor URL stacks the session token on the access token any more', async () => {
  for (const file of ['src/viewer/viewer.ts', 'src/viewer/xr-world.ts', 'src/viewer/splat-layer.ts', 'src/viewer/splat4d-layer.ts']) {
    const source = await fs.readFile(new URL(`../../../${file}`, import.meta.url), 'utf8')
    assertEquals(/withSessionToken\(\s*withAccessToken/.test(source), false, `${file} builds one token per URL`)
  }
})
