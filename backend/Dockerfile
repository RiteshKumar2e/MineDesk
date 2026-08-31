# MineDesk backend - standalone image, no monorepo/workspace dependency.
#
# Build from this folder:
#   cd backend
#   docker build -t minedesk-backend .

FROM node:22-alpine AS deps
WORKDIR /app
# package-lock.json is deliberately NOT copied in: it's generated on whatever
# OS a developer last ran `npm install` on (Windows, here), so it only has a
# resolved entry for that platform's @libsql/* native binary. Installing
# from package.json alone lets npm resolve the *actual* platform-correct
# optional dependency (@libsql/linux-x64-musl on this Alpine image) fresh
# every build, instead of reusing a lockfile that doesn't know musl exists.
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S minedesk && adduser -S minedesk -G minedesk

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db/schema.sql ./db/schema.sql

USER minedesk
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
