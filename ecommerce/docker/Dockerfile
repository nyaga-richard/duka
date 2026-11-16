# E-commerce images. One install/build stage, then two runtime targets:
#   docker build --target api  -f docker/Dockerfile .   (api / worker / migrate / seed)
#   docker build --target web  -f docker/Dockerfile .   (storefront + admin)
#
# The API and web targets deliberately share one `npm ci` install stage: the web
# runtime needs Next, which the workspace declares as a dependency of
# apps/web, so a pruned copy would either lose Next or keep it anyway. The API
# process only ever loads dist/ (bundled) plus the root runtime dependencies.
FROM node:22-alpine AS build
WORKDIR /app
# Installation must see dev dependencies (esbuild, tsx, Next), so the stage is
# NOT production. The Next build below therefore overrides NODE_ENV explicitly.
ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY database ./database
RUN npm ci --no-audit --no-fund

ARG API_INTERNAL_URL=http://shop-api:4100
ENV API_INTERNAL_URL=${API_INTERNAL_URL}

# API/worker/esbuild bundle first (independent of NODE_ENV), so a web-build
# failure does not throw away this layer.
RUN npm run build

# `next build` MUST run with NODE_ENV=production. Under any other value Next 16
# loads the development React runtime and static prerendering dies with
# "Cannot read properties of null (reading 'useContext')" on /_global-error.
RUN NODE_ENV=production npm run build:web


# ---- API / worker / migrate / seed -------------------------------------------
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4100

# `database/` carries the reviewed forward-only migrations that dist/migrate.mjs
# and dist/seed.mjs read from the working directory.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/database ./database

# The container runs unprivileged; no build toolchain is invoked at run time.
USER node
EXPOSE 4100
CMD ["node", "dist/api.mjs"]


# ---- Storefront / admin web --------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    API_INTERNAL_URL=http://shop-api:4100

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web ./apps/web

USER node
EXPOSE 3100
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0", "--port", "3100"]
