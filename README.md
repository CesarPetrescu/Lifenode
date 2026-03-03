# LifeNode

Offline-first Raspberry Pi web hub: download Wikipedia, run local semantic search + LLM Q&A, plus calendar, live-synced notes, and a lightweight file drive.

## Features

- Wikipedia downloader and local storage
- Semantic search over indexed Wikipedia chunks
- Local Q&A over retrieved context (GGUF via `llama.cpp` when available)
- Calendar event manager
- Live-synced notes (WebSocket)
- Browser file upload/download mini-drive

## Model Targets

- LLM model family: `Qwen/Qwen3.5-0.8B`
- GGUF file target: `Qwen3.5-0.8B-UD-Q3_K_XL.gguf`
- LLM GGUF page: <https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF?show_file_info=Qwen3.5-0.8B-UD-Q3_K_XL.gguf>

- Embedding model family: `google/embeddinggemma-300m`
- GGUF file target: `embeddinggemma-300M-Q8_0.gguf`
- Embedding GGUF page: <https://huggingface.co/unsloth/embeddinggemma-300m-GGUF?show_file_info=embeddinggemma-300M-Q8_0.gguf>

## Docker Deploy (Recommended)

```bash
cd LifeNode
cp .env.example .env
mkdir -p models

# Put your GGUF files in ./models
# models/Qwen3.5-0.8B-UD-Q3_K_XL.gguf
# models/embeddinggemma-300M-Q8_0.gguf

docker compose build
docker compose up -d
docker compose logs -f
```

Open `http://<rpi-ip>:8000`.

### Docker Notes

- Persistent data is stored in the Docker volume `lifenode_data`.
- Models are loaded from `./models` on the host (read-only mount).
- The app runs as a non-root user in the container.
- Healthcheck is enabled (`/api/health`).

If `llama-cpp-python` build is too heavy for your Pi, build without LLM backend:

```bash
INSTALL_LLM_BACKEND=0 docker compose build --no-cache
docker compose up -d
```

In that mode, retrieval still works and `/api/ask` uses fallback answer formatting.

## Local Dev (No Docker)

```bash
cd LifeNode
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Optional local model paths
export LIFENODE_LLM_MODEL_PATH=/absolute/path/Qwen3.5-0.8B-UD-Q3_K_XL.gguf
export LIFENODE_EMBED_MODEL_PATH=/absolute/path/embeddinggemma-300M-Q8_0.gguf

uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Environment Variables

- `LIFENODE_DATA_DIR` (default: `./data`)
- `LIFENODE_DB_PATH` (default: `<data_dir>/lifenode.db`)
- `LIFENODE_DRIVE_DIR` (default: `<data_dir>/drive`)
- `LIFENODE_WIKI_LANG` (default: `en`)
- `LIFENODE_LLM_MODEL_PATH` (optional)
- `LIFENODE_EMBED_MODEL_PATH` (optional)
- `LIFENODE_MAX_UPLOAD_MB` (default: `100`)
- `LIFENODE_CORS_ORIGINS` (default: `*`)
- `LIFENODE_LOG_LEVEL` (default: `INFO`)

If model paths are not set or model loading fails, LifeNode still works with fallback retrieval behavior:
- embeddings use a deterministic hash embedding fallback
- Q&A returns retrieval-grounded context fallback

## API Summary

- `POST /api/wiki/download` download and index a Wikipedia article
- `GET /api/wiki/articles` list indexed articles
- `POST /api/search` semantic search over indexed chunks
- `POST /api/ask` retrieve + answer from local model/fallback
- `GET/PUT /api/notes` read/update notes
- `WS /ws/notes` live note sync
- `GET/POST/DELETE /api/calendar/events` calendar CRUD
- `POST /api/drive/upload` upload file
- `GET /api/drive/files` list files
- `GET /api/drive/download/{filename}` download file
- `DELETE /api/drive/files/{filename}` delete file
