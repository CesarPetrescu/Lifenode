use std::{
    collections::HashMap,
    path::{Component, PathBuf},
    time::{Duration, Instant},
};

use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use futures::{StreamExt, future::join_all};
use reqwest::Url;
use serde::Deserialize;
use sqlx::Row;
use tokio::io::AsyncWriteExt;
use tracing::warn;

use crate::auth::{authorize_username, require_auth};
use crate::error::{AppError, AppResult, internal_error};
use crate::state::AppState;
use crate::types::{
    MapDatasetPresetItem, MapDownloadJobItem, MapDownloadStartRequest, MapFileItem,
    MapsCatalogResponse,
};
use crate::utils::{ensure_user_maps_dir, sanitize_filename, sanitize_username};

#[derive(Clone, Copy)]
struct DatasetPreset {
    id: &'static str,
    source: &'static str,
    title: &'static str,
    description: &'static str,
    url: &'static str,
    approx_size: &'static str,
}

#[derive(Clone, Copy)]
struct KiwixDiscoverySpec {
    id: &'static str,
    index_url: &'static str,
    filename_prefix: &'static str,
}

const KIWIX_PRESETS: &[DatasetPreset] = &[
    DatasetPreset {
        id: "kiwix_wikipedia_en_nopic",
        source: "kiwix",
        title: "Wikipedia EN (No Images)",
        description: "Most practical full English offline Wikipedia without image payload.",
        url: "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_nopic_2025-12.zim",
        approx_size: "~57 GB",
    },
    DatasetPreset {
        id: "kiwix_wikipedia_en_maxi",
        source: "kiwix",
        title: "Wikipedia EN (With Images)",
        description: "Full English Wikipedia with images for complete offline browsing.",
        url: "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2026-02.zim",
        approx_size: "~110 GB",
    },
    DatasetPreset {
        id: "kiwix_wiktionary_en_nopic",
        source: "kiwix",
        title: "Wiktionary EN",
        description: "English offline dictionary with definitions, usage, and translations.",
        url: "https://download.kiwix.org/zim/wiktionary/wiktionary_en_all_nopic_2026-02.zim",
        approx_size: "~2 GB",
    },
    DatasetPreset {
        id: "kiwix_wikivoyage_en_maxi",
        source: "kiwix",
        title: "Wikivoyage EN",
        description: "Offline travel guides and destination knowledge from Wikivoyage.",
        url: "https://download.kiwix.org/zim/wikivoyage/wikivoyage_en_all_maxi_2025-12.zim",
        approx_size: "~2 GB",
    },
    DatasetPreset {
        id: "kiwix_wikibooks_en_maxi",
        source: "kiwix",
        title: "Wikibooks EN",
        description: "Open textbooks and manuals for offline study.",
        url: "https://download.kiwix.org/zim/wikibooks/wikibooks_en_all_maxi_2026-01.zim",
        approx_size: "~5 GB",
    },
    DatasetPreset {
        id: "kiwix_wikiversity_en_maxi",
        source: "kiwix",
        title: "Wikiversity EN",
        description: "Learning resources and course-style educational content.",
        url: "https://download.kiwix.org/zim/wikiversity/wikiversity_en_all_maxi_2026-02.zim",
        approx_size: "~1 GB",
    },
    DatasetPreset {
        id: "kiwix_wikiquote_en_maxi",
        source: "kiwix",
        title: "Wikiquote EN",
        description: "Large quote collections and citation references.",
        url: "https://download.kiwix.org/zim/wikiquote/wikiquote_en_all_maxi_2026-01.zim",
        approx_size: "~1 GB",
    },
    DatasetPreset {
        id: "kiwix_wikisource_en_maxi",
        source: "kiwix",
        title: "Wikisource EN",
        description: "Public domain and source texts for offline reading.",
        url: "https://download.kiwix.org/zim/wikisource/wikisource_en_all_maxi_2026-02.zim",
        approx_size: "~6 GB",
    },
    DatasetPreset {
        id: "kiwix_wikinews_en_maxi",
        source: "kiwix",
        title: "Wikinews EN",
        description: "Archived news articles for offline access.",
        url: "https://download.kiwix.org/zim/wikinews/wikinews_en_all_maxi_2026-01.zim",
        approx_size: "~1 GB",
    },
];
const KIWIX_DISCOVERY_SPECS: &[KiwixDiscoverySpec] = &[
    KiwixDiscoverySpec {
        id: "kiwix_wikipedia_en_nopic",
        index_url: "https://download.kiwix.org/zim/wikipedia/",
        filename_prefix: "wikipedia_en_all_nopic_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wikipedia_en_maxi",
        index_url: "https://download.kiwix.org/zim/wikipedia/",
        filename_prefix: "wikipedia_en_all_maxi_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wiktionary_en_nopic",
        index_url: "https://download.kiwix.org/zim/wiktionary/",
        filename_prefix: "wiktionary_en_all_nopic_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wikivoyage_en_maxi",
        index_url: "https://download.kiwix.org/zim/wikivoyage/",
        filename_prefix: "wikivoyage_en_all_maxi_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wikibooks_en_maxi",
        index_url: "https://download.kiwix.org/zim/wikibooks/",
        filename_prefix: "wikibooks_en_all_maxi_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wikiversity_en_maxi",
        index_url: "https://download.kiwix.org/zim/wikiversity/",
        filename_prefix: "wikiversity_en_all_maxi_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wikiquote_en_maxi",
        index_url: "https://download.kiwix.org/zim/wikiquote/",
        filename_prefix: "wikiquote_en_all_maxi_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wikisource_en_maxi",
        index_url: "https://download.kiwix.org/zim/wikisource/",
        filename_prefix: "wikisource_en_all_maxi_",
    },
    KiwixDiscoverySpec {
        id: "kiwix_wikinews_en_maxi",
        index_url: "https://download.kiwix.org/zim/wikinews/",
        filename_prefix: "wikinews_en_all_maxi_",
    },
];

