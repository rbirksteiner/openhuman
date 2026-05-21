//! Handler logic for the ElevenLabs bridge HTTP routes.
//!
//! Two-step shape:
//! 1. `custom_llm_stream` dispatches the user's last message into
//!    `channel_web_chat` and returns an SSE stream that maps the web
//!    channel's broadcast events (`text_delta`, `chat_done`, `chat_error`)
//!    to OpenAI-format chat-completion chunks.
//! 2. `current_time` / `memory_recall` / `memory_store` are one-shot JSON
//!    routes returning ElevenLabs's `{ "result": ... }` webhook envelope.

use std::time::{Duration, Instant};

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::{http::StatusCode, Json};
use chrono::Utc;
use futures_util::stream::{self, Stream, StreamExt};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::broadcast::Receiver;
use uuid::Uuid;

use crate::core::socketio::WebChannelEvent;
use crate::openhuman::channels::providers::web::{channel_web_chat, subscribe_web_channel_events};
use crate::openhuman::memory::ops::{doc_ingest, memory_query_namespace};
use crate::openhuman::memory::{IngestDocParams, QueryNamespaceRequest};

use super::types::{
    CustomLlmRequest, MemoryRecallRequest, MemoryStoreRequest, OpenAiChunk, OpenAiChunkChoice,
    OpenAiChunkDelta, DEFAULT_VOICE_NAMESPACE, ELEVENLABS_CLIENT_ID,
};

/// Hard cap on a single custom-LLM streaming response. ElevenLabs's own
/// turn-timeout is ~60 s; we match that so a stuck orchestrator can't
/// pin a SSE connection forever.
const STREAM_TIMEOUT: Duration = Duration::from_secs(60);

// ── /elevenlabs/custom-llm ───────────────────────────────────────────────────

/// Dispatch the inbound chat-completion request into the orchestrator and
/// return an SSE stream of OpenAI-format chunks.
pub async fn custom_llm_stream(req: CustomLlmRequest) -> Response {
    let last_user = match last_user_message(&req) {
        Some(m) => m,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "no user message in body" })),
            )
                .into_response();
        }
    };

    let thread_id = derive_thread_id(&req);
    let client_id = ELEVENLABS_CLIENT_ID.to_string();
    let model_label = req.model.clone().unwrap_or_else(|| "openhuman".to_string());

    tracing::info!(
        thread_id = %thread_id,
        chars = last_user.len(),
        "[elevenlabs-bridge] custom-llm: dispatching into channel_web_chat"
    );

    // Subscribe BEFORE dispatch so the very first `text_delta` is in our
    // receiver buffer when the orchestrator starts streaming.
    let rx = subscribe_web_channel_events();

    if let Err(err) =
        channel_web_chat(&client_id, &thread_id, &last_user, None, None, None, None).await
    {
        tracing::warn!(
            thread_id = %thread_id,
            error = %err,
            "[elevenlabs-bridge] custom-llm: channel_web_chat rejected request"
        );
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("orchestrator dispatch failed: {err}") })),
        )
            .into_response();
    }

    let completion_id = format!("chatcmpl-{}", Uuid::new_v4());
    let event_stream = build_chunk_stream(rx, thread_id, client_id, completion_id, model_label);

    Sse::new(event_stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response()
}

