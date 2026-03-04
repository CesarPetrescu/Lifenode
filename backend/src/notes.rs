use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use chrono::Utc;
use serde_json::json;
use sqlx::Row;

use crate::auth::{authorize_username, require_auth};
use crate::error::{AppError, AppResult, internal_error};
use crate::state::AppState;
use crate::types::{
    NoteFileCreateRequest, NoteFileDetailItem, NoteFileListItem, NoteFileUpdateRequest,
    NoteFolderCreateRequest, NoteFolderItem, NoteFolderUpdateRequest, NoteItem, NoteUpdateRequest,
    NotesTreeResponse,
};
use crate::utils::sanitize_username;

pub async fn get_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
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

pub async fn update_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<NoteUpdateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
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

pub async fn get_notes_tree(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    migrate_legacy_note_if_needed(&state, &username).await?;

    let folder_rows = sqlx::query(
        "SELECT id, name, parent_id, created_at, updated_at
         FROM note_folders
         WHERE username = ?
         ORDER BY lower(name), id",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;
    let folders = folder_rows
        .into_iter()
        .map(|row| NoteFolderItem {
            id: row.get("id"),
            name: row.get("name"),
            parent_id: row.get("parent_id"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect::<Vec<_>>();

    let file_rows = sqlx::query(
        "SELECT id, name, folder_id, created_at, updated_at
         FROM note_files
         WHERE username = ?
         ORDER BY lower(name), id",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;
    let files = file_rows
        .into_iter()
        .map(|row| NoteFileListItem {
            id: row.get("id"),
            name: row.get("name"),
            folder_id: row.get("folder_id"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect::<Vec<_>>();

    Ok(Json(NotesTreeResponse { folders, files }))
}

pub async fn create_note_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<NoteFolderCreateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let name = sanitize_note_name(&payload.name, "Folder name")?;
    validate_folder_for_user(&state, &username, payload.parent_id).await?;
    if folder_name_exists(&state, &username, payload.parent_id, &name, None).await? {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "A folder with this name already exists in that location",
        ));
    }

    let now = Utc::now().to_rfc3339();
    let insert = sqlx::query(
        "INSERT INTO note_folders (username, name, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(&name)
    .bind(payload.parent_id)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    let folder_id = insert.last_insert_rowid();

    Ok(Json(NoteFolderItem {
        id: folder_id,
        name,
        parent_id: payload.parent_id,
        created_at: now.clone(),
        updated_at: now,
    }))
}

pub async fn update_note_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, folder_id)): AxumPath<(String, i64)>,
    Json(payload): Json<NoteFolderUpdateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let existing = sqlx::query(
        "SELECT id, parent_id, created_at
         FROM note_folders
         WHERE id = ? AND username = ?",
    )
    .bind(folder_id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    let Some(existing) = existing else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Folder not found"));
    };
    let parent_id: Option<i64> = existing.get("parent_id");
    let created_at: String = existing.get("created_at");
    let name = sanitize_note_name(&payload.name, "Folder name")?;

    if folder_name_exists(&state, &username, parent_id, &name, Some(folder_id)).await? {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "A folder with this name already exists in that location",
        ));
    }

    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE note_folders
         SET name = ?, updated_at = ?
         WHERE id = ? AND username = ?",
    )
    .bind(&name)
    .bind(&now)
    .bind(folder_id)
    .bind(&username)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    Ok(Json(NoteFolderItem {
        id: folder_id,
        name,
        parent_id,
        created_at,
        updated_at: now,
    }))
}

pub async fn delete_note_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, folder_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM note_folders WHERE id = ? AND username = ? LIMIT 1",
    )
    .bind(folder_id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?
    .is_some();
    if !exists {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Folder not found"));
    }

    sqlx::query("DELETE FROM note_folders WHERE id = ? AND username = ?")
        .bind(folder_id)
        .bind(&username)
        .execute(&state.db)
        .await
        .map_err(internal_error)?;

    Ok(Json(json!({ "deleted": true })))
}

pub async fn create_note_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<NoteFileCreateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let name = sanitize_note_name(&payload.name, "File name")?;
    validate_folder_for_user(&state, &username, payload.folder_id).await?;
    if file_name_exists(&state, &username, payload.folder_id, &name, None).await? {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "A file with this name already exists in that folder",
        ));
    }

    let now = Utc::now().to_rfc3339();
    let content = payload.content.unwrap_or_default();
    let insert = sqlx::query(
        "INSERT INTO note_files (username, folder_id, name, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(payload.folder_id)
    .bind(&name)
    .bind(&content)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    let file_id = insert.last_insert_rowid();

    Ok(Json(NoteFileDetailItem {
        id: file_id,
        name,
        folder_id: payload.folder_id,
        content,
        created_at: now.clone(),
        updated_at: now,
    }))
}

