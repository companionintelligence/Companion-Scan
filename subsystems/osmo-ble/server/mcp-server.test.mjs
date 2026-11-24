import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { planDomePans, DEFAULT_PAN_ARC } from '../protocol/dome.mjs';

// The MCP server (server/mcp-server.mjs), run for real over stdio and driven with the SDK's own
// client. Its backend is a fake on a loopback port that records what each tool asks for. Inventory
// findings FN-180, FN-181, FN-184 and FN-189 changed these tools: a stop tool, recenter to the
// arc's centre, a sweep along the arc, a shared grid order and the backend token. A syntax check
// cannot see a bad reference inside a tool handler, so every changed tool is called here.

const MCP = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
const TOKEN = 'mcp-server-test-token-0123456789';
const MEASURED = { startDeg: -60, endDeg: 100, spanDeg: 160, centerDeg: 20, source: 'measured', measuredAt: 1 };
const FALLBACK = { startDeg: 82, endDeg: -100, spanDeg: 178, centerDeg: 171, source: 'default' };

const backend = { arc: FALLBACK, seen: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    backend.seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const reply = (code, json) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.url === '/api/status') return reply(200, { connected: true, link: 'streaming', panArc: backend.arc });
    if (req.url === '/api/move-to') return reply(200, { converged: true, finalYaw: 0, finalPitch: 0 });
    if (req.url === '/api/grid-stop') return reply(200, { stopped: true, note: 'Scan will stop after the current position.' });
    return reply(404, { error: `fake backend: no route for ${req.method} ${req.url}` });
  });
});

let client;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: { ...process.env, OSMO_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, OSMO_BACKEND_TOKEN: TOKEN },
    stderr: 'ignore',
  });
  client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
  await client.connect(transport);
});
after(async () => {
  await client?.close();
  await new Promise((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  backend.seen.length = 0;
  backend.arc = FALLBACK;
});

const posted = (url) => backend.seen.filter((s) => s.url === url && s.method === 'POST');
const text = (result) => result.content.map((c) => c.text).join('');

test('stop_grid_capture is listed, posts /api/grid-stop with the backend token, and relays the answer', async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'stop_grid_capture'));
  const result = await client.callTool({ name: 'stop_grid_capture', arguments: {} });
  assert.equal(result.isError, undefined, text(result));
  assert.equal(posted('/api/grid-stop').length, 1);
  assert.equal(posted('/api/grid-stop')[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.match(text(result), /"stopped": true/);
});

test('gimbal_recenter aims at the centre of the arc in use, not at pan 0 in the dead zone', async () => {
  await client.callTool({ name: 'gimbal_recenter', arguments: {} });
  assert.deepEqual(posted('/api/move-to').map((s) => [s.body.yawDeg, s.body.pitchDeg]), [[171, 0]], 'the fallback centre');
  backend.seen.length = 0;
  backend.arc = MEASURED;
  const result = await client.callTool({ name: 'gimbal_recenter', arguments: {} });
  assert.deepEqual(posted('/api/move-to').map((s) => s.body.yawDeg), [20], 'the measured centre');
  assert.match(text(result), /measured from this tripod position/);
});

test('gimbal_sweep steps along the arc, 96 round through 180 to -114, never through the front', async () => {
  const result = await client.callTool({ name: 'gimbal_sweep', arguments: { startYawDeg: 96, endYawDeg: -114, stepDeg: 30, dwellMs: 200 } });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(posted('/api/move-to').map((s) => s.body.yawDeg), [96, 126, 156, -174, -144, -114]);
});

test('gimbal_sweep refuses an end outside the arc before its first move, and says it is the fallback', async () => {
  const result = await client.callTool({ name: 'gimbal_sweep', arguments: { startYawDeg: 0, endYawDeg: 120, dwellMs: 200 } });
  assert.equal(result.isError, true);
  assert.match(text(result), /0° is outside the reachable arc in use/);
  assert.match(text(result), /probe_pan_arc/);
  assert.equal(posted('/api/move-to').length, 0);
});

test('gimbal_move_to accepts the arc centre (171), which its old +/-160 schema refused, and the tilt limits', async () => {
  const ok = await client.callTool({ name: 'gimbal_move_to', arguments: { yawDeg: 171, pitchDeg: -40 } });
  assert.equal(ok.isError, undefined, text(ok));
  assert.deepEqual(posted('/api/move-to').map((s) => s.body.yawDeg), [171]);
  const tooFar = await client.callTool({ name: 'gimbal_move_to', arguments: { yawDeg: 171, pitchDeg: 30 } }).catch((err) => ({ isError: true, content: [{ text: err.message }] }));
  assert.equal(tooFar.isError, true, 'a tilt past +16 is outside the schema now');
});

test('plan_scan_grid returns exactly the targets its own serpentine copy did, now through planGrid', async () => {
  const result = await client.callTool({ name: 'plan_scan_grid', arguments: {} });
  const { targets, totalTargets } = JSON.parse(text(result));
  // The e897380 implementation, inlined: rows of pitch, odd rows reversed, a running index.
  const dome = planDomePans({ spanDeg: 150, count: 7, arc: DEFAULT_PAN_ARC });
  const pitchSteps = [0, 1].map((i) => -10 - 30 / 2 + (30 * i) / 1);
  const expected = [];
  let index = 0;
  for (let row = 0; row < 2; row++) {
    const cols = row % 2 === 0 ? dome.pans.map((v, i) => [i, v]) : dome.pans.map((v, i) => [i, v]).reverse();
    for (const [col, yawDeg] of cols) expected.push({ index: index++, row, col, yawDeg, pitchDeg: Math.round(pitchSteps[row] * 10) / 10 });
  }
  assert.equal(totalTargets, 14);
  assert.deepEqual(targets, expected);
});
