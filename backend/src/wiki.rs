use std::path::PathBuf;

use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use reqwest::Client;
use serde_json::{Value, json};
use sqlx::Row;
use tracing::warn;
use urlencoding::encode;

use crate::auth::{authorize_username, require_auth};
use crate::error::{AppError, AppResult, internal_error};
use crate::search::{chunk_text, embed_texts_with_fallback};
use crate::state::{AppState, WIKIPEDIA_MAX_IMAGES_PER_ARTICLE};
use crate::types::{
    WikiArticleDetailItem, WikiArticleItem, WikiBulkDownloadRequest, WikiBulkJobItem,
    WikiDownloadRequest, WikiImageItem, WikipediaArticle, WikipediaImage,
};
use crate::utils::{ensure_user_wiki_dir, sanitize_storage_name, sanitize_username};

pub async fn wiki_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<WikiDownloadRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let title = payload.title.trim();
    if title.is_empty() {
        return Err(AppError::new(StatusCode::BAD_REQUEST, "Title is required"));
    }
    let lang = payload
        .lang
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(&state.wiki_lang);
    let include_images = payload.include_images.unwrap_or(false);

    let article = fetch_wikipedia_article(&state.http_client, title, lang).await?;
    let images = if include_images {
        match fetch_wikipedia_images(
            &state.http_client,
            &article.title,
            lang,
            WIKIPEDIA_MAX_IMAGES_PER_ARTICLE,
        )
        .await
        {
            Ok(items) => items,
            Err(err) => {
                warn!(
                    "failed fetching wikipedia images for `{}`: {}",
                    article.title, err.message
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let (article_id, indexed_chunks, article_path) =
        index_wikipedia_article_for_user(&state, &username, &article, &images).await?;

    Ok(Json(json!({
        "username": username,
        "article_id": article_id,
        "title": article.title,
        "url": article.url,
        "indexed_chunks": indexed_chunks,
        "include_images": include_images,
        "image_count": images.len(),
        "cached_file": article_path.to_string_lossy(),
    })))
}

pub async fn list_wiki_articles(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let rows = sqlx::query(
        "SELECT a.id, a.title, a.url, a.downloaded_at, COUNT(i.id) AS image_count
         FROM wiki_articles a
         LEFT JOIN wiki_images i ON i.article_id = a.id
         WHERE a.username = ?
         GROUP BY a.id
         ORDER BY a.downloaded_at DESC",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    let articles: Vec<WikiArticleItem> = rows
        .into_iter()
        .map(|row| WikiArticleItem {
            id: row.get("id"),
            title: row.get("title"),
            url: row.get("url"),
            downloaded_at: row.get("downloaded_at"),
            image_count: row.get("image_count"),
        })
        .collect();

    Ok(Json(articles))
}

pub async fn get_wiki_article(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, article_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;
    let row = sqlx::query(
        "SELECT id, title, url, content, downloaded_at FROM wiki_articles WHERE username = ? AND id = ?",
    )
    .bind(&username)
    .bind(article_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;

    let Some(row) = row else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Article not found"));
    };

    let image_rows = sqlx::query(
        "SELECT title, url, thumb_url, width, height
         FROM wiki_images
         WHERE article_id = ? AND username = ?
         ORDER BY id ASC",
    )
    .bind(article_id)
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;
    let images: Vec<WikiImageItem> = image_rows
        .into_iter()
        .map(|img| WikiImageItem {
            title: img.get("title"),
            url: img.get("url"),
            thumb_url: img.get("thumb_url"),
            width: img.get("width"),
            height: img.get("height"),
        })
        .collect();

    Ok(Json(WikiArticleDetailItem {
        id: row.get("id"),
        title: row.get("title"),
        url: row.get("url"),
        content: row.get("content"),
        downloaded_at: row.get("downloaded_at"),
        image_count: images.len() as i64,
        images,
    }))
}

pub async fn export_wiki_text(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<Response> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let rows = sqlx::query(
        "SELECT title, url, content, downloaded_at
         FROM wiki_articles
         WHERE username = ?
         ORDER BY downloaded_at DESC",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;

    if rows.is_empty() {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "No indexed Wikipedia articles for this user",
        ));
    }

    let mut output = String::new();
    output.push_str(&format!(
        "LifeNode Wikipedia Text Export\nUser: {}\nGenerated: {}\n\n",
        username,
        Utc::now().to_rfc3339()
    ));

    for row in rows {
        let title: String = row.get("title");
        let url: String = row.get("url");
        let content: String = row.get("content");
        let downloaded_at: String = row.get("downloaded_at");

        output.push_str(&format!(
            "# {}\nSource: {}\nDownloaded: {}\n\n{}\n\n{}\n\n",
            title,
            url,
            downloaded_at,
            content.trim(),
            "-".repeat(72),
        ));
    }

    let filename = format!(
        "lifenode-wiki-{}-{}.txt",
        sanitize_storage_name(&username),
        Utc::now().format("%Y%m%d-%H%M%S")
    );

    let mut response = Response::new(Body::from(output.into_bytes()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", filename)) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(response)
}

pub async fn start_wiki_bulk_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<WikiBulkDownloadRequest>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&payload.username)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let lang = payload
        .lang
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(&state.wiki_lang)
        .to_string();
    let include_images = payload.include_images.unwrap_or(false);
    let max_pages_i64 = payload
        .max_pages
        .and_then(|v| if v == 0 { None } else { Some(v as i64) });
    let batch_size = payload.batch_size.unwrap_or(25).clamp(5, 50) as i64;

    let running = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM wiki_bulk_jobs WHERE username = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    if let Some(existing_id) = running {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            format!(
                "A bulk download job is already running for this user (job id {}).",
                existing_id
            ),
        ));
    }

    let now = Utc::now().to_rfc3339();
    let insert = sqlx::query(
        "INSERT INTO wiki_bulk_jobs (username, lang, include_images, status, max_pages, batch_size, started_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(&lang)
    .bind(if include_images { 1 } else { 0 })
    .bind(max_pages_i64)
    .bind(batch_size)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;
    let job_id = insert.last_insert_rowid();

    let worker_state = state.clone();
    let worker_username = username.clone();
    let worker_lang = lang.clone();
    tokio::spawn(async move {
        run_wiki_bulk_download_job(
            worker_state,
            job_id,
            worker_username,
            worker_lang,
            include_images,
            max_pages_i64,
            batch_size,
        )
        .await;
    });

    let row = sqlx::query(
        "SELECT id, username, lang, include_images, status, continuation_token, processed_pages, indexed_articles, failed_pages, max_pages, batch_size, started_at, updated_at, finished_at, last_error
         FROM wiki_bulk_jobs
         WHERE id = ?",
    )
    .bind(job_id)
    .fetch_one(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(Json(wiki_bulk_job_from_row(&row)))
}

pub async fn list_wiki_bulk_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username_raw): AxumPath<String>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let rows = sqlx::query(
        "SELECT id, username, lang, include_images, status, continuation_token, processed_pages, indexed_articles, failed_pages, max_pages, batch_size, started_at, updated_at, finished_at, last_error
         FROM wiki_bulk_jobs
         WHERE username = ?
         ORDER BY id DESC
         LIMIT 20",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .map_err(internal_error)?;
    let items = rows
        .into_iter()
        .map(|row| wiki_bulk_job_from_row(&row))
        .collect::<Vec<_>>();
    Ok(Json(items))
}

pub async fn get_wiki_bulk_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, job_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let row = sqlx::query(
        "SELECT id, username, lang, include_images, status, continuation_token, processed_pages, indexed_articles, failed_pages, max_pages, batch_size, started_at, updated_at, finished_at, last_error
         FROM wiki_bulk_jobs
         WHERE id = ? AND username = ?",
    )
    .bind(job_id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_error)?;
    let Some(row) = row else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Bulk job not found"));
    };
    Ok(Json(wiki_bulk_job_from_row(&row)))
}

