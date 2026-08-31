# MineDesk frontend - standalone static build, no monorepo/workspace dependency.
#
# VITE_API_URL / VITE_WS_URL are baked in at build time (Vite inlines
# import.meta.env at compile time, it cannot read them at container start), so
# they are passed as build args rather than runtime environment variables.
#
# Build from this folder:
#   cd frontend
#   docker build \
#     --build-arg VITE_API_URL=https://api.example.com \
#     --build-arg VITE_WS_URL=wss://api.example.com \
#     -t minedesk-frontend .

FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:4000
ARG VITE_WS_URL=ws://localhost:4000
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

# package-lock.json is deliberately NOT copied in: it's generated on whatever
# OS a developer last ran `npm install` on (Windows, here), so it only has a
# resolved entry for that platform's Rollup/esbuild native binary. Installing
# from package.json alone lets npm resolve the platform-correct optional
# dependency fresh every build instead of reusing a lockfile that doesn't
# know about this image's platform.
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
