> **Type:** Infra
> **Wave:** 18-node26-runtime
> **Branch:** `feat/node26-no-deno`
> **Commit style:** `ci: summary`
> **Design:** [ADR 0016](../../adr/0016-the-server-runs-on-node-26.md); this ticket is the spec
> **Dependencies:** 0003

## Goal

CI, the container image and the systemd unit run the server on Node 26 and install nothing from
Deno.

## Non-goals

- Do not dispatch a workflow. Actions credit is low, so every check runs on this machine.
- Do not change a workflow's triggers. Every workflow stays `workflow_dispatch`, gated by
  `ci-local`.
- Do not rename the GHCR image `ghcr.io/companionintelligence/ci-web-xr-scan` (CLAUDE.md, "Do not
  rename").

## Pinned conventions

- **The workflow.** `.github/workflows/deno-ci.yml` becomes `.github/workflows/server-ci.yml`,
  named "Server CI", with two jobs:
  - `server-test`: `actions/setup-node` from `.node-version`, `npm ci` with the CUDA skip,
    `npm run typecheck:server`, `npm run test:server`;
  - `detection-gate`: as before, without Deno.

  `actions/setup-node` is pinned to the SHA the other workflows use
  (`49933ea5288caeca8642d1e84afbd3f7d6820020`, v4.4.0).
- **Docker.**
  - Stage 1 is `FROM node:26-alpine`, and stage 2 is `FROM node:26-trixie-slim` (the README,
    decision 2: decided by the owner, 2026-11-24).
  - Stage 2 installs `ffmpeg` with apt. Node comes with the image.
  - It runs `npm ci --omit=dev --ignore-scripts`. onnxruntime-node's CPU libraries ship in its
    package, and its install script only fetches the CUDA ones, which the image does not use.
  - It starts with `CMD ["node", "server/main.ts"]`.
  - The `COPY` lines for `server/`, `src/world/`, `src/shared/`, `src/inference/` and
    `src/geo/tile-source.ts` stay, and
    `tests/unit/node/wp-docker-server-imports.test.ts` still holds them to the server's imports.
- **systemd.** `deploy/systemd/cscan-server.service` runs `__NODE__ server/main.ts`.
  `scripts/install-services.sh` fills `__NODE__` from the `node` it already resolves for the Vite
  unit.

## Before implementation

- `Dockerfile`, `.github/workflows/docker-publish.yml` (its smoke boot),
  `.github/workflows/deno-ci.yml`, `deploy/systemd/*.service`, `deploy/cscan.env.example` and
  `scripts/install-services.sh`.

## Open questions & answers

- Q: Base image tag or digest? — A: The major tags, `node:26-trixie-slim` and `node:26-alpine`
  (the README, decision 2). Decided by the owner, 2026-11-24.

## Files impacted

- Renamed: `.github/workflows/deno-ci.yml` → `.github/workflows/server-ci.yml`.
- Changed:
  - `Dockerfile`;
  - `.github/workflows/docker-publish.yml`, `quest-build.yml` and `subsystem-tests.yml` (comments
    that name the Deno workflow);
  - `deploy/systemd/cscan-server.service`, `deploy/cscan.env.example` and
    `scripts/install-services.sh`.

## Schema required

None.

## Definition of Done

- [x] `docker build .` succeeds here, and the image answers `GET /health` with the mock engine.
- [x] `git grep -n -i deno -- .github Dockerfile deploy` finds nothing.

## Tests

- [x] A local image build and boot, as `docker-publish.yml`'s smoke step does.
- [x] `npm run test:native-release` and the other source-shape tests that read the workflows
  still pass (they run in `verify`).

```
docker build -t cscan-node26 .
docker run --rm -d -p 8124:8000 -e INFERENCE_MODE=mock cscan-node26   # then curl :8124/health
```

## Acceptance Criteria

- [x] The image boots, serves `/health`, and serves the bundle at `/`.

## Risks / potential issues

- **Risk:** The image grows, because `npm ci --omit=dev` installs the browser libraries in
  `dependencies` too. — **Mitigation:** measured and reported in the PR. Splitting them out is
  deferred (the README).
- **Risk:** The workflow rename resets the run history GitHub shows for "Deno CI". —
  **Mitigation:** none needed; the old runs stay under the old name.

## Subtasks

1. [x] Rename and rewrite the workflow.
2. [x] Rewrite the Dockerfile's server stage, and build and boot it here.
3. [x] Move the systemd unit and its installer to Node.
