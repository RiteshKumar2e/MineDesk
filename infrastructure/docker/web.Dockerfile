# MineDesk web dashboard - static build served by nginx.
#
# VITE_API_URL / VITE_WS_URL are baked in at build time (Vite inlines
# import.meta.env at compile time, it cannot read them at container start), so
# they are passed as build args rather than runtime environment variables.
#
# Build from the repo root:
#   docker build -f infrastructure/docker/web.Dockerfile \
#     --build-arg VITE_API_URL=https://api.example.com \
#     --build-arg VITE_WS_URL=wss://api.example.com \
#     -t minedesk-web .

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci

FROM deps AS build
ARG VITE_API_URL=http://localhost:4000
ARG VITE_WS_URL=ws://localhost:4000
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

COPY tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/protocol packages/protocol
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @minedesk/types -w @minedesk/protocol -w @minedesk/shared
RUN npm run build -w @minedesk/web

FROM nginx:1.27-alpine AS runtime
COPY infrastructure/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
