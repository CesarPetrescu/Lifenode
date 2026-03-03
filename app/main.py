import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app import db
from app.models import (
    AskRequest,
    CalendarEventCreateRequest,
    NoteUpdateRequest,
    SearchRequest,
    WikiDownloadRequest,
)
from app.services.llm import LocalLlmService
from app.services.vector import EmbeddingService, chunk_text, cosine_similarity
from app.services.wiki import fetch_wikipedia_article


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.getenv("LIFENODE_DATA_DIR", str(BASE_DIR / "data"))).resolve()
DRIVE_DIR = Path(os.getenv("LIFENODE_DRIVE_DIR", str(DATA_DIR / "drive"))).resolve()
DB_PATH = Path(os.getenv("LIFENODE_DB_PATH", str(DATA_DIR / "lifenode.db"))).resolve()
WIKI_LANG = os.getenv("LIFENODE_WIKI_LANG", "en")
LLM_MODEL_PATH = os.getenv("LIFENODE_LLM_MODEL_PATH")
EMBED_MODEL_PATH = os.getenv("LIFENODE_EMBED_MODEL_PATH")


DATA_DIR.mkdir(parents=True, exist_ok=True)
DRIVE_DIR.mkdir(parents=True, exist_ok=True)
db.init_db(DB_PATH)
embedding_service = EmbeddingService(EMBED_MODEL_PATH)
llm_service = LocalLlmService(LLM_MODEL_PATH)

app = FastAPI(title="LifeNode", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

note_clients: set[WebSocket] = set()


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _safe_drive_path(filename: str) -> Path:
    normalized = Path(filename).name
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = (DRIVE_DIR / normalized).resolve()
    if path.parent != DRIVE_DIR:
        raise HTTPException(status_code=400, detail="Invalid path")
    return path


def _rank_chunks(query: str, top_k: int) -> list[dict[str, Any]]:
    chunks = db.list_wiki_chunks()
    if not chunks:
        return []

    query_embedding = embedding_service.encode([query])[0]
    scored: list[dict[str, Any]] = []
    for chunk in chunks:
        score = cosine_similarity(query_embedding, chunk["embedding"])
        scored.append(
            {
                "article_id": chunk["article_id"],
                "title": chunk["title"],
                "chunk_index": chunk["chunk_index"],
                "text": chunk["text"],
                "score": score,
            }
        )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:top_k]


async def _broadcast_note(content: str) -> None:
    disconnected: list[WebSocket] = []
    message = {"type": "note", "content": content, "updated_at": _utc_now()}
    for client in note_clients:
        try:
            await client.send_json(message)
        except Exception:
            disconnected.append(client)
    for client in disconnected:
        note_clients.discard(client)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "time": _utc_now(),
        "embedding_backend": embedding_service.backend,
        "llm_backend": llm_service.backend,
    }


@app.post("/api/wiki/download")
def download_wiki(payload: WikiDownloadRequest) -> dict[str, Any]:
    article = fetch_wikipedia_article(payload.title, lang=WIKI_LANG)
    chunks = chunk_text(article["content"])
    embeddings = embedding_service.encode(chunks)
    article_id = db.upsert_wiki_article(article["title"], article["url"], article["content"])
    db.replace_article_chunks(article_id, chunks, embeddings)
    return {
        "article_id": article_id,
        "title": article["title"],
        "url": article["url"],
        "indexed_chunks": len(chunks),
        "embedding_backend": embedding_service.backend,
    }


@app.get("/api/wiki/articles")
def list_wiki_articles() -> list[dict[str, Any]]:
    return db.list_wiki_articles()


@app.post("/api/search")
def semantic_search(payload: SearchRequest) -> dict[str, Any]:
    results = _rank_chunks(payload.query, payload.top_k)
    return {"query": payload.query, "results": results}


@app.post("/api/ask")
def ask(payload: AskRequest) -> dict[str, Any]:
    ranked = _rank_chunks(payload.question, payload.top_k)
    context_chunks = [item["text"] for item in ranked]
    answer = llm_service.answer(payload.question, context_chunks)
    return {"question": payload.question, "answer": answer, "contexts": ranked}


@app.get("/api/notes")
def get_note() -> dict[str, Any]:
    return db.get_note()


@app.put("/api/notes")
async def update_note(payload: NoteUpdateRequest) -> dict[str, Any]:
    note = db.set_note(payload.content)
    await _broadcast_note(note["content"])
    return note


@app.websocket("/ws/notes")
async def notes_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    note_clients.add(websocket)
    current = db.get_note()
    await websocket.send_json(
        {"type": "note", "content": current["content"], "updated_at": current["updated_at"]}
    )

    try:
        while True:
            event = await websocket.receive_json()
            if event.get("type") == "note":
                content = str(event.get("content", ""))
                db.set_note(content)
                await _broadcast_note(content)
    except WebSocketDisconnect:
        note_clients.discard(websocket)
    except Exception:
        note_clients.discard(websocket)


@app.get("/api/calendar/events")
def list_events() -> list[dict[str, Any]]:
    return db.list_calendar_events()


@app.post("/api/calendar/events")
def create_event(payload: CalendarEventCreateRequest) -> dict[str, Any]:
    return db.create_calendar_event(
        title=payload.title,
        start_ts=payload.start_ts,
        end_ts=payload.end_ts,
        details=payload.details,
    )


@app.delete("/api/calendar/events/{event_id}")
def delete_event(event_id: int) -> dict[str, Any]:
    deleted = db.delete_calendar_event(event_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"deleted": True}


@app.post("/api/drive/upload")
async def upload_file(file: UploadFile = File(...)) -> dict[str, Any]:
    target = _safe_drive_path(file.filename or "")
    content = await file.read()
    target.write_bytes(content)
    return {"filename": target.name, "size": len(content)}


@app.get("/api/drive/files")
def list_files() -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for path in sorted(DRIVE_DIR.glob("*")):
        if path.is_file():
            stat = path.stat()
            files.append(
                {
                    "filename": path.name,
                    "size": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
                }
            )
    return files


@app.get("/api/drive/download/{filename}")
def download_file(filename: str) -> FileResponse:
    target = _safe_drive_path(filename)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path=target, filename=target.name)


@app.delete("/api/drive/files/{filename}")
def delete_file(filename: str) -> dict[str, Any]:
    target = _safe_drive_path(filename)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    target.unlink()
    return {"deleted": True}