pub async fn get_note_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, file_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let row = sqlx::query(
        "SELECT id, name, folder_id, content, created_at, updated_at
         FROM note_files
         WHERE id = ? AND username = ?",
    )
    .bind(file_id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    let Some(row) = row else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    };

    Ok(Json(NoteFileDetailItem {
        id: row.get("id"),
        name: row.get("name"),
        folder_id: row.get("folder_id"),
        content: row.get("content"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn update_note_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, file_id)): AxumPath<(String, i64)>,
    Json(payload): Json<NoteFileUpdateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let existing = sqlx::query(
        "SELECT created_at
         FROM note_files
         WHERE id = ? AND username = ?",
    )
    .bind(file_id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    let Some(existing) = existing else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    };
    let created_at: String = existing.get("created_at");

    let name = sanitize_note_name(&payload.name, "File name")?;
    validate_folder_for_user(&state, &username, payload.folder_id).await?;
    if file_name_exists(&state, &username, payload.folder_id, &name, Some(file_id)).await? {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "A file with this name already exists in that folder",
        ));
    }

    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE note_files
         SET name = ?, folder_id = ?, content = ?, updated_at = ?
         WHERE id = ? AND username = ?",
    )
    .bind(&name)
    .bind(payload.folder_id)
    .bind(&payload.content)
    .bind(&now)
    .bind(file_id)
    .bind(&username)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    Ok(Json(NoteFileDetailItem {
        id: file_id,
        name,
        folder_id: payload.folder_id,
        content: payload.content,
        created_at,
        updated_at: now,
    }))
}

pub async fn delete_note_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, file_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM note_files WHERE id = ? AND username = ? LIMIT 1",
    )
    .bind(file_id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?
    .is_some();
    if !exists {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }

    sqlx::query("DELETE FROM note_files WHERE id = ? AND username = ?")
        .bind(file_id)
        .bind(&username)
        .execute(&state.db)
        .await
        .map_err(internal_error)?;

    Ok(Json(json!({ "deleted": true })))
}

async fn migrate_legacy_note_if_needed(state: &AppState, username: &str) -> AppResult<()> {
    let existing_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM note_files WHERE username = ?")
            .bind(username)
            .fetch_one(&state.db)
            .await
            .map_err(internal_error)?;
    if existing_count > 0 {
        return Ok(());
    }

    let legacy = sqlx::query("SELECT content, updated_at FROM notes WHERE username = ?")
        .bind(username)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_error)?;
    let Some(legacy) = legacy else {
        return Ok(());
    };

    let content: String = legacy.get("content");
    if content.trim().is_empty() {
        return Ok(());
    }
    let updated_at: String = legacy.get("updated_at");

    sqlx::query(
        "INSERT INTO note_files (username, folder_id, name, content, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?)",
    )
    .bind(username)
    .bind("Legacy Note.md")
    .bind(content)
    .bind(&updated_at)
    .bind(&updated_at)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(())
}

async fn folder_name_exists(
    state: &AppState,
    username: &str,
    parent_id: Option<i64>,
    name: &str,
    exclude_id: Option<i64>,
) -> AppResult<bool> {
    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1
         FROM note_folders
         WHERE username = ?
           AND lower(name) = lower(?)
           AND ifnull(parent_id, -1) = ifnull(?, -1)
           AND (? IS NULL OR id != ?)
         LIMIT 1",
    )
    .bind(username)
    .bind(name)
    .bind(parent_id)
    .bind(exclude_id)
    .bind(exclude_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?
    .is_some();
    Ok(exists)
}

async fn file_name_exists(
    state: &AppState,
    username: &str,
    folder_id: Option<i64>,
    name: &str,
    exclude_id: Option<i64>,
) -> AppResult<bool> {
    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1
         FROM note_files
         WHERE username = ?
           AND lower(name) = lower(?)
           AND ifnull(folder_id, -1) = ifnull(?, -1)
           AND (? IS NULL OR id != ?)
         LIMIT 1",
    )
    .bind(username)
    .bind(name)
    .bind(folder_id)
    .bind(exclude_id)
    .bind(exclude_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?
    .is_some();
    Ok(exists)
}

async fn validate_folder_for_user(
    state: &AppState,
    username: &str,
    folder_id: Option<i64>,
) -> AppResult<()> {
    if let Some(folder_id) = folder_id {
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM note_folders WHERE id = ? AND username = ? LIMIT 1",
        )
        .bind(folder_id)
        .bind(username)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_error)?
        .is_some();
        if !exists {
            return Err(AppError::new(StatusCode::BAD_REQUEST, "Folder not found"));
        }
    }
    Ok(())
}

fn sanitize_note_name(raw: &str, field_name: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            format!("{field_name} is required"),
        ));
    }
    if trimmed.len() > 140 {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            format!("{field_name} must be at most 140 characters"),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            format!("{field_name} cannot contain path separators"),
        ));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            format!("{field_name} contains invalid characters"),
        ));
    }
    Ok(trimmed.to_string())
}