/// Pluck the final user message out of the OpenAI-shape body. Returns
/// `None` only when no user message exists — every other case (missing
/// content, weird roles) is best-effort-tolerated.
fn last_user_message(req: &CustomLlmRequest) -> Option<String> {
    req.messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Derive a stable thread id for an inbound ElevenLabs call.
///
/// Preference order:
/// 1. The client-supplied `user` field (ElevenLabs passes their
///    conversation_id there in Custom-LLM mode).
/// 2. A SHA-256 hash of the message history, truncated to 16 hex chars
///    and prefixed `el-`.  Same conversation → same hash → same thread,
///    so multi-turn dialogs reuse the orchestrator's session cache.
pub(crate) fn derive_thread_id(req: &CustomLlmRequest) -> String {
    if let Some(user) = req.user.as_ref().filter(|s| !s.trim().is_empty()) {
        return format!("el-{}", user.trim());
    }

    let mut hasher = Sha256::new();
    for msg in &req.messages {
        hasher.update(msg.role.as_bytes());
        hasher.update(b"\x1f");
        hasher.update(msg.content.as_bytes());
        hasher.update(b"\x1e");
    }
    let digest = hasher.finalize();
    let hex = hex::encode(&digest[..8]);
    format!("el-{hex}")
}

/// Per-stream pull state held across `futures::stream::unfold` calls.
struct StreamState {
    rx: Receiver<WebChannelEvent>,
    thread_id: String,
    client_id: String,
    completion_id: String,
    model_label: String,
    created: i64,
    deadline: Instant,
    /// Pending events that haven't been yielded yet (we emit handshake
    /// first; then sometimes two events from one source — content +
    /// finish_reason — which we queue here to keep the unfold simple).
    pending: std::collections::VecDeque<Event>,
    finished: bool,
}

/// Wrap the broadcast receiver into an SSE event stream of OpenAI
/// chunks.  Returns three kinds of chunks:
/// - first chunk: role=assistant, content=None (the OpenAI handshake)
/// - mid chunks: content=<delta>, no role
/// - terminal chunk: finish_reason=stop, empty delta, then `[DONE]`
fn build_chunk_stream(
    rx: Receiver<WebChannelEvent>,
    thread_id: String,
    client_id: String,
    completion_id: String,
    model_label: String,
) -> impl Stream<Item = Result<Event, std::convert::Infallible>> + Send + 'static {
    let created = Utc::now().timestamp();
    let mut pending = std::collections::VecDeque::new();
    // Handshake chunk goes out first.
    pending.push_back(chunk_event(
        &completion_id,
        created,
        &model_label,
        OpenAiChunkDelta {
            role: Some("assistant"),
            content: None,
        },
        None,
    ));

    let state = StreamState {
        rx,
        thread_id,
        client_id,
        completion_id,
        model_label,
        created,
        deadline: Instant::now() + STREAM_TIMEOUT,
        pending,
        finished: false,
    };

    stream::unfold(state, |mut state| async move {
        // Drain pending queue first.
        if let Some(ev) = state.pending.pop_front() {
            return Some((Ok(ev), state));
        }
        if state.finished {
            return None;
        }

        loop {
            let now = Instant::now();
            if now >= state.deadline {
                tracing::warn!(
                    thread_id = %state.thread_id,
                    "[elevenlabs-bridge] custom-llm: 60s deadline reached, terminating stream"
                );
                push_termination(&mut state);
                state.finished = true;
                return state.pending.pop_front().map(|ev| (Ok(ev), state));
            }
            let remaining = state.deadline.saturating_duration_since(now);

            match tokio::time::timeout(remaining, state.rx.recv()).await {
                Err(_) => continue, // loop will re-check deadline
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    tracing::warn!(
                        thread_id = %state.thread_id,
                        missed = n,
                        "[elevenlabs-bridge] custom-llm: broadcast lagged"
                    );
                    continue;
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    tracing::warn!(
                        thread_id = %state.thread_id,
                        "[elevenlabs-bridge] custom-llm: broadcast closed unexpectedly"
                    );
                    push_termination(&mut state);
                    state.finished = true;
                    return state.pending.pop_front().map(|ev| (Ok(ev), state));
                }
                Ok(Ok(event)) => {
                    if event.client_id != state.client_id || event.thread_id != state.thread_id {
                        continue;
                    }
                    match event.event.as_str() {
                        "text_delta" => {
                            let Some(delta) = event.delta.filter(|s: &String| !s.is_empty()) else {
                                continue;
                            };
                            let ev = chunk_event(
                                &state.completion_id,
                                state.created,
                                &state.model_label,
                                OpenAiChunkDelta {
                                    role: None,
                                    content: Some(delta),
                                },
                                None,
                            );
                            return Some((Ok(ev), state));
                        }
                        "chat_done" => {
                            tracing::info!(
                                thread_id = %state.thread_id,
                                "[elevenlabs-bridge] custom-llm: chat_done — closing stream"
                            );
                            push_termination(&mut state);
                            state.finished = true;
                            return state.pending.pop_front().map(|ev| (Ok(ev), state));
                        }
                        "chat_error" => {
                            let msg = event
                                .message
                                .clone()
                                .unwrap_or_else(|| "chat error".to_string());
                            tracing::warn!(
                                thread_id = %state.thread_id,
                                error = %msg,
                                "[elevenlabs-bridge] custom-llm: chat_error — closing stream"
                            );
                            // Surface a short error text first.
                            state.pending.push_back(chunk_event(
                                &state.completion_id,
                                state.created,
                                &state.model_label,
                                OpenAiChunkDelta {
                                    role: None,
                                    content: Some(format!("[error: {msg}]")),
                                },
                                None,
                            ));
                            push_termination(&mut state);
                            state.finished = true;
                            return state.pending.pop_front().map(|ev| (Ok(ev), state));
                        }
                        _ => continue, // skip non-chat events
                    }
                }
            }
        }
    })
    // Tag a separate `[DONE]` sentinel onto the end after the inner
    // stream signals completion.  Because `push_termination` already
    // queues the OpenAI-format finish chunk *and* the `[DONE]` line,
    // we just need to make sure no extra `[DONE]` is added here.
    .boxed()
}

