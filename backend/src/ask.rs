use std::convert::Infallible;

use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
};
use chrono::Utc;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};
use sqlx::Row;
use tokio_stream::wrappers::ReceiverStream;
use tracing::warn;

use crate::auth::{authorize_username, require_auth};
use crate::error::{AppError, AppResult, internal_error};
use crate::search::rank_chunks;
use crate::state::{AppState, DEFAULT_TOP_K, LlamaChatConfig, QwenSamplingPreset};
use crate::types::{
    AskMessageItem, AskRequest, AskThreadCreateRequest, AskThreadDetailItem, AskThreadItem,
    AskThreadRenameRequest, SearchResultItem,
};
use crate::utils::{sanitize_username, trim_to_chars};

pub async fn ask_question(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AskRequest>,
) -> AppResult<impl axum::response::IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let question = payload.question.trim();
    if question.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Question is required",
        ));
    }

    let thread_id =
        ensure_thread_for_question(&state, &username, payload.thread_id, question).await?;
    save_chat_message(
        &state, &username, thread_id, "user", question, None, None, false,
    )
    .await?;

    let top_k = payload.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 20) as usize;
    let thinking = payload.thinking.unwrap_or_else(|| {
        state
            .llama_chat
            .as_ref()
            .map(|cfg| cfg.default_thinking)
            .unwrap_or(false)
    });
    let use_wiki_retrieval = payload.use_wiki_retrieval.unwrap_or(false);

    let ranked = if use_wiki_retrieval {
        rank_chunks(&state, &username, question, top_k).await?
    } else {
        Vec::new()
    };
    let answer =
        generate_answer_with_fallback(&state, question, &ranked, thinking, use_wiki_retrieval)
            .await;
    let sampling = qwen_sampling_preset(thinking);

    save_chat_message(
        &state,
        &username,
        thread_id,
        "assistant",
        &answer,
        if use_wiki_retrieval {
            Some(&ranked)
        } else {
            None
        },
        Some(sampling),
        thinking,
    )
    .await?;

    Ok(Json(json!({
        "username": username,
        "thread_id": thread_id,
        "question": question,
        "thinking": thinking,
        "use_wiki_retrieval": use_wiki_retrieval,
        "sampling": sampling,
        "answer": answer,
        "contexts": ranked,
    })))
}

