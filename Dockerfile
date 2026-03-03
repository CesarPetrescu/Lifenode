# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.93-bookworm AS backend-builder
WORKDIR /build/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 lifenode

WORKDIR /app
COPY --from=backend-builder /build/backend/target/release/lifenode-backend /usr/local/bin/lifenode-backend
COPY --from=frontend-builder /build/frontend/dist /app/frontend/dist

RUN mkdir -p /data/user-files && chown -R lifenode:lifenode /app /data
USER lifenode

ENV LIFENODE_HOST=0.0.0.0 \
    LIFENODE_PORT=8000 \
    LIFENODE_WIKI_LANG=en \
    LIFENODE_DB_PATH=/data/user-files/lifenode.db \
    LIFENODE_USER_FILES_DIR=/data/user-files \
    LIFENODE_FRONTEND_DIST=/app/frontend/dist \
    LIFENODE_MAX_UPLOAD_MB=100 \
    LIFENODE_CORS_ORIGINS=*

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

CMD ["lifenode-backend"]

