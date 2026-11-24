import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { OsmoBleTransport } from './ble-transport.mjs';
import { makeArc } from '../protocol/dome.mjs';

// The move-to arc guard (FN-181), the stop flag that used to outlive its run (found while wiring
// Stop, FN-180), and the test-routes flag on status (FN-191), through the real request handler of
// server/backend.mjs. Nothing listens. The link is reported as up and streaming, every frame the
// backend would write is recorded, and no token or origin setting is in force: today's defaults.
process.env.BACKEND_NO_LISTEN = '1';
delete process.env.BACKEND_TEST_ROUTES;
delete process.env.OSMO_BACKEND_TOKEN;
delete process.env.BACKEND_ALLOWED_ORIGINS;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ANDROID_MCP_')) delete process.env[name];
}
process.env.ANDROID_MCP_ENV_FILE = '';
process.env.ANDROID_MCP_CONFIG = '/nonexistent/backend-guards-no-device-registry.json';

const sent = [];
Object.defineProperty(OsmoBleTransport.prototype, 'connected', { get: () => true, configurable: true });
Object.defineProperty(OsmoBleTransport.prototype, 'linked', { get: () => true, configurable: true });
OsmoBleTransport.prototype.sendRaw = async function sendRaw(frame) {
  sent.push(Uint8Array.from(frame));
};

const { server, setScanStateForTest, setMeasuredArcForTest, transportForTest, gridCancelRequestedForTest } = await import('./backend.mjs');
const transport = transportForTest();
/** A pose the closed loop can act on: quaternion [x, y, z, w]. */
const LEVEL = [0, 0, 0, 1];

/** One request through the real handler. NDJSON comes back as an array of events. */
function call(method, path, body) {
  return new Promise((resolve) => {
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
    const req = Readable.from(raw);
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost:8788' };
    const chunks = [];
    let contentType = 'application/json';
    const res = {
      headersSent: false,
      writeHead(code, headers = {}) {
        this.statusCode = code;
        this.headersSent = true;
        contentType = headers['Content-Type'] ?? contentType;
      },
      write(chunk) {
        chunks.push(String(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(String(chunk));
        const text = chunks.join('');
        const parsed = contentType === 'application/x-ndjson'
          ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
          : JSON.parse(text || 'null');
        resolve({ status: this.statusCode, body: parsed });
      },
    };
    server.emit('request', req, res);
  });
}

beforeEach(() => {
  sent.length = 0;
  setScanStateForTest({ scanRunning: false });
  setMeasuredArcForTest(null);
  transport.lastQuaternion = LEVEL;
});

test('move-to refuses a pan in the fallback dead zone, names that arc as the fallback, and sends nothing', async () => {
  const r = await call('POST', '/api/move-to', { yawDeg: 0, pitchDeg: 0, maxMs: 50 });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /pan 0° is .* past a stop/);
  assert.match(r.body.error, /built-in fallback/);
  assert.match(r.body.remediation, /arc-probe/);
  assert.equal(r.body.reachableArc.source, 'default');
  assert.equal(sent.length, 0, 'not one speed frame');
});

test('an omitted target is pan 0, as it always was, and so is refused on the fallback arc too', async () => {
  const r = await call('POST', '/api/move-to', { maxMs: 50 });
  assert.equal(r.status, 400);
  assert.equal(sent.length, 0);
});

test('move-to inside the fallback arc still moves (the arc centre, 171)', async () => {
  const r = await call('POST', '/api/move-to', { yawDeg: 171, pitchDeg: 0, maxMs: 150, tickMs: 10, settleMs: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(sent.length > 0, 'the closed loop drove');
});

test('a measured arc decides instead: pan 0 inside it moves, 171 outside it is refused as measured', async () => {
  setMeasuredArcForTest(makeArc({ startDeg: -60, endDeg: 100, source: 'measured', measuredAt: Date.now() }));
  const inside = await call('POST', '/api/move-to', { yawDeg: 0, pitchDeg: 0, maxMs: 150, tickMs: 10, settleMs: 10 });
  assert.equal(inside.status, 200, JSON.stringify(inside.body));
  sent.length = 0;
  const outside = await call('POST', '/api/move-to', { yawDeg: 171, pitchDeg: 0, maxMs: 50 });
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /measured from this tripod position/);
  assert.match(outside.body.remediation, /centre is 20°/);
  assert.equal(sent.length, 0);
});

test('move-to refuses a target that is not a finite number, including JSON 1e999 (Infinity)', async () => {
  for (const body of ['{"yawDeg": 1e999, "pitchDeg": 0}', { yawDeg: '120', pitchDeg: 0 }, { yawDeg: 120, pitchDeg: null, maxMs: 1 }]) {
    const r = await call('POST', '/api/move-to', body);
    if (typeof body === 'object' && body.pitchDeg === null) {
      // null is "omitted", which has always meant 0: inside the travel, so this one moves.
      assert.equal(r.status, 200, JSON.stringify(r.body));
      continue;
    }
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, /not a finite number/);
  }
});

test('move-to refuses a tilt past the measured travel, the same limits the grid uses', async () => {
  for (const pitchDeg of [20, -50]) {
    const r = await call('POST', '/api/move-to', { yawDeg: 171, pitchDeg, maxMs: 50 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /tilt .* outside the measured travel \(-45°\.\.\+16°\)/);
  }
  assert.equal(sent.length, 0);
});

test('a running scan still answers 409 whatever the target: the scan check comes first', async () => {
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/move-to', { yawDeg: 0, pitchDeg: 0, maxMs: 50 });
  assert.equal(r.status, 409);
  assert.equal(sent.length, 0);
});

test('a stop request does not outlive the run it stopped', { timeout: 20000 }, async () => {
  // Two positions, no photos, short moves: long enough for a stop to land during the first.
  const run = call('POST', '/api/grid-capture', {
    pans: [120, 150], tilts: [0], stations: 1, capturePhotos: false, probeArc: false, maxMs: 300, dwellMs: 1,
  });
  let stop;
  for (let i = 0; i < 200 && !stop; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const r = await call('POST', '/api/grid-stop');
    if (r.body?.stopped) stop = r;
  }
  assert.ok(stop, 'the run started and took the stop');
  const { status, body: events } = await run;
  assert.equal(status, 200);
  const done = events.at(-1);
  assert.equal(done.phase, 'done');
  // `reason` leads with whatever matters most (here, that nothing converged against a stub
  // gimbal); why the run ended is `incompleteReason`.
  assert.match(done.incompleteReason ?? '', /Stopped by request/);
  assert.equal(done.complete, false);
  // The defect: the flag stayed set until the NEXT grid started, so a standalone arc probe, the
  // step the jam message tells the operator to take, gave up at once with "stopped by request".
  assert.equal(gridCancelRequestedForTest(), false);
});

test('status says whether the test routes exist, so the page can say why its probes are off', async () => {
  const r = await call('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.testRoutes, false);
  const probe = await call('POST', '/api/test/command-probe', { type: 'speed', params: {} });
  assert.equal(probe.status, 404);
});

test('the route list names every route, GET /api/capture-device included', async () => {
  const r = await call('GET', '/');
  assert.ok(r.body.routes.includes('GET /api/capture-device'));
  assert.ok(!r.body.routes.some((route) => route.startsWith('POST /api/test/')), 'test routes are listed only when on');
});
