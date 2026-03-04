mod ask;
mod auth;
mod calendar;
mod db;
mod drive;
mod error;
mod maps;
mod notes;
mod search;
mod state;
mod types;
mod utils;
mod wiki;

use std::{net::SocketAddr, path::PathBuf};

use anyhow::Context;
use axum::{
    Json, Router,
    extract::State,
    response::IntoResponse,
    routing::{delete, get, get_service, post, put},
};
use chrono::Utc;
use reqwest::Client;
use serde_json::json;
use sqlx::{
    ConnectOptions,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use state::{AppState, LLAMA_CHAT_TIMEOUT_SECS_DEFAULT, LlamaChatConfig, LlamaEmbeddingConfig};
use utils::{build_cors, non_empty, parse_env_bool};

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
    let wiki_user_agent = non_empty(std::env::var("LIFENODE_WIKI_USER_AGENT").unwrap_or_else(
        |_| "LifeNode/1.0 (+https://github.com/CesarPetrescu/LifeNode)".to_string(),
    ))
    .unwrap_or_else(|| "LifeNode/1.0 (+https://github.com/CesarPetrescu/LifeNode)".to_string());
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
    let llama_embed_url = std::env::var("LIFENODE_LLAMACPP_EMBED_URL")
        .unwrap_or_else(|_| "http://llama-embed:8080/v1/embeddings".to_string());
    let llama_embed_model = std::env::var("LIFENODE_LLAMACPP_EMBED_MODEL")
        .unwrap_or_else(|_| "embeddinggemma-300M-Q8_0.gguf".to_string());
    let llama_chat_url = std::env::var("LIFENODE_LLAMACPP_CHAT_URL")
        .unwrap_or_else(|_| "http://llama-qwen:8080/v1/chat/completions".to_string());
    let llama_chat_model = std::env::var("LIFENODE_LLAMACPP_CHAT_MODEL")
        .unwrap_or_else(|_| "Qwen3.5-0.8B-UD-Q3_K_XL.gguf".to_string());
    let llama_api_key = std::env::var("LIFENODE_LLAMACPP_API_KEY")
        .ok()
        .and_then(|v| non_empty(v));
    let llama_chat_max_tokens: u32 = std::env::var("LIFENODE_LLAMACPP_CHAT_MAX_TOKENS")
        .unwrap_or_else(|_| "1024".to_string())
        .parse()
        .context("LIFENODE_LLAMACPP_CHAT_MAX_TOKENS must be an integer")?;
    let llama_chat_timeout_secs: u64 = std::env::var("LIFENODE_LLAMACPP_CHAT_TIMEOUT_SECS")
        .unwrap_or_else(|_| LLAMA_CHAT_TIMEOUT_SECS_DEFAULT.to_string())
        .parse()
        .context("LIFENODE_LLAMACPP_CHAT_TIMEOUT_SECS must be an integer")?;
    let llama_chat_default_thinking =
        parse_env_bool("LIFENODE_LLAMACPP_CHAT_THINKING_DEFAULT", false)
            .context("LIFENODE_LLAMACPP_CHAT_THINKING_DEFAULT must be a boolean")?;

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

    db::init_db(&db).await?;
    let admin_username = std::env::var("LIFENODE_ADMIN_USERNAME")
        .ok()
        .and_then(non_empty);
    let admin_password = std::env::var("LIFENODE_ADMIN_PASSWORD")
        .ok()
        .and_then(non_empty);
    if let (Some(username), Some(password)) = (admin_username, admin_password) {
        auth::bootstrap_admin_account(&db, &username, &password).await?;
    }

    let llama_embedding = if llama_embed_url.trim().is_empty() {
        None
    } else {
        Some(LlamaEmbeddingConfig {
            url: llama_embed_url.clone(),
            model: non_empty(llama_embed_model),
            api_key: llama_api_key.clone(),
        })
    };
    let llama_chat = if llama_chat_url.trim().is_empty() {
        None
    } else {
        Some(LlamaChatConfig {
            url: llama_chat_url.clone(),
            model: non_empty(llama_chat_model),
            api_key: llama_api_key,
            max_tokens: llama_chat_max_tokens,
            timeout_secs: llama_chat_timeout_secs.max(10),
            default_thinking: llama_chat_default_thinking,
        })
    };

    if let Some(cfg) = &llama_embedding {
        info!("llama.cpp embeddings enabled at {}", cfg.url);
    } else {
        warn!("llama.cpp embeddings disabled, using hash fallback embeddings");
    }
    if let Some(cfg) = &llama_chat {
        info!("llama.cpp chat enabled at {}", cfg.url);
    } else {
        warn!("llama.cpp chat disabled, using retrieval-only fallback answers");
    }

    let app_state = AppState {
        db,
        http_client: Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent(&wiki_user_agent)
            .build()
            .context("Failed to build HTTP client")?,
        user_files_dir,
        wiki_lang,
        max_upload_bytes,
        llama_embedding,
        llama_chat,
    };

    let cors = build_cors(&cors_origins_raw)?;

    let auth_router = Router::new()
        .route("/register", post(auth::auth_register))
        .route("/login", post(auth::auth_login))
        .route("/me", get(auth::auth_me))
        .route("/logout", post(auth::auth_logout))
        .route("/users", get(auth::auth_list_users))
        .route("/users/{user_id}/role", post(auth::auth_update_user_role));

    let api_router = Router::new()
        .nest("/auth", auth_router)
        .route("/health", get(health))
        .route("/wiki/download", post(wiki::wiki_download))
        .route("/wiki/export/{username}", get(wiki::export_wiki_text))
        .route("/wiki/bulk/start", post(wiki::start_wiki_bulk_download))
        .route("/wiki/bulk/jobs/{username}", get(wiki::list_wiki_bulk_jobs))
        .route(
            "/wiki/bulk/jobs/{username}/{job_id}",
            get(wiki::get_wiki_bulk_job),
        )
        .route(
            "/wiki/bulk/jobs/{username}/{job_id}/cancel",
            post(wiki::cancel_wiki_bulk_job),
        )
        .route("/wiki/articles/{username}", get(wiki::list_wiki_articles))
        .route(
            "/wiki/articles/{username}/{article_id}",
            get(wiki::get_wiki_article),
        )
        .route("/search", post(search::semantic_search))
        .route("/ask", post(ask::ask_question))
        .route("/ask/stream", post(ask::ask_question_stream))
        .route("/maps/catalog", get(maps::maps_catalog))
        .route(
            "/maps/jobs/{username}",
            get(maps::list_download_jobs).post(maps::start_download_job),
        )
        .route(
            "/maps/jobs/{username}/{job_id}",
            delete(maps::delete_download_job),
        )
        .route(
            "/maps/jobs/{username}/{job_id}/cancel",
            post(maps::cancel_download_job),
        )
        .route(
            "/maps/files/{username}",
            get(maps::list_map_files).delete(maps::delete_map_file_by_path),
        )
        .route(
            "/maps/download/{username}",
            get(maps::download_map_file_by_path),
        )
        .route(
            "/ask/threads/{username}",
            get(ask::list_threads).post(ask::create_thread),
        )
        .route(
            "/ask/threads/{username}/{thread_id}",
            get(ask::get_thread)
                .put(ask::rename_thread)
                .delete(ask::delete_thread),
        )
        .route(
            "/notes/{username}",
            get(notes::get_note).put(notes::update_note),
        )
        .route("/notes/tree/{username}", get(notes::get_notes_tree))
        .route("/notes/folders/{username}", post(notes::create_note_folder))
        .route(
            "/notes/folders/{username}/{folder_id}",
            put(notes::update_note_folder).delete(notes::delete_note_folder),
        )
        .route("/notes/files/{username}", post(notes::create_note_file))
        .route(
            "/notes/files/{username}/{file_id}",
            get(notes::get_note_file)
                .put(notes::update_note_file)
                .delete(notes::delete_note_file),
        )
        .route(
            "/calendar/events/{username}",
            get(calendar::list_calendar_events).post(calendar::create_calendar_event),
        )
        .route(
            "/calendar/events/{username}/{event_id}",
            delete(calendar::delete_calendar_event),
        )
        .route("/drive/upload/{username}", post(drive::upload_file))
        .route("/drive/tree/{username}", get(drive::get_drive_tree))
        .route(
            "/drive/folders/{username}",
            post(drive::create_folder).delete(drive::delete_folder),
        )
        .route(
            "/drive/content/{username}",
            get(drive::open_file).delete(drive::delete_file_by_path),
        )
        .route(
            "/drive/download/{username}",
            get(drive::download_file_by_path),
        )
        .route("/drive/files/{username}", get(drive::list_files))
        .route(
            "/drive/download/{username}/{filename}",
            get(drive::download_file),
        )
        .route(
            "/drive/files/{username}/{filename}",
            delete(drive::delete_file),
        );

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
        .with_state(app_state);

    let socket_addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .with_context(|| format!("Invalid bind address {host}:{port}"))?;
    let listener = tokio::net::TcpListener::bind(socket_addr).await?;

    info!("LifeNode backend listening on http://{}", socket_addr);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn root_message() -> impl IntoResponse {
    Json(json!({
        "message": "LifeNode backend running. Frontend is not built yet.",
        "hint": "Build frontend and set LIFENODE_FRONTEND_DIST."
    }))
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let embedding_backend = if state.llama_embedding.is_some() {
        "llama.cpp"
    } else {
        "hash-fallback"
    };
    let llm_backend = if state.llama_chat.is_some() {
        "llama.cpp"
    } else {
        "retrieval-fallback"
    };
    Json(json!({
        "status": "ok",
        "time": Utc::now().to_rfc3339(),
        "embedding_backend": embedding_backend,
        "llm_backend": llm_backend,
    }))
}