pub async fn ask_question_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AskRequest>,
) -> AppResult<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>> {
    let username = sanitize_username(&payload.username)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let question = payload.question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Question is required",
        ));
    }

    let thread_id =
        ensure_thread_for_question(&state, &username, payload.thread_id, &question).await?;
    save_chat_message(
        &state, &username, thread_id, "user", &question, None, None, false,
    )
    .await?;

    let top_k = payload.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 20) as usize;
    let thinking = payload.thinking.unwrap_or_else(|| {
        state
            .llama_chat
            .as_ref()
            .map(|cfg| cfg.default_thinking)
            .unwrap_or(false)
    });
    let use_wiki_retrieval = payload.use_wiki_retrieval.unwrap_or(false);

    let ranked = if use_wiki_retrieval {
        rank_chunks(&state, &username, &question, top_k).await?
    } else {
        Vec::new()
    };
    let sampling = qwen_sampling_preset(thinking);

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(64);

    let meta = json!({
        "thread_id": thread_id,
        "contexts": ranked,
        "sampling": sampling,
        "thinking": thinking,
        "use_wiki_retrieval": use_wiki_retrieval,
    });
    let _ = tx
        .send(Ok(Event::default().event("meta").data(meta.to_string())))
        .await;

    let state_clone = state.clone();
    let username_clone = username.clone();
    tokio::spawn(async move {
        let assistant_text: String;

        if let Some(cfg) = &state_clone.llama_chat {
            match stream_chat_with_llama_cpp(
                &state_clone.http_client,
                cfg,
                &question,
                &ranked,
                thinking,
                use_wiki_retrieval,
                &tx,
            )
            .await
            {
                Ok(answer) if !answer.trim().is_empty() => {
                    assistant_text = answer;
                }
                Ok(_) => {
                    assistant_text =
                        answer_fallback_for_mode(&question, &ranked, use_wiki_retrieval);
                    let _ = tx
                        .send(Ok(Event::default()
                            .event("delta")
                            .data(json!({"t": assistant_text}).to_string())))
                        .await;
                }
                Err(err) => {
                    warn!("llama.cpp streaming failed, using mode fallback: {err}");
                    assistant_text =
                        answer_fallback_for_mode(&question, &ranked, use_wiki_retrieval);
                    let _ = tx
                        .send(Ok(Event::default()
                            .event("delta")
                            .data(json!({"t": assistant_text}).to_string())))
                        .await;
                }
            }
            let _ = tx.send(Ok(Event::default().event("done").data("{}"))).await;
        } else {
            assistant_text = answer_fallback_for_mode(&question, &ranked, use_wiki_retrieval);
            let _ = tx
                .send(Ok(Event::default()
                    .event("delta")
                    .data(json!({"t": assistant_text}).to_string())))
                .await;
            let _ = tx.send(Ok(Event::default().event("done").data("{}"))).await;
        }

        if let Err(err) = save_chat_message(
            &state_clone,
            &username_clone,
            thread_id,
            "assistant",
            &assistant_text,
            if use_wiki_retrieval {
                Some(&ranked)
            } else {
                None
            },
            Some(sampling),
            thinking,
        )
        .await
        {
            warn!("failed to persist assistant chat message: {}", err.message);
        }
    });

    let stream = ReceiverStream::new(rx);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn list_threads(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl axum::response::IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let rows = sqlx::query(
        "SELECT t.id, t.title, t.created_at, t.updated_at,
                (
                    SELECT m.content
                    FROM chat_messages m
                    WHERE m.thread_id = t.id
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS last_message,
                (
                    SELECT COUNT(*)
                    FROM chat_messages m2
                    WHERE m2.thread_id = t.id
                ) AS message_count
         FROM chat_threads t
         WHERE t.username = ?
         ORDER BY t.updated_at DESC, t.id DESC",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let threads = rows
        .into_iter()
        .map(|row| AskThreadItem {
            id: row.get("id"),
            title: row.get("title"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            last_message_preview: row
                .get::<Option<String>, _>("last_message")
                .map(|msg| trim_to_chars(&msg, 120)),
            message_count: row.get("message_count"),
        })
        .collect::<Vec<_>>();

    Ok(Json(threads))
}

pub async fn create_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<AskThreadCreateRequest>,
) -> AppResult<impl axum::response::IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let title = sanitize_thread_title(payload.title.as_deref(), "New chat");
    let now = Utc::now().to_rfc3339();
    let insert = sqlx::query(
        "INSERT INTO chat_threads (username, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(&title)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    let thread_id = insert.last_insert_rowid();

    Ok(Json(AskThreadItem {
        id: thread_id,
        title,
        created_at: now.clone(),
        updated_at: now,
        last_message_preview: None,
        message_count: 0,
    }))
}

pub async fn get_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, thread_id)): AxumPath<(String, i64)>,
) -> AppResult<impl axum::response::IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let thread = fetch_thread_meta(&state, &username, thread_id).await?;

    let rows = sqlx::query(
        "SELECT id, role, content, contexts, sampling, thinking, created_at
         FROM chat_messages
         WHERE thread_id = ? AND username = ?
         ORDER BY id ASC",
    )
    .bind(thread_id)
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let mut messages = Vec::new();
    for row in rows {
        let contexts = row
            .get::<Option<String>, _>("contexts")
            .and_then(|raw| serde_json::from_str::<Vec<SearchResultItem>>(&raw).ok());
        let sampling = row
            .get::<Option<String>, _>("sampling")
            .and_then(|raw| serde_json::from_str::<QwenSamplingPreset>(&raw).ok());
        let thinking = row.get::<i64, _>("thinking") != 0;
        messages.push(AskMessageItem {
            id: row.get("id"),
            role: row.get("role"),
            content: row.get("content"),
            timestamp: row.get("created_at"),
            contexts,
            sampling,
            thinking,
        });
    }

    Ok(Json(AskThreadDetailItem {
        id: thread.id,
        title: thread.title,
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        messages,
    }))
}

