# PulseReader: one image with the web app and the server that syncs it.
#
#   cp .env.example .env    # set API_KEY (your password) and the folders
#   docker compose up -d --build
#
# Then open http://<host>:3000 on any device and sign in.

# ---- web app ----------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npx vite build

# ---- server dependencies (better-sqlite3 is native) -------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY sync-server/package.json sync-server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    BOOKS_DIR=/data/books \
    DATA_DIR=/data
# API_KEY is passed at runtime (.env / docker-compose), never baked in.
COPY --from=deps /app/node_modules ./node_modules
COPY sync-server/package.json ./
COPY sync-server/src ./src
COPY --from=web /web/dist ./web
RUN mkdir -p /data/books /data/db
EXPOSE 3000
VOLUME ["/data/books", "/data/db"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "src/index.js"]