const OSM_PRESETS: &[DatasetPreset] = &[
    DatasetPreset {
        id: "osm_romania_latest",
        source: "osm",
        title: "OSM Romania (Geofabrik)",
        description: "Country extract for Romania from Geofabrik.",
        url: "https://download.geofabrik.de/europe/romania-latest.osm.pbf",
        approx_size: "~200-400 MB",
    },
    DatasetPreset {
        id: "osm_usa_latest",
        source: "osm",
        title: "OSM USA (Geofabrik)",
        description: "United States regional extract for offline analysis and rendering.",
        url: "https://download.geofabrik.de/north-america/us-latest.osm.pbf",
        approx_size: "~11 GB",
    },
    DatasetPreset {
        id: "osm_europe_latest",
        source: "osm",
        title: "OSM Europe (Geofabrik)",
        description: "Europe-wide extract for large-scale local map deployments.",
        url: "https://download.geofabrik.de/europe-latest.osm.pbf",
        approx_size: "~25 GB",
    },
    DatasetPreset {
        id: "osm_planet_latest",
        source: "osm",
        title: "OSM Planet (Global)",
        description: "Weekly global OpenStreetMap planet snapshot (raw PBF dataset).",
        url: "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf",
        approx_size: "~85 GB",
    },
];

#[derive(Deserialize)]
pub struct MapPathQuery {
    pub path: String,
}

pub async fn maps_catalog() -> impl IntoResponse {
    let mut kiwix = KIWIX_PRESETS.iter().map(preset_to_item).collect::<Vec<_>>();
    let discovered_urls = discover_latest_kiwix_urls().await;
    for item in &mut kiwix {
        if let Some(latest) = discovered_urls.get(&item.id) {
            item.url = latest.clone();
        }
    }
    let osm = OSM_PRESETS.iter().map(preset_to_item).collect::<Vec<_>>();
    let kiwix_embed_url = std::env::var("LIFENODE_KIWIX_EMBED_URL")
        .ok()
        .and_then(|v| {
            let t = v.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        })
        .unwrap_or_else(|| "http://localhost:8081".to_string());

    Json(MapsCatalogResponse {
        kiwix,
        osm,
        kiwix_embed_url,
    })
}

