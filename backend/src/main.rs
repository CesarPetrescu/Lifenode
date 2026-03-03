use std::{
    cmp::Ordering,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::Context;
use axum::{
    Json, Router,
    body::Body,
    extract::{Multipart, Path as AxumPath, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, get_service, post},
};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{
    ConnectOptions, Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use tokio::io::AsyncWriteExt;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use urlencoding::encode;

const EMBEDDING_DIM: usize = 384;
const DEFAULT_TOP_K: u32 = 4;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    http_client: Client,
    user_files_dir: PathBuf,
    wiki_lang: String,
    max_upload_bytes: usize,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "error": self.message }));
        (self.status, body).into_response()
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Deserialize)]
struct WikiDownloadRequest {
    username: String,
    title: String,
    lang: Option<String>,
}

#[derive(Deserialize)]
struct SearchRequest {
    username: String,
    query: String,
    top_k: Option<u32>,
}

#[derive(Deserialize)]
struct AskRequest {
    username: String,
    question: String,
    top_k: Option<u32>,
}

#[derive(Deserialize)]
struct NoteUpdateRequest {
    content: String,
}

#[derive(Deserialize)]
struct CalendarEventCreateRequest {
    title: String,
    start_ts: String,
    end_ts: String,
    details: Option<String>,
}

#[derive(Serialize)]
struct SearchResultItem {
    article_id: i64,
    title: String,
    chunk_index: i64,
    text: String,
    score: f64,
}

#[derive(Serialize)]
struct DriveFileItem {
    filename: String,
    size: u64,
    modified_at: String,
}

#[derive(Serialize)]
struct WikiArticleItem {
    id: i64,
    title: String,
    url: String,
    downloaded_at: String,
}

#[derive(Serialize)]
struct CalendarEventItem {
    id: i64,
    title: String,
    start_ts: String,
    end_ts: String,
    details: String,
}

#[derive(Serialize)]
struct NoteItem {
    content: String,
    updated_at: String,
}

