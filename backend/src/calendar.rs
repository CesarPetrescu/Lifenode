use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde_json::json;
use sqlx::Row;

use crate::auth::{authorize_username, require_auth};
use crate::error::{AppError, AppResult, internal_error};
use crate::state::AppState;
use crate::types::{CalendarEventCreateRequest, CalendarEventItem};
use crate::utils::sanitize_username;

pub async fn list_calendar_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
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

pub async fn create_calendar_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<CalendarEventCreateRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
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

pub async fn delete_calendar_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, event_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
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
