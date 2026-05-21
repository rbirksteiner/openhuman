//! Wire types for the ElevenLabs bridge routes.
//!
//! The custom-LLM endpoint speaks the OpenAI Chat Completions protocol —
//! request body shape, response chunk shape. We duplicate (rather than
//! reuse) `openhuman::inference::http::types` to keep the bridge a small,
//! self-contained surface area: ElevenLabs's Custom-LLM contract is a
//! moving target separate from the user-facing `/v1` API, and we want to
//! be able to evolve them independently.

use serde::{Deserialize, Serialize};

// ── /elevenlabs/custom-llm — request ────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CustomLlmRequest {
    /// Model id requested by ElevenLabs. Ignored — we always dispatch
    /// into the orchestrator, which picks the model from its own
    /// configuration. Field retained so JSON-deserialisation succeeds
    /// on the OpenAI-shape payload.
    #[serde(default)]
    pub model: Option<String>,

    /// The chat history.  The last user-role message is the new prompt;
    /// everything before is conversation context the agent has heard
    /// itself say or the user say.
    #[serde(default)]
    pub messages: Vec<CustomLlmMessage>,

    /// Always `true` from ElevenLabs Cloud. Accepted for completeness.
    #[serde(default = "default_stream")]
    pub stream: bool,

    /// Optional client-supplied conversation identifier.  When present
    /// we use it as the OpenHuman thread id so multi-turn conversations
    /// reuse the same agent session.  When absent we hash the message
    /// list (best-effort stable id).
    #[serde(default)]
    pub user: Option<String>,
}

fn default_stream() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct CustomLlmMessage {
    pub role: String,
    pub content: String,
}

// ── /elevenlabs/custom-llm — SSE chunk wire format ──────────────────────────

#[derive(Debug, Serialize)]
pub struct OpenAiChunk {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub model: String,
    pub choices: Vec<OpenAiChunkChoice>,
}

#[derive(Debug, Serialize)]
pub struct OpenAiChunkChoice {
    pub index: u32,
    pub delta: OpenAiChunkDelta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<&'static str>,
}

#[derive(Debug, Serialize, Default)]
pub struct OpenAiChunkDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

// ── /elevenlabs/tools/* — tool route wire shapes ────────────────────────────

#[derive(Debug, Deserialize, Default)]
pub struct CurrentTimeRequest {}

#[derive(Debug, Deserialize)]
pub struct MemoryRecallRequest {
    pub query: String,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MemoryStoreRequest {
    pub note: String,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ToolResultEnvelope<T: Serialize> {
    pub result: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

// ── Defaults ────────────────────────────────────────────────────────────────

/// Default namespace for memory-store / memory-recall tools.
pub const DEFAULT_VOICE_NAMESPACE: &str = "voice-agent";

/// Static client_id used when dispatching ElevenLabs-originated chats
/// into `channel_web_chat`.  The web channel partitions in-flight
/// requests by `(client_id, thread_id)` so we need a stable label —
/// using a fixed string is sufficient because the thread_id (derived
/// from ElevenLabs's `conversation_id`) already disambiguates.
pub const ELEVENLABS_CLIENT_ID: &str = "elevenlabs-custom-llm";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_llm_request_accepts_minimal_body() {
        let json = serde_json::json!({
            "model": "openhuman",
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": true,
        });
        let parsed: CustomLlmRequest = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.messages.len(), 1);
        assert_eq!(parsed.messages[0].role, "user");
        assert!(parsed.stream);
    }

    #[test]
    fn custom_llm_request_defaults_stream_to_true() {
        let json = serde_json::json!({ "messages": [] });
        let parsed: CustomLlmRequest = serde_json::from_value(json).unwrap();
        assert!(parsed.stream);
        assert!(parsed.user.is_none());
    }

    #[test]
    fn memory_recall_request_namespace_optional() {
        let json = serde_json::json!({ "query": "what did I say about X" });
        let parsed: MemoryRecallRequest = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.query, "what did I say about X");
        assert!(parsed.namespace.is_none());
    }

    #[test]
    fn memory_store_request_parses() {
        let json = serde_json::json!({ "note": "remember X", "namespace": "custom-ns" });
        let parsed: MemoryStoreRequest = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.note, "remember X");
        assert_eq!(parsed.namespace.as_deref(), Some("custom-ns"));
    }
}
