# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Frontend (web/): manifests first for layer caching, then sources.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web/tsconfig.json web/vite.config.ts web/index.html ./web/
COPY web/src ./web/src
RUN cd web && npm run build

# ---- runtime stage ----
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The API serves the built frontend from web/dist (see src/server.ts).
COPY --from=build /app/web/dist ./web/dist
# Keep .sql files next to the compiled runner so `node dist/db/migrate.js` finds them.
COPY src/db/migrations ./dist/db/migrations
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
