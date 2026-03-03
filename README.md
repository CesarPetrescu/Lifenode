# LifeNode

LifeNode is a local-first Raspberry Pi web app with:

- Rust backend (`axum` + `sqlx` + SQLite)
- React frontend (`Vite` + `MUI`)
- `llama.cpp` for embeddings and Qwen chat inference
- Per-user local storage in `./user-files/<username>/...`

## Features

- Wikipedia download + indexing
- Semantic search (embeddings via `llama.cpp`)
- Q&A over retrieved context (Qwen via `llama.cpp`)
- Calendar events
- Notes
- File upload/download per user

## Storage Model

- SQLite DB: `./user-files/lifenode.db`
- User uploads: `./user-files/<username>/files`
- Cached wiki text: `./user-files/<username>/wiki`

## Models

Put your GGUF files in `./models`:

- `Qwen3.5-0.8B-UD-Q3_K_XL.gguf`
- `embeddinggemma-300M-Q8_0.gguf`

You can change paths in `.env`.

## Run With Docker

```bash
cd LifeNode
cp .env.example .env
mkdir -p user-files models
docker compose build
docker compose up -d
docker compose logs -f
```

Open:

- `http://<rpi-ip>:8000`

## Local Dev

### Backend

```bash
cd backend
cargo run
```

### Frontend

```bash
cd frontend
npm install
npm run dev -- --host
```

Set frontend API base in dev if needed:

```bash
export VITE_API_BASE=http://<backend-host>:8000/api
```

## Environment Variables

- `LIFENODE_HOST` default `0.0.0.0`
- `LIFENODE_PORT` default `8000`
- `LIFENODE_WIKI_LANG` default `en`
- `LIFENODE_DB_PATH` default `/data/user-files/lifenode.db`
- `LIFENODE_USER_FILES_DIR` default `/data/user-files`
- `LIFENODE_FRONTEND_DIST` default `/app/frontend/dist`
- `LIFENODE_MAX_UPLOAD_MB` default `100`
- `LIFENODE_CORS_ORIGINS` default `*`
- `LIFENODE_LLAMACPP_EMBED_URL` default `http://llama-embed:8080/v1/embeddings`
- `LIFENODE_LLAMACPP_EMBED_MODEL` default `embeddinggemma-300M-Q8_0.gguf`
- `LIFENODE_LLAMACPP_CHAT_URL` default `http://llama-qwen:8080/v1/chat/completions`
- `LIFENODE_LLAMACPP_CHAT_MODEL` default `Qwen3.5-0.8B-UD-Q3_K_XL.gguf`
- `LIFENODE_LLAMACPP_CHAT_TEMPERATURE` default `0.2`
- `LIFENODE_LLAMACPP_CHAT_MAX_TOKENS` default `320`

If llama services are unavailable, backend falls back to:

- deterministic hash embeddings
- retrieval-only answer formatting

## API Summary

- `GET /api/health`
- `POST /api/wiki/download`
- `GET /api/wiki/articles/{username}`
- `POST /api/search`
- `POST /api/ask`
- `GET /api/notes/{username}`
- `PUT /api/notes/{username}`
- `GET /api/calendar/events/{username}`
- `POST /api/calendar/events/{username}`
- `DELETE /api/calendar/events/{username}/{event_id}`
- `POST /api/drive/upload/{username}`
- `GET /api/drive/files/{username}`
- `GET /api/drive/download/{username}/{filename}`
- `DELETE /api/drive/files/{username}/{filename}`

