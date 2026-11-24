# Companion Scan — single-container image for CI-Hub marketplace installs.
#
# Stage 1 builds the Vite static bundle (scanner + editor UI); stage 2 is the
# API server on Node, which also serves that bundle via the STATIC_DIR
# fall-through in server/main.ts — one container, one port (8000), UI + API.

# Stage 1 — build the static viewer bundle (vite)
FROM node:26-alpine AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json vite.config.ts ./
# Root .ts is now only vite.config.ts/playwright.config.ts (thing_tags moved to
# src/shared/, which COPY src/ already covers). Kept as a glob rather than
# deleted: it costs nothing and it is what stops the next browser-imported root
# module from silently failing the bundle, which is how this line was earned.
COPY *.ts ./
# Every root HTML file. Also a glob: vite.config.ts's `input` map grew
# ar-hittest-sphere.html (#115) and ar-ground-anchor.html (wave 09) after this
# line was written, and Vite fails the build with UNRESOLVED_ENTRY when an
# entry it names is missing from the context. Same failure mode the server
# module copy below avoids, one stage earlier.
COPY *.html ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/copy-draco.mjs ./scripts/copy-draco.mjs
RUN node scripts/copy-draco.mjs && npx vite build

# Stage 2 — the API server, on Node 26 (the version .node-version names; see ADR 0016)
# Debian, not Alpine: onnxruntime-node ships glibc builds only.
FROM node:26-trixie-slim
WORKDIR /app

# ffmpeg powers the /ingest-video and /ingest-photos routes (server/main.ts
# spawns `node scripts/ingest-*.mjs`, which shell out to ffmpeg/ffprobe).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# The server's packages, from the lockfile, before the source: a source change
# then reuses this layer. --omit=dev leaves out the build and test tools.
# --ignore-scripts skips the root package's postinstall (it copies browser
# assets that the bundle from stage 1 already holds) and its git-hook setup
# (there is no checkout here); onnxruntime-node's CPU libraries ship in its
# package, and its install script only fetches the CUDA ones, which this image
# does not use.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Server modules. `COPY server/ ./server/` grabs the whole directory rather than
# a hand-maintained file list — the previous approach (an explicit COPY list,
# then a *.ts glob at the repo root) twice fell behind as server/main.ts grew
# new static imports the list didn't name, so the image failed to load
# server/main.ts without anyone noticing (publishing is workflow_dispatch-only).
# A directory copy can't have that failure mode: it structurally cannot omit a
# file that exists under server/. `*.ts` at the root now only matches
# vite.config.ts and playwright.config.ts (everything server-side now lives
# under server/), so it's kept as a harmless glob rather than deleted, for the
# same reason: it's what stops the next root-level module from silently missing
# the build instead of failing it.
COPY *.ts ./
COPY server/ ./server/
COPY src/world/ ./src/world/
COPY src/shared/ ./src/shared/
# server/inference.ts imports ../src/inference/lfm-driver.ts; omitting this broke
# the image's module load (Module not found) in the 2026-09-06 publish run.
COPY src/inference/ ./src/inference/
# server/main.ts imports ../src/geo/tile-source.ts (the map tile setting, which the browser reads
# too). One file, not src/geo/: the rest of that folder is browser code the image has no use for.
# tests/unit/node/wp-docker-server-imports.test.ts fails when a file the server imports from
# src/ is not copied by a line here, so this list cannot fall behind unseen again.
COPY src/geo/tile-source.ts ./src/geo/tile-source.ts

# Runtime worker scripts. The Python workers (lingbot-map, splat-detect) and
# the Brush trainer need GPU-capable hosts — install them on the host and point
# LINGBOT_MAP_PYTHON / SPLAT_DETECT_PYTHON / SPLAT_TRAIN_BIN at them; the jobs
# degrade gracefully (skippedReason) when the binaries are absent.
# NOTE: these are spawned by server/main.ts at runtime, so their own imports must be
# here too — ingest-{video,photos}.mjs both `import './ingest-quality.mjs'`.
# A miss here is invisible at build time and only shows up as a 500 from the
# ingest routes in a real install.
COPY scripts/lingbot_map_worker.py ./scripts/lingbot_map_worker.py
# Both Python workers import this sibling for device selection (NVIDIA/AMD/
# Apple/CPU). Omitting it does not fail the build — the workers degrade to
# 'skipped' with a copy hint at run time, which reads like a missing GPU tool
# rather than a missing file. Keep it beside the workers.
COPY scripts/_torch_device.py ./scripts/_torch_device.py
# The floor-plan job runs this on LINGBOT_MAP_PYTHON over the cloud LingBot-Map wrote. It needs only numpy and
# imports no sibling.
COPY scripts/floor_plan_worker.py ./scripts/floor_plan_worker.py
COPY scripts/ingest-video.mjs ./scripts/ingest-video.mjs
COPY scripts/ingest-photos.mjs ./scripts/ingest-photos.mjs
COPY scripts/ingest-quality.mjs ./scripts/ingest-quality.mjs

# Static viewer bundle from stage 1
COPY --from=web /web/dist ./dist

# Model files must be mounted at runtime — DO NOT bake 1.5 GB into the image:
#   docker run -v /path/to/models:/app/public/models ...
#
# Persist scans (uploads + optimized artifacts + keyframe sessions) and worlds:
#   docker run -v scans:/app/scans -v worlds:/app/worlds ...

EXPOSE 8000

# Node runs the TypeScript as it is, stripping its types: there is no build step.
CMD ["node", "server/main.ts"]
