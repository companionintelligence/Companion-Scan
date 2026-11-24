import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { OsmoBleTransport } from './ble-transport.mjs';

// F-12 through the real request handler and the real WebSocket server of server/backend.mjs. The
// backend is started with a token and the default origin rule. The link is reported as up, and
// every frame the backend would write is recorded, so "refused" can be checked as "nothing sent".
// HTTP requests are emitted at the module's `server` without listening. The WebSocket tests
// listen on an ephemeral loopback port, because an upgrade needs a real socket.
process.env.BACKEND_NO_LISTEN = '1';
const TOKEN = 'backend-access-test-token-0123456789';
process.env.OSMO_BACKEND_TOKEN = TOKEN;
delete process.env.BACKEND_ALLOWED_ORIGINS;
delete process.env.BACKEND_HOST;

const sent = [];
Object.defineProperty(OsmoBleTransport.prototype, 'connected', { get: () => true, configurable: true });
Object.defineProperty(OsmoBleTransport.prototype, 'linked', { get: () => true, configurable: true });
OsmoBleTransport.prototype.sendRaw = async function sendRaw(frame) {
  sent.push(Uint8Array.from(frame));
};

const { server, relayInboundForTest } = await import('./backend.mjs');

const SPEED = { type: 'speed', params: { yawDegPerSec: 30 } };
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** One request through the real handler, with whatever headers a test gives. */
function call(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
    const req = Readable.from(raw);
    req.method = method;
    req.url = path;
    req.headers = { host: 'rig.example:8788', ...headers };
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(code, responseHeaders = {}) {
        this.statusCode = code;
        this.headers = responseHeaders;
        this.headersSent = true;
      },
      write(chunk) {
        chunks.push(String(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(String(chunk));
        const text = chunks.join('');
        resolve({ status: this.statusCode, headers: this.headers, body: text ? JSON.parse(text) : null });
      },
    };
    server.emit('request', req, res);
  });
}

beforeEach(() => {
  sent.length = 0;
});

test('a page on another origin cannot move the gimbal: 403 before any handler, and nothing is sent', async () => {
  const r = await call('POST', '/api/command', SPEED, { origin: 'https://evil.example', ...AUTH });
  assert.equal(r.status, 403);
  assert.match(r.body.remediation, /BACKEND_ALLOWED_ORIGINS=https:\/\/evil\.example/);
  assert.equal(sent.length, 0);
  // The refusal is readable by the page that made it, so a misconfigured page can show it.
  assert.equal(r.headers['Access-Control-Allow-Origin'], 'https://evil.example');
});

test('a "simple" cross-site POST with no Content-Type is refused the same way; CORS alone never stopped it', async () => {
  const r = await call('POST', '/api/command', JSON.stringify(SPEED), { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(sent.length, 0);
});

test('without the token: 401, nothing sent, and the refusal does not carry the token', async () => {
  const r = await call('POST', '/api/command', SPEED);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'This backend needs a token.');
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  assert.equal(sent.length, 0);
  const wrong = await call('POST', '/api/command', SPEED, { authorization: 'Bearer not-the-token' });
  assert.equal(wrong.status, 401);
  assert.equal(sent.length, 0);
});

test('with the token and no Origin (the CLI, the MCP server, curl): the command goes out', async () => {
  const r = await call('POST', '/api/command', SPEED, AUTH);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 1);
});

