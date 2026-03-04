use std::path::PathBuf;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub const HASH_EMBEDDING_DIM: usize = 384;
pub const DEFAULT_TOP_K: u32 = 4;
pub const SESSION_TTL_HOURS: i64 = 24 * 14;
pub const LLAMA_CHAT_TIMEOUT_SECS_DEFAULT: u64 = 120;
pub const WIKIPEDIA_MAX_IMAGES_PER_ARTICLE: usize = 60;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub http_client: Client,
    pub user_files_dir: PathBuf,
    pub wiki_lang: String,
    pub max_upload_bytes: usize,
    pub llama_embedding: Option<LlamaEmbeddingConfig>,
    pub llama_chat: Option<LlamaChatConfig>,
}

#[derive(Clone)]
pub struct AuthenticatedUser {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
}

#[derive(Clone)]
pub struct LlamaEmbeddingConfig {
    pub url: String,
    pub model: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Clone)]
pub struct LlamaChatConfig {
    pub url: String,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub max_tokens: u32,
    pub timeout_secs: u64,
    pub default_thinking: bool,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct QwenSamplingPreset {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    pub min_p: f32,
    pub presence_penalty: f32,
    pub repetition_penalty: f32,
    pub enable_thinking: bool,
}
