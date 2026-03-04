use sqlx::SqlitePool;

pub async fn init_db(db: &SqlitePool) -> anyhow::Result<()> {
    let schema = r#"
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

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

    CREATE TABLE IF NOT EXISTS wiki_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        thumb_url TEXT,
        width INTEGER,
        height INTEGER,
        downloaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(article_id) REFERENCES wiki_articles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_images_article_id ON wiki_images(article_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_images_username ON wiki_images(username);

    CREATE TABLE IF NOT EXISTS wiki_bulk_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        lang TEXT NOT NULL,
        include_images INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        continuation_token TEXT,
        processed_pages INTEGER NOT NULL DEFAULT 0,
        indexed_articles INTEGER NOT NULL DEFAULT 0,
        failed_pages INTEGER NOT NULL DEFAULT 0,
        max_pages INTEGER,
        batch_size INTEGER NOT NULL DEFAULT 25,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT,
        last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_bulk_jobs_username ON wiki_bulk_jobs(username);
    CREATE INDEX IF NOT EXISTS idx_wiki_bulk_jobs_status ON wiki_bulk_jobs(status);

    CREATE TABLE IF NOT EXISTS notes (
        username TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS note_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(parent_id) REFERENCES note_folders(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_note_folders_username ON note_folders(username);
    CREATE INDEX IF NOT EXISTS idx_note_folders_parent ON note_folders(parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_note_folders_parent_name
        ON note_folders(username, ifnull(parent_id, -1), lower(name));

    CREATE TABLE IF NOT EXISTS note_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        folder_id INTEGER,
        name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(folder_id) REFERENCES note_folders(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_note_files_username ON note_files(username);
    CREATE INDEX IF NOT EXISTS idx_note_files_folder ON note_files(folder_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_note_files_folder_name
        ON note_files(username, ifnull(folder_id, -1), lower(name));

    CREATE TABLE IF NOT EXISTS chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chat_threads_username_updated
        ON chat_threads(username, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        contexts TEXT,
        sampling TEXT,
        thinking INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created
        ON chat_messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_username
        ON chat_messages(username);

    CREATE TABLE IF NOT EXISTS maps_download_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        source TEXT NOT NULL,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL,
        bytes_total INTEGER,
        bytes_downloaded INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_maps_jobs_username_created
        ON maps_download_jobs(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maps_jobs_username_status
        ON maps_download_jobs(username, status);

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