test('the control page on its own origin, with the token: allowed, and its origin is reflected', async () => {
  const r = await call('GET', '/api/status', undefined, { origin: 'http://rig.example:8787', ...AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.headers['Access-Control-Allow-Origin'], 'http://rig.example:8787');
  assert.equal(r.headers.Vary, 'Origin');
  const lookalike = await call('GET', '/api/status', undefined, { origin: 'http://rig.example.evil.example:8787', ...AUTH });
  assert.equal(lookalike.status, 403);
});

test('a token in the query is not accepted on plain HTTP', async () => {
  const r = await call('POST', `/api/command?token=${TOKEN}`, SPEED);
  assert.equal(r.status, 401);
  assert.equal(sent.length, 0);
});

test('the preflight is answered without the token, and allows the Authorization header', async () => {
  const r = await call('OPTIONS', '/api/command', undefined, { origin: 'http://rig.example:8787' });
  assert.equal(r.status, 204);
  assert.match(r.headers['Access-Control-Allow-Headers'], /Authorization/);
  assert.equal(r.headers['Access-Control-Allow-Origin'], 'http://rig.example:8787');
});

test('a refused request cannot even learn which routes exist', async () => {
  const r = await call('POST', '/api/test/command-probe', SPEED);
  assert.equal(r.status, 401, 'the gate runs before the test-route and 404 checks');
});

test('a body that is not JSON is a 400 and one over the cap a 413, not a 500', async () => {
  const bad = await call('POST', '/api/command', '{not json', AUTH);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not JSON/);
  const notObject = await call('POST', '/api/command', '[1,2]', AUTH);
  assert.equal(notObject.status, 400);
  const huge = await call('POST', '/api/command', JSON.stringify({ type: 'speed', pad: 'x'.repeat(70 * 1024) }), AUTH);
  assert.equal(huge.status, 413);
  assert.equal(sent.length, 0);
});

test('the phone-telemetry relay keeps every key but drops the location before caching it', async () => {
  relayInboundForTest(null, {
    type: 'phone-telemetry', heading: 91, headingAccuracyDeg: 5, pitch: 1, roll: 2,
    lat: 12.5, lng: -3.25, accuracyM: 8, altitudeM: 40, at: '2026-11-23T00:00:00.000Z', deviceLabel: 'phone',
  });
  const r = await call('GET', '/api/status', undefined, AUTH);
  assert.equal(r.status, 200);
  const phone = r.body.phoneTelemetry;
  assert.equal(phone.heading, 91, 'the heading the page shows survives');
  assert.equal(phone.deviceLabel, 'phone');
  for (const key of ['lat', 'lng', 'accuracyM', 'altitudeM']) {
    assert.ok(key in phone, `${key} is still present, so the frame still validates`);
    assert.equal(phone[key], null, `${key} is not relayed`);
  }
});

// ── The WebSocket upgrade, on a real loopback socket ─────────────────────────────────────────

let port = 0;
async function listening() {
  if (port) return port;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return port;
}
after(() => new Promise((resolve) => server.close(() => resolve())));

/** Open /ws and report how the handshake ended: 'open', or the HTTP status of the refusal. */
async function upgrade({ query = '', origin, headers = {} } = {}) {
  const p = await listening();
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/ws${query}`, { origin, headers });
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
    ws.once('error', () => {});
  });
}

test('the WebSocket upgrade checks the token: refused without it, accepted with ?token=', async () => {
  assert.equal(await upgrade(), 401);
  assert.equal(await upgrade({ query: '?token=wrong' }), 401);
  assert.equal(await upgrade({ query: `?token=${encodeURIComponent(TOKEN)}` }), 'open');
  assert.equal(await upgrade({ headers: AUTH }), 'open', 'a non-browser client may send the header instead');
});

test('the WebSocket upgrade checks the origin: a page elsewhere cannot read telemetry or push frames', async () => {
  assert.equal(await upgrade({ query: `?token=${TOKEN}`, origin: 'https://evil.example' }), 403);
  assert.equal(await upgrade({ query: `?token=${TOKEN}`, origin: 'http://127.0.0.1:8787' }), 'open', 'the page on this machine');
});

test('Node fetch sends no Origin, so the CLI and MCP server are judged by the token alone', async () => {
  const p = await listening();
  const r = await fetch(`http://127.0.0.1:${p}/api/status`, { headers: AUTH });
  assert.equal(r.status, 200, 'an Origin header would have been refused: 127.0.0.1:8787 is the only page origin here');
  const none = await fetch(`http://127.0.0.1:${p}/api/status`);
  assert.equal(none.status, 401);
});