pub async fn rename_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, thread_id)): AxumPath<(String, i64)>,
    Json(payload): Json<AskThreadRenameRequest>,
) -> AppResult<impl axum::response::IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let title = sanitize_thread_title(Some(payload.title.as_str()), "New chat");
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE chat_threads
         SET title = ?, updated_at = ?
         WHERE id = ? AND username = ?",
    )
    .bind(&title)
    .bind(&now)
    .bind(thread_id)
    .bind(&username)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    if result.rows_affected() == 0 {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Thread not found"));
    }

    let summary = fetch_thread_summary(&state, &username, thread_id).await?;
    Ok(Json(summary))
}

pub async fn delete_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, thread_id)): AxumPath<(String, i64)>,
) -> AppResult<impl axum::response::IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let result = sqlx::query("DELETE FROM chat_threads WHERE id = ? AND username = ?")
        .bind(thread_id)
        .bind(&username)
        .execute(&state.db)
        .await
        .map_err(internal_error)?;
    if result.rows_affected() == 0 {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Thread not found"));
    }
    Ok(Json(json!({ "deleted": true })))
}

async fn stream_chat_with_llama_cpp(
    client: &Client,
    cfg: &LlamaChatConfig,
    question: &str,
    contexts: &[SearchResultItem],
    thinking: bool,
    use_wiki_retrieval: bool,
    tx: &tokio::sync::mpsc::Sender<Result<Event, Infallible>>,
) -> Result<String, String> {
    let sampling = qwen_sampling_preset(thinking);
    let (system_prompt, user_prompt) = build_chat_prompts(question, contexts, use_wiki_retrieval);

    let mut payload = json!({
        "messages": [
            {"role": "system", "content": system_prompt.as_str()},
            {"role": "user", "content": user_prompt.as_str()}
        ],
        "temperature": sampling.temperature,
        "top_p": sampling.top_p,
        "top_k": sampling.top_k,
        "min_p": sampling.min_p,
        "presence_penalty": sampling.presence_penalty,
        "repetition_penalty": sampling.repetition_penalty,
        "repeat_penalty": sampling.repetition_penalty,
        "enable_thinking": sampling.enable_thinking,
        "max_tokens": cfg.max_tokens,
        "stream": true
    });
    if let Some(model) = cfg.model.as_ref() {
        payload["model"] = json!(model);
    }

    let mut request = client
        .post(&cfg.url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs));
    if let Some(api_key) = cfg.api_key.as_ref() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?;

    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut accumulated = String::new();

    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk.map_err(|err| err.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            let data = if let Some(stripped) = line.strip_prefix("data: ") {
                stripped
            } else {
                continue;
            };

            if data == "[DONE]" {
                return Ok(accumulated);
            }

            if let Ok(value) = serde_json::from_str::<Value>(data) {
                if let Some(content) = value
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !content.is_empty() {
                        accumulated.push_str(content);
                        let _ = tx
                            .send(Ok(Event::default()
                                .event("delta")
                                .data(json!({"t": content}).to_string())))
                            .await;
                    }
                }
            }
        }
    }

    Ok(accumulated)
}

async fn generate_answer_with_fallback(
    state: &AppState,
    question: &str,
    contexts: &[SearchResultItem],
    thinking: bool,
    use_wiki_retrieval: bool,
) -> String {
    if use_wiki_retrieval && contexts.is_empty() {
        return retrieval_unavailable_message();
    }

    if let Some(cfg) = &state.llama_chat {
        match chat_with_llama_cpp(
            &state.http_client,
            cfg,
            question,
            contexts,
            thinking,
            use_wiki_retrieval,
        )
        .await
        {
            Ok(answer) => {
                let trimmed = answer.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
                warn!("llama.cpp chat returned an empty answer, using mode fallback");
            }
            Err(err) => {
                warn!("llama.cpp chat failed, using mode fallback: {err}");
            }
        }
    }

    answer_fallback_for_mode(question, contexts, use_wiki_retrieval)
}