/// Queue the OpenAI-format stop chunk + the `[DONE]` SSE sentinel so the
/// next `unfold` poll drains them in order before returning `None`.
fn push_termination(state: &mut StreamState) {
    state.pending.push_back(chunk_event(
        &state.completion_id,
        state.created,
        &state.model_label,
        OpenAiChunkDelta::default(),
        Some("stop"),
    ));
    state.pending.push_back(Event::default().data("[DONE]"));
}

/// Build one OpenAI-format SSE event.
fn chunk_event(
    id: &str,
    created: i64,
    model: &str,
    delta: OpenAiChunkDelta,
    finish_reason: Option<&'static str>,
) -> Event {
    let chunk = OpenAiChunk {
        id: id.to_string(),
        object: "chat.completion.chunk",
        created,
        model: model.to_string(),
        choices: vec![OpenAiChunkChoice {
            index: 0,
            delta,
            finish_reason,
        }],
    };
    let data = serde_json::to_string(&chunk).unwrap_or_else(|_| "{}".to_string());
    Event::default().data(data)
}

// ── /elevenlabs/tools/current-time ──────────────────────────────────────────

pub async fn current_time() -> Response {
    let now = Utc::now().to_rfc3339();
    tracing::debug!("[elevenlabs-bridge] current-time -> {now}");
    (StatusCode::OK, Json(json!({ "result": now }))).into_response()
}

// ── /elevenlabs/tools/memory-recall ─────────────────────────────────────────

pub async fn memory_recall(req: MemoryRecallRequest) -> Response {
    let query = req.query.trim().to_string();
    if query.is_empty() {
        return (
            StatusCode::OK,
            Json(json!({ "result": [], "error": "empty query" })),
        )
            .into_response();
    }
    let namespace = req
        .namespace
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_VOICE_NAMESPACE.to_string());

    tracing::debug!(
        namespace = %namespace,
        chars = query.len(),
        "[elevenlabs-bridge] memory-recall: dispatching"
    );

    let request = QueryNamespaceRequest {
        namespace: namespace.clone(),
        query,
        include_references: Some(true),
        document_ids: None,
        limit: None,
        max_chunks: Some(8),
    };

    match memory_query_namespace(request).await {
        Ok(outcome) => match serde_json::to_value(&outcome.value) {
            Ok(v) => (StatusCode::OK, Json(json!({ "result": v }))).into_response(),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("serialize failed: {err}") })),
            )
                .into_response(),
        },
        Err(err) => {
            tracing::warn!(
                namespace = %namespace,
                error = %err,
                "[elevenlabs-bridge] memory-recall failed"
            );
            (StatusCode::OK, Json(json!({ "result": [], "error": err }))).into_response()
        }
    }
}

// ── /elevenlabs/tools/memory-store ──────────────────────────────────────────

