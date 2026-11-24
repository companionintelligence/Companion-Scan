/**
 * Sign-in fixes in server/portal_auth.ts (wave 14 ticket 0001):
 *
 *   F-10  The Quest app signs in through the shell flow: `shell=quest` ends in its own fixed URL,
 *         com.companionintelligence.scan.quest://auth, with a one-time code (wave 13 ticket 0010's contract).
 *   F-11  whoami's cookie branch applies PORTAL_OIDC_ALLOWED_EMAILS, like its other two branches; and sign-in switched
 *         on with no issuer stops the server at boot instead of installing a guard nobody can pass.
 *
 * The flow is driven in-process with app.request() and a loopback stub Portal, as portal_auth.test.ts does. The boot
 * check spawns the real server (server_core_harness.ts).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from './assert.ts'
import { Hono } from 'hono'
import {
  createPkcePair,
  DESKTOP_RETURN_URL,
  type PortalAuthConfig,
  portalConfigProblem,
  QUEST_RETURN_URL,
  registerPortalAuth,
  SHELL_RETURN_URL,
  shellReturnFor,
  signSession,
} from '../../../server/portal_auth.ts'
import { bootOutcome } from './server_core_harness.ts'
import { test } from 'node:test'
import { serveFetch } from './http_server.ts'

const SECRET = 'server-core-portal-secret'

function config(issuer: string, allowed: string[]): PortalAuthConfig {
  return {
    enabled: true,
    issuerUrl: issuer,
    clientId: 'ci-web-xr-scan',
    publicBaseUrl: 'https://scan.example',
    allowedEmails: allowed,
    jwksUri: '',
    audience: ['ci-web-xr-scan'],
    sessionSecret: SECRET,
    sessionTtlSec: 3600,
  }
}

async function stubPortal(email: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await serveFetch((req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/auth/.well-known/openid-configuration') {
      return Response.json({
        issuer: u.origin,
        authorization_endpoint: `${u.origin}/api/auth/oauth2/authorize`,
        token_endpoint: `${u.origin}/api/auth/oauth2/token`,
        userinfo_endpoint: `${u.origin}/api/auth/oauth2/userinfo`,
        jwks_uri: `${u.origin}/api/auth/jwks`,
      })
    }
    if (u.pathname === '/api/auth/oauth2/token') return Response.json({ access_token: 'stub-access' })
    if (u.pathname === '/api/auth/oauth2/userinfo') {
      return Response.json({ sub: 'portal-user-1', email, email_verified: true, name: 'Test User' })
    }
    return new Response('not found', { status: 404 })
  })
  return { url: server.url, close: () => server.close() }
}

function app(cfg: PortalAuthConfig): Hono {
  const hono = new Hono()
  registerPortalAuth(hono, cfg, { ownerDestination: () => Promise.resolve('/editor?world=default&token=owner-tok') })
  return hono
}

function cookiesFrom(res: Response): Map<string, string> {
  const jar = new Map<string, string>()
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';')
    const eq = pair.indexOf('=')
    jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)))
  }
  return jar
}

test('quest: shell=quest is the Quest app, at the contract\'s fixed URL, and nothing else names it', () => {
  assertEquals(QUEST_RETURN_URL, 'com.companionintelligence.scan.quest://auth')
  assertEquals(shellReturnFor('quest'), QUEST_RETURN_URL)
  assertEquals(shellReturnFor('1'), SHELL_RETURN_URL)
  assertEquals(shellReturnFor('desktop'), DESKTOP_RETURN_URL)
  for (const other of ['Quest', 'quest ', 'meta', QUEST_RETURN_URL, 'https://evil.example', null, undefined]) {
    assertEquals(shellReturnFor(other), null, String(other))
  }
})

test('quest: initiate marks the Quest app; the callback ends in its scheme; the code trades for a token once', async () => {
  const portal = await stubPortal('owner@example.com')
  try {
    const hono = app(config(portal.url, ['owner@example.com']))
    const { verifier, challenge } = await createPkcePair()
    const init = await hono.request(`https://scan.example/authenticate/oidc?shell=quest&challenge=${challenge}`)
    assertEquals(init.status, 302)
    const jar = cookiesFrom(init)
    assertEquals(jar.get('oidc_shell_app'), 'quest')
    assertEquals(jar.get('oidc_shell'), challenge)

    const cb = await hono.request(
      `https://scan.example/authenticate/oidc/callback?code=authcode&state=${jar.get('oidc_state')}`,
      {
        headers: {
          cookie: `oidc_state=${jar.get('oidc_state')}; oidc_pkce=${jar.get('oidc_pkce')}; oidc_shell=${challenge}; oidc_shell_app=quest`,
        },
      },
    )
    assertEquals(cb.status, 302, await cb.text())
    const location = cb.headers.get('location')!
    assert(location.startsWith(`${QUEST_RETURN_URL}?code=`), location)
    assertEquals(cookiesFrom(cb).has('cs_session'), false, 'the app gets a code, not a cookie')

    const code = new URL(location.replace(QUEST_RETURN_URL, 'https://x.invalid/')).searchParams.get('code')!
    const exchange = () =>
      hono.request('https://scan.example/authenticate/shell/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
      })
    const first = await exchange()
    assertEquals(first.status, 200)
    const { token } = await first.json() as { token: string }
    const who = await hono.request('https://scan.example/authenticate/whoami', { headers: { authorization: `Bearer ${token}` } })
    assertEquals(who.status, 200)
    assertEquals((await who.json() as { via: string }).via, 'shell-token')
    assertEquals((await exchange()).status, 400, 'single use')
  } finally {
    await portal.close()
  }
})

test('quest: a mark that names no app ends in the phone app, as a sign-in with no mark always has', async () => {
  const portal = await stubPortal('owner@example.com')
  try {
    const hono = app(config(portal.url, ['owner@example.com']))
    const { challenge } = await createPkcePair()
    const jar = cookiesFrom(await hono.request(`https://scan.example/authenticate/oidc?shell=1&challenge=${challenge}`))
    const cb = await hono.request(
      `https://scan.example/authenticate/oidc/callback?code=authcode&state=${jar.get('oidc_state')}`,
      {
        headers: {
          cookie: `oidc_state=${jar.get('oidc_state')}; oidc_pkce=${jar.get('oidc_pkce')}; oidc_shell=${challenge}; oidc_shell_app=https://evil.example`,
        },
      },
    )
    assert(cb.headers.get('location')!.startsWith(`${SHELL_RETURN_URL}?code=`), cb.headers.get('location')!)
  } finally {
    await portal.close()
  }
})

test('whoami: the session cookie of an account taken off the allowlist is refused', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const listed = await signSession({ sub: 'a', email: 'owner@example.com', exp }, SECRET)
  const removed = await signSession({ sub: 'b', email: 'former@example.com', exp }, SECRET)
  const hono = app(config('https://portal.example', ['owner@example.com']))
  const ask = (session: string) =>
    hono.request('https://scan.example/authenticate/whoami', { headers: { cookie: `cs_session=${encodeURIComponent(session)}` } })
  const ok = await ask(listed)
  assertEquals(ok.status, 200)
  assertEquals((await ok.json() as { via: string; email: string }).email, 'owner@example.com')
  const refused = await ask(removed)
  assertEquals(refused.status, 403, 'the cookie branch applies PORTAL_OIDC_ALLOWED_EMAILS')
  assertStringIncludes(await refused.text(), 'Not authorized')
})

test('boot check: sign-in on with no issuer is a problem; with one, or off, it is not', () => {
  const on = config('', ['owner@example.com'])
  const problem = portalConfigProblem(on)
  assert(problem !== null)
  assertMatch(problem, /PORTAL_OIDC_ENABLED/)
  assertMatch(problem, /OIDC_ISSUER_URL/)
  assertEquals(portalConfigProblem(config('https://portal.example', [])), null)
  assertEquals(portalConfigProblem({ ...on, enabled: false }), null)
})

test('boot check: the server stops at boot, with the reason, and never listens', async () => {
  const { exitCode, output } = await bootOutcome({ PORTAL_OIDC_ENABLED: '1', PORTAL_OIDC_ALLOWED_EMAILS: 'owner@example.com' })
  assertEquals(exitCode, 1, output)
  assertStringIncludes(output, 'OIDC_ISSUER_URL is empty')
  assert(!/Listening on/.test(output), 'it never served a request')
})