pub async fn cancel_wiki_bulk_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((username_raw, job_id)): AxumPath<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let username = sanitize_username(&username_raw)?;
    let auth = require_auth(&state, &headers).await?;
    authorize_username(&auth, &username)?;

    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM wiki_bulk_jobs WHERE id = ? AND username = ?")
            .bind(job_id)
            .bind(&username)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_error)?;
    let Some(status) = status else {
        return Err(AppError::new(StatusCode::NOT_FOUND, "Bulk job not found"));
    };
    if status == "completed" || status == "failed" || status == "canceled" {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            format!("Job already finished with status `{}`", status),
        ));
    }

    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE wiki_bulk_jobs SET status = 'canceled', updated_at = ?, finished_at = ? WHERE id = ? AND username = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(job_id)
    .bind(&username)
    .execute(&state.db)
    .await
    .map_err(internal_error)?;

    let row = sqlx::query(
        "SELECT id, username, lang, include_images, status, continuation_token, processed_pages, indexed_articles, failed_pages, max_pages, batch_size, started_at, updated_at, finished_at, last_error
         FROM wiki_bulk_jobs
         WHERE id = ? AND username = ?",
    )
    .bind(job_id)
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .map_err(internal_error)?;
    Ok(Json(wiki_bulk_job_from_row(&row)))
}

