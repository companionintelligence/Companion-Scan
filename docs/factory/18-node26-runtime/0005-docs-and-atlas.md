> **Type:** Docs
> **Wave:** 18-node26-runtime
> **Branch:** `feat/node26-no-deno`
> **Commit style:** `docs: summary`
> **Design:** [ADR 0016](../../adr/0016-the-server-runs-on-node-26.md); this ticket is the spec
> **Dependencies:** 0001–0004

## Goal

Every living document describes the Node 26 server and the commands that exist after this wave. The
atlas carries this wave's diffs and its card.

## Non-goals

- Do not rewrite history: old wave folders (01–17), `docs/audits/` and `history/` keep their Deno
  wording. Their links to `tests/unit/deno/…` files follow the rename.
- Do not edit an ADR's body. ADR 0002's rule is restated by ADR 0016, and 0002's status line says so.

## Pinned conventions

- **CLAUDE.md.**
  - The key commands become `npm run typecheck:server` and `npm run test:server`.
  - The section "Both npm and Deno materialise `node_modules`" becomes a short section on the one
    toolchain:
    - Node 26 through nvm, beside the Node 22 that other trees use;
    - `npm ci` with the CUDA skip;
    - the Playwright "two versions" symptom and its fix, which is still true of an interrupted
      `npm install`.
- **ADR 0002's rule.** A file the browser may import has no `node:` import and no `process` or
  `Buffer` reference. The source-shape tests that checked for `Deno.` check for that instead.
- **The atlas.** As in the wave README's "Atlas" section: one-line diffs and a wave card, with no
  ticket content.

## Before implementation

- CLAUDE.md, README.md, `docs/architecture.md`, `docs/targets/server.md`,
  `docs/testing/TEST_INFRA.md`, `docs/operations/DEPLOY.md`,
  `docs/operations/PLATFORM_SUPPORT.md` and `docs/pipelines/*.md`.
- `.claude/commands/factory.md` (Phase 4's pinned server conventions), `.env.example`,
  `playwright.config.ts`'s comments, and `docs/factory/atlas.html`.

## Open questions & answers

- Q: Does "Deno" stay anywhere? — A: Only in history: the old wave folders, the audits,
  `history/`, ADR 0002's body, and this wave's own description of what it removed. Decided by the
  author, 2026-11-24.

## Files impacted

- New: `docs/adr/0016-the-server-runs-on-node-26.md`.
- Changed:
  - `CLAUDE.md`, `README.md`, `.env.example`, `.claude/commands/factory.md`;
  - `docs/` (the living docs listed above, and `docs/adr/README.md`);
  - `docs/factory/atlas.html`;
  - the code comments under `src/`, `server/`, `scripts/` and `tests/` that named Deno;
  - the ADR 0002 source-shape tests in `tests/unit/node/`.

## Schema required

None.

## Definition of Done

- [ ] `git grep -n -i deno -- . ':!history' ':!docs/audits' ':!docs/factory/0*' ':!docs/factory/1[0-7]-*' ':!docs/factory/foundation-updates' ':!docs/adr/000[0-9]-*' ':!docs/adr/001[0-5]-*'`
  finds only this wave's own account of the move: `docs/factory/18-node26-runtime/`, ADR 0016, and
  the atlas's wave card and diffs.
- [ ] `npm run verify` passes, since some of its tests read the docs.

## Tests

- [ ] `npm run verify`

```
npm run verify
```

## Acceptance Criteria

- [ ] A new contributor who follows CLAUDE.md and the README on a clean machine installs Node 26,
  runs `npm ci` and `npm start`, and never meets a `deno` command.

## Risks / potential issues

- **Risk:** Source-shape tests pin doc lines, such as the deno-ci.yml line numbers that CLAUDE.md
  cited. — **Mitigation:** `verify` runs them all, and each is updated with the text it pins.

## Subtasks

1. [ ] CLAUDE.md, the README and `.env.example`.
2. [ ] The living docs, and the code comments.
3. [ ] ADR 0016, ADR 0002's status line, and the ADR index.
4. [ ] The atlas.
