> **Type:** Infra
> **Wave:** 18-node26-runtime
> **Branch:** `feat/node26-no-deno`
> **Commit style:** `build: summary`
> **Design:** [ADR 0016](../../adr/0016-the-server-runs-on-node-26.md); this ticket is the spec
> **Dependencies:** 0001, 0002

## Goal

Nothing a developer or the gate runs needs a `deno` binary:

- `npm start` and `npm run server` start `node server/main.ts`;
- `npm run verify` type-checks and tests the server with Node;
- every script that booted the Deno API boots the Node one;
- `deno.json` and `deno.lock` are deleted;
- `.node-version` and `engines` name Node 26.

## Non-goals

- Do not change what `verify` checks, beyond swapping `deno task check` and `deno task test` for
  their Node equivalents.
- Do not change the ports, data folders or environment the test box gives its server.

## Pinned conventions

- **npm scripts:**
  - `server`: `node --env-file-if-exists=.env --watch server/main.ts`. Deno's `--env-file` read
    `.env` when it was there and went on when it was not; `--env-file-if-exists` does the same.
  - `typecheck:server`: `tsc --noEmit -p tsconfig.server.json && tsc --noEmit -p tests/unit/server`.
    Two programs, so that the DOM lib two of the suite's files reference cannot hide a browser
    global in server code.
  - `test:server`: `node --test --test-concurrency=1 'tests/unit/server/*.test.ts'`.
  - `migrate:jobs` and `migrate:scan-ids` replace the `deno task migrate-*` entries.
- **The gate.** `verify` begins `npm run typecheck:server && npm run test:viewport && npm run
  test:server && …`, in the order `deno task check`, `test:viewport` and `deno task test` had.
- **The test box.** `scripts/test-box.mjs` launches `process.execPath server/main.ts`, labelled
  `server`, with the environment it gave Deno. That includes `ALLOW_DEV_ORIGINS=1` and the CUDA
  skip.
- **Node.**
  - `.node-version` is `26.13.1`, and `engines.node` is `>=26.13.0` (the README, decision 1: decided
    by the owner, 2026-11-24).
  - The lockfile is regenerated with npm 11 (`npm install --package-lock-only`). npm 10 drops the
    `libc` fields that #260 recorded.

## Before implementation

- `scripts/test-box.mjs`, `scripts/ci-mock-gate.mjs`, `scripts/bench-models.mjs`,
  `scripts/video-stage.mjs` and `scripts/loop.mjs`.
- `scripts/dx9-collect.ts` and `scripts/scan-room.ts`, which are Deno programs.
- `scripts/install-services.sh`, `.githooks/pre-push` and `scripts/postinstall-hint.mjs`.

## Open questions & answers

- Q: Does `npm ci` still need `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`? — A: Yes. That is
  onnxruntime-node's own install script, whichever runtime then loads it. Decided by the author,
  2026-11-24.

## Files impacted

- Deleted: `deno.json`, `deno.lock`.
- Changed:
  - `package.json`, `package-lock.json`, `.node-version`;
  - `scripts/test-box.mjs`, `scripts/ci-mock-gate.mjs`, `scripts/bench-models.mjs`,
    `scripts/video-stage.mjs`, `scripts/loop.mjs`, `scripts/dx9-collect.ts`,
    `scripts/scan-room.ts`, `scripts/install-services.sh` and `scripts/postinstall-hint.mjs`;
  - `.githooks/pre-push`.

## Schema required

None.

## Definition of Done

- [x] `git grep -n -w deno -- package.json scripts .githooks` finds no command.
- [x] `npm run verify` passes on Node 26.
- [x] `node scripts/test-box.mjs --workers=6 --retries=0` shows only main's known failures.

## Tests

- [x] `npm run verify`
- [x] `node scripts/test-box.mjs --workers=6 --retries=0`

```
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
npm run verify
ONNXRUNTIME_NODE_INSTALL_CUDA=skip TEST_BOX_API_PORT=<free> TEST_BOX_VITE_PORT=<free> node scripts/test-box.mjs --workers=6 --retries=0
```

## Acceptance Criteria

- [x] On a machine with no `deno` on PATH, `npm ci`, `npm start`, `npm run verify` and the box all
  work.

## Risks / potential issues

- **Risk:** `engine-strict` with `>=26.13.0` stops `npm ci` on the Node 22 that other trees on this
  machine use. — **Mitigation:** intended. nvm holds 26.13.1 beside 22.23.2, and CLAUDE.md says so.

## Subtasks

1. [x] Rewrite the npm scripts and the gate.
2. [x] Move each script that booted Deno onto Node.
3. [x] Delete `deno.json` and `deno.lock`. Set `.node-version` and `engines`.
4. [x] Regenerate `package-lock.json` with npm 11.
