//! Types for the voice_agent domain.
//!
//! `VoiceAgentConfig` mirrors the `[voice_agent]` TOML section.
//! The input/output structs drive the RPC surface (see `schemas.rs`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// ── Config (mirrors TOML / Config struct field) ──────────────────────────────

/// Per-session configuration for the ElevenLabs Conversational Agent.
///
/// Mounted on [`crate::openhuman::config::Config`] as `voice_agent`.
/// Env-override prefix: `OPENHUMAN_VOICE_AGENT_*`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceAgentConfig {
    /// Whether the voice agent is enabled.
    #[serde(default)]
    pub enabled: bool,

    /// ElevenLabs agent_id override.  `None` → the backend falls back to its
    /// `ELEVENLABS_AGENT_ID` env var (the Phase-0 agent already created there).
    #[serde(default)]
    pub agent_id: Option<String>,

    /// Voice id to request from ElevenLabs TTS.  `None` → the frontend falls
    /// back to `MASCOT_VOICE_ID` (`JBFqnCBsd6RMkjVDRZzb`).
    #[serde(default)]
    pub voice_id: Option<String>,

    /// TTS model id.  Defaults to `"eleven_flash_v2"` (English-only, ~75 ms TTFB).
    #[serde(default = "default_voice_agent_model")]
    pub model: String,

    /// How eagerly the agent grabs the turn.
    /// One of `"patient"` | `"normal"` | `"eager"`.  Defaults to `"normal"`.
    #[serde(default = "default_turn_eagerness")]
    pub turn_eagerness: String,

    /// Whether the client should reconnect automatically on session loss.
    #[serde(default = "yes")]
    pub auto_reconnect: bool,
}

impl Default for VoiceAgentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            agent_id: None,
            voice_id: None,
            model: default_voice_agent_model(),
            turn_eagerness: default_turn_eagerness(),
            auto_reconnect: yes(),
        }
    }
}

pub(crate) fn default_voice_agent_model() -> String {
    "eleven_flash_v2".to_string()
}

pub(crate) fn default_turn_eagerness() -> String {
    "normal".to_string()
}

pub(crate) fn yes() -> bool {
    true
}

// ── RPC input / output structs ────────────────────────────────────────────────

/// Output of `openhuman.voice_agent_get_signed_url`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedUrlOutput {
    pub ok: bool,
    pub signed_url: String,
    /// Unix seconds at which the signed URL expires (0 on failure).
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Input for `openhuman.voice_agent_get_signed_url`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GetSignedUrlInput {
    /// Optional agent_id override; falls back to `config.voice_agent.agent_id`
    /// (and ultimately to the backend's `ELEVENLABS_AGENT_ID`).
    pub agent_id: Option<String>,
}

/// Output of `openhuman.voice_agent_config_get`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAgentConfigGetOutput {
    pub enabled: bool,
    pub agent_id: Option<String>,
    pub voice_id: Option<String>,
    pub model: String,
    pub turn_eagerness: String,
    pub auto_reconnect: bool,
}

impl From<&VoiceAgentConfig> for VoiceAgentConfigGetOutput {
    fn from(cfg: &VoiceAgentConfig) -> Self {
        Self {
            enabled: cfg.enabled,
            agent_id: cfg.agent_id.clone(),
            voice_id: cfg.voice_id.clone(),
            model: cfg.model.clone(),
            turn_eagerness: cfg.turn_eagerness.clone(),
            auto_reconnect: cfg.auto_reconnect,
        }
    }
}

/// Input for `openhuman.voice_agent_config_set` (all fields optional — partial
/// update semantics).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VoiceAgentConfigSetInput {
    pub enabled: Option<bool>,
    pub agent_id: Option<String>,
    pub voice_id: Option<String>,
    pub model: Option<String>,
    pub turn_eagerness: Option<String>,
    pub auto_reconnect: Option<bool>,
}

/// Output of `openhuman.voice_agent_config_set`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAgentConfigSetOutput {
    pub ok: bool,
    pub config: VoiceAgentConfigGetOutput,
}

/// Input for `openhuman.voice_agent_session_started`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStartedInput {
    pub conversation_id: String,
    pub agent_id: String,
}

/// Input for `openhuman.voice_agent_session_ended`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEndedInput {
    pub conversation_id: String,
    pub duration_ms: u64,
    pub turn_count: u32,
    /// One of: `"user_closed"` | `"error"` | `"fallback"` | `"expired"`.
    pub end_reason: String,
}

/// Generic `{ ok: bool }` output for telemetry methods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OkOutput {
    pub ok: bool,
}

/// Backend JSON shape for the signed-URL response.
#[derive(Debug, Clone, Deserialize)]
pub struct SignedUrlResponse {
    pub signed_url: String,
    pub expires_at: u64,
}