#[derive(Clone)]
struct WikipediaArticle {
    title: String,
    url: String,
    content: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lifenode_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let host = std::env::var("LIFENODE_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port: u16 = std::env::var("LIFENODE_PORT")
        .unwrap_or_else(|_| "8000".to_string())
        .parse()
        .context("LIFENODE_PORT must be a valid u16")?;
    let wiki_lang = std::env::var("LIFENODE_WIKI_LANG").unwrap_or_else(|_| "en".to_string());
    let db_path = std::env::var("LIFENODE_DB_PATH")
        .unwrap_or_else(|_| "./user-files/lifenode.db".to_string());
    let user_files_dir = PathBuf::from(
        std::env::var("LIFENODE_USER_FILES_DIR").unwrap_or_else(|_| "./user-files".to_string()),
    );
    let frontend_dist = PathBuf::from(
        std::env::var("LIFENODE_FRONTEND_DIST").unwrap_or_else(|_| "./frontend/dist".to_string()),
    );
    let max_upload_mb: usize = std::env::var("LIFENODE_MAX_UPLOAD_MB")
        .unwrap_or_else(|_| "100".to_string())
        .parse()
        .context("LIFENODE_MAX_UPLOAD_MB must be an integer")?;
    let max_upload_bytes = max_upload_mb * 1024 * 1024;
    let cors_origins_raw =
        std::env::var("LIFENODE_CORS_ORIGINS").unwrap_or_else(|_| "*".to_string());

    tokio::fs::create_dir_all(&user_files_dir).await?;

    let connect_opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .disable_statement_logging();

    let db = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(connect_opts)
        .await
        .with_context(|| format!("Failed to open SQLite DB at {}", db_path))?;

    init_db(&db).await?;

    let state = AppState {
        db,
        http_client: Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("Failed to build HTTP client")?,
        user_files_dir,
        wiki_lang,
        max_upload_bytes,
    };

    let cors = build_cors(&cors_origins_raw)?;

    let api_router = Router::new()
        .route("/health", get(health))
        .route("/wiki/download", post(wiki_download))
        .route("/wiki/articles/{username}", get(list_wiki_articles))
        .route("/search", post(semantic_search))
        .route("/ask", post(ask_question))
        .route("/notes/{username}", get(get_note).put(update_note))
        .route(
            "/calendar/events/{username}",
            get(list_calendar_events).post(create_calendar_event),
        )
        .route(
            "/calendar/events/{username}/{event_id}",
            delete(delete_calendar_event),
        )
        .route("/drive/upload/{username}", post(upload_file))
        .route("/drive/files/{username}", get(list_files))
        .route("/drive/download/{username}/{filename}", get(download_file))
        .route("/drive/files/{username}/{filename}", delete(delete_file));

    let mut app = Router::new().nest("/api", api_router);
    let index_file = frontend_dist.join("index.html");
    if index_file.is_file() {
        let static_service = get_service(
            ServeDir::new(&frontend_dist).not_found_service(ServeFile::new(&index_file)),
        );
        app = app.fallback_service(static_service);
        info!("Serving frontend from {}", frontend_dist.display());
    } else {
        app = app.route("/", get(root_message));
        info!(
            "Frontend dist not found at {}. API mode only.",
            frontend_dist.display()
        );
    }

    let app = app
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let socket_addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .with_context(|| format!("Invalid bind address {host}:{port}"))?;
    let listener = tokio::net::TcpListener::bind(socket_addr).await?;

    info!("LifeNode backend listening on http://{}", socket_addr);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn init_db(db: &SqlitePool) -> anyhow::Result<()> {
    let schema = r#"
    CREATE TABLE IF NOT EXISTS wiki_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        content TEXT NOT NULL,
        downloaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(username, title)
    );

    CREATE TABLE IF NOT EXISTS wiki_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        FOREIGN KEY(article_id) REFERENCES wiki_articles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notes (
        username TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        title TEXT NOT NULL,
        start_ts TEXT NOT NULL,
        end_ts TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    "#;

    sqlx::query(schema).execute(db).await?;
    Ok(())
}

fn build_cors(raw: &str) -> anyhow::Result<CorsLayer> {
    let trimmed = raw.trim();
    if trimmed == "*" {
        return Ok(CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any));
    }

    let mut origins = Vec::new();
    for item in trimmed.split(',') {
        let origin = item.trim();
        if origin.is_empty() {
            continue;
        }
        let hv = HeaderValue::from_str(origin)
            .with_context(|| format!("Invalid CORS origin in LIFENODE_CORS_ORIGINS: {origin}"))?;
        origins.push(hv);
    }
    if origins.is_empty() {
        return Ok(CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any));
    }

    Ok(CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any)
        .allow_origin(origins))
}

async fn root_message() -> impl IntoResponse {
    Json(json!({
        "message": "LifeNode backend running. Frontend is not built yet.",
        "hint": "Build frontend and set LIFENODE_FRONTEND_DIST."
    }))
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "time": Utc::now().to_rfc3339(),
    }))
}

