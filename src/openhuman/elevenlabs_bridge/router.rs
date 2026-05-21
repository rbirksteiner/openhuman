//! Axum sub-router for the ElevenLabs bridge.
//!
//! Mounted from `src/core/jsonrpc.rs` via `.nest("/elevenlabs", router())`.
//! All routes pass the shared-secret middleware before reaching the
//! handlers in `ops`.

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{from_fn, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};

use crate::core::types::AppState;

use super::auth::verify_request;
use super::ops;
use super::types::{CustomLlmRequest, MemoryRecallRequest, MemoryStoreRequest};

/// Build the `/elevenlabs` axum sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        // ElevenLabs Cloud follows the OpenAI Custom-LLM convention: the
        // configured URL is the *base*, and the client appends
        // `/chat/completions` to it before POSTing. Register both the raw
        // and the appended path so the same handler answers either form.
        .route("/custom-llm", post(custom_llm_handler))
        .route("/custom-llm/chat/completions", post(custom_llm_handler))
        .route("/tools/current-time", post(current_time_handler))
        .route("/tools/memory-recall", post(memory_recall_handler))
        .route("/tools/memory-store", post(memory_store_handler))
        .layer(from_fn(shared_secret_layer))
}

/// Middleware that runs the shared-secret check before any handler.
async fn shared_secret_layer(req: Request, next: Next) -> Response {
    if let Err(resp) = verify_request(req.headers()) {
        return resp;
    }
    next.run(req).await
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn custom_llm_handler(
    body: Result<Json<CustomLlmRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(j) => j,
        Err(err) => return bad_request(&err.to_string()),
    };
    ops::custom_llm_stream(req).await
}

async fn current_time_handler() -> Response {
    ops::current_time().await
}

async fn memory_recall_handler(
    body: Result<Json<MemoryRecallRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(j) => j,
        Err(err) => return bad_request(&err.to_string()),
    };
    ops::memory_recall(req).await
}

async fn memory_store_handler(
    body: Result<Json<MemoryStoreRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(j) => j,
        Err(err) => return bad_request(&err.to_string()),
    };
    ops::memory_store(req).await
}

fn bad_request(reason: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "ok": false,
            "error": "bad_request",
            "reason": reason,
        })),
    )
        .into_response()
}
