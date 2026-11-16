# AI Sites isolated build worker (Stage 5A). Build from the repository root AFTER
# `npm run build:server`:
#
#   docker build -f deploy/cloud-build-worker/Dockerfile -t REGION-docker.pkg.dev/PROJECT/REPO/build-worker .
#
# Then deploy the job with the pushed image's @sha256 digest (never a tag).
#
# The image must contain no secrets: it copies ONLY package manifests and dist/.
# Sandboxes mount this root filesystem read-only, so anything here is readable by
# untrusted build code. Never COPY .env, credentials, .npmrc or the repository.
#
# Pin the base image by digest before use (e.g. node:22-bookworm-slim@sha256:...).
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY dist ./dist

# Per-build host directory (bind-mounted into sandboxes); the worker needs no root.
RUN mkdir -p /work && chown node:node /work
USER node
ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/publishing/cloud/worker/main.js"]
CMD ["build"]
