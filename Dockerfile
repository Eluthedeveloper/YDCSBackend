# ---------------- Dependencies ----------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------- Build ----------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------- Runtime ----------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Email logo used by the contact form
COPY --from=build /app/asset ./asset

# Uploaded tracks & covers (use a named volume at /app/uploads for persistence)
RUN mkdir -p /app/uploads/tracks /app/uploads/covers

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:7000/health || exit 1

CMD ["node", "dist/index.js"]