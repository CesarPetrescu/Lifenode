use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use chrono::{Duration, Utc};
use serde_json::json;
use sqlx::{Row, SqlitePool};
use tracing::info;
use uuid::Uuid;

use crate::error::{AppError, AppResult, internal_error};
use crate::state::{AppState, AuthenticatedUser, SESSION_TTL_HOURS};
use crate::types::{
    AuthResponse, AuthUserResponse, LoginRequest, RegisterRequest, UpdateUserRoleRequest,
    UserListItem,
};
use crate::utils::{
    ensure_user_files_dir, ensure_user_maps_dir, ensure_user_wiki_dir, sanitize_username,
};

pub async fn auth_register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let password = payload.password.trim();
    if password.len() < 8 {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Password must be at least 8 characters",
        ));
    }

    let existing = sqlx::query_scalar::<_, i64>("SELECT id FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_error)?;
    if existing.is_some() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "Username already exists",
        ));
    }

    let user_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .map_err(internal_error)?;
    let is_admin = user_count == 0;
    let password_hash = hash_password(password)?;

    let result =
        sqlx::query("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)")
            .bind(&username)
            .bind(password_hash)
            .bind(if is_admin { 1 } else { 0 })
            .execute(&state.db)
            .await
            .map_err(internal_error)?;
    let user_id = result.last_insert_rowid();
    let (token, expires_at) = create_session(&state.db, user_id).await?;

    // Ensure per-user folders exist on first registration.
    let _ = ensure_user_files_dir(&state.user_files_dir, &username).await;
    let _ = ensure_user_wiki_dir(&state.user_files_dir, &username).await;
    let _ = ensure_user_maps_dir(&state.user_files_dir, &username).await;

    Ok(Json(AuthResponse {
        token,
        expires_at,
        user: AuthUserResponse {
            id: user_id,
            username,
            is_admin,
        },
    }))
}

pub async fn auth_login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let password = payload.password.trim();
    if password.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Password is required",
        ));
    }

    let row =
        sqlx::query("SELECT id, username, password_hash, is_admin FROM users WHERE username = ?")
            .bind(&username)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_error)?;

    let Some(row) = row else {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    };

    let user_id: i64 = row.get("id");
    let db_username: String = row.get("username");
    let password_hash: String = row.get("password_hash");
    let is_admin = row.get::<i64, _>("is_admin") != 0;
    if !verify_password(password, &password_hash) {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    }

    let (token, expires_at) = create_session(&state.db, user_id).await?;
    Ok(Json(AuthResponse {
        token,
        expires_at,
        user: AuthUserResponse {
            id: user_id,
            username: db_username,
            is_admin,
        },
    }))
}

pub async fn auth_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let auth = require_auth(&state, &headers).await?;
    Ok(Json(AuthUserResponse {
        id: auth.id,
        username: auth.username,
        is_admin: auth.is_admin,
    }))
}

pub async fn auth_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let token = bearer_token_from_headers(&headers)
        .ok_or_else(|| AppError::new(StatusCode::UNAUTHORIZED, "Missing bearer token"))?;
    let _ = require_auth(&state, &headers).await?;
    sqlx::query("DELETE FROM sessions WHERE token = ?")
        .bind(token)
        .execute(&state.db)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "logged_out": true })))
}

pub async fn auth_list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let auth = require_auth(&state, &headers).await?;
    if !auth.is_admin {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "Admin access required",
        ));
    }

    let rows = sqlx::query(
        "SELECT id, username, is_admin, created_at FROM users ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let users = rows
        .into_iter()
        .map(|row| UserListItem {
            id: row.get("id"),
            username: row.get("username"),
            is_admin: row.get::<i64, _>("is_admin") != 0,
            created_at: row.get("created_at"),
        })
        .collect::<Vec<_>>();

    Ok(Json(users))
}

