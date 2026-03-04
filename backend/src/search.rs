use std::cmp::Ordering;

use axum::{Json, extract::State, http::HeaderMap, response::IntoResponse};
use reqwest::Client;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use tracing::warn;

use crate::auth::{authorize_username, require_auth};
use crate::error::{AppResult, internal_error};
use crate::state::{AppState, DEFAULT_TOP_K, HASH_EMBEDDING_DIM, LlamaEmbeddingConfig};
use crate::types::{LlamaEmbeddingResponse, SearchRequest, SearchResultItem};
use crate::utils::sanitize_username;

pub async fn semantic_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SearchRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let query = payload.query.trim();
    if query.is_empty() {
        return Err(crate::error::AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "Query is required",
        ));
    }
    let top_k = payload.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 20) as usize;

    let ranked = rank_chunks(&state, &username, query, top_k).await?;
    Ok(Json(json!({
        "username": username,
        "query": query,
        "results": ranked,
    })))
}

pub async fn rank_chunks(
    state: &AppState,
    username: &str,
    query: &str,
    top_k: usize,
) -> AppResult<Vec<SearchResultItem>> {
    let rows = sqlx::query(
        "SELECT c.article_id, a.title, c.chunk_index, c.text, c.embedding
         FROM wiki_chunks c
         JOIN wiki_articles a ON a.id = c.article_id
         WHERE c.username = ?",
    )
    .bind(username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let query_embedding = embed_single_with_fallback(state, query).await;
    let mut scored = Vec::new();

    for row in rows {
        let embedding_json: String = row.get("embedding");
        let embedding: Vec<f32> = serde_json::from_str(&embedding_json).unwrap_or_default();
        let score = cosine_similarity(&query_embedding, &embedding);
        scored.push(SearchResultItem {
            article_id: row.get("article_id"),
            title: row.get("title"),
            chunk_index: row.get("chunk_index"),
            text: row.get("text"),
            score,
        });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    if scored.len() > top_k {
        scored.truncate(top_k);
    }
    Ok(scored)
}

pub async fn embed_texts_with_fallback(state: &AppState, texts: &[String]) -> Vec<Vec<f32>> {
    if texts.is_empty() {
        return Vec::new();
    }

    if let Some(cfg) = &state.llama_embedding {
        match embed_with_llama_cpp(&state.http_client, cfg, texts).await {
            Ok(vectors) if vectors.len() == texts.len() => {
                return vectors;
            }
            Ok(vectors) => {
                warn!(
                    "llama.cpp embedding count mismatch (got {}, expected {}), using hash fallback",
                    vectors.len(),
                    texts.len()
                );
            }
            Err(err) => {
                warn!("llama.cpp embeddings failed, using hash fallback: {err}");
            }
        }
    }

    texts
        .iter()
        .map(|text| hash_embedding(text, HASH_EMBEDDING_DIM))
        .collect()
}

async fn embed_single_with_fallback(state: &AppState, text: &str) -> Vec<f32> {
    let inputs = vec![text.to_string()];
    embed_texts_with_fallback(state, &inputs)
        .await
        .into_iter()
        .next()
        .unwrap_or_else(|| hash_embedding(text, HASH_EMBEDDING_DIM))
}

async fn embed_with_llama_cpp(
    client: &Client,
    cfg: &LlamaEmbeddingConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let mut payload = json!({
        "input": texts,
    });
    if let Some(model) = cfg.model.as_ref() {
        payload["model"] = json!(model);
    }

    let mut request = client.post(&cfg.url).json(&payload);
    if let Some(api_key) = cfg.api_key.as_ref() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?;

    let mut parsed: LlamaEmbeddingResponse =
        response.json().await.map_err(|err| err.to_string())?;
    if parsed.data.is_empty() {
        return Err("llama.cpp embeddings response contained no vectors".to_string());
    }
    parsed.data.sort_by_key(|item| item.index);

    let vectors: Vec<Vec<f32>> = parsed.data.into_iter().map(|item| item.embedding).collect();
    if vectors.iter().any(|vector| vector.is_empty()) {
        return Err("llama.cpp returned at least one empty embedding vector".to_string());
    }
    Ok(vectors)
}

pub fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Vec::new();
    }

    let overlap = if overlap >= chunk_size {
        chunk_size / 4
    } else {
        overlap
    };
    let bytes = normalized.as_bytes();
    let mut start = 0usize;
    let mut chunks = Vec::new();

    while start < bytes.len() {
        let mut end = (start + chunk_size).min(bytes.len());
        while end < bytes.len() && !normalized.is_char_boundary(end) {
            end -= 1;
        }
        if end <= start {
            break;
        }

        let slice = normalized[start..end].trim();
        if !slice.is_empty() {
            chunks.push(slice.to_string());
        }

        if end == bytes.len() {
            break;
        }

        start = end.saturating_sub(overlap);
        while start < bytes.len() && !normalized.is_char_boundary(start) {
            start += 1;
        }
    }

    chunks
}

fn hash_embedding(text: &str, dim: usize) -> Vec<f32> {
    if dim == 0 {
        return Vec::new();
    }

    let mut vector = vec![0.0f32; dim];
    let tokens = tokenize(text);
    if tokens.is_empty() {
        return vector;
    }

    for token in tokens {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        let digest = hasher.finalize();
        let idx = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) as usize % dim;
        let sign = if digest[4] % 2 == 0 { 1.0 } else { -1.0 };
        vector[idx] += sign;
    }

    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            cur.push(ch.to_ascii_lowercase());
        } else if !cur.is_empty() {
            out.push(cur.clone());
            cur.clear();
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let xf = *x as f64;
        let yf = *y as f64;
        dot += xf * yf;
        norm_a += xf * xf;
        norm_b += yf * yf;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}