async fn run_wiki_bulk_download_job(
    state: AppState,
    job_id: i64,
    username: String,
    lang: String,
    include_images: bool,
    max_pages: Option<i64>,
    batch_size: i64,
) {
    let started = Utc::now().to_rfc3339();
    if let Err(err) = sqlx::query(
        "UPDATE wiki_bulk_jobs SET status = 'running', updated_at = ?, started_at = ? WHERE id = ?",
    )
    .bind(&started)
    .bind(&started)
    .bind(job_id)
    .execute(&state.db)
    .await
    {
        warn!("failed to set bulk job {} running: {}", job_id, err);
        return;
    }

    let mut continuation: Option<String> = None;
    let mut processed_pages = 0_i64;
    let mut indexed_articles = 0_i64;
    let mut failed_pages = 0_i64;

    loop {
        match bulk_job_status(&state.db, job_id).await {
            Ok(Some(status)) if status == "canceled" => {
                finalize_bulk_job(
                    &state.db,
                    job_id,
                    "canceled",
                    continuation.as_deref(),
                    processed_pages,
                    indexed_articles,
                    failed_pages,
                    None,
                )
                .await;
                return;
            }
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(err) => {
                warn!("failed reading bulk job status {}: {}", job_id, err);
                return;
            }
        }

        if max_pages.is_some_and(|limit| processed_pages >= limit) {
            finalize_bulk_job(
                &state.db,
                job_id,
                "completed",
                continuation.as_deref(),
                processed_pages,
                indexed_articles,
                failed_pages,
                None,
            )
            .await;
            return;
        }

        let page_titles = fetch_wikipedia_page_titles(
            &state.http_client,
            &lang,
            continuation.as_deref(),
            batch_size as u32,
        )
        .await;
        let (titles, next_continuation) = match page_titles {
            Ok(value) => value,
            Err(err) => {
                finalize_bulk_job(
                    &state.db,
                    job_id,
                    "failed",
                    continuation.as_deref(),
                    processed_pages,
                    indexed_articles,
                    failed_pages,
                    Some(err.message.as_str()),
                )
                .await;
                return;
            }
        };

        if titles.is_empty() {
            finalize_bulk_job(
                &state.db,
                job_id,
                "completed",
                continuation.as_deref(),
                processed_pages,
                indexed_articles,
                failed_pages,
                None,
            )
            .await;
            return;
        }

        for title in titles {
            if max_pages.is_some_and(|limit| processed_pages >= limit) {
                break;
            }
            processed_pages += 1;

            let article = fetch_wikipedia_article(&state.http_client, &title, &lang).await;
            let Ok(article) = article else {
                if let Err(err) = article {
                    warn!(
                        "bulk job {} failed article fetch `{}`: {}",
                        job_id, title, err.message
                    );
                }
                failed_pages += 1;
                continue;
            };

            let images = if include_images {
                match fetch_wikipedia_images(
                    &state.http_client,
                    &article.title,
                    &lang,
                    WIKIPEDIA_MAX_IMAGES_PER_ARTICLE,
                )
                .await
                {
                    Ok(items) => items,
                    Err(err) => {
                        warn!(
                            "bulk job {} failed image fetch for `{}`: {}",
                            job_id, article.title, err.message
                        );
                        Vec::new()
                    }
                }
            } else {
                Vec::new()
            };

            match index_wikipedia_article_for_user(&state, &username, &article, &images).await {
                Ok(_) => indexed_articles += 1,
                Err(err) => {
                    failed_pages += 1;
                    warn!(
                        "bulk job {} failed indexing article `{}`: {}",
                        job_id, article.title, err.message
                    );
                }
            }
        }

        continuation = next_continuation;
        update_bulk_job_progress(
            &state.db,
            job_id,
            continuation.as_deref(),
            processed_pages,
            indexed_articles,
            failed_pages,
        )
        .await;

        if continuation.is_none() {
            finalize_bulk_job(
                &state.db,
                job_id,
                "completed",
                None,
                processed_pages,
                indexed_articles,
                failed_pages,
                None,
            )
            .await;
            return;
        }
    }
}

