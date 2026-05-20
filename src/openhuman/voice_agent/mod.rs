//! Voice-agent domain — ElevenLabs Conversational Agent integration.
//!
//! Exposes five JSON-RPC methods:
//! - `openhuman.voice_agent_get_signed_url`
//! - `openhuman.voice_agent_config_get`
//! - `openhuman.voice_agent_config_set`
//! - `openhuman.voice_agent_session_started`
//! - `openhuman.voice_agent_session_ended`
//!
//! Configuration lives under `[voice_agent]` in `config.toml`.
//! Env-override prefix: `OPENHUMAN_VOICE_AGENT_*`.

pub mod ops;
pub mod schemas;
pub mod types;

pub use schemas::{
    all_controller_schemas as all_voice_agent_controller_schemas,
    all_registered_controllers as all_voice_agent_registered_controllers,
};
