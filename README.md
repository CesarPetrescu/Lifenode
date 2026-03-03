# LifeNode

Offline-first Raspberry Pi web hub: download Wikipedia, run local semantic search + LLM Q&A, plus calendar, live-synced notes, and a lightweight file drive.

## What It Includes

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

## Quick Start

```bash
cd LifeNode
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Optional model paths (recommended on Raspberry Pi)
export LIFENODE_LLM_MODEL_PATH=/path/to/Qwen3.5-0.8B-UD-Q3_K_XL.gguf
export LIFENODE_EMBED_MODEL_PATH=/path/to/embeddinggemma-300M-Q8_0.gguf

uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `http://<rpi-ip>:8000` from your browser.

## Environment Variables

- `LIFENODE_DATA_DIR` (default: `./data`)
- `LIFENODE_DB_PATH` (default: `<data_dir>/lifenode.db`)
- `LIFENODE_DRIVE_DIR` (default: `<data_dir>/drive`)
- `LIFENODE_WIKI_LANG` (default: `en`)
- `LIFENODE_LLM_MODEL_PATH` (optional)
- `LIFENODE_EMBED_MODEL_PATH` (optional)

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

