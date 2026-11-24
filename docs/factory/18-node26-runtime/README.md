# Wave 18 — The server on Node 26, and no Deno

On 2026-11-24 the owner asked for Deno to be removed from Companion Scan, and for everything to run
on Node 26 instead. This wave plans that move and carries it out in one pull request. Wave 17 (#302)
was the last number in use on main when it was drafted.

The decision behind it is [ADR 0016](../../adr/0016-the-server-runs-on-node-26.md).

## What ran on Deno, at `0de2afa`

Counted on main at `0de2afa`, before this wave changed anything:

- **The server.** `server/main.ts` and every module it pulls in: 59 files under `server/` with 549
  call sites of the `Deno` namespace outside comments. They cover:
  - `Deno.serve` and `Deno.upgradeWebSocket` (Hono served by Deno);
  - `Deno.env`, `Deno.Command` and `Deno.ChildProcess`;
  - the file APIs (`Deno.readTextFile`, `Deno.open`, `Deno.readDir`, `Deno.stat` and the rest);
  - `Deno.build`, `Deno.permissions`, `Deno.unrefTimer` and `Deno.errors.*`.
- **`deno.json`.** It held:
  - nine tasks: `dev`, `start`, `check`, `migrate-jobs`, `migrate-scan-ids`, `test`, `test:mock`,
    `test:splat`, `test:auth`;
  - an import map of `jsr:@std/path` and ten `npm:` entries: hono and its two subpaths,
    onnxruntime-node, jimp, the three `@gltf-transform/*` packages, draco3dgltf and jose;
  - `"nodeModulesDir": "auto"`, and `allowScripts` for onnxruntime-node's install script.
- **`deno.lock`**: lockfile version 5, with 285 npm packages and three JSR packages
  (`@std/assert`, `@std/internal`, `@std/path`).
- **The Deno unit suite**, `tests/unit/deno/`:
  - 199 files, with 2,526 `Deno.test` calls and 4,828 uses of the `Deno` namespace;
  - its assertions come from `jsr:@std/assert`, with 7,896 `assertEquals` calls;
  - 15 of the files spawn the real `server/main.ts` with `deno run`.
- **`package.json`.**
  - `npm start` boots the Deno API beside Vite (`npm run server` is `deno run --watch …`).
  - `verify` starts with `deno task check` and runs `deno task test`.
  - `test:splat:unit`, `test:mock:unit`, `test:auth:unit` and `test:deno` call deno.
- **Scripts.** All of these start the Deno API with `deno run`:
  - `scripts/test-box.mjs` (the browser box);
  - `scripts/ci-mock-gate.mjs` (the detection gate's mock run);
  - `scripts/bench-models.mjs` and `scripts/video-stage.mjs`.

  The rest:
  - `scripts/loop.mjs` runs `deno task check` and `deno task test`.
  - `scripts/dx9-collect.ts` and `scripts/scan-room.ts` are Deno programs.
  - `scripts/install-services.sh` writes the Deno binary into the systemd unit.
- **CI.**
  - `.github/workflows/deno-ci.yml` installs with `deno install` and runs `deno task check` and
    `deno task test`.
  - Its detection-gate job sets up Deno and Node both.
- **Docker.** The server stage is `FROM denoland/deno:2.8.3`, with Debian's `nodejs` added by apt for
  the ingest scripts. It runs `deno cache server/main.ts` and starts with `deno run --allow-…`.
- **Deploy.** `deploy/systemd/cscan-server.service` runs `__DENO__ run --allow-… server/main.ts`.
- **Node.** `.node-version` is 22.18.0, and `engines.node` is `>=22.18.0` with `engine-strict`.
- **Docs.**
  - CLAUDE.md's key commands, and its section "Both npm and Deno materialise node_modules".
  - 33 files under `docs/` outside the wave folders and audits, and the README.
  - The atlas (22 mentions).

## Tickets

| # | Ticket | Status | Depends on |
|---|---|---|---|
| 0001 | [The server runs on Node 26](0001-server-on-node-26.md) | in this wave's PR | none |
| 0002 | [The server's unit suite runs on `node:test`](0002-server-suite-on-node-test.md) | in this wave's PR | 0001 |
| 0003 | [Scripts, the gate and the lockfiles](0003-scripts-gate-and-lockfiles.md) | in this wave's PR | 0001, 0002 |
| 0004 | [CI, Docker and the systemd unit](0004-ci-docker-and-deploy.md) | in this wave's PR | 0003 |
| 0005 | [CLAUDE.md, the docs and the atlas](0005-docs-and-atlas.md) | in this wave's PR | 0001–0004 |

The tickets cannot merge apart. Once the server stops importing `npm:` specifiers, Deno can no longer
run it, and the Deno suite stops type-checking. So the wave lands as one PR of three commits: this
plan, then the move itself (0001 to 0004, which share `package.json` and cannot build apart), then
the docs and the atlas (0005). The tickets run in order:

1. 0001 and 0002 touch the same files, because the suite's fakes stand in for the server's
   subprocess and file APIs.
2. 0003 needs both before `npm run verify` can pass.
3. 0004 and 0005 describe what the first three built.

## What changes in behaviour

The aim is the same server on another runtime. Five things differ, and ADR 0016 records each:

1. **No permission flags.** Deno ran the server with `--allow-net --allow-read --allow-write
   --allow-env --allow-ffi --allow-run`, so it held every permission. Node has no per-run grants.
   - The code paths that guarded against a missing grant stay, and simply no longer trigger. One is
     `budgetFromEnv`'s catch; another is `capabilities.ts`'s `Deno.permissions.querySync`.
   - Their comments are corrected.
2. **Responses are not compressed.** `Deno.serve` compressed bodies by itself when a client sent
   `Accept-Encoding`. `@hono/node-server` does not. This wave adds no compression; see "Deferred".
3. **No request timeout.** Node's HTTP server ends a request after 300 s by default
   (`requestTimeout`). Deno had no such limit, and a large upload over a slow tailnet link can take
   longer. The server sets `requestTimeout: 0`.
4. **A child's environment.** A child process inherits the server's environment plus the `env` a
   call passes, as under Deno, unless the call asks for a clean one (Deno's `clearEnv`).
   `child_process.spawn` alone replaces the environment. `server/subprocess.ts` keeps Deno's rule,
   so a child keeps finding `PATH`.
5. **Exit codes and signals.** A child killed by a signal reports `code` 128 + the signal number and
   the signal's name, as Deno did. For SIGKILL that is 137. Node alone reports `code: null`.

## Decisions for the owner

The owner took both recommended answers on 2026-11-24 ("Keep both").

1. **Is Node 26 the minimum for the mobile and desktop builds too?** Decided: yes.
   - Every workflow reads `.node-version`, and `engines` applies to every `npm ci` at the root,
     because of `engine-strict`.
   - *Recommended:* yes, one Node everywhere: `.node-version` 26.13.1 (the current LTS, "Lithium")
     and `engines.node` `>=26.13.0`.
   - *The alternative*, not taken, kept `>=22.18.0` for the app builds, with a second version file
     for their workflows. That would have meant two Node versions to keep current.
2. **Which base image for Docker?** Decided: the recommended pair, on major tags.
   - *Recommended:* `node:26-trixie-slim` (Debian 13) for the server stage, and `node:26-alpine` for
     the Vite stage, as stage 1 is today. onnxruntime-node ships glibc builds only, so the server
     stage cannot be Alpine.
   - *Alternatives, not taken:* `node:26-bookworm-slim` (Debian 12); or pinning the exact patch
     (`node:26.13.1-…`) or a digest instead of the major tag.

The author made three further calls, which the owner may also overrule:

3. **Assertions.** The suite keeps its assertion calls. A local module, `tests/unit/server/assert.ts`,
   carries `@std/assert` 1.0.19's equality rules (MIT; the licence notice is in that file's header). The reason is
   `0` and `-0`, which `@std/assert` counts as equal and `node:assert`'s `deepStrictEqual` does not.
   Moving 7,896 `assertEquals` calls onto `deepStrictEqual` would change what the geometry tests
   accept.
4. **WebSockets** go through `@hono/node-ws`, the Hono project's Node adapter (MIT, built on `ws`).
   It upgrades `/events` and `/rtc-signal` in place of `Deno.upgradeWebSocket`.
5. **Names.**
   - `tests/unit/deno/` becomes `tests/unit/server/`.
   - `.github/workflows/deno-ci.yml` becomes `server-ci.yml` ("Server CI").
   - The capability report's `platform.deno` field becomes `platform.node`. No client reads it.

## Atlas

This wave's atlas pass, on 2026-11-24, changed these entries:

- **The lede, the server section's description, and the architecture diagram's hub.**
  - Before: "a Deno server", "The Deno process".
  - After: the Node 26 server.
- **"Host toolchain requirements".**
  - Before: a Node new enough to type-strip the scripts, and a `node_modules` that npm and Deno had
    not both written.
  - After: Node 26 and one `npm ci`.
- **"Capability report".**
  - Before: `deno run … server/capabilities.ts`.
  - After: `node server/capabilities.ts`.
- **"Pre-push verification gate".**
  - Before: `deno task check` and the Deno suite.
  - After: `npm run typecheck:server` and `npm run test:server`.
- **"Docker containerization".**
  - Before: Deno serving the bundle.
  - After: Node 26 serving it.
- **"GitHub Actions CI/CD".**
  - Before: the Deno type-check and suite.
  - After: the server's type-check and suite on Node 26.
- **The `PORT` row.**
  - Before: "Deno API listen port".
  - After: "API listen port".
- **A wave card.**

Until this pass, the atlas said nothing about `deno.lock` beside `package-lock.json`, two lockfiles
for one `node_modules` (gap filled: the toolchain card now says there is one lockfile).

## Verification available on this machine

All of the following runs here with no workflow dispatched, since Actions credit is low:

- `npm run verify`, on Node 26;
- the full browser box, `node scripts/test-box.mjs --workers=6 --retries=0`;
- a Docker build of the image, booted to `/health`.

These cannot be checked here:

- the iOS and desktop installers, since this machine has no Xcode and no Tauri system libraries;
- the GitHub-hosted runners themselves.

## Deferred

- **Response compression.** `hono/compress` could restore what `Deno.serve` did by itself, but it
  needs a rule for range replies and for media that is already compressed. That is its own change.
- **A lean server image.** `npm ci --omit=dev` installs the browser libraries too, because they sit
  in `dependencies` beside the server's. Moving them to `devDependencies` would shrink the image. It
  would also change what the app builds see, so it waits for the owner.
- **Migrating the suite to `node:assert`.** This is possible file by file, once someone checks each
  geometry test's tolerance against signed zeros.
- **History.** Old wave folders (01–17), `docs/audits/` and `history/` keep their Deno wording,
  because they record what was true at the time. Test paths in them move with the rename, as
  server paths did in the earlier repo-tidy pass.
