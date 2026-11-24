/**
 * Who may do what on a world route (wave 14 ticket 0001): F-02, F-03, F-04 and F-05, over HTTP against the real
 * server (server_core_harness.ts), on an install that is open by design and on one with sign-in on.
 *
 *   F-02  GET /worlds/:slug/share gives the links at or below the caller's role. Only an owner gets the owner link.
 *   F-03  A request for a world that has no file answers 404 and writes nothing. `default` and a known Place's
 *         `project-<id>` are still built on first read; POST /worlds makes the rest.
 *   F-04  With strict world auth off, the jobs that send data off the box or delete it need an editor token or a
 *         Companion session. The others keep the open default.
 *   F-05  A Companion session sent as Bearer or ?token= is never answered 403 "invalid world token" on a world route.
 */
import { assert, assertEquals, assertFalse, assertMatch } from './assert.ts'
import {
  companionSession,
  defaultWorldTokens,
  filesUnder,
  type RunningServer,
  SIGN_IN_ON,
  startServer,
  TEST_EMAIL,
  TEST_SESSION_SECRET,
} from './server_core_harness.ts'
import { test } from 'node:test'

type ShareReply = { role: string | null; links: Record<string, string> }

async function worldFiles(server: RunningServer): Promise<string[]> {
  return (await filesUnder(server.worldsDir)).filter((name) => name.endsWith('.json'))
}

/** An open install that can still verify a session: the secret and the allowlist are set, sign-in is not switched on. */
const OPEN_WITH_SESSIONS = { SESSION_SECRET: TEST_SESSION_SECRET, PORTAL_OIDC_ALLOWED_EMAILS: TEST_EMAIL }

test('world access, an install open by design', async (t) => {
  const server = await startServer(OPEN_WITH_SESSIONS)
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    const tokens = await defaultWorldTokens(server)
    const session = await companionSession()

    await t.test('F-03: a world that has no file is a 404 on every route, and none is written', async () => {
      const before = await worldFiles(server)
      for (const path of ['', '/patches', '/comments', '/jobs', '/share', '/frames/scan-x', '/export.glb']) {
        const reply = await server.get(`/worlds/never-made${path}`)
        assertEquals(reply.status, 404, why(`GET /worlds/never-made${path}`))
      }
      assertEquals((await server.post('/worlds/never-made/jobs', { type: 'export-world' })).status, 404, why('POST jobs'))
      assertEquals((await server.post('/worlds/never-made/comments', { body: 'hello' })).status, 404, why('POST comments'))
      assertEquals(
        (await server.post('/worlds/never-made/patches', { scope: 'world', targetId: 'note', notes: 'x' })).status,
        404,
        why('POST patches'),
      )
      assertEquals((await server.post('/worlds/never-made/patches/revert', {})).status, 404, why('POST revert'))
      // A token or a session does not make one either.
      assertEquals((await server.get('/worlds/never-made', { token: tokens.owner })).status, 404)
      assertEquals((await server.get('/worlds/never-made', { bearer: session })).status, 404)
      assertEquals(await worldFiles(server), before, 'no world file was written')
    })

    await t.test('F-03: POST /worlds still makes a world, and a known Place\'s world is built on first read', async () => {
      const made = await server.post('/worlds', { shareSlug: 'made-by-post', name: 'Made by post' })
      assertEquals(made.status, 201, why('POST /worlds'))
      assertEquals((await server.get('/worlds/made-by-post')).status, 200, why('the world POST made'))

      const place = await server.post('/projects', { name: 'A Place' })
      assertEquals(place.status, 201, why('POST /projects'))
      const projectId = place.json<{ projectId: string }>().projectId
      const read = await server.get(`/worlds/project-${projectId}`)
      assertEquals(read.status, 200, why('a known Place\'s world'))
      assertEquals(read.json<{ projectId: string }>().projectId, projectId, 'built with its projectId, like GET /projects/:id/world')
      assertEquals((await server.get('/worlds/project-proj-not-a-place')).status, 404, why('a Place the registry does not hold'))
    })

    await t.test('F-02: each role gets the links at or below it; only the owner gets the owner link', async () => {
      const share = async (opts: { token?: string; bearer?: string }) => {
        const reply = await server.get('/worlds/default/share', opts)
        return { status: reply.status, body: reply.status === 200 ? reply.json<ShareReply>() : null, text: reply.text }
      }
      const owner = await share({ token: tokens.owner })
      assertEquals(owner.status, 200, owner.text)
      assertEquals(Object.keys(owner.body!.links).sort(), ['commenter', 'editor', 'owner', 'scanner', 'viewer'])
      assertMatch(owner.body!.links.owner, new RegExp(`token=${tokens.owner}$`))

      const editor = await share({ token: tokens.editor })
      assertEquals(editor.status, 200, editor.text)
      assertEquals(editor.body!.role, 'editor')
      assertEquals(Object.keys(editor.body!.links).sort(), ['commenter', 'editor', 'scanner', 'viewer'])
      assertFalse(editor.text.includes(tokens.owner), 'the owner token appears nowhere in an editor\'s reply')

      // An open install lets a request with no token act as an editor, as it always has, never as the owner.
      const anonymous = await share({})
      assertEquals(anonymous.status, 200, anonymous.text)
      assertEquals(anonymous.body!.role, 'editor')
      assertFalse(anonymous.text.includes(tokens.owner), 'no owner token for a caller with no token')
      assertEquals(Object.keys(anonymous.body!.links).sort(), ['commenter', 'editor', 'scanner', 'viewer'])

      assertEquals((await share({ token: tokens.viewer })).status, 403, 'below editor, the route refuses as before')
    })

    await t.test('F-04: off-box and deleting jobs need an editor token or a session; the rest keep the default', async () => {
      for (const body of [
        { type: 'memory-push', scanId: 'scan-not-there' },
        { type: 'thing-interactive-asset', scanId: 'scan-not-there', payload: { keyframe: 'kf-00000.jpg' } },
        { type: 'keyframe-purge', payload: { dryRun: false } },
      ]) {
        const refused = await server.post('/worlds/default/jobs', body)
        assertEquals(refused.status, 401, why(`${body.type} with no token`))
        assertMatch(refused.json<{ error: string }>().error, /editor token .* or a Companion sign-in/)
        assertEquals((await server.post('/worlds/default/jobs', body, { token: tokens.viewer })).status, 403, `${body.type}, viewer token`)
      }
      const withEditor = await server.post('/worlds/default/jobs', { type: 'memory-push', scanId: 'scan-not-there' }, { token: tokens.editor })
      assertEquals(withEditor.status, 202, why('memory-push with an editor token'))
      const withSession = await server.post('/worlds/default/jobs', { type: 'keyframe-purge', payload: { dryRun: false } }, { bearer: session })
      assertEquals(withSession.status, 202, why('a real purge with a Companion session'))
      // A dry run deletes nothing, and the jobs that stay on the box keep the open default.
      assertEquals((await server.post('/worlds/default/jobs', { type: 'keyframe-purge', payload: { dryRun: true } })).status, 202)
      assertEquals((await server.post('/worlds/default/jobs', { type: 'export-world' })).status, 202)
    })

    await t.test('F-05: a session as Bearer or ?token= is not a bad world token', async () => {
      for (const path of ['/worlds/default', '/worlds/default/patches', '/worlds/default/comments', '/worlds/default/jobs']) {
        assertEquals((await server.get(path, { bearer: session })).status, 200, why(`${path}, session as Bearer`))
        assertEquals((await server.get(path, { token: session })).status, 200, why(`${path}, session as ?token=`))
      }
      assertEquals((await server.get('/worlds/default/share', { bearer: session })).status, 200, 'share, session as Bearer')
      const patch = await server.post('/worlds/default/patches', { scope: 'world', targetId: 'note', notes: 'from a shell' }, { bearer: session })
      assertEquals(patch.status, 200, why('an open install takes a patch with a session, as with no token'))
      // A member token next to the session still names the member.
      const both = await server.post('/worlds/default/comments', { body: 'both' }, { token: tokens.commenter, bearer: session })
      assertEquals(both.status, 201, why('commenter token beside a session'))
      assertEquals(both.json<{ actorRole: string }>().actorRole, 'commenter')
      // Something that is neither is refused as before.
      assertEquals((await server.get('/worlds/default', { bearer: 'not-a-token' })).status, 403)
      // A session of an account that is not on the allowlist is not a session here.
      assertEquals((await server.get('/worlds/default', { bearer: await companionSession('someone@example.com') })).status, 403)
      assertEquals((await server.get('/projects/proj-default/world', { bearer: session })).status !== 403, true)
    })
  } finally {
    await server.stop()
  }
})