async fn wiki_download(
    State(state): State<AppState>,
    Json(payload): Json<WikiDownloadRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let title = payload.title.trim();
    if title.is_empty() {
        return Err(AppError::new(StatusCode::BAD_REQUEST, "Title is required"));
    }
    let lang = payload
        .lang
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(&state.wiki_lang);

    let article = fetch_wikipedia_article(&state.http_client, title, lang).await?;
    let chunks = chunk_text(&article.content, 900, 150);
    let embeddings: Vec<Vec<f32>> = chunks
        .iter()
        .map(|chunk| hash_embedding(chunk, EMBEDDING_DIM))
        .collect();

    let mut tx = state.db.begin().await.map_err(internal_error)?;

    let existing = sqlx::query("SELECT id FROM wiki_articles WHERE username = ? AND title = ?")
        .bind(&username)
        .bind(&article.title)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal_error)?;

    let article_id: i64 = if let Some(row) = existing {
        let id: i64 = row.get("id");
        sqlx::query(
            "UPDATE wiki_articles SET url = ?, content = ?, downloaded_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(&article.url)
        .bind(&article.content)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
        sqlx::query("DELETE FROM wiki_chunks WHERE article_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
        id
    } else {
        let res = sqlx::query(
            "INSERT INTO wiki_articles (username, title, url, content) VALUES (?, ?, ?, ?)",
        )
        .bind(&username)
        .bind(&article.title)
        .bind(&article.url)
        .bind(&article.content)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
        res.last_insert_rowid()
    };

    for (idx, (chunk, embedding)) in chunks.iter().zip(embeddings.iter()).enumerate() {
        let embedding_json = serde_json::to_string(embedding).map_err(internal_error)?;
        sqlx::query(
            "INSERT INTO wiki_chunks (article_id, username, chunk_index, text, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(article_id)
        .bind(&username)
        .bind(idx as i64)
        .bind(chunk)
        .bind(embedding_json)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
    }

    tx.commit().await.map_err(internal_error)?;

    let wiki_dir = ensure_user_wiki_dir(&state.user_files_dir, &username).await?;
    let article_filename = sanitize_storage_name(&article.title);
    let article_path = wiki_dir.join(format!("{article_filename}.txt"));
    tokio::fs::write(&article_path, article.content.as_bytes())
        .await
        .map_err(internal_error)?;

    Ok(Json(json!({
        "username": username,
        "article_id": article_id,
        "title": article.title,
        "url": article.url,
        "indexed_chunks": chunks.len(),
        "cached_file": article_path.to_string_lossy(),
    })))
}

async fn list_wiki_articles(
    State(state): State<AppState>,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let rows = sqlx::query(
        "SELECT id, title, url, downloaded_at FROM wiki_articles WHERE username = ? ORDER BY downloaded_at DESC",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let articles: Vec<WikiArticleItem> = rows
        .into_iter()
        .map(|row| WikiArticleItem {
            id: row.get("id"),
            title: row.get("title"),
            url: row.get("url"),
            downloaded_at: row.get("downloaded_at"),
        })
        .collect();

    Ok(Json(articles))
}

async fn semantic_search(
    State(state): State<AppState>,
    Json(payload): Json<SearchRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let query = payload.query.trim();
    if query.is_empty() {
        return Err(AppError::new(StatusCode::BAD_REQUEST, "Query is required"));
    }
    let top_k = payload.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 20) as usize;

    let ranked = rank_chunks(&state.db, &username, query, top_k).await?;
    Ok(Json(json!({
        "username": username,
        "query": query,
        "results": ranked,
    })))
}

async fn ask_question(
    State(state): State<AppState>,
    Json(payload): Json<AskRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let question = payload.question.trim();
    if question.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Question is required",
        ));
    }
    let top_k = payload.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 20) as usize;

    let ranked = rank_chunks(&state.db, &username, question, top_k).await?;
    let answer = if ranked.is_empty() {
        "No indexed Wikipedia context found for this user yet.".to_string()
    } else {
        let mut text =
            String::from("Retrieval-based answer (LLM not wired in this Rust build yet):\n\n");
        for (idx, item) in ranked.iter().take(3).enumerate() {
            let excerpt = trim_to_chars(&item.text, 420);
            text.push_str(&format!(
                "{}. {} [chunk {} | score {:.4}]\n{}\n\n",
                idx + 1,
                item.title,
                item.chunk_index,
                item.score,
                excerpt
            ));
        }
        text.push_str("Question: ");
        text.push_str(question);
        text
    };

    Ok(Json(json!({
        "username": username,
        "question": question,
        "answer": answer,
        "contexts": ranked,
    })))
}

