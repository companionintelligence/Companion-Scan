> **Type:** Refactor / Infra
> **Wave:** 18-node26-runtime
> **Branch:** `feat/node26-no-deno`
> **Commit style:** `refactor(server): summary`
> **Design:** [ADR 0016](../../adr/0016-the-server-runs-on-node-26.md); this ticket is the spec
> **Dependencies:** None

## Goal

`node server/main.ts` serves the same API that `deno run --allow-… server/main.ts` served, on Node 26
with type stripping, with no reference to the `Deno` namespace left under `server/`. The server
type-checks with `tsc` against `@types/node`.

## Non-goals

- Do not change a route, a response shape, a world-file format or an environment variable name.
  The one exception is the capability report's `platform.deno` field, which becomes `platform.node`.
- Do not add response compression, a new middleware or a validation library.
- Do not touch the browser bundle (`src/` code paths the server does not import).
- Do not rename anything in CLAUDE.md's "Do not rename" table (the OIDC client id in
  `server/portal_auth.ts` and memory-push's `sourceSystem` in `server/memory_push.ts` stay exactly
  as they are).

## Pinned conventions

- **ADR 0001.** The server keeps one subprocess path: `server/subprocess.ts` replaces
  `Deno.Command` everywhere. `runWithDeadline` (`server/run_with_deadline.ts`) and `runCapture`
  (`server/capabilities.ts`) both build on it. No call site spawns with `node:child_process` itself.
  No environment variable is added or renamed. `PORT`, `SCANS_DIR` and the rest keep their names
  and defaults.
- **Imports.**
  - `npm:pkg@range/sub` becomes `pkg/sub`.
  - `jsr:@std/path` and `@std/path` become `node:path`.
  - `fromFileUrl` becomes `fileURLToPath` from `node:url`, and `SEPARATOR` becomes `sep`.
  - Relative imports keep their `.ts` extension.
  - Type-only imports say `type` (`verbatimModuleSyntax`). Node strips types, so an unmarked type
    import fails at load.
- **Syntax.** Erasable TypeScript only (`erasableSyntaxOnly`): no `enum`, no `namespace` with
  values, no parameter properties.
- **Files.**
  - The `fs` namespace from `node:fs/promises`, not named imports, because `const stat = await
    stat(p)` would shadow.
  - Bytes read from disk are plain `Uint8Array`s (`readBytes` in `server/fs_util.ts`), as
    `Deno.readFile` returned. A `Buffer` would differ in `slice()` (a view, not a copy) and in
    equality checks.
  - `Deno.errors.NotFound` and the rest become the `isNotFound` family in `server/fs_util.ts`
    (`err.code === 'ENOENT'` and its siblings).
  - `Deno.readDir` becomes `fs.readdir(dir, { withFileTypes: true })`. `entry.isFile` becomes
    `entry.isFile()`, and the same for `Stats`. `isSymlink` becomes `isSymbolicLink()`.
- **Platform.** `Deno.build.os` was `'windows' | 'darwin' | 'linux' | …`. The injectable
  `ExecPlatform` in `server/exec_probe.ts` keeps that vocabulary, so tests that pass `'windows'`
  still mean Windows. `hostPlatform()` maps `process.platform`'s `'win32'` to `'windows'`.
  `Deno.build.arch` `aarch64` and `x86_64` map from Node's `arm64` and `x64`.
- **HTTP.**
  - `serve` from `@hono/node-server`, on `0.0.0.0:PORT`, with `requestTimeout: 0` and
    `overrideGlobalObjects: false`, so `Request` and `Response` stay Node's own.
  - The listening line keeps Deno's wording, `Listening on http://0.0.0.0:<port>/`. The test
    harnesses read the port from it when `PORT=0`.
- **WebSockets.** `createNodeWebSocket` from `@hono/node-ws`. The origin check and the per-role gate
  run as middleware before the upgrade, and answer 403 or 404 as before.
- **Peer address.** `remoteAddressOf(c.env)` reads `incoming.socket.remoteAddress`, which is
  `@hono/node-server`'s binding.

## Before implementation

- `server/main.ts`: the listener at the end, `/events` and `/rtc-signal`, and the probe at line
  ~337.
- `server/run_with_deadline.ts`, `server/capabilities.ts` (`runCapture`, the
  `Deno.permissions.querySync` reachability check) and `server/exec_probe.ts`.
