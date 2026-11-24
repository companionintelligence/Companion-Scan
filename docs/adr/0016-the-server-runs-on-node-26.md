# 0016. The server runs on Node 26, and the repo has no Deno

- **Status:** Accepted
- **Date:** 2026-11-24
- **Related issue:** N/A. This is the owner's request of 2026-11-24, planned as wave 18
  (`docs/factory/18-node26-runtime/`).

## Context

The repo ran two JavaScript runtimes:

- **Deno** for the server: `server/main.ts` and its modules, the Deno unit suite, `deno task check`,
  and the container's server stage.
- **Node** for everything else: Vite, Playwright, the Node unit suites, every script, and the mobile
  and desktop builds.

Two runtimes cost the repo in four ways:

- **Two dependency trees over one folder.** `deno.json` set `"nodeModulesDir": "auto"`, so `deno
  install` and npm both wrote `node_modules`. CLAUDE.md carried a long section on the corruption
  that followed.
- **Two lockfiles that could disagree.** `deno.lock` pinned the server's packages apart from
  `package-lock.json`. Running any `deno task` relinked `node_modules` to `deno.lock`'s older Vite.
- **Two type-checkers.** `deno check` covered the server and `tsc` covered the browser. A
  shared file could pass one and fail the other, which is what ADR 0002 records.
- **Two installs in every environment that tests the server.** CI needed `denoland/setup-deno` and
  `actions/setup-node`, and the image installed Debian's `nodejs` on top of the Deno image, for the
  ingest scripts.

Node 26 runs TypeScript files directly by stripping their types. The server's relative imports
already carry `.ts` extensions, and `tests/unit/node/` already imported server modules under Node.

## Decision

We will run the server on Node 26, and remove Deno from the repo.

- **Startup.** `node server/main.ts` starts the server.
  - Hono is served by `@hono/node-server`, with `requestTimeout: 0`.
  - `/events` and `/rtc-signal` upgrade through `@hono/node-ws`.
  - There is no build step and no transpiler.
- **TypeScript.** The server is written in erasable TypeScript only, and every type-only import
  says `type`. `npm run typecheck:server` holds it there, with `verbatimModuleSyntax` and
  `erasableSyntaxOnly`. It runs two programs: `tsconfig.server.json` checks the server and the
  scripts with no DOM lib, and `tests/unit/server/tsconfig.json` checks the suite, two of whose
  files need the DOM lib.
- **One subprocess module.** `server/subprocess.ts` keeps two of `Deno.Command`'s rules that
  `child_process` alone does not:
  - a child inherits the server's environment plus the call's `env`, unless the call asks for a
    clean one;
  - a child killed by a signal reports `128 + n`.

  `runWithDeadline` and the capability report's `runCapture` build on it.
- **One file-helper module.** `server/fs_util.ts` holds:
  - `readBytes`, because `Deno.readFile` returned a plain `Uint8Array`, not a `Buffer`;
  - the `isNotFound` family, for `Deno.errors.*`;
  - `makeTempDir`.
- **The unit suite.** It is `tests/unit/server/`, on `node:test`, run one file at a time. Its
  assertions keep `@std/assert` 1.0.19's equality rules, through a local module. For example, `0`
  equals `-0`.
- **One version.** Node 26 is the one version for the server, CI, Docker and the app builds:
  `.node-version` 26.13.1, `engines.node` `>=26.13.0`.
- **ADR 0002's rule** now reads: a file the browser may import, even type-only, has no `node:`
  import and no `process` or `Buffer` reference. Its reasoning is unchanged. `tsc` for the browser
  has no Node types, so such a reference fails `npm run build` but passes
  `npm run typecheck:server`.

## Consequences

- **Easier:**
  - One install (`npm ci`), one lockfile, and one `node_modules` written by one tool.
  - One type-checker family.
  - CI sets up one runtime, and the image has no second runtime added by apt.
  - Server modules can be imported by any Node script or test.
- **Harder:**
  - Type stripping refuses `enum`, `namespace` and parameter properties, and an unmarked type-only
    import fails at load rather than at check. `typecheck:server` catches both, so run it after any
    server change.
- **Behaviour that changed:**
  - Deno's per-run permission flags are gone, and so are the guards written for a missing grant.
    The capability CLI now probes the services it lists, which Deno, run without `--allow-net`, did
    not.
  - Responses are no longer compressed by the runtime. `Deno.serve` did that unasked.
  - Node's default 300-second request timeout is turned off, to match Deno.
  - Deno's WebSocket keepalive (a ping, and a close after 30 s without a pong) is kept by
    `server/ws_heartbeat.ts`, because `ws` has none.
  - Node's `fetch` stops waiting after 300 s for a reply's headers or body. Every default budget is
    shorter, and a budget raised past that is cut to it.
  - The path-free error logs name the system code (`EACCES`) where they named Deno's class
    (`PermissionDenied`).
- **Follow-up:**
  - Optional compression with `hono/compress`.
  - A lean server image, by moving the browser libraries out of `dependencies`.
  - Running the suite's files in parallel, once they share no fixed paths.
- **Revisit this ADR** if:
  - Node's type stripping changes what it accepts;
  - the server needs a runtime feature only another runtime has;
  - the app builds need a different Node from the server's.
