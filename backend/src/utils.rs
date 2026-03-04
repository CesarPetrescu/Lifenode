use std::path::{Path, PathBuf};

use anyhow::Context;
use axum::http::{HeaderValue, Method, StatusCode};
use tower_http::cors::{Any, CorsLayer};

use crate::error::{AppError, AppResult, internal_error};

pub fn sanitize_username(input: &str) -> AppResult<String> {
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

pub fn sanitize_filename(input: &str) -> Option<String> {
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

pub fn sanitize_storage_name(input: &str) -> String {
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

pub fn trim_to_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    input.chars().take(max_chars).collect::<String>() + "..."
}

pub fn parse_env_bool(name: &str, default: bool) -> anyhow::Result<bool> {
    match std::env::var(name) {
        Ok(raw) => {
            let trimmed = raw.trim().to_ascii_lowercase();
            match trimmed.as_str() {
                "1" | "true" | "yes" | "on" => Ok(true),
                "0" | "false" | "no" | "off" => Ok(false),
                _ => anyhow::bail!("{} has invalid boolean value `{}`", name, raw),
            }
        }
        Err(_) => Ok(default),
    }
}

pub fn non_empty(input: String) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn build_cors(raw: &str) -> anyhow::Result<CorsLayer> {
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

pub async fn ensure_user_files_dir(base: &Path, username: &str) -> AppResult<PathBuf> {
    let user_root = base.join(username);
    let files_dir = user_root.join("files");
    tokio::fs::create_dir_all(&files_dir)
        .await
        .map_err(internal_error)?;
    Ok(files_dir)
}

pub async fn ensure_user_wiki_dir(base: &Path, username: &str) -> AppResult<PathBuf> {
    let user_root = base.join(username);
    let wiki_dir = user_root.join("wiki");
    tokio::fs::create_dir_all(&wiki_dir)
        .await
        .map_err(internal_error)?;
    Ok(wiki_dir)
}

pub async fn ensure_user_maps_dir(base: &Path, username: &str) -> AppResult<PathBuf> {
    let user_root = base.join(username);
    let maps_dir = user_root.join("maps");
    tokio::fs::create_dir_all(&maps_dir)
        .await
        .map_err(internal_error)?;
    Ok(maps_dir)
}