async fn discover_latest_kiwix_urls() -> HashMap<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .build()
        .ok();

    let Some(client) = client else {
        warn!("maps catalog: could not build client for kiwix discovery");
        return HashMap::new();
    };

    let jobs = KIWIX_DISCOVERY_SPECS.iter().map(|spec| async {
        let resolved = discover_latest_kiwix_url(&client, spec.index_url, spec.filename_prefix).await;
        (spec.id, resolved)
    });
    let discovered = join_all(jobs).await;

    let mut result = HashMap::new();
    for (id, resolved) in discovered {
        if let Some(url) = resolved {
            result.insert(id.to_string(), url);
        } else {
            warn!(
                "maps catalog: could not resolve latest kiwix filename for id={}",
                id
            );
        }
    }
    result
}

async fn discover_latest_kiwix_url(
    client: &reqwest::Client,
    index_url: &str,
    filename_prefix: &str,
) -> Option<String> {
    let body = client
        .get(index_url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    let latest = extract_latest_kiwix_filename(&body, filename_prefix)?;
    Some(format!("{index_url}{latest}"))
}

fn extract_latest_kiwix_filename(index_html: &str, prefix: &str) -> Option<String> {
    let mut latest: Option<&str> = None;
    for token in index_html.split('"') {
        if !token.starts_with(prefix) || !token.ends_with(".zim") {
            continue;
        }
        let should_set = latest.map(|current| token > current).unwrap_or(true);
        if should_set {
            latest = Some(token);
        }
    }
    latest.map(|name| name.to_string())
}

pub async fn list_download_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let rows = sqlx::query(
        "SELECT id, username, source, label, url, target_path, status, bytes_total, bytes_downloaded,
                cancel_requested, created_at, updated_at, finished_at, error_message
         FROM maps_download_jobs
         WHERE username = ?
         ORDER BY id DESC
         LIMIT 200",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let jobs = rows.into_iter().map(row_to_job).collect::<Vec<_>>();
    Ok(Json(jobs))
}

pub async fn start_download_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Json(payload): Json<MapDownloadStartRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let (source, label, url) = resolve_download_target(&payload)?;
    let url = validate_download_url(&url)?;
    let file_name = resolve_target_filename(payload.file_name.as_deref(), &url, &source)?;
    let target_path = format!("{source}/{file_name}");

    let running = sqlx::query_scalar::<_, i64>(
        "SELECT id
         FROM maps_download_jobs
         WHERE username = ? AND status IN ('queued', 'running')
         ORDER BY id DESC
         LIMIT 1",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    if running.is_some() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "A maps download is already running. Wait or cancel the current job first.",
        ));
    }

    let now = Utc::now().to_rfc3339();
    let insert = sqlx::query(
        "INSERT INTO maps_download_jobs
         (username, source, label, url, target_path, status, bytes_downloaded, cancel_requested, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?)",
    )
    .bind(&username)
    .bind(&source)
    .bind(&label)
    .bind(&url)
    .bind(&target_path)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    let job_id = insert.last_insert_rowid();

    let worker_state = state.clone();
    let worker_username = username.clone();
    tokio::spawn(async move {
        run_download_job(worker_state, job_id, worker_username).await;
    });

    let row = sqlx::query(
        "SELECT id, username, source, label, url, target_path, status, bytes_total, bytes_downloaded,
                cancel_requested, created_at, updated_at, finished_at, error_message
         FROM maps_download_jobs
         WHERE id = ?",
    )
    .bind(job_id)
    .fetch_one(&state.db)
    .await
    .map_err(internal_error)?;

    Ok(Json(row_to_job(row)))
}