- The `_spawn` seams: `server/colmap/colmap_poses.ts`, `server/panoptic/panoptic_scan.ts`,
  `server/physag3d/physag3d.ts`, `server/register/place_register_sfm.ts` and
  `server/splat/{splat_train,spirula_train,splat_detect,splat_finish}.ts`.
- The `Deno.open` users: `server/http_range.ts`, `server/scan_world_side.ts`,
  `server/world/scan_store.ts`, `server/colmap/colmap_joint.ts`, `server/physag3d/physag3d.ts` and
  `server/splat/splat_finish.ts`.

## Open questions & answers

- Q: Does Node 26 run the server's TypeScript as written? — A: Not quite. Type stripping needs
  `import type` on every type-only import, and erasable syntax only. `tsc` with
  `verbatimModuleSyntax` and `erasableSyntaxOnly` finds each case, and they are fixed in place.
  Decided by the author, 2026-11-24.
- Q: `@hono/node-ws` or `ws` directly? — A: `@hono/node-ws`. It is the Hono project's own adapter,
  so the upgrade still runs through the route's middleware. Decided by the author, 2026-11-24.
- Q: Which hono? — A: 4.12.9, the version `deno.lock` resolved, so the runtime move does not also
  move Hono. Decided by the author, 2026-11-24.
- Q: Which onnxruntime-node? — A: Exactly 1.21.0, the version `deno.lock` resolved, and the one
  `@huggingface/transformers` pins, so one copy is installed. Decided by the author, 2026-11-24.

## Files impacted

- New:
  - `server/subprocess.ts`: `runCommand`, `spawnCommand`, and the `CommandOptions`,
    `CommandOutput` and `SpawnedCommand` types.
  - `server/fs_util.ts`: `readBytes`, `readBytesSync`, `makeTempDir`, `isNotFound`,
    `isAlreadyExists`, `isPermissionDenied` and `isADirectory`.
  - `tsconfig.server.json`.
- Changed: the 59 files under `server/` that used the `Deno` namespace, and `package.json`
  (dependencies only; the scripts are 0003's).

## Schema required

None. The one reply field that moves is `platform.deno` → `platform.node` in `GET /capabilities`.
Nothing under `src/` or `scripts/` reads it, which was checked with a grep for `platform.deno` and
`.deno`.

## Definition of Done

- [x] `git grep -n 'Deno\.' -- server` finds nothing.
- [x] `npm run typecheck:server` passes.
- [x] `node server/main.ts` boots with the mock engine and answers `GET /health`.
- [x] `/events` and `/rtc-signal` upgrade, and refuse a foreign origin with 403.

## Tests

- [x] The server suite (0002) passes on Node 26.
- [x] The browser box (0003) shows only main's known failures.

```
npm run typecheck:server
PORT=8123 INFERENCE_MODE=mock node server/main.ts   # then curl :8123/health
```

## Acceptance Criteria

- [x] Given the same environment, `node server/main.ts` and the old `deno run …` give the same
  replies to the API suite (`playwright test --project=api`) and to the box.

## Risks / potential issues

- **Risk:** A type-only import missed by the checker fails only at load. — **Mitigation:** the
  suite imports every server module, and `tsc` runs with `verbatimModuleSyntax`.
- **Risk:** `child_process.spawn` reports a missing binary asynchronously, where `Deno.Command`
  threw at once. — **Mitigation:** `spawnCommand` waits for the `spawn` or `error` event, so callers
  still see the throw where they caught it.
- **Risk:** Windows. Node refuses to spawn `.bat` and `.cmd` files without a shell, which Deno
  allowed. — **Mitigation:** none in this wave. The runners name `.exe` tools, and no Windows host
  runs the server today.

## Subtasks

1. [x] Add `@hono/node-server`, `@hono/node-ws`, `hono`, `jose` and `onnxruntime-node` as
   dependencies. Move the server's runtime packages from devDependencies to dependencies. Add
   `@types/node` 26.
2. [x] Write `server/subprocess.ts` and `server/fs_util.ts`, and move `runWithDeadline` and
   `runCapture` onto them.
3. [x] Convert every `Deno` call under `server/`.
4. [x] Serve with `@hono/node-server`, and upgrade with `@hono/node-ws`.
5. [x] `tsconfig.server.json` and the `typecheck:server` script.
