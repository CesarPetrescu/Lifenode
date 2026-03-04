use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub message: String,
}

impl AppError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
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

pub type AppResult<T> = Result<T, AppError>;

pub fn bad_request<E: std::fmt::Display>(err: E) -> AppError {
    AppError::new(StatusCode::BAD_REQUEST, err.to_string())
}

pub fn internal_error<E: std::fmt::Display>(err: E) -> AppError {
    AppError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}
