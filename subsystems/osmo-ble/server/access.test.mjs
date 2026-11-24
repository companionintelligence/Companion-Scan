import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseAccessSettings, describeAccess, bareOrigin, requestHostname, isLoopbackHost,
  originDecision, tokenDecision, decideAccess, corsHeaders, servedFilePath, parseBindHost, DEFAULT_WEB_PORT,
} from './access.mjs';

// The access rules for the gimbal backend (F-12) and the page server, as pure functions. The
// backend applies them in server/backend-access.test.mjs; this file pins the rules themselves.

const DEFAULTS = parseAccessSettings({});
const TOKEN = 'a-test-token-that-is-long-enough';
const WITH_TOKEN = parseAccessSettings({ OSMO_BACKEND_TOKEN: TOKEN });

test('defaults keep the old reachability: no token, every interface, the page origin rule', () => {
  assert.equal(DEFAULTS.token, null);
  assert.equal(DEFAULTS.host, null);
  assert.deepEqual(DEFAULTS.origins, { mode: 'page', webPort: DEFAULT_WEB_PORT });
  assert.deepEqual(DEFAULTS.problems, []);
  assert.match(describeAccess(DEFAULTS), /token: not set; bind: every interface/);
});

test('settings: a blank value is unset, * anywhere in the list is any origin, junk entries are reported', () => {
  const blank = parseAccessSettings({ OSMO_BACKEND_TOKEN: '   ', BACKEND_ALLOWED_ORIGINS: ' ', BACKEND_HOST: ' ' });
  assert.equal(blank.token, null);
  assert.equal(blank.origins.mode, 'page');
  assert.equal(blank.host, null);

  assert.equal(parseAccessSettings({ BACKEND_ALLOWED_ORIGINS: '*' }).origins.mode, 'any');
  assert.equal(parseAccessSettings({ BACKEND_ALLOWED_ORIGINS: 'http://a.example:8787, *' }).origins.mode, 'any');

  const listed = parseAccessSettings({ BACKEND_ALLOWED_ORIGINS: 'http://rig.example:8787/, ftp://x.example, https://Scan.Example' });
  assert.equal(listed.origins.mode, 'list');
  assert.deepEqual([...listed.origins.list].sort(), ['http://rig.example:8787', 'https://scan.example']);
  assert.equal(listed.problems.length, 1);
  assert.match(listed.problems[0], /ftp:\/\/x\.example/);

  assert.equal(parseAccessSettings({ BACKEND_HOST: ' 127.0.0.1 ' }).host, '127.0.0.1');
  assert.equal(parseBindHost(undefined), null);
});

test('settings: a short token is accepted, with a warning; the token never appears in the description', () => {
  const short = parseAccessSettings({ OSMO_BACKEND_TOKEN: 'abc' });
  assert.equal(short.token, 'abc');
  assert.match(short.problems[0], /3 characters/);
  assert.ok(!describeAccess(WITH_TOKEN).includes(TOKEN));
  assert.match(describeAccess(WITH_TOKEN), /token: required/);
});

test('bareOrigin takes a whole http(s) origin and nothing that is not one', () => {
  assert.equal(bareOrigin('http://rig.example:8787'), 'http://rig.example:8787');
  assert.equal(bareOrigin('HTTP://RIG.example:80'), 'http://rig.example');
  for (const bad of ['null', '', 'file:///x', 'http://a.example/path', 'http://u:p@a.example', 'http://a.example?x=1', 'not a url', undefined, 7]) {
    assert.equal(bareOrigin(bad), null, JSON.stringify(bad));
  }
});

test('request host and loopback names', () => {
  assert.equal(requestHostname('Rig.Example:8788'), 'rig.example');
  assert.equal(requestHostname('[::1]:8788'), '[::1]');
  assert.equal(requestHostname(''), null);
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['localhost.example', '128.0.0.1', '0.0.0.0', 'rig.example']) assert.equal(isLoopbackHost(h), false, h);
});