pub async fn auth_update_user_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(user_id): AxumPath<i64>,
    Json(payload): Json<UpdateUserRoleRequest>,
) -> AppResult<impl IntoResponse> {
    let auth = require_auth(&state, &headers).await?;
    if !auth.is_admin {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "Admin access required",
        ));
    }

    let row = sqlx::query("SELECT id, username, is_admin, created_at FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_error)?;
    let Some(row) = row else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "User not found"));
    };
    let current_is_admin = row.get::<i64, _>("is_admin") != 0;
    if current_is_admin && !payload.is_admin {
        let admin_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE is_admin = 1")
                .fetch_one(&state.db)
                .await
                .map_err(internal_error)?;
        if admin_count <= 1 {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "Cannot remove the last admin account",
            ));
        }
    }

    sqlx::query("UPDATE users SET is_admin = ? WHERE id = ?")
        .bind(if payload.is_admin { 1 } else { 0 })
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(internal_error)?;

    Ok(Json(UserListItem {
        id: row.get("id"),
        username: row.get("username"),
        is_admin: payload.is_admin,
        created_at: row.get("created_at"),
    }))
}

pub async fn bootstrap_admin_account(
    db: &SqlitePool,
    username: &str,
    password: &str,
) -> anyhow::Result<()> {
    let existing = sqlx::query("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(db)
        .await?;
    if existing.is_some() {
        sqlx::query("UPDATE users SET is_admin = 1 WHERE username = ?")
            .bind(username)
            .execute(db)
            .await?;
        return Ok(());
    }

    let password_hash = hash_password(password).map_err(|err| {
        anyhow::anyhow!("Failed hashing bootstrap admin password: {}", err.message)
    })?;
    sqlx::query("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)")
        .bind(username)
        .bind(password_hash)
        .execute(db)
        .await?;
    info!("Bootstrapped admin account `{}` from environment", username);
    Ok(())
}

async fn create_session(db: &SqlitePool, user_id: i64) -> AppResult<(String, String)> {
    let token = format!("ln_{}", Uuid::new_v4());
    let created_at = Utc::now();
    let expires_at = created_at + Duration::hours(SESSION_TTL_HOURS);

    sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&token)
    .bind(user_id)
    .bind(created_at.to_rfc3339())
    .bind(expires_at.to_rfc3339())
    .execute(db)
    .await
    .map_err(internal_error)?;

    Ok((token, expires_at.to_rfc3339()))
}

fn bearer_token_from_headers(headers: &HeaderMap) -> Option<String> {
    let auth_header = headers.get(header::AUTHORIZATION)?;
    let auth_value = auth_header.to_str().ok()?.trim();
    let token = auth_value
        .strip_prefix("Bearer ")
        .or_else(|| auth_value.strip_prefix("bearer "))?
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub async fn require_auth(state: &AppState, headers: &HeaderMap) -> AppResult<AuthenticatedUser> {
    let token = bearer_token_from_headers(headers)
        .ok_or_else(|| AppError::new(StatusCode::UNAUTHORIZED, "Missing bearer token"))?;

    let row = sqlx::query(
        "SELECT u.id, u.username, u.is_admin, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?",
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;

    let Some(row) = row else {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid session token",
        ));
    };

    let expires_at_raw: String = row.get("expires_at");
    let expires_at = chrono::DateTime::parse_from_rfc3339(&expires_at_raw)
        .map_err(internal_error)?
        .with_timezone(&Utc);
    if Utc::now() > expires_at {
        sqlx::query("DELETE FROM sessions WHERE token = ?")
            .bind(&token)
            .execute(&state.db)
            .await
            .map_err(internal_error)?;
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "Session expired"));
    }

    Ok(AuthenticatedUser {
        id: row.get("id"),
        username: row.get("username"),
        is_admin: row.get::<i64, _>("is_admin") != 0,
    })
}

pub fn authorize_username(auth: &AuthenticatedUser, requested_username: &str) -> AppResult<()> {
    if auth.is_admin || auth.username == requested_username {
        Ok(())
    } else {
        Err(AppError::new(
            StatusCode::FORBIDDEN,
            "You can only access your own data",
        ))
    }
}

fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(internal_error)?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|value| value.to_string())
        .map_err(internal_error)
}

fn verify_password(password: &str, password_hash: &str) -> bool {
    let parsed = match PasswordHash::new(password_hash) {
        Ok(value) => value,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}