test('world access, sign-in on (strict world auth)', async (t) => {
  const server = await startServer(SIGN_IN_ON)
  const why = (what: string) => `${what}\n${server.log()}`
  try {
    const tokens = await defaultWorldTokens(server)
    const session = await companionSession()

    await t.test('F-05: a signed-in shell reads a world with its session, and still needs the world token to write', async () => {
      for (const path of ['/worlds/default', '/worlds/default/patches', '/worlds/default/comments', '/worlds/default/jobs']) {
        assertEquals((await server.get(path, { bearer: session })).status, 200, why(`${path}, session as Bearer`))
      }
      const note = { scope: 'world', targetId: 'note', notes: 'x' }
      assertEquals((await server.post('/worlds/default/patches', note, { bearer: session })).status, 401, why('session alone, a write'))
      assertEquals((await server.post('/worlds/default/patches', note, { token: tokens.editor, bearer: session })).status, 200, why('editor token beside the session'))
      assertEquals((await server.get('/worlds/default/frames/scan-x', { bearer: session })).status, 401, why('frames need a viewer token'))
      assertEquals((await server.get('/worlds/default', { bearer: 'not-a-token' })).status, 403)
    })

    await t.test('F-02: no token, no links; an editor never gets the owner link', async () => {
      assertEquals((await server.get('/worlds/default/share')).status, 401)
      const editor = await server.get('/worlds/default/share', { token: tokens.editor })
      assertEquals(editor.status, 200, editor.text)
      assert(!('owner' in editor.json<ShareReply>().links))
      assert('owner' in (await server.get('/worlds/default/share', { token: tokens.owner })).json<ShareReply>().links)
    })

    await t.test('F-03: no world is made by a read, signed in or not', async () => {
      const before = await worldFiles(server)
      assertEquals((await server.get('/worlds/never-made')).status, 404)
      assertEquals((await server.get('/worlds/never-made', { bearer: session })).status, 404)
      assertEquals(await worldFiles(server), before)
    })

    await t.test('F-04: strict mode already asks every job for an editor token', async () => {
      assertEquals((await server.post('/worlds/default/jobs', { type: 'export-world' })).status, 401)
      assertEquals((await server.post('/worlds/default/jobs', { type: 'memory-push', scanId: 'x' }, { bearer: session })).status, 401)
      assertEquals((await server.post('/worlds/default/jobs', { type: 'export-world' }, { token: tokens.editor })).status, 202)
    })
  } finally {
    await server.stop()
  }
})