async fn bulk_job_status(
    db: &sqlx::SqlitePool,
    job_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT status FROM wiki_bulk_jobs WHERE id = ?")
        .bind(job_id)
        .fetch_optional(db)
        .await
}

async fn update_bulk_job_progress(
    db: &sqlx::SqlitePool,
    job_id: i64,
    continuation_token: Option<&str>,
    processed_pages: i64,
    indexed_articles: i64,
    failed_pages: i64,
) {
    let now = Utc::now().to_rfc3339();
    if let Err(err) = sqlx::query(
        "UPDATE wiki_bulk_jobs
         SET continuation_token = ?, processed_pages = ?, indexed_articles = ?, failed_pages = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(continuation_token)
    .bind(processed_pages)
    .bind(indexed_articles)
    .bind(failed_pages)
    .bind(&now)
    .bind(job_id)
    .execute(db)
    .await
    {
        warn!("failed updating bulk job progress {}: {}", job_id, err);
    }
}

async fn finalize_bulk_job(
    db: &sqlx::SqlitePool,
    job_id: i64,
    status: &str,
    continuation_token: Option<&str>,
    processed_pages: i64,
    indexed_articles: i64,
    failed_pages: i64,
    last_error: Option<&str>,
) {
    let now = Utc::now().to_rfc3339();
    if let Err(err) = sqlx::query(
        "UPDATE wiki_bulk_jobs
         SET status = ?, continuation_token = ?, processed_pages = ?, indexed_articles = ?, failed_pages = ?, last_error = ?, updated_at = ?, finished_at = ?
         WHERE id = ?",
    )
    .bind(status)
    .bind(continuation_token)
    .bind(processed_pages)
    .bind(indexed_articles)
    .bind(failed_pages)
    .bind(last_error)
    .bind(&now)
    .bind(&now)
    .bind(job_id)
    .execute(db)
    .await
    {
        warn!("failed finalizing bulk job {}: {}", job_id, err);
    }
}

fn wiki_bulk_job_from_row(row: &sqlx::sqlite::SqliteRow) -> WikiBulkJobItem {
    WikiBulkJobItem {
        id: row.get("id"),
        username: row.get("username"),
        lang: row.get("lang"),
        include_images: row.get::<i64, _>("include_images") != 0,
        status: row.get("status"),
        continuation_token: row.get("continuation_token"),
        processed_pages: row.get("processed_pages"),
        indexed_articles: row.get("indexed_articles"),
        failed_pages: row.get("failed_pages"),
        max_pages: row.get("max_pages"),
        batch_size: row.get("batch_size"),
        started_at: row.get("started_at"),
        updated_at: row.get("updated_at"),
        finished_at: row.get("finished_at"),
        last_error: row.get("last_error"),
    }
}

pub async fn index_wikipedia_article_for_user(
    state: &AppState,
    username: &str,
    article: &WikipediaArticle,
    images: &[WikipediaImage],
) -> AppResult<(i64, usize, PathBuf)> {
    let chunks = chunk_text(&article.content, 900, 150);
    let embeddings = embed_texts_with_fallback(state, &chunks).await;

    let mut tx = state.db.begin().await.map_err(internal_error)?;
    let existing = sqlx::query("SELECT id FROM wiki_articles WHERE username = ? AND title = ?")
        .bind(username)
        .bind(&article.title)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal_error)?;

    let article_id: i64 = if let Some(row) = existing {
        let id: i64 = row.get("id");
        sqlx::query(
            "UPDATE wiki_articles SET url = ?, content = ?, downloaded_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(&article.url)
        .bind(&article.content)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
        sqlx::query("DELETE FROM wiki_chunks WHERE article_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
        sqlx::query("DELETE FROM wiki_images WHERE article_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal_error)?;
        id
    } else {
        let res = sqlx::query(
            "INSERT INTO wiki_articles (username, title, url, content) VALUES (?, ?, ?, ?)",
        )
        .bind(username)
        .bind(&article.title)
        .bind(&article.url)
        .bind(&article.content)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
        res.last_insert_rowid()
    };

    for (idx, (chunk, embedding)) in chunks.iter().zip(embeddings.iter()).enumerate() {
        let embedding_json = serde_json::to_string(embedding).map_err(internal_error)?;
        sqlx::query(
            "INSERT INTO wiki_chunks (article_id, username, chunk_index, text, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(article_id)
        .bind(username)
        .bind(idx as i64)
        .bind(chunk)
        .bind(embedding_json)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
    }

    for image in images {
        sqlx::query(
            "INSERT INTO wiki_images (article_id, username, title, url, thumb_url, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(article_id)
        .bind(username)
        .bind(&image.title)
        .bind(&image.url)
        .bind(&image.thumb_url)
        .bind(image.width)
        .bind(image.height)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
    }

    tx.commit().await.map_err(internal_error)?;

    let wiki_dir = ensure_user_wiki_dir(&state.user_files_dir, username).await?;
    let article_filename = sanitize_storage_name(&article.title);
    let article_path = wiki_dir.join(format!("{article_filename}.txt"));
    tokio::fs::write(&article_path, article.content.as_bytes())
        .await
        .map_err(internal_error)?;

    Ok((article_id, chunks.len(), article_path))
}

async fn fetch_wikipedia_article(
    client: &Client,
    title: &str,
    lang: &str,
) -> AppResult<WikipediaArticle> {
    let endpoint = format!("https://{}.wikipedia.org/w/api.php", lang);
    let resp = client
        .get(&endpoint)
        .query(&[
            ("action", "query"),
            ("format", "json"),
            ("prop", "extracts"),
            ("explaintext", "1"),
            ("redirects", "1"),
            ("titles", title),
        ])
        .send()
        .await
        .map_err(internal_error)?
        .error_for_status()
        .map_err(internal_error)?;

    let payload: Value = resp.json().await.map_err(internal_error)?;
    let pages = payload
        .get("query")
        .and_then(|v| v.get("pages"))
        .and_then(|v| v.as_object())
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "Wikipedia response missing pages"))?;

    let page = pages
        .values()
        .next()
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "Wikipedia article not found"))?;
    let article_title = page
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(title)
        .to_string();
    let extract = page
        .get("extract")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if extract.is_empty() {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            format!("Wikipedia article `{}` has no extract", article_title),
        ));
    }

    let title_slug = article_title.replace(' ', "_");
    let encoded_title = encode(&title_slug);
    Ok(WikipediaArticle {
        title: article_title,
        url: format!("https://{}.wikipedia.org/wiki/{}", lang, encoded_title),
        content: extract,
    })
}