pub async fn cancel_download_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, job_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let now = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE maps_download_jobs
         SET cancel_requested = 1, updated_at = ?
         WHERE id = ? AND username = ? AND status IN ('queued', 'running')",
    )
    .bind(&now)
    .bind(job_id)
    .bind(&username)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    if result.rows_affected() == 0 {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "Running maps job not found",
        ));
    }

    let row = sqlx::query(
        "SELECT id, username, source, label, url, target_path, status, bytes_total, bytes_downloaded,
                cancel_requested, created_at, updated_at, finished_at, error_message
         FROM maps_download_jobs
         WHERE id = ?",
    )
    .bind(job_id)
    .fetch_one(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(Json(row_to_job(row)))
}

pub async fn delete_download_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, job_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM maps_download_jobs WHERE id = ? AND username = ?",
    )
    .bind(job_id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;

    let Some(status) = status else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Maps job not found"));
    };

    if status == "queued" || status == "running" {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "Cannot delete a running maps job. Cancel it first.",
        ));
    }

    sqlx::query("DELETE FROM maps_download_jobs WHERE id = ? AND username = ?")
        .bind(job_id)
        .bind(&username)
        .execute(&state.db)
        .await
        .map_err(internal_error)?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_map_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let maps_dir = ensure_user_maps_dir(&state.user_files_dir, &username).await?;
    let mut files = Vec::new();
    for source in ["kiwix", "osm"] {
        let source_dir = maps_dir.join(source);
        if !source_dir.is_dir() {
            continue;
        }
        collect_source_files(&source_dir, source, &mut files).await?;
    }

    files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(Json(files))
}

pub async fn download_map_file_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Query(query): Query<MapPathQuery>,
) -> AppResult<Response> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let rel = sanitize_rel_path(&query.path)?;
    let maps_dir = ensure_user_maps_dir(&state.user_files_dir, &username).await?;
    let abs = maps_dir.join(&rel);
    if !abs.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }

    let bytes = tokio::fs::read(&abs).await.map_err(internal_error)?;
    let filename = abs
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "download.bin".to_string());

    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", filename)) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(response)
}

pub async fn delete_map_file_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
    Query(query): Query<MapPathQuery>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let rel = sanitize_rel_path(&query.path)?;
    let maps_dir = ensure_user_maps_dir(&state.user_files_dir, &username).await?;
    let abs = maps_dir.join(&rel);
    if !abs.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "File not found"));
    }

    tokio::fs::remove_file(&abs).await.map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

fn preset_to_item(item: &DatasetPreset) -> MapDatasetPresetItem {
    MapDatasetPresetItem {
        id: item.id.to_string(),
        source: item.source.to_string(),
        title: item.title.to_string(),
        description: item.description.to_string(),
        url: item.url.to_string(),
        approx_size: item.approx_size.to_string(),
    }
}

fn resolve_download_target(
    payload: &MapDownloadStartRequest,
) -> AppResult<(String, String, String)> {
    if let Some(preset_id) = payload.preset_id.as_deref() {
        if let Some(preset) = find_preset(preset_id) {
            return Ok((
                preset.source.to_string(),
                preset.title.to_string(),
                preset.url.to_string(),
            ));
        }
        return Err(AppError::new(StatusCode::BAD_REQUEST, "Unknown preset_id"));
    }

    let source_raw = payload
        .source
        .as_deref()
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "source is required"))?;
    let source = normalize_source(source_raw)?;
    let url = payload
        .url
        .as_deref()
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "url is required"))?
        .trim()
        .to_string();
    let label = payload
        .label
        .as_deref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or("Custom download")
        .to_string();
    Ok((source, label, url))
}

fn validate_download_url(raw: &str) -> AppResult<String> {
    let parsed = Url::parse(raw)
        .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "Invalid download URL"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "Only http/https URLs are supported",
            ));
        }
    }
    Ok(parsed.to_string())
}

