# ---------------- Dependencies ----------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies are needed to compile TypeScript.
RUN npm ci

# ---------------- Build ----------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------- Production dependencies ----------------
# Installed separately rather than copied out of `deps`, so the runtime image
# never carries typescript, vitest, supertest or tsx. That is image bloat and
# reachable surface (a test runner and a TS compiler have no business being
# callable in production) on top of the size saving.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------- Runtime ----------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Email logo used by the contact form
COPY --from=build /app/asset ./asset

# The `node` user ships with the base image (uid/gid 1000). Running as root
# would mean a container escape starts with root on the host.
# Created as root before the USER switch, then chowned to node so the runtime
# process (uid 1000) owns them. The bind mount in docker-compose.yml overrides
# this with the host directory, so that one needs to be writable by uid 1000 as
# well.
RUN mkdir -p /app/uploads/tracks /app/uploads/covers && chown -R node:node /app/uploads

USER node

EXPOSE 7000

# Uses wget from busybox rather than adding a healthcheck dependency layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:7000/health || exit 1

CMD ["node", "dist/index.js"]