test('origin: a request with no Origin header (CLI, MCP, curl) is never refused for its origin', () => {
  for (const origin of [undefined, null, '']) {
    assert.deepEqual(originDecision({ origin, hostHeader: 'rig.example:8788', settings: DEFAULTS }), { ok: true, browser: false });
  }
});

test('origin, by default: the control page on port 8787 of the host the backend was reached at', () => {
  const ok = (origin, hostHeader) => originDecision({ origin, hostHeader, settings: DEFAULTS }).ok;
  assert.equal(ok('http://rig.example:8787', 'rig.example:8788'), true, 'the documented rig: same name, page port');
  assert.equal(ok('http://localhost:8787', 'localhost:8788'), true);
  assert.equal(ok('http://127.0.0.1:8787', 'localhost:8788'), true, 'loopback page to loopback backend, any spelling');
  assert.equal(ok('http://[::1]:8787', '127.0.0.1:8788'), true);

  assert.equal(ok('http://rig.example:5173', 'rig.example:8788'), false, 'another port on the same host is another page');
  assert.equal(ok('https://evil.example', 'rig.example:8788'), false, 'a site the operator happens to have open');
  assert.equal(ok('http://rig.example.evil.example:8787', 'rig.example:8788'), false, 'a longer host is not the host');
  assert.equal(ok('http://localhost:8787', 'rig.example:8788'), false, "a page on the browser's own localhost is not this machine's page");
  assert.equal(ok('null', 'rig.example:8788'), false, 'an opaque origin is never admitted');
  assert.equal(ok('http://rig.example:8787', undefined), false, 'no Host header, nothing to match against');
});

test('origin refusals say which setting to change, and name the origin to add', () => {
  const refused = originDecision({ origin: 'https://evil.example', hostHeader: 'rig.example:8788', settings: DEFAULTS });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.match(refused.remediation, /BACKEND_ALLOWED_ORIGINS=https:\/\/evil\.example/);
  assert.match(refused.remediation, /'\*'/);
  const opaque = originDecision({ origin: 'null', hostHeader: 'rig.example:8788', settings: DEFAULTS });
  assert.match(opaque.remediation, /opaque origin/);
});

test('origin, with an explicit list: exactly those origins, whatever the host; * admits anything', () => {
  const settings = parseAccessSettings({ BACKEND_ALLOWED_ORIGINS: 'https://scan.example:5173' });
  assert.equal(originDecision({ origin: 'https://scan.example:5173', hostHeader: 'other:8788', settings }).ok, true);
  assert.equal(originDecision({ origin: 'http://rig.example:8787', hostHeader: 'rig.example:8788', settings }).ok, false, 'a list replaces the default');
  const any = parseAccessSettings({ BACKEND_ALLOWED_ORIGINS: '*' });
  assert.equal(originDecision({ origin: 'https://evil.example', hostHeader: 'x', settings: any }).ok, true);
  assert.equal(originDecision({ origin: 'null', hostHeader: 'x', settings: any }).ok, true, '* is the old behaviour, exactly');
});

test('token: off unless set; then a Bearer header, and the query form only on the WebSocket', () => {
  assert.deepEqual(tokenDecision({ settings: DEFAULTS }), { ok: true });
  assert.equal(tokenDecision({ authorization: `Bearer ${TOKEN}`, settings: WITH_TOKEN }).ok, true);
  assert.equal(tokenDecision({ authorization: `bearer   ${TOKEN}  `, settings: WITH_TOKEN }).ok, true);

  const missing = tokenDecision({ settings: WITH_TOKEN });
  assert.equal(missing.status, 401);
  assert.equal(missing.error, 'This backend needs a token.');
  const wrong = tokenDecision({ authorization: 'Bearer nope', settings: WITH_TOKEN });
  assert.equal(wrong.error, 'Wrong backend token.', 'a different length is a plain refusal, not a throw');
  assert.equal(tokenDecision({ authorization: `Bearer ${TOKEN.slice(0, -1)}x`, settings: WITH_TOKEN }).ok, false);
  assert.equal(tokenDecision({ authorization: `Basic ${TOKEN}`, settings: WITH_TOKEN }).ok, false);

  assert.equal(tokenDecision({ queryToken: TOKEN, settings: WITH_TOKEN }).ok, false, 'no query tokens on plain HTTP');
  assert.equal(tokenDecision({ queryToken: TOKEN, settings: WITH_TOKEN, allowQuery: true }).ok, true);
  for (const refusal of [missing, wrong]) assert.ok(!JSON.stringify(refusal).includes(TOKEN), 'a refusal never carries the token');
});

