import json
import sqlite3
import threading
from pathlib import Path
from typing import Any


_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def init_db(db_path: Path) -> None:
    global _conn
    db_path.parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(db_path, check_same_thread=False)
    _conn.row_factory = sqlite3.Row

    with _lock:
        cursor = _conn.cursor()
        cursor.executescript(
            """
            CREATE TABLE IF NOT EXISTS wiki_articles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL UNIQUE,
                url TEXT NOT NULL,
                content TEXT NOT NULL,
                downloaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS wiki_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding TEXT NOT NULL,
                FOREIGN KEY(article_id) REFERENCES wiki_articles(id)
            );

            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                content TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS calendar_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                start_ts TEXT NOT NULL,
                end_ts TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT ''
            );
            """
        )
        cursor.execute(
            "INSERT OR IGNORE INTO notes (id, content, updated_at) VALUES (1, '', CURRENT_TIMESTAMP)"
        )
        _conn.commit()


def _must_conn() -> sqlite3.Connection:
    if _conn is None:
        raise RuntimeError("Database is not initialized")
    return _conn


def _fetch_all(query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    conn = _must_conn()
    with _lock:
        cursor = conn.execute(query, params)
        return cursor.fetchall()


def _fetch_one(query: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
    conn = _must_conn()
    with _lock:
        cursor = conn.execute(query, params)
        return cursor.fetchone()


def _execute(query: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
    conn = _must_conn()
    with _lock:
        cursor = conn.execute(query, params)
        conn.commit()
        return cursor


def upsert_wiki_article(title: str, url: str, content: str) -> int:
    existing = _fetch_one("SELECT id FROM wiki_articles WHERE title = ?", (title,))
    if existing:
        article_id = int(existing["id"])
        _execute(
            """
            UPDATE wiki_articles
            SET url = ?, content = ?, downloaded_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (url, content, article_id),
        )
    else:
        cursor = _execute(
            "INSERT INTO wiki_articles (title, url, content) VALUES (?, ?, ?)",
            (title, url, content),
        )
        article_id = int(cursor.lastrowid)
    return article_id


def replace_article_chunks(article_id: int, chunks: list[str], embeddings: list[list[float]]) -> None:
    if len(chunks) != len(embeddings):
        raise ValueError("Chunk and embedding counts must match")

    conn = _must_conn()
    with _lock:
        conn.execute("DELETE FROM wiki_chunks WHERE article_id = ?", (article_id,))
        conn.executemany(
            """
            INSERT INTO wiki_chunks (article_id, chunk_index, text, embedding)
            VALUES (?, ?, ?, ?)
            """,
            [
                (article_id, idx, chunk, json.dumps(embedding))
                for idx, (chunk, embedding) in enumerate(zip(chunks, embeddings, strict=True))
            ],
        )
        conn.commit()


def list_wiki_articles() -> list[dict[str, Any]]:
    rows = _fetch_all(
        "SELECT id, title, url, downloaded_at FROM wiki_articles ORDER BY downloaded_at DESC"
    )
    return [dict(row) for row in rows]


def list_wiki_chunks() -> list[dict[str, Any]]:
    rows = _fetch_all(
        """
        SELECT c.id, c.article_id, a.title, c.chunk_index, c.text, c.embedding
        FROM wiki_chunks c
        JOIN wiki_articles a ON a.id = c.article_id
        """
    )
    chunks: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["embedding"] = json.loads(item["embedding"])
        chunks.append(item)
    return chunks


def get_note() -> dict[str, Any]:
    row = _fetch_one("SELECT content, updated_at FROM notes WHERE id = 1")
    if row is None:
        return {"content": "", "updated_at": ""}
    return dict(row)


def set_note(content: str) -> dict[str, Any]:
    _execute(
        """
        UPDATE notes
        SET content = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        """,
        (content,),
    )
    return get_note()


def list_calendar_events() -> list[dict[str, Any]]:
    rows = _fetch_all(
        """
        SELECT id, title, start_ts, end_ts, details
        FROM calendar_events
        ORDER BY start_ts ASC
        """
    )
    return [dict(row) for row in rows]


def create_calendar_event(title: str, start_ts: str, end_ts: str, details: str) -> dict[str, Any]:
    cursor = _execute(
        """
        INSERT INTO calendar_events (title, start_ts, end_ts, details)
        VALUES (?, ?, ?, ?)
        """,
        (title, start_ts, end_ts, details),
    )
    event_id = int(cursor.lastrowid)
    row = _fetch_one(
        "SELECT id, title, start_ts, end_ts, details FROM calendar_events WHERE id = ?",
        (event_id,),
    )
    if row is None:
        raise RuntimeError("Failed to fetch newly created event")
    return dict(row)


def delete_calendar_event(event_id: int) -> bool:
    cursor = _execute("DELETE FROM calendar_events WHERE id = ?", (event_id,))
    return cursor.rowcount > 0

