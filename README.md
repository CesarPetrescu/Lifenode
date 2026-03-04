# LifeNode

LifeNode is a local-first, self-hosted knowledge workspace.

It runs as a single web app with:

- Rust backend (`axum` + `sqlx` + SQLite)
- React frontend (`Vite` + `MUI`)
- `llama.cpp` services for chat + embeddings
- Per-user local storage under `./user-files`

## What You Get

- Authenticated multi-user app with optional admin bootstrap.
- `Wiki` tab: Kiwix Wikipedia download center + embedded Kiwix viewer.
- `Maps` tab: OpenStreetMap download center + embedded OSM visualizer.
- Download job system for maps/wiki payloads (queue, progress, cancel, delete logs, delete files).
- `Ask` tab with:
  - chat sidebar and persistent thread history
  - thread create/rename/delete
  - streaming assistant responses over SSE (`/api/ask/stream`)
  - optional model "thinking" mode
- `Notes` tab with folder tree, file management, markdown editing, and live preview.
- `Drive` tab with folder/file operations and rich file preview.
- Drive viewer supports Markdown, text, PDF, image, audio, and video formats.
- `Calendar` tab for personal events.
- Health indicator for backend + model status.

## Architecture

```text
Browser (React + MUI)
        |
        v
Rust API (Axum)  ---> SQLite (user/files + metadata)
        |
        +---> llama-qwen (chat, OpenAI-compatible endpoint)
        +---> llama-embed (embeddings, OpenAI-compatible endpoint)
        +---> Kiwix service (serves downloaded .zim files)
```

## Quick Start (Docker)

1. Clone and enter the repo.
2. Create env file and required directories.
3. Place GGUF model files.
4. Build and start all services.

```bash
cp .env.example .env
mkdir -p user-files models

# put your models in ./models
# - Qwen3.5-0.8B-UD-Q3_K_XL.gguf
# - embeddinggemma-300M-Q8_0.gguf

docker compose up --build -d
docker compose ps
```

Open:

- App: `http://<your-private-ip>:8000`
- Kiwix direct (optional): `http://<your-private-ip>:8081`

Find your Wi-Fi private IP (Linux):

```bash
ip -4 addr show wlan0 | awk '/inet / {print $2}' | cut -d/ -f1
```

If your Wi-Fi interface is not `wlan0`, replace it (for example `wlp2s0`).

## Service Layout

`compose.yml` runs 4 services:

- `lifenode`: backend API + bundled frontend
- `llama-qwen`: chat inference
- `llama-embed`: embeddings
- `kiwix`: serves local `.zim` files on port `8081`

## Storage Layout

- Database: `./user-files/lifenode.db`
- Per-user maps/wiki files: `./user-files/<username>/maps/...`
- Per-user drive files: `./user-files/<username>/files/...`
- Other per-user assets are stored under `./user-files/<username>/...`

## Local Development

Backend:

```bash
cd backend
cargo run
```

Frontend:

```bash
cd frontend
npm install
npm run dev -- --host
```

Optional frontend API override:

```bash
export VITE_API_BASE=http://127.0.0.1:8000/api
```

## Key Environment Variables

General:

- `LIFENODE_HOST` (default `0.0.0.0`)
- `LIFENODE_PORT` (default `8000`)
- `LIFENODE_CORS_ORIGINS` (default `*`)
- `LIFENODE_MAX_UPLOAD_MB` (default `100`)

Storage:

- `LIFENODE_DB_PATH` (default `/data/user-files/lifenode.db`)
- `LIFENODE_USER_FILES_DIR` (default `/data/user-files`)
- `LIFENODE_FRONTEND_DIST` (default `/app/frontend/dist`)

Admin bootstrap (optional):

- `LIFENODE_ADMIN_USERNAME`
- `LIFENODE_ADMIN_PASSWORD`

Kiwix:

- `LIFENODE_KIWIX_EMBED_URL` (default `http://localhost:8081`)
- `LIFENODE_KIWIX_PORT` (default `8081`)

llama.cpp endpoints:

- `LIFENODE_LLAMACPP_EMBED_URL`
- `LIFENODE_LLAMACPP_EMBED_MODEL`
- `LIFENODE_LLAMACPP_CHAT_URL`
- `LIFENODE_LLAMACPP_CHAT_MODEL`
- `LIFENODE_LLAMACPP_API_KEY`
- `LIFENODE_LLAMACPP_CHAT_MAX_TOKENS`
- `LIFENODE_LLAMACPP_CHAT_TIMEOUT_SECS`
- `LIFENODE_LLAMACPP_CHAT_THINKING_DEFAULT`

llama.cpp container runtime:

- `LLAMACPP_QWEN_MODEL_PATH`
- `LLAMACPP_EMBED_MODEL_PATH`
- `LLAMACPP_QWEN_CTX`
- `LLAMACPP_EMBED_CTX`
- `LLAMACPP_NGL`

## API Overview

Main route groups:

- Auth: `/api/auth/*`
- Ask + chat threads: `/api/ask/*`
- Maps/wiki download center: `/api/maps/*`
- Legacy wiki indexing/search endpoints: `/api/wiki/*`, `/api/search`
- Notes: `/api/notes/*`
- Drive: `/api/drive/*`
- Calendar: `/api/calendar/*`
- Health: `/api/health`

For a concrete route map, see `backend/src/main.rs`.

## Build and Verify

Backend:

```bash
cd backend
cargo check
```

Frontend:

```bash
cd frontend
npm run build
```

Stack:

```bash
docker compose up --build -d
docker compose ps
```

## Troubleshooting

- Download preset returns 404:
  - Use `Custom Download URL` in the UI for a known-good `.zim` or `.osm.pbf`.
  - The backend also attempts to auto-discover latest Kiwix English filenames.
- Kiwix panel is blank:
  - Confirm at least one `.zim` file exists in your configured user-files mount.
  - Confirm `kiwix` container is running and `LIFENODE_KIWIX_EMBED_URL` is reachable.
- Chat answers are fallback-style:
  - Check `GET /api/health`; if llama services are unavailable, backend falls back to deterministic embeddings and retrieval-only behavior.
