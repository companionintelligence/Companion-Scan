> **Type:** Tests
> **Wave:** 18-node26-runtime
> **Branch:** `feat/node26-no-deno`
> **Commit style:** `test(server): summary`
> **Design:** [ADR 0016](../../adr/0016-the-server-runs-on-node-26.md); this ticket is the spec
> **Dependencies:** 0001

## Goal

The 199 files of `tests/unit/deno/` move to `tests/unit/server/`, and run under `node --test` on
Node 26. Every `Deno.test` becomes a `node:test` test, and each test asserts what it asserted
before.

## Non-goals

- Do not weaken, skip or delete a test to make it pass. A test that relied on a Deno feature with no
  Node equivalent is rewritten to assert the same behaviour, and the change is named in the
  commit message. One example is a test run without `--allow-env`.
- Do not move the assertions onto `node:assert` (see the README, decision 3).
- Do not merge `tests/unit/node/` into the new folder. It holds the browser-side and script suites,
  each with its own npm script.

## Pinned conventions

- **Tests.**
  - `import { test } from 'node:test'`.
  - `Deno.test(name, fn)` becomes `test(name, fn)`.
  - `Deno.test({ name, fn, ignore, only })` becomes `test(name, { skip: ignore, only }, fn)`.
    `sanitizeOps`, `sanitizeResources`, `sanitizeExit` and `permissions` are dropped: Node has no
    sanitizers and no per-test grants.
  - `t.step(name, fn)` becomes `await t.test(name, fn)`.
- **Assertions.** `tests/unit/server/assert.ts` exports what the suite imports from
  `jsr:@std/assert`: `assert`, `assertFalse`, `assertEquals`, `assertNotEquals`,
  `assertAlmostEquals`, `assertStringIncludes`, `assertMatch`, `assertGreater`, `assertThrows` and
  `assertRejects`.
  - Its `equal` is `@std/assert` 1.0.19's, with the MIT licence notice in the header. So `0` equals `-0`, `NaN`
    equals `NaN`, prototypes must match, and typed arrays compare element by element.
  - Failures throw `node:assert`'s `AssertionError`, with both values in `util.inspect` form.
- **Servers in tests.**
  - The 15 files that spawned `deno run … server/main.ts` spawn `process.execPath` with the same
    entry, through `spawnCommand`. Each keeps its own environment, a clean one with `clearEnv`.
  - Fake upstreams that used `Deno.serve` (the OIDC issuer, CI-Server, the PhysAg3D controller)
    use `serveFetch` in `tests/unit/server/http_server.ts`, which wraps `@hono/node-server`. It
    returns `{ port, url, close() }`.
- **Runner flags.**
  - `node --test --test-concurrency=1`. Deno ran the files one after another, and some still share
    fixed paths.
  - No `--test-force-exit`. It ends a file as soon as every test Node knows of has finished, so a
    file that declares tests after a top-level `await` loses them without a word. The first run
    lost five that way (the `lingbot run:` tests in `wp-a2-lingbot-quality.test.ts`). Node waits for
    every open handle instead, so a test that leaks a timer or a server hangs its file, and the leak
    is fixed in the test.

## Before implementation

- `tests/unit/deno/server_core_harness.ts` (the spawned server) and `georef_server_support.ts`.
- One file of each shape: a `Deno.test({ … })` with `sanitizeResources: false`, a `t.step` user,
  and a `permissions:` user (three tests).

## Open questions & answers

- Q: Keep the files' names? — A: Yes. Only the folder moves, with `git mv`, so `git log --follow`
  still works. Decided by the author, 2026-11-24.
- Q: What about the three `permissions:` tests? — A: They ran code without a grant, to check that
  the guarded paths fall back. Node has no grants, so they assert the fallback through the seam the
  code already has (an injected reader), or are removed where the guard is gone too. Each such case
  is listed in the commit message. Decided by the author, 2026-11-24.

## Files impacted

- New:
  - `tests/unit/server/assert.ts`
  - `tests/unit/server/http_server.ts`
- Changed: every file of `tests/unit/deno/`, moved to `tests/unit/server/`.
- Changed: references to the old folder in `tests/`, `docs/`, `meta/`, `subsystems/`,
  `.github/` and `scripts/`, which now point at `tests/unit/server/`.

## Schema required

None.

## Definition of Done

- [ ] `git grep -n 'Deno\.' -- tests` finds nothing.
- [ ] `npm run test:server` passes on Node 26.
- [ ] The number of tests is at least the 2,526 the Deno suite ran, less any removed with a stated
  reason.

## Tests

- [ ] `npm run test:server`

```
npm run test:server
```

## Acceptance Criteria

- [ ] Each test file still asserts what it asserted under Deno. The diff of a test body is limited
  to runtime calls.

## Risks / potential issues

- **Risk:** Node runs a test file's top-level tests one after another, as Deno did, but test files
  in parallel unless told otherwise. — **Mitigation:** `--test-concurrency=1`. Parallel files can be
  a follow-up, once the fixed paths are gone.
- **Risk:** A test that leaked a timer or a server passed under Deno with `sanitizeOps: false`, and
  would hang Node. — **Mitigation:** the leak is fixed in the test. `--test-force-exit` would hide
  it, and drops tests declared after a top-level `await` (see Pinned conventions).
- **Risk:** A test that disappears is not a failure. — **Mitigation:** the names of every test the
  Deno suite ran on `0de2afa` are compared with the names the Node run reports. The only
  differences are the tests renamed or removed in this ticket, each named in the commit.

## Subtasks

1. [ ] `git mv tests/unit/deno tests/unit/server`.
2. [ ] Write `assert.ts` and `http_server.ts`.
3. [ ] Convert `Deno.test`, the imports and the runtime calls.
4. [ ] Run the suite and fix each failure at its cause.
