use std::path::{Component, Path, PathBuf};

use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde_json::json;
use tokio::io::AsyncWriteExt;

use crate::auth::{authorize_username, require_auth};
use crate::error::{AppError, AppResult, bad_request, internal_error};
use crate::state::AppState;
use crate::types::{
    DriveFileItem, DriveFolderCreateRequest, DriveFolderItem, DrivePathQuery, DriveTreeFileItem,
    DriveTreeResponse,
};
use crate::utils::{ensure_user_files_dir, sanitize_filename, sanitize_username};

pub async fn upload_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    mut multipart: Multipart,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;

    let mut folder_path = PathBuf::new();

    while let Some(field) = multipart.next_field().await.map_err(bad_request)? {
        match field.name() {
            Some("folder_path") => {
                let raw = field.text().await.map_err(bad_request)?;
                folder_path = sanitize_relative_path(&raw)?;
            }
            Some("file") => {
                let original_name = field.file_name().unwrap_or("upload.bin");
                let filename = sanitize_filename(original_name)
                    .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid filename"))?;
                let target_dir = files_dir.join(&folder_path);
                tokio::fs::create_dir_all(&target_dir)
                    .await
                    .map_err(internal_error)?;
                let file_path = target_dir.join(&filename);
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

                let relative = path_to_string(&folder_path.join(&filename));
                return Ok(Json(json!({
                    "username": username,
                    "filename": filename,
                    "path": relative,
                    "size": written,
                })));
            }
            _ => {}
        }
    }

    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        "Multipart field `file` is required",
    ))
}

pub async fn list_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
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
        files.push(DriveFileItem {
            filename: entry.file_name().to_string_lossy().to_string(),
            size: metadata.len(),
            modified_at: file_modified_time(&metadata),
        });
    }

    files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(Json(files))
}

pub async fn get_drive_tree(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;

    let mut folders = Vec::new();
    let mut files = Vec::new();
    let mut stack = vec![PathBuf::new()];

    while let Some(rel_dir) = stack.pop() {
        let abs_dir = if rel_dir.as_os_str().is_empty() {
            files_dir.clone()
        } else {
            files_dir.join(&rel_dir)
        };

        let mut entries = tokio::fs::read_dir(&abs_dir)
            .await
            .map_err(internal_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(internal_error)? {
            let file_type = entry.file_type().await.map_err(internal_error)?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }

            let child_rel = rel_dir.join(&name);
            if file_type.is_dir() {
                folders.push(DriveFolderItem {
                    name: name.clone(),
                    path: path_to_string(&child_rel),
                    parent_path: parent_string(&child_rel),
                });
                stack.push(child_rel);
                continue;
            }

            if file_type.is_file() {
                let metadata = entry.metadata().await.map_err(internal_error)?;
                files.push(DriveTreeFileItem {
                    name,
                    path: path_to_string(&child_rel),
                    parent_path: parent_string(&child_rel),
                    size: metadata.len(),
                    modified_at: file_modified_time(&metadata),
                });
            }
        }
    }

    folders.sort_by(|a, b| a.path.cmp(&b.path));
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Json(DriveTreeResponse { folders, files }))
}

pub async fn create_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<DriveFolderCreateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;

    let name = sanitize_filename(payload.name.trim())
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid folder name"))?;
    let parent_rel = sanitize_relative_path(payload.parent_path.as_deref().unwrap_or(""))?;
    let folder_rel = parent_rel.join(&name);
    if folder_rel.as_os_str().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Invalid folder path",
        ));
    }

    let parent_abs = files_dir.join(&parent_rel);
    if !parent_abs.is_dir() {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "Parent folder not found",
        ));
    }
    let folder_abs = files_dir.join(&folder_rel);
    if folder_abs.exists() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "A folder or file with this name already exists",
        ));
    }

    tokio::fs::create_dir_all(&folder_abs)
        .await
        .map_err(internal_error)?;

    Ok(Json(DriveFolderItem {
        name,
        path: path_to_string(&folder_rel),
        parent_path: parent_string(&folder_rel),
    }))
}

pub async fn delete_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Query(query): Query<DrivePathQuery>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;

    let rel = sanitize_relative_path(&query.path)?;
    if rel.as_os_str().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Folder path is required",
        ));
    }
    let folder_abs = files_dir.join(&rel);
    if !folder_abs.is_dir() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Folder not found"));
    }

    tokio::fs::remove_dir_all(&folder_abs)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "deleted": true })))
}

pub async fn open_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Query(query): Query<DrivePathQuery>,
) -> AppResult<Response> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;
    let rel = sanitize_relative_path(&query.path)?;
    if rel.as_os_str().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "File path is required",
        ));
    }

    let file_path = files_dir.join(&rel);
    if !file_path.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }
    build_file_response(&file_path, false).await
}

pub async fn download_file_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Query(query): Query<DrivePathQuery>,
) -> AppResult<Response> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;
    let rel = sanitize_relative_path(&query.path)?;
    if rel.as_os_str().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "File path is required",
        ));
    }

    let file_path = files_dir.join(&rel);
    if !file_path.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }
    build_file_response(&file_path, true).await
}

pub async fn download_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, filename_raw)): AxumPath<(String, String)>,
) -> AppResult<Response> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let filename = sanitize_filename(&filename_raw)
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid filename"))?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;
    let file_path = files_dir.join(&filename);
    if !file_path.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }
    build_file_response(&file_path, true).await
}

pub async fn delete_file_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Query(query): Query<DrivePathQuery>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let files_dir = ensure_user_files_dir(&state.user_files_dir, &username).await?;

    let rel = sanitize_relative_path(&query.path)?;
    if rel.as_os_str().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "File path is required",
        ));
    }
    let file_path = files_dir.join(&rel);
    if !file_path.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }
    tokio::fs::remove_file(&file_path)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "deleted": true })))
}

pub async fn delete_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, filename_raw)): AxumPath<(String, String)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
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

async fn build_file_response(file_path: &Path, attachment: bool) -> AppResult<Response> {
    let bytes = tokio::fs::read(file_path).await.map_err(internal_error)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type_for_path(file_path)),
    );
    if let Some(filename) = file_path.file_name().and_then(|s| s.to_str()) {
        let disposition = if attachment {
            format!("attachment; filename=\"{}\"", filename)
        } else {
            format!("inline; filename=\"{}\"", filename)
        };
        if let Ok(v) = HeaderValue::from_str(&disposition) {
            response
                .headers_mut()
                .insert(header::CONTENT_DISPOSITION, v);
        }
    }
    Ok(response)
}

fn content_type_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" => "text/markdown; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

fn file_modified_time(metadata: &std::fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .map(DateTime::<Utc>::from)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn parent_string(path: &Path) -> Option<String> {
    let parent = path.parent()?;
    if parent.as_os_str().is_empty() {
        None
    } else {
        Some(path_to_string(parent))
    }
}

fn path_to_string(path: &Path) -> String {
    let mut parts = Vec::new();
    for component in path.components() {
        if let Component::Normal(seg) = component {
            parts.push(seg.to_string_lossy().to_string());
        }
    }
    parts.join("/")
}

fn sanitize_relative_path(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }

    let normalized = trimmed.replace('\\', "/");
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        let segment = part.trim();
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(AppError::new(StatusCode::BAD_REQUEST, "Invalid path"));
        }
        let safe = sanitize_filename(segment)
            .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid path segment"))?;
        if safe != segment {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "Invalid path segment",
            ));
        }
        out.push(segment);
    }
    Ok(out)
}
