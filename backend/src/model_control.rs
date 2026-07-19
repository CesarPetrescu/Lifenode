use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    auth::require_auth,
    error::{AppError, AppResult},
    state::{AppState, LlamaModelManagerConfig, qwen_sampling_preset},
    types::{AskModelItem, AskModelSelectRequest, AskModelStatusResponse},
};

#[derive(Deserialize)]
struct ManagerStatusPayload {
    state: String,
    active_model_id: Option<String>,
    desired_model_id: Option<String>,
    last_error: Option<String>,
    models: Vec<AskModelItem>,
}

pub async fn get_chat_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl axum::response::IntoResponse> {
    require_auth(&state, &headers).await?;
    Ok(Json(fetch_chat_model_status(&state).await?))
}

pub async fn select_chat_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AskModelSelectRequest>,
) -> AppResult<impl axum::response::IntoResponse> {
    require_auth(&state, &headers).await?;
    let model_id = payload.model_id.trim();
    if model_id.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "model_id is required",
        ));
    }

    let Some(cfg) = &state.llama_model_manager else {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Chat model switching is not enabled",
        ));
    };

    let manager_status = post_manager_model_select(&state, cfg, model_id).await?;
    Ok(Json(enrich_model_status(&state, manager_status)))
}

pub async fn fetch_chat_model_status(state: &AppState) -> AppResult<AskModelStatusResponse> {
    if let Some(cfg) = &state.llama_model_manager {
        let manager_status = get_manager_status(state, cfg).await?;
        Ok(enrich_model_status(state, manager_status))
    } else {
        Ok(static_model_status(state))
    }
}

fn static_model_status(state: &AppState) -> AskModelStatusResponse {
    let chat_cfg = state.llama_chat.as_ref();
    let model_name = chat_cfg
        .and_then(|cfg| cfg.model.clone())
        .unwrap_or_else(|| "llama.cpp chat".to_string());
    AskModelStatusResponse {
        manager_enabled: false,
        switchable: false,
        shared_runtime: true,
        state: if chat_cfg.is_some() {
            "ready".to_string()
        } else {
            "unavailable".to_string()
        },
        active_model_id: Some(model_name.clone()),
        desired_model_id: Some(model_name.clone()),
        last_error: None,
        models: vec![AskModelItem {
            id: model_name.clone(),
            label: model_name.clone(),
            filename: model_name,
            context_length: 0,
            description: "Static llama.cpp chat runtime configured via environment.".to_string(),
            available: chat_cfg.is_some(),
            selectable: chat_cfg.is_some(),
            availability_reason: None,
            estimated_ram_mib: None,
            required_free_ram_mib: None,
        }],
        fast_sampling: qwen_sampling_preset(false),
        thinking_sampling: qwen_sampling_preset(true),
        default_thinking: chat_cfg.map(|cfg| cfg.default_thinking).unwrap_or(false),
        max_tokens: chat_cfg.map(|cfg| cfg.max_tokens).unwrap_or(0),
    }
}

fn enrich_model_status(state: &AppState, payload: ManagerStatusPayload) -> AskModelStatusResponse {
    let chat_cfg = state.llama_chat.as_ref();
    AskModelStatusResponse {
        manager_enabled: true,
        switchable: payload
            .models
            .iter()
            .filter(|model| model.selectable)
            .count()
            > 1,
        shared_runtime: true,
        state: payload.state,
        active_model_id: payload.active_model_id,
        desired_model_id: payload.desired_model_id,
        last_error: payload.last_error,
        models: payload.models,
        fast_sampling: qwen_sampling_preset(false),
        thinking_sampling: qwen_sampling_preset(true),
        default_thinking: chat_cfg.map(|cfg| cfg.default_thinking).unwrap_or(false),
        max_tokens: chat_cfg.map(|cfg| cfg.max_tokens).unwrap_or(0),
    }
}

async fn get_manager_status(
    state: &AppState,
    cfg: &LlamaModelManagerConfig,
) -> AppResult<ManagerStatusPayload> {
    let url = format!("{}/v1/status", cfg.url.trim_end_matches('/'));
    let mut request = state.http_client.get(url);
    if let Some(api_key) = cfg.api_key.as_ref() {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(|err| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            format!("Could not reach llama.cpp model manager: {err}"),
        )
    })?;
    parse_manager_response(response).await
}

async fn post_manager_model_select(
    state: &AppState,
    cfg: &LlamaModelManagerConfig,
    model_id: &str,
) -> AppResult<ManagerStatusPayload> {
    let url = format!("{}/v1/models/select", cfg.url.trim_end_matches('/'));
    let mut request = state
        .http_client
        .post(url)
        .json(&serde_json::json!({ "model_id": model_id }));
    if let Some(api_key) = cfg.api_key.as_ref() {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(|err| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            format!("Could not reach llama.cpp model manager: {err}"),
        )
    })?;
    parse_manager_response(response).await
}

async fn parse_manager_response(response: reqwest::Response) -> AppResult<ManagerStatusPayload> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("last_error")
                    .and_then(|item| item.as_str())
                    .or_else(|| value.get("error").and_then(|item| item.as_str()))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "llama.cpp model manager request failed".to_string());
        let proxied_status =
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return Err(AppError::new(proxied_status, message));
    }

    serde_json::from_str::<ManagerStatusPayload>(&body).map_err(|err| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            format!("Invalid response from llama.cpp model manager: {err}"),
        )
    })
}