fn resolve_target_filename(
    requested_name: Option<&str>,
    url: &str,
    source: &str,
) -> AppResult<String> {
    let candidate = if let Some(name) = requested_name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else {
        Url::parse(url).ok().and_then(|parsed| {
            parsed
                .path_segments()
                .and_then(|segments| segments.last().map(|v| v.to_string()))
        })
    };

    let fallback = if source == "kiwix" {
        "wikipedia.zim"
    } else {
        "map.osm.pbf"
    };
    let raw_name = candidate.unwrap_or_else(|| fallback.to_string());
    sanitize_filename(&raw_name)
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid file name"))
}

fn find_preset(id: &str) -> Option<&'static DatasetPreset> {
    KIWIX_PRESETS
        .iter()
        .chain(OSM_PRESETS.iter())
        .find(|preset| preset.id == id)
}

fn normalize_source(raw: &str) -> AppResult<String> {
    let source = raw.trim().to_ascii_lowercase();
    if source == "kiwix" || source == "osm" {
        Ok(source)
    } else {
        Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "source must be `kiwix` or `osm`",
        ))
    }
}

async fn run_download_job(state: AppState, job_id: i64, username: String) {
    if let Err(err) = run_download_job_inner(&state, job_id, &username).await {
        let _ = mark_job_failed(&state, job_id, &err.message).await;
    }
}

async fn run_download_job_inner(state: &AppState, job_id: i64, username: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE maps_download_jobs
         SET status = 'running', updated_at = ?, finished_at = NULL, error_message = NULL
         WHERE id = ?",
    )
    .bind(&now)
    .bind(job_id)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    let row = sqlx::query("SELECT source, url, target_path FROM maps_download_jobs WHERE id = ?")
        .bind(job_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal_error)?;
    let source: String = row.get("source");
    let url: String = row.get("url");
    let target_rel: String = row.get("target_path");

    let maps_dir = ensure_user_maps_dir(&state.user_files_dir, username).await?;
    let source_dir = maps_dir.join(&source);
    tokio::fs::create_dir_all(&source_dir)
        .await
        .map_err(internal_error)?;

    let target_abs = maps_dir.join(&target_rel);
    let target_parent = target_abs
        .parent()
        .ok_or_else(|| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, "Invalid target path"))?;
    tokio::fs::create_dir_all(target_parent)
        .await
        .map_err(internal_error)?;

    let file_name = target_abs
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "download.bin".to_string());
    let tmp_abs = target_abs.with_file_name(format!("{file_name}.part"));
    let _ = tokio::fs::remove_file(&tmp_abs).await;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(24 * 60 * 60))
        .build()
        .map_err(internal_error)?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|err| AppError::new(StatusCode::BAD_GATEWAY, err.to_string()))?
        .error_for_status()
        .map_err(|err| AppError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;

    let total = response.content_length().map(|v| v as i64);
    sqlx::query(
        "UPDATE maps_download_jobs
         SET bytes_total = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(total)
    .bind(Utc::now().to_rfc3339())
    .bind(job_id)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    let mut file = tokio::fs::File::create(&tmp_abs)
        .await
        .map_err(internal_error)?;
    let mut downloaded: i64 = 0;
    let mut stream = response.bytes_stream();
    let mut last_update = Instant::now();
    let mut last_cancel_check = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| AppError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;
        file.write_all(&chunk).await.map_err(internal_error)?;
        downloaded += chunk.len() as i64;

        if last_cancel_check.elapsed() >= Duration::from_secs(2) {
            last_cancel_check = Instant::now();
            if is_cancel_requested(state, job_id).await.unwrap_or(false) {
                let _ = file.flush().await;
                let _ = tokio::fs::remove_file(&tmp_abs).await;
                mark_job_cancelled(state, job_id, downloaded).await?;
                return Ok(());
            }
        }

        if last_update.elapsed() >= Duration::from_secs(1) {
            last_update = Instant::now();
            sqlx::query(
                "UPDATE maps_download_jobs
                 SET bytes_downloaded = ?, updated_at = ?
                 WHERE id = ?",
            )
            .bind(downloaded)
            .bind(Utc::now().to_rfc3339())
            .bind(job_id)
            .execute(&state.db)
            .await
            .map_err(internal_error)?;
        }
    }

    file.flush().await.map_err(internal_error)?;
    if tokio::fs::try_exists(&target_abs)
        .await
        .map_err(internal_error)?
    {
        tokio::fs::remove_file(&target_abs)
            .await
            .map_err(internal_error)?;
    }
    tokio::fs::rename(&tmp_abs, &target_abs)
        .await
        .map_err(internal_error)?;

    let finished = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE maps_download_jobs
         SET status = 'completed', bytes_downloaded = ?, updated_at = ?, finished_at = ?, error_message = NULL
         WHERE id = ?",
    )
    .bind(downloaded)
    .bind(&finished)
    .bind(&finished)
    .bind(job_id)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(())
}