async fn fetch_wikipedia_page_titles(
    client: &Client,
    lang: &str,
    continuation_token: Option<&str>,
    limit: u32,
) -> AppResult<(Vec<String>, Option<String>)> {
    let endpoint = format!("https://{}.wikipedia.org/w/api.php", lang);
    let mut request = client.get(&endpoint).query(&[
        ("action", "query"),
        ("format", "json"),
        ("list", "allpages"),
        ("apnamespace", "0"),
        ("apfilterredir", "nonredirects"),
        ("aplimit", &limit.clamp(1, 50).to_string()),
    ]);
    if let Some(token) = continuation_token {
        request = request.query(&[("apcontinue", token)]);
    }

    let resp = request
        .send()
        .await
        .map_err(internal_error)?
        .error_for_status()
        .map_err(internal_error)?;
    let payload: Value = resp.json().await.map_err(internal_error)?;

    let titles = payload
        .get("query")
        .and_then(|v| v.get("allpages"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("title").and_then(|v| v.as_str()))
                .map(|title| title.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let next = payload
        .get("continue")
        .and_then(|v| v.get("apcontinue"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    Ok((titles, next))
}

async fn fetch_wikipedia_images(
    client: &Client,
    title: &str,
    lang: &str,
    max_images: usize,
) -> AppResult<Vec<WikipediaImage>> {
    let endpoint = format!("https://{}.wikipedia.org/w/api.php", lang);
    let mut all = Vec::new();
    let mut gimcontinue: Option<String> = None;

    while all.len() < max_images {
        let mut request = client.get(&endpoint).query(&[
            ("action", "query"),
            ("format", "json"),
            ("generator", "images"),
            ("titles", title),
            ("prop", "imageinfo"),
            ("iiprop", "url|size"),
            ("iiurlwidth", "1280"),
            ("gimlimit", "50"),
            ("redirects", "1"),
        ]);
        if let Some(next) = gimcontinue.as_deref() {
            request = request.query(&[("gimcontinue", next)]);
        }

        let resp = request
            .send()
            .await
            .map_err(internal_error)?
            .error_for_status()
            .map_err(internal_error)?;

        let payload: Value = resp.json().await.map_err(internal_error)?;
        if let Some(pages) = payload
            .get("query")
            .and_then(|v| v.get("pages"))
            .and_then(|v| v.as_object())
        {
            for page in pages.values() {
                let image_title = page
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if image_title.is_empty() || !supported_wikipedia_image_title(&image_title) {
                    continue;
                }

                let Some(image_info) = page
                    .get("imageinfo")
                    .and_then(|v| v.as_array())
                    .and_then(|items| items.first())
                else {
                    continue;
                };
                let Some(url) = image_info.get("url").and_then(|v| v.as_str()) else {
                    continue;
                };

                all.push(WikipediaImage {
                    title: image_title,
                    url: url.to_string(),
                    thumb_url: image_info
                        .get("thumburl")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string()),
                    width: image_info.get("width").and_then(|v| v.as_i64()),
                    height: image_info.get("height").and_then(|v| v.as_i64()),
                });
                if all.len() >= max_images {
                    break;
                }
            }
        }

        if all.len() >= max_images {
            break;
        }
        gimcontinue = payload
            .get("continue")
            .and_then(|v| v.get("gimcontinue"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        if gimcontinue.is_none() {
            break;
        }
    }

    Ok(all)
}

fn supported_wikipedia_image_title(title: &str) -> bool {
    let lowered = title.to_ascii_lowercase();
    lowered.ends_with(".png")
        || lowered.ends_with(".jpg")
        || lowered.ends_with(".jpeg")
        || lowered.ends_with(".webp")
        || lowered.ends_with(".gif")
        || lowered.ends_with(".svg")
}