async fn chat_with_llama_cpp(
    client: &Client,
    cfg: &LlamaChatConfig,
    question: &str,
    contexts: &[SearchResultItem],
    thinking: bool,
    use_wiki_retrieval: bool,
) -> Result<String, String> {
    let sampling = qwen_sampling_preset(thinking);
    let (system_prompt, user_prompt) = build_chat_prompts(question, contexts, use_wiki_retrieval);

    let mut payload = json!({
        "messages": [
            {"role": "system", "content": system_prompt.as_str()},
            {"role": "user", "content": user_prompt.as_str()}
        ],
        "temperature": sampling.temperature,
        "top_p": sampling.top_p,
        "top_k": sampling.top_k,
        "min_p": sampling.min_p,
        "presence_penalty": sampling.presence_penalty,
        "repetition_penalty": sampling.repetition_penalty,
        "repeat_penalty": sampling.repetition_penalty,
        "enable_thinking": sampling.enable_thinking,
        "max_tokens": cfg.max_tokens,
        "stream": false
    });
    if let Some(model) = cfg.model.as_ref() {
        payload["model"] = json!(model);
    }

    let mut request = client
        .post(&cfg.url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs));
    if let Some(api_key) = cfg.api_key.as_ref() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?;

    let value: Value = response.json().await.map_err(|err| err.to_string())?;
    extract_chat_content(&value)
        .ok_or_else(|| "could not parse llama.cpp chat completion content".to_string())
}

fn extract_chat_content(value: &Value) -> Option<String> {
    let content = value
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"))?;

    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    if let Some(items) = content.as_array() {
        let mut chunks = Vec::new();
        for item in items {
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                chunks.push(text.to_string());
            } else if let Some(text) = item.as_str() {
                chunks.push(text.to_string());
            }
        }
        if !chunks.is_empty() {
            return Some(chunks.join(""));
        }
    }

    None
}