async fn is_cancel_requested(state: &AppState, job_id: i64) -> AppResult<bool> {
    let flag = sqlx::query_scalar::<_, i64>(
        "SELECT cancel_requested FROM maps_download_jobs WHERE id = ?",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(flag.unwrap_or(0) != 0)
}

async fn mark_job_cancelled(state: &AppState, job_id: i64, downloaded: i64) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE maps_download_jobs
         SET status = 'cancelled', bytes_downloaded = ?, updated_at = ?, finished_at = ?
         WHERE id = ?",
    )
    .bind(downloaded)
    .bind(&now)
    .bind(&now)
    .bind(job_id)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(())
}

async fn mark_job_failed(state: &AppState, job_id: i64, message: &str) -> AppResult<()> {
    warn!("maps download job {} failed: {}", job_id, message);
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE maps_download_jobs
         SET status = 'failed', updated_at = ?, finished_at = ?, error_message = ?
         WHERE id = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(message)
    .bind(job_id)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(())
}

async fn collect_source_files(
    source_dir: &PathBuf,
    source: &str,
    out: &mut Vec<MapFileItem>,
) -> AppResult<()> {
    let mut stack = vec![source_dir.clone()];
    while let Some(dir) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&dir).await.map_err(internal_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(internal_error)? {
            let file_type = entry.file_type().await.map_err(internal_error)?;
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".part") {
                continue;
            }
            let metadata = entry.metadata().await.map_err(internal_error)?;
            let modified = metadata
                .modified()
                .ok()
                .map(DateTime::<Utc>::from)
                .map(|t| t.to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let rel = entry
                .path()
                .strip_prefix(source_dir)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or(name.clone());

            out.push(MapFileItem {
                source: source.to_string(),
                name: name.clone(),
                path: format!("{}/{}", source, rel),
                size: metadata.len(),
                modified_at: modified,
            });
        }
    }
    Ok(())
}

fn sanitize_rel_path(input: &str) -> AppResult<PathBuf> {
    let trimmed = input.trim().trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::new(StatusCode::BAD_REQUEST, "path is required"));
    }

    let mut out = PathBuf::new();
    for component in PathBuf::from(trimmed).components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    "Invalid relative path",
                ));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Invalid relative path",
        ));
    }
    Ok(out)
}

fn row_to_job(row: sqlx::sqlite::SqliteRow) -> MapDownloadJobItem {
    let bytes_total = row.get::<Option<i64>, _>("bytes_total");
    let bytes_downloaded = row.get::<i64, _>("bytes_downloaded");
    let progress = bytes_total.and_then(|total| {
        if total <= 0 {
            None
        } else {
            Some((bytes_downloaded as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
        }
    });

    MapDownloadJobItem {
        id: row.get("id"),
        username: row.get("username"),
        source: row.get("source"),
        label: row.get("label"),
        url: row.get("url"),
        target_path: row.get("target_path"),
        status: row.get("status"),
        bytes_total,
        bytes_downloaded,
        progress,
        cancel_requested: row.get::<i64, _>("cancel_requested") != 0,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        finished_at: row.get("finished_at"),
        error_message: row.get("error_message"),
    }
}
