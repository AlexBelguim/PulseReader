FROM node:22-alpine

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY src/ ./src/

# Create data directory
RUN mkdir -p /data/books /data/db

# Environment variables
ENV PORT=3000
ENV BOOKS_DIR=/data/books
ENV DATA_DIR=/data
# API_KEY is passed at runtime via -e or docker-compose

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