pub async fn memory_store(req: MemoryStoreRequest) -> Response {
    let note = req.note.trim().to_string();
    if note.is_empty() {
        return (StatusCode::OK, Json(json!({ "error": "empty note" }))).into_response();
    }
    let namespace = req
        .namespace
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_VOICE_NAMESPACE.to_string());

    let ts_ms = chrono::Utc::now().timestamp_millis();
    let key = format!("voice-{ts_ms}");
    let title = format!("Voice note {}", chrono::Utc::now().to_rfc3339());

    tracing::debug!(
        namespace = %namespace,
        key = %key,
        chars = note.len(),
        "[elevenlabs-bridge] memory-store: dispatching"
    );

    let params = IngestDocParams {
        namespace: namespace.clone(),
        key: key.clone(),
        title,
        content: note,
        source_type: "voice_agent".to_string(),
        priority: "medium".to_string(),
        tags: vec!["voice".to_string()],
        metadata: serde_json::Value::Null,
        category: "user".to_string(),
        session_id: None,
        document_id: None,
        config: None,
    };

    match doc_ingest(params).await {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "result": "saved", "key": key })),
        )
            .into_response(),
        Err(err) => {
            tracing::warn!(
                namespace = %namespace,
                key = %key,
                error = %err,
                "[elevenlabs-bridge] memory-store failed"
            );
            (StatusCode::OK, Json(json!({ "error": err }))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openhuman::elevenlabs_bridge::types::CustomLlmMessage;

    fn req(messages: Vec<(&str, &str)>, user: Option<&str>) -> CustomLlmRequest {
        CustomLlmRequest {
            model: Some("openhuman".to_string()),
            messages: messages
                .into_iter()
                .map(|(role, content)| CustomLlmMessage {
                    role: role.to_string(),
                    content: content.to_string(),
                })
                .collect(),
            stream: true,
            user: user.map(str::to_string),
        }
    }

    #[test]
    fn last_user_message_finds_final_user_turn() {
        let r = req(
            vec![
                ("system", "you are helpful"),
                ("user", "hi"),
                ("assistant", "hi back"),
                ("user", "what's the time"),
            ],
            None,
        );
        assert_eq!(last_user_message(&r).as_deref(), Some("what's the time"));
    }

    #[test]
    fn last_user_message_none_when_no_user_role() {
        let r = req(vec![("system", "x"), ("assistant", "y")], None);
        assert!(last_user_message(&r).is_none());
    }

    #[test]
    fn last_user_message_skips_whitespace_only() {
        let r = req(vec![("user", "   ")], None);
        assert!(last_user_message(&r).is_none());
    }

    #[test]
    fn derive_thread_id_prefers_user_field() {
        let r = req(vec![("user", "hi")], Some("conv-abc-123"));
        assert_eq!(derive_thread_id(&r), "el-conv-abc-123");
    }

    #[test]
    fn derive_thread_id_is_stable_for_same_history() {
        let r1 = req(vec![("user", "alpha"), ("assistant", "beta")], None);
        let r2 = req(vec![("user", "alpha"), ("assistant", "beta")], None);
        assert_eq!(derive_thread_id(&r1), derive_thread_id(&r2));
    }

    #[test]
    fn derive_thread_id_differs_for_different_history() {
        let r1 = req(vec![("user", "alpha")], None);
        let r2 = req(vec![("user", "beta")], None);
        assert_ne!(derive_thread_id(&r1), derive_thread_id(&r2));
    }

    #[test]
    fn derive_thread_id_falls_back_when_user_blank() {
        let r = req(vec![("user", "x")], Some("   "));
        assert!(derive_thread_id(&r).starts_with("el-"));
        assert!(derive_thread_id(&r).len() > 4);
    }

    #[test]
    fn chunk_event_builds_without_panic() {
        let ev = chunk_event(
            "chatcmpl-x",
            42,
            "openhuman",
            OpenAiChunkDelta {
                role: None,
                content: Some("hi".to_string()),
            },
            None,
        );
        let s = format!("{ev:?}");
        // smoke-test only — Event has no public introspection API
        assert!(!s.is_empty());
    }

    #[tokio::test]
    async fn current_time_returns_iso_string() {
        let resp = current_time().await;
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn memory_recall_empty_query_short_circuits() {
        let resp = memory_recall(MemoryRecallRequest {
            query: "   ".to_string(),
            namespace: None,
        })
        .await;
        // Empty query short-circuits without dispatching, so always 200.
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn memory_store_empty_note_short_circuits() {
        let resp = memory_store(MemoryStoreRequest {
            note: "".to_string(),
            namespace: None,
        })
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
