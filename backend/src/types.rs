use serde::{Deserialize, Serialize};

use crate::state::QwenSamplingPreset;

// --- Request types ---

#[derive(Deserialize)]
pub struct WikiDownloadRequest {
    pub username: String,
    pub title: String,
    pub lang: Option<String>,
    pub include_images: Option<bool>,
}

#[derive(Deserialize)]
pub struct WikiBulkDownloadRequest {
    pub username: String,
    pub lang: Option<String>,
    pub include_images: Option<bool>,
    pub max_pages: Option<u32>,
    pub batch_size: Option<u32>,
}

#[derive(Deserialize)]
pub struct SearchRequest {
    pub username: String,
    pub query: String,
    pub top_k: Option<u32>,
}

#[derive(Deserialize)]
pub struct AskRequest {
    pub username: String,
    pub question: String,
    pub top_k: Option<u32>,
    pub thinking: Option<bool>,
    pub use_wiki_retrieval: Option<bool>,
    pub thread_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct MapDownloadStartRequest {
    pub preset_id: Option<String>,
    pub source: Option<String>,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub label: Option<String>,
}

#[derive(Deserialize)]
pub struct AskThreadCreateRequest {
    pub title: Option<String>,
}

#[derive(Deserialize)]
pub struct AskThreadRenameRequest {
    pub title: String,
}

#[derive(Deserialize)]
pub struct NoteUpdateRequest {
    pub content: String,
}

#[derive(Deserialize)]
pub struct NoteFolderCreateRequest {
    pub name: String,
    pub parent_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct NoteFolderUpdateRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct NoteFileCreateRequest {
    pub name: String,
    pub folder_id: Option<i64>,
    pub content: Option<String>,
}

#[derive(Deserialize)]
pub struct NoteFileUpdateRequest {
    pub name: String,
    pub folder_id: Option<i64>,
    pub content: String,
}

#[derive(Deserialize)]
pub struct DriveFolderCreateRequest {
    pub name: String,
    pub parent_path: Option<String>,
}

#[derive(Deserialize)]
pub struct DrivePathQuery {
    pub path: String,
}

#[derive(Deserialize)]
pub struct CalendarEventCreateRequest {
    pub title: String,
    pub start_ts: String,
    pub end_ts: String,
    pub details: Option<String>,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct UpdateUserRoleRequest {
    pub is_admin: bool,
}

// --- Response types ---

#[derive(Serialize, Deserialize)]
pub struct SearchResultItem {
    pub article_id: i64,
    pub title: String,
    pub chunk_index: i64,
    pub text: String,
    pub score: f64,
}

#[derive(Serialize)]
pub struct DriveFileItem {
    pub filename: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Serialize)]
pub struct DriveFolderItem {
    pub name: String,
    pub path: String,
    pub parent_path: Option<String>,
}

#[derive(Serialize)]
pub struct DriveTreeFileItem {
    pub name: String,
    pub path: String,
    pub parent_path: Option<String>,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Serialize)]
pub struct DriveTreeResponse {
    pub folders: Vec<DriveFolderItem>,
    pub files: Vec<DriveTreeFileItem>,
}

#[derive(Serialize)]
pub struct MapDatasetPresetItem {
    pub id: String,
    pub source: String,
    pub title: String,
    pub description: String,
    pub url: String,
    pub approx_size: String,
}

#[derive(Serialize)]
pub struct MapsCatalogResponse {
    pub kiwix: Vec<MapDatasetPresetItem>,
    pub osm: Vec<MapDatasetPresetItem>,
    pub kiwix_embed_url: String,
}

#[derive(Serialize)]
pub struct MapDownloadJobItem {
    pub id: i64,
    pub username: String,
    pub source: String,
    pub label: String,
    pub url: String,
    pub target_path: String,
    pub status: String,
    pub bytes_total: Option<i64>,
    pub bytes_downloaded: i64,
    pub progress: Option<f64>,
    pub cancel_requested: bool,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Serialize)]
pub struct MapFileItem {
    pub source: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Serialize)]
pub struct AskThreadItem {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_message_preview: Option<String>,
    pub message_count: i64,
}

#[derive(Serialize, Deserialize)]
pub struct AskMessageItem {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub contexts: Option<Vec<SearchResultItem>>,
    pub sampling: Option<QwenSamplingPreset>,
    pub thinking: bool,
}

#[derive(Serialize)]
pub struct AskThreadDetailItem {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<AskMessageItem>,
}

#[derive(Serialize)]
pub struct WikiArticleItem {
    pub id: i64,
    pub title: String,
    pub url: String,
    pub downloaded_at: String,
    pub image_count: i64,
}

#[derive(Serialize)]
pub struct WikiArticleDetailItem {
    pub id: i64,
    pub title: String,
    pub url: String,
    pub content: String,
    pub downloaded_at: String,
    pub image_count: i64,
    pub images: Vec<WikiImageItem>,
}

#[derive(Serialize)]
pub struct WikiImageItem {
    pub title: String,
    pub url: String,
    pub thumb_url: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Serialize)]
pub struct WikiBulkJobItem {
    pub id: i64,
    pub username: String,
    pub lang: String,
    pub include_images: bool,
    pub status: String,
    pub continuation_token: Option<String>,
    pub processed_pages: i64,
    pub indexed_articles: i64,
    pub failed_pages: i64,
    pub max_pages: Option<i64>,
    pub batch_size: i64,
    pub started_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Serialize)]
pub struct CalendarEventItem {
    pub id: i64,
    pub title: String,
    pub start_ts: String,
    pub end_ts: String,
    pub details: String,
}

#[derive(Serialize)]
pub struct NoteItem {
    pub content: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct NoteFolderItem {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct NoteFileListItem {
    pub id: i64,
    pub name: String,
    pub folder_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct NoteFileDetailItem {
    pub id: i64,
    pub name: String,
    pub folder_id: Option<i64>,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct NotesTreeResponse {
    pub folders: Vec<NoteFolderItem>,
    pub files: Vec<NoteFileListItem>,
}

#[derive(Serialize)]
pub struct AuthUserResponse {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub expires_at: String,
    pub user: AuthUserResponse,
}

#[derive(Serialize)]
pub struct UserListItem {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
    pub created_at: String,
}

// --- Internal types ---

#[derive(Clone)]
pub struct WikipediaArticle {
    pub title: String,
    pub url: String,
    pub content: String,
}

#[derive(Clone)]
pub struct WikipediaImage {
    pub title: String,
    pub url: String,
    pub thumb_url: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Deserialize)]
pub struct LlamaEmbeddingResponse {
    pub data: Vec<LlamaEmbeddingItem>,
}

#[derive(Deserialize)]
pub struct LlamaEmbeddingItem {
    pub index: usize,
    pub embedding: Vec<f32>,
}
