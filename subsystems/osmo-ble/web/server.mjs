#!/usr/bin/env node
// Zero-dependency static file server for the web app. Serves what the page loads, web/ and
// protocol/ (so relative imports of ../protocol/*.mjs from web/app.mjs resolve), on
// http://localhost. Web Bluetooth requires a secure context, and localhost counts as one.
//
// Settings, read from the shell that starts it:
//   PORT      the port, default 8787. The backend's default origin rule expects the page here
//             (see ../server/access.mjs).
//   WEB_HOST  the bind address, default every interface. That default is what the documented
//             rig needs, because the operator opens this page from a phone. Set it to 127.0.0.1
//             to keep the page on this machine. (Not a bare HOST, which some shells set to the
//             machine's name.)

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBindHost, servedFilePath } from '../server/access.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8787;
const host = parseBindHost(process.env.WEB_HOST);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // Redirect (not rewrite) "/" to "/web/index.html" so the browser's resolved base URL is
  // actually /web/, otherwise relative imports in the served HTML/JS (./app.mjs,
  // ../protocol/*.mjs) resolve against the wrong directory and 404 silently.
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(302, { Location: '/web/index.html' });
    res.end();
    return;
  }

  // Only web/ and protocol/. See servedFilePath for what this used to let through.
  const served = servedFilePath(root, req.url);
  if (!served.file || !existsSync(served.file) || !statSync(served.file).isFile()) {
    const status = served.status === 400 ? 400 : 404;
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(status === 400 ? 'Bad request' : 'Not found');
    return;
  }

  const ext = path.extname(served.file);
  // This project is under active iteration (protocol/command fixes land mid-session) — a
  // browser-cached stale copy of a .mjs module has already caused one confusing "the fix isn't
  // working" report, so always force a revalidation instead of letting heuristic HTTP caching
  // serve an old file.
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(served.file).pipe(res);
});

const onListening = () => {
  console.log(`Osmo BLE web app: http://${host ?? 'localhost'}:${port}/  (listening on ${host ?? 'every interface'})`);
};
if (host) server.listen(port, host, onListening);
else server.listen(port, onListening);