async fn get_note(
    State(state): State<AppState>,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let row = sqlx::query("SELECT content, updated_at FROM notes WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_error)?;

    let note = if let Some(row) = row {
        NoteItem {
            content: row.get("content"),
            updated_at: row.get("updated_at"),
        }
    } else {
        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO notes (username, content, updated_at) VALUES (?, '', ?)")
            .bind(&username)
            .bind(&now)
            .execute(&state.db)
            .await
            .map_err(internal_error)?;
        NoteItem {
            content: String::new(),
            updated_at: now,
        }
    };

    Ok(Json(note))
}

async fn update_note(
    State(state): State<AppState>,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<NoteUpdateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO notes (username, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
    )
    .bind(&username)
    .bind(payload.content)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    Ok(Json(NoteItem {
        content: sqlx::query_scalar::<_, String>("SELECT content FROM notes WHERE username = ?")
            .bind(&username)
            .fetch_one(&state.db)
            .await
            .map_err(internal_error)?,
        updated_at: now,
    }))
}

async fn list_calendar_events(
    State(state): State<AppState>,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let rows = sqlx::query(
        "SELECT id, title, start_ts, end_ts, details FROM calendar_events WHERE username = ? ORDER BY start_ts ASC",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let items: Vec<CalendarEventItem> = rows
        .into_iter()
        .map(|row| CalendarEventItem {
            id: row.get("id"),
            title: row.get("title"),
            start_ts: row.get("start_ts"),
            end_ts: row.get("end_ts"),
            details: row.get("details"),
        })
        .collect();
    Ok(Json(items))
}

async fn create_calendar_event(
    State(state): State<AppState>,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<CalendarEventCreateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let title = payload.title.trim();
    if title.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Event title is required",
        ));
    }
    if payload.start_ts.trim().is_empty() || payload.end_ts.trim().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "start_ts and end_ts are required",
        ));
    }

    let res = sqlx::query(
        "INSERT INTO calendar_events (username, title, start_ts, end_ts, details) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(title)
    .bind(payload.start_ts)
    .bind(payload.end_ts)
    .bind(payload.details.unwrap_or_default())
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    let event_id = res.last_insert_rowid();
    let row = sqlx::query(
        "SELECT id, title, start_ts, end_ts, details FROM calendar_events WHERE id = ? AND username = ?",
    )
    .bind(event_id)
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .map_err(internal_error)?;

    Ok(Json(CalendarEventItem {
        id: row.get("id"),
        title: row.get("title"),
        start_ts: row.get("start_ts"),
        end_ts: row.get("end_ts"),
        details: row.get("details"),
    }))
}

async fn delete_calendar_event(
    State(state): State<AppState>,
    AxumPath((username_raw, event_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let res = sqlx::query("DELETE FROM calendar_events WHERE id = ? AND username = ?")
        .bind(event_id)
        .bind(&username)
        .execute(&state.db)
        .await
        .map_err(internal_error)?;

    if res.rows_affected() == 0 {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Event not found"));
    }
    Ok(Json(json!({ "deleted": true })))
}

async fn upload_file(
    State(state): State<AppState>,
    AxumPath(username_raw): AxumPath<String>,
    mut multipart: Multipart,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;

    while let Some(field) = multipart.next_field().await.map_err(bad_request)? {
        if field.name() != Some("file") {
            continue;
        }

        let original_name = field.file_name().unwrap_or("upload.bin");
        let filename = sanitize_filename(original_name)
            .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid filename"))?;
        let file_path = files_dir.join(&filename);
        let mut output = tokio::fs::File::create(&file_path)
            .await
            .map_err(internal_error)?;

        let mut written: usize = 0;
        let mut field = field;
        while let Some(chunk) = field.chunk().await.map_err(bad_request)? {
            written += chunk.len();
            if written > state.max_upload_bytes {
                let _ = tokio::fs::remove_file(&file_path).await;
                return Err(AppError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "File exceeds max upload size",
                ));
            }
            output.write_all(&chunk).await.map_err(internal_error)?;
        }
        output.flush().await.map_err(internal_error)?;

        return Ok(Json(json!({
            "username": username,
            "filename": filename,
            "size": written,
        })));
    }

    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        "Multipart field `file` is required",
    ))
}