fn build_chat_prompts(
    question: &str,
    contexts: &[SearchResultItem],
    use_wiki_retrieval: bool,
) -> (String, String) {
    if use_wiki_retrieval {
        let context_block = contexts
            .iter()
            .take(5)
            .map(|ctx| {
                format!(
                    "[{} | chunk {} | score {:.4}]\n{}",
                    ctx.title,
                    ctx.chunk_index,
                    ctx.score,
                    trim_to_chars(&ctx.text, 700)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let system_prompt = "You are LifeNode local assistant. Use only the provided context. If the answer is not present in context, explicitly say you do not know.";
        let user_prompt = format!(
            "Question:\n{}\n\nContext:\n{}\n\nAnswer concisely and cite relevant context points.",
            question, context_block
        );
        (system_prompt.to_string(), user_prompt)
    } else {
        let system_prompt = "You are LifeNode local assistant. Answer clearly and concisely.";
        let user_prompt = format!("Question:\n{}\n\nAnswer clearly and concisely.", question);
        (system_prompt.to_string(), user_prompt)
    }
}

fn retrieval_unavailable_message() -> String {
    "No indexed Wikipedia context found for this user yet.".to_string()
}

fn llm_unavailable_message() -> String {
    "LLM backend unavailable for non-retrieval chat. Enable Wiki retrieval or configure llama.cpp chat."
        .to_string()
}

fn answer_fallback_for_mode(
    question: &str,
    contexts: &[SearchResultItem],
    use_wiki_retrieval: bool,
) -> String {
    if use_wiki_retrieval {
        if contexts.is_empty() {
            return retrieval_unavailable_message();
        }
        return retrieval_answer_fallback(question, contexts);
    }

    llm_unavailable_message()
}

fn retrieval_answer_fallback(question: &str, contexts: &[SearchResultItem]) -> String {
    let mut text = String::from("Retrieval fallback answer:\n\n");
    for (idx, item) in contexts.iter().take(3).enumerate() {
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
}

fn qwen_sampling_preset(thinking: bool) -> QwenSamplingPreset {
    if thinking {
        QwenSamplingPreset {
            temperature: 1.0,
            top_p: 0.95,
            top_k: 20,
            min_p: 0.0,
            presence_penalty: 1.5,
            repetition_penalty: 1.0,
            enable_thinking: true,
        }
    } else {
        QwenSamplingPreset {
            temperature: 1.0,
            top_p: 1.0,
            top_k: 20,
            min_p: 0.0,
            presence_penalty: 2.0,
            repetition_penalty: 1.0,
            enable_thinking: false,
        }
    }
}

async fn ensure_thread_for_question(
    state: &AppState,
    username: &str,
    thread_id: Option<i64>,
    question: &str,
) -> AppResult<i64> {
    if let Some(thread_id) = thread_id {
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM chat_threads WHERE id = ? AND username = ? LIMIT 1",
        )
        .bind(thread_id)
        .bind(username)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_error)?
        .is_some();
        if !exists {
            return Err(AppError::new(StatusCode::NOT_FOUND, "Thread not found"));
        }
        return Ok(thread_id);
    }

    let title = build_thread_title_from_question(question);
    let now = Utc::now().to_rfc3339();
    let insert = sqlx::query(
        "INSERT INTO chat_threads (username, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(username)
    .bind(title)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(insert.last_insert_rowid())
}

async fn save_chat_message(
    state: &AppState,
    username: &str,
    thread_id: i64,
    role: &str,
    content: &str,
    contexts: Option<&[SearchResultItem]>,
    sampling: Option<QwenSamplingPreset>,
    thinking: bool,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let contexts_json = contexts
        .map(serde_json::to_string)
        .transpose()
        .map_err(internal_error)?;
    let sampling_json = sampling
        .map(|value| serde_json::to_string(&value))
        .transpose()
        .map_err(internal_error)?;

    sqlx::query(
        "INSERT INTO chat_messages
         (thread_id, username, role, content, contexts, sampling, thinking, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(thread_id)
    .bind(username)
    .bind(role)
    .bind(content)
    .bind(contexts_json)
    .bind(sampling_json)
    .bind(if thinking { 1 } else { 0 })
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    sqlx::query(
        "UPDATE chat_threads
         SET updated_at = ?
         WHERE id = ? AND username = ?",
    )
    .bind(&now)
    .bind(thread_id)
    .bind(username)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    Ok(())
}

async fn fetch_thread_summary(
    state: &AppState,
    username: &str,
    thread_id: i64,
) -> AppResult<AskThreadItem> {
    let row = sqlx::query(
        "SELECT t.id, t.title, t.created_at, t.updated_at,
                (
                    SELECT m.content
                    FROM chat_messages m
                    WHERE m.thread_id = t.id
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS last_message,
                (
                    SELECT COUNT(*)
                    FROM chat_messages m2
                    WHERE m2.thread_id = t.id
                ) AS message_count
         FROM chat_threads t
         WHERE t.id = ? AND t.username = ?",
    )
    .bind(thread_id)
    .bind(username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    let Some(row) = row else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Thread not found"));
    };

    Ok(AskThreadItem {
        id: row.get("id"),
        title: row.get("title"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        last_message_preview: row
            .get::<Option<String>, _>("last_message")
            .map(|msg| trim_to_chars(&msg, 120)),
        message_count: row.get("message_count"),
    })
}

async fn fetch_thread_meta(
    state: &AppState,
    username: &str,
    thread_id: i64,
) -> AppResult<AskThreadItem> {
    let row = sqlx::query(
        "SELECT id, title, created_at, updated_at
         FROM chat_threads
         WHERE id = ? AND username = ?",
    )
    .bind(thread_id)
    .bind(username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    let Some(row) = row else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Thread not found"));
    };

    Ok(AskThreadItem {
        id: row.get("id"),
        title: row.get("title"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        last_message_preview: None,
        message_count: 0,
    })
}

fn sanitize_thread_title(raw: Option<&str>, fallback: &str) -> String {
    let source = raw.unwrap_or(fallback);
    let collapsed = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    let base = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    trim_to_chars(base, 120)
}

fn build_thread_title_from_question(question: &str) -> String {
    sanitize_thread_title(Some(question), "New chat")
}
