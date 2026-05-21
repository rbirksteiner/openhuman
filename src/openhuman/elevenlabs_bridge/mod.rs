//! ElevenLabs bridge — server-side webhook + custom-LLM endpoints.
//!
//! Exposes three HTTP routes (mounted from `src/core/jsonrpc.rs`):
//!
//! - `POST /elevenlabs/custom-llm`             — OpenAI-compatible chat
//!   completion proxy. ElevenLabs Cloud points its "Custom LLM" agent at
//!   this URL; we dispatch into the OpenHuman orchestrator
//!   (`channel_web_chat`) and stream the response back as OpenAI-format
//!   SSE chunks.
//! - `POST /elevenlabs/tools/current-time`     — returns ISO-8601 now.
//! - `POST /elevenlabs/tools/memory-recall`    — calls
//!   `memory_query_namespace` (default namespace `voice-agent`).
//! - `POST /elevenlabs/tools/memory-store`     — calls `doc_ingest`,
//!   auto-generating a `voice-<ts>` key.
//!
//! Auth: all routes require an `X-ElevenLabs-Secret: <secret>` header
//! matching the `OPENHUMAN_ELEVENLABS_WEBHOOK_SECRET` env var. The shared
//! secret is the **only** thing gating these routes — they intentionally
//! bypass the per-launch `OPENHUMAN_CORE_TOKEN` bearer auth used by
//! `/rpc` and `/v1`, because ElevenLabs Cloud has no way to obtain the
//! per-launch token (which rotates on every core restart in the Tauri
//! path). The two auths are otherwise equivalent — both prove
//! out-of-band knowledge of a server-issued secret.
//!
//! This module is HTTP-only — no JSON-RPC controller surface — so
//! `schemas.rs` is intentionally absent.

pub mod auth;
pub mod ops;
pub mod router;
pub mod types;

pub use router::router as build_elevenlabs_router;