async fn list_files(
    State(state): State<AppState>,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;

    let mut entries = tokio::fs::read_dir(&files_dir)
        .await
        .map_err(internal_error)?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(internal_error)? {
        let file_type = entry.file_type().await.map_err(internal_error)?;
        if !file_type.is_file() {
            continue;
        }
        let metadata = entry.metadata().await.map_err(internal_error)?;
        let modified = metadata
            .modified()
            .ok()
            .map(DateTime::<Utc>::from)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        files.push(DriveFileItem {
            filename: entry.file_name().to_string_lossy().to_string(),
            size: metadata.len(),
            modified_at: modified,
        });
    }

    files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(Json(files))
}

async fn download_file(
    State(state): State<AppState>,
    AxumPath((username_raw, filename_raw)): AxumPath<(String, String)>,
) -> AppResult<Response> {
    let username = sanitize_username(&username_raw)?;
    let filename = sanitize_filename(&filename_raw)
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid filename"))?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;
    let file_path = files_dir.join(&filename);
    if !file_path.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }

    let bytes = tokio::fs::read(&file_path).await.map_err(internal_error)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let content_disposition = format!("attachment; filename=\"{}\"", filename);
    if let Ok(v) = HeaderValue::from_str(&content_disposition) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(response)
}

async fn delete_file(
    State(state): State<AppState>,
    AxumPath((username_raw, filename_raw)): AxumPath<(String, String)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let filename = sanitize_filename(&filename_raw)
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid filename"))?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;
    let file_path = files_dir.join(&filename);
    if !file_path.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }
    tokio::fs::remove_file(&file_path)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "deleted": true })))
}

async fn rank_chunks(
    db: &SqlitePool,
    username: &str,
    query: &str,
    top_k: usize,
) -> AppResult<Vec<SearchResultItem>> {
    let rows = sqlx::query(
        "SELECT c.article_id, a.title, c.chunk_index, c.text, c.embedding
         FROM wiki_chunks c
         JOIN wiki_articles a ON a.id = c.article_id
         WHERE c.username = ?",
    )
    .bind(username)
    .fetch_all(db)
    .await
    .map_err(internal_error)?;

    let query_embedding = hash_embedding(query, EMBEDDING_DIM);
    let mut scored = Vec::new();

    for row in rows {
        let embedding_json: String = row.get("embedding");
        let embedding: Vec<f32> = serde_json::from_str(&embedding_json).unwrap_or_default();
        let score = cosine_similarity(&query_embedding, &embedding);
        scored.push(SearchResultItem {
            article_id: row.get("article_id"),
            title: row.get("title"),
            chunk_index: row.get("chunk_index"),
            text: row.get("text"),
            score,
        });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    if scored.len() > top_k {
        scored.truncate(top_k);
    }
    Ok(scored)
}

async fn fetch_wikipedia_article(
    client: &Client,
    title: &str,
    lang: &str,
) -> AppResult<WikipediaArticle> {
    let endpoint = format!("https://{}.wikipedia.org/w/api.php", lang);
    let resp = client
        .get(&endpoint)
        .query(&[
            ("action", "query"),
            ("format", "json"),
            ("prop", "extracts"),
            ("explaintext", "1"),
            ("redirects", "1"),
            ("titles", title),
        ])
        .send()
        .await
        .map_err(internal_error)?
        .error_for_status()
        .map_err(internal_error)?;

    let payload: Value = resp.json().await.map_err(internal_error)?;
    let pages = payload
        .get("query")
        .and_then(|v| v.get("pages"))
        .and_then(|v| v.as_object())
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "Wikipedia response missing pages"))?;

    let page = pages
        .values()
        .next()
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "Wikipedia article not found"))?;
    let article_title = page
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(title)
        .to_string();
    let extract = page
        .get("extract")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if extract.is_empty() {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            format!("Wikipedia article `{}` has no extract", article_title),
        ));
    }

    let title_slug = article_title.replace(' ', "_");
    let encoded_title = encode(&title_slug);
    Ok(WikipediaArticle {
        title: article_title,
        url: format!("https://{}.wikipedia.org/wiki/{}", lang, encoded_title),
        content: extract,
    })
}

fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Vec::new();
    }

    let overlap = if overlap >= chunk_size {
        chunk_size / 4
    } else {
        overlap
    };
    let bytes = normalized.as_bytes();
    let mut start = 0usize;
    let mut chunks = Vec::new();

    while start < bytes.len() {
        let mut end = (start + chunk_size).min(bytes.len());
        while end < bytes.len() && !normalized.is_char_boundary(end) {
            end -= 1;
        }
        if end <= start {
            break;
        }

        let slice = normalized[start..end].trim();
        if !slice.is_empty() {
            chunks.push(slice.to_string());
        }

        if end == bytes.len() {
            break;
        }

        start = end.saturating_sub(overlap);
        while start < bytes.len() && !normalized.is_char_boundary(start) {
            start += 1;
        }
    }

    chunks
}

fn hash_embedding(text: &str, dim: usize) -> Vec<f32> {
    if dim == 0 {
        return Vec::new();
    }

    let mut vector = vec![0.0f32; dim];
    let tokens = tokenize(text);
    if tokens.is_empty() {
        return vector;
    }

    for token in tokens {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        let digest = hasher.finalize();
        let idx = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) as usize % dim;
        let sign = if digest[4] % 2 == 0 { 1.0 } else { -1.0 };
        vector[idx] += sign;
    }

    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            cur.push(ch.to_ascii_lowercase());
        } else if !cur.is_empty() {
            out.push(cur.clone());
            cur.clear();
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let xf = *x as f64;
        let yf = *y as f64;
        dot += xf * yf;
        norm_a += xf * xf;
        norm_b += yf * yf;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

async fn ensure_user_files_dir(base: &Path, username: &str) -> AppResult<PathBuf> {
    let user_root = base.join(username);
    let files_dir = user_root.join("files");
    tokio::fs::create_dir_all(&files_dir)
        .await
        .map_err(internal_error)?;
    Ok(files_dir)
}

async fn ensure_user_wiki_dir(base: &Path, username: &str) -> AppResult<PathBuf> {
    let user_root = base.join(username);
    let wiki_dir = user_root.join("wiki");
    tokio::fs::create_dir_all(&wiki_dir)
        .await
        .map_err(internal_error)?;
    Ok(wiki_dir)
}

fn sanitize_username(input: &str) -> AppResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Username is required",
        ));
    }
    if trimmed.len() > 64 {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Username must be <= 64 characters",
        ));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Username can only contain [a-zA-Z0-9_-]",
        ));
    }
    Ok(trimmed.to_string())
}

fn sanitize_filename(input: &str) -> Option<String> {
    let fname = Path::new(input).file_name()?.to_string_lossy().to_string();
    if fname.is_empty() || fname.len() > 255 {
        return None;
    }
    if fname.starts_with('.') {
        return None;
    }
    if fname
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ')
    {
        Some(fname)
    } else {
        None
    }
}

fn sanitize_storage_name(input: &str) -> String {
    let mut out = String::new();
    for c in input.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c.is_whitespace() {
            out.push('_');
        }
    }
    if out.is_empty() {
        "article".to_string()
    } else {
        out
    }
}

fn trim_to_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    input.chars().take(max_chars).collect::<String>() + "..."
}

fn bad_request<E: std::fmt::Display>(err: E) -> AppError {
    AppError::new(StatusCode::BAD_REQUEST, err.to_string())
}

fn internal_error<E: std::fmt::Display>(err: E) -> AppError {
    AppError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}
