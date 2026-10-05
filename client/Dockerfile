# Pxxl treats a Dockerfile source as a Web Service, not a static app. That is
# what we need: the demo is an Express API plus the SPA it serves, so there has
# to be a process alive after the build finishes.
FROM node:22-bookworm-slim

RUN corepack enable

WORKDIR /app

# Manifests first so the dependency layer caches independently of source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No --prod: tsx (the start script) is a devDependency.
RUN pnpm install --frozen-lockfile

COPY . .

# vite builds the SPA into web/dist, which server/index.ts serves statically.
RUN pnpm run build:web

ENV NODE_ENV=production
EXPOSE 3000

# server/index.ts reads PORT (default 8788) and express binds 0.0.0.0.
CMD ["pnpm", "start"]