test('decideAccess: preflight passes untouched; origin is judged before the token', () => {
  assert.equal(decideAccess({ method: 'OPTIONS', origin: 'https://evil.example', settings: WITH_TOKEN }).ok, true);
  const both = decideAccess({ method: 'POST', origin: 'https://evil.example', hostHeader: 'rig.example:8788', settings: WITH_TOKEN });
  assert.equal(both.status, 403);
  assert.equal(decideAccess({ method: 'POST', hostHeader: 'rig.example:8788', settings: WITH_TOKEN }).status, 401);
  assert.equal(decideAccess({ method: 'POST', hostHeader: 'rig.example:8788', authorization: `Bearer ${TOKEN}`, settings: WITH_TOKEN }).ok, true);
  // A WebSocket upgrade is a GET with a token in the query, and is never a preflight.
  assert.equal(decideAccess({ method: 'GET', upgrade: true, origin: 'http://rig.example:8787', hostHeader: 'rig.example:8788', queryToken: TOKEN, settings: WITH_TOKEN }).ok, true);
  assert.equal(decideAccess({ method: 'OPTIONS', upgrade: true, hostHeader: 'rig.example:8788', settings: WITH_TOKEN }).status, 401);
});

test('CORS: * only when configured; otherwise the origin is reflected, never "null", and Authorization is allowed', () => {
  assert.equal(corsHeaders({ origin: 'https://a.example', settings: parseAccessSettings({ BACKEND_ALLOWED_ORIGINS: '*' }) })['Access-Control-Allow-Origin'], '*');
  const reflected = corsHeaders({ origin: 'http://rig.example:8787', settings: DEFAULTS });
  assert.equal(reflected['Access-Control-Allow-Origin'], 'http://rig.example:8787');
  assert.equal(reflected.Vary, 'Origin');
  assert.match(reflected['Access-Control-Allow-Headers'], /Authorization/);
  assert.equal(corsHeaders({ origin: undefined, settings: DEFAULTS })['Access-Control-Allow-Origin'], undefined);
  assert.equal(corsHeaders({ origin: 'null', settings: DEFAULTS })['Access-Control-Allow-Origin'], undefined);
});

test('page server: only web/ and protocol/, no sibling-prefix escape, and a bad escape is a 400', () => {
  const root = path.resolve('/srv/osmo-ble');
  assert.deepEqual(servedFilePath(root, '/web/index.html?v=1'), { file: path.join(root, 'web', 'index.html') });
  assert.deepEqual(servedFilePath(root, '/protocol/dome.mjs'), { file: path.join(root, 'protocol', 'dome.mjs') });
  for (const url of ['/.cli-state.json', '/server/cli.mjs', '/node_modules/ws/index.js', '/package.json', '/web', '/../osmo-ble-other/x', '/web/../server/backend.mjs', '/%2e%2e/osmo-ble-other/x']) {
    assert.deepEqual(servedFilePath(root, url), { status: 404 }, url);
  }
  // The service worker precaches './' (= /web/); a 404 there failed its whole install.
  assert.deepEqual(servedFilePath(root, '/web/'), { file: path.join(root, 'web', 'index.html') });
  assert.deepEqual(servedFilePath(root, '/'), { status: 404 }, 'the root itself is not served (the server redirects it)');
  assert.deepEqual(servedFilePath(root, '/web/%E0%A4%A'), { status: 400 });
  assert.deepEqual(servedFilePath(root, '/web/a%00.html'), { status: 400 });
});
