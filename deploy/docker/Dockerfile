# Version-pinned images; Docker builds have not been executed in the development sandbox.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/accounting/package.json packages/accounting/package.json
COPY packages/inventory/package.json packages/inventory/package.json
RUN npm install --global npm@10.8.2 && npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL DEMO_MODE=false NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS api
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=production-dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/artifacts/server ./artifacts/server
COPY --from=build --chown=1000:1000 /app/database/migrations ./database/migrations
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
RUN mkdir -p /app/uploads && chown 1000:1000 /app/uploads
USER 1000:1000
EXPOSE 4000
CMD ["node","artifacts/server/api.mjs"]

FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/artifacts/web ./
USER 1000:1000
EXPOSE 3000
CMD ["node","apps/web/server.js"]

# pg_dump/pg_restore must be the same major version as PostgreSQL, not Debian's
# potentially older default client. The official PG17 image provides those tools.
FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826 AS ops
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates tar && rm -rf /var/lib/apt/lists/*
COPY --from=api /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=api /app/node_modules ./node_modules
COPY --from=api /app/artifacts/server ./artifacts/server
COPY --from=api /app/database ./database
COPY --from=api /app/package.json ./package.json
ENTRYPOINT ["node"]
CMD ["artifacts/server/reconcile.mjs"]
