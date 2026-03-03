# LifeNode

LifeNode is a local-first Raspberry Pi web app with:

- Rust backend (`axum` + `sqlx` + SQLite)
- React frontend (`Vite` + `MUI`)
- Per-user local storage under `./user-files/<username>/...`

It includes:

- Wikipedia download + indexing
- Semantic search over indexed chunks
- Retrieval-based Q&A endpoint
- Calendar events
- Notes
- File upload/download per user

## Storage Model

SQLite DB is local-only and lives at:

- `/data/user-files/lifenode.db` in Docker
- configurable by `LIFENODE_DB_PATH`

Per-user filesystem data goes to:

- `./user-files/<username>/files` for uploaded files
- `./user-files/<username>/wiki` for cached article text

## Run With Docker

```bash
cd LifeNode
cp .env.example .env
mkdir -p user-files
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

