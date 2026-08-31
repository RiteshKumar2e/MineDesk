# MineDesk API - multi-stage build.
#
# The monorepo's workspace packages (types, protocol, shared) must be built
# before the API, since it imports their compiled output rather than source.
#
# Build from the repo root:
#   docker build -f infrastructure/docker/api.Dockerfile -t minedesk-api .

FROM node:22-alpine AS base
WORKDIR /app

# ---------------------------------------------------------------- dependencies
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci

# --------------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/protocol packages/protocol
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @minedesk/types -w @minedesk/protocol -w @minedesk/shared
RUN npm run build -w @minedesk/api

# --------------------------------------------------------- production deps
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev

# ------------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S minedesk && adduser -S minedesk -G minedesk

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/types/dist packages/types/dist
COPY --from=build /app/packages/types/package.json packages/types/package.json
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/db/schema.sql apps/api/db/schema.sql

USER minedesk
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
