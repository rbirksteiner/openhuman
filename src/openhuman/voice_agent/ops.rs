//! Pure operation functions for the voice_agent domain.
//!
//! Entry points called from `schemas.rs` handlers.  All HTTP is done
//! through the existing `IntegrationClient` (same bearer + backend URL
//! used for `/openai/v1/audio/speech` and Composio calls).

use std::time::Instant;

use serde_json::json;

use crate::core::event_bus::{publish_global, DomainEvent};
use crate::openhuman::config::rpc as config_rpc;
use crate::openhuman::integrations;

use super::types::{
    GetSignedUrlInput, OkOutput, SessionEndedInput, SessionStartedInput, SignedUrlOutput,
    VoiceAgentConfigGetOutput, VoiceAgentConfigSetInput, VoiceAgentConfigSetOutput,
};

// ── signed-url ────────────────────────────────────────────────────────────────

/// Fetch a signed ElevenLabs WebSocket URL via the OpenHuman backend.
///
/// Route: `POST /api/v1/elevenlabs/signed-url`.
/// On backend 401 → publishes `SessionExpired` and returns `ok: false`.
/// On backend 404 / 502 (route not yet deployed) → publishes `VoiceAgentError`
/// and returns `ok: false`.
pub async fn get_signed_url(input: GetSignedUrlInput) -> Result<SignedUrlOutput, String> {
    tracing::debug!(
        agent_id = ?input.agent_id,
        "[voice_agent] get_signed_url: entry"
    );

    let config = config_rpc::load_config_with_timeout()
        .await
        .map_err(|e| format!("[voice_agent] failed to load config: {e}"))?;

    // Resolve agent_id: input override → config → None (backend uses its env default).
    let agent_id = input
        .agent_id
        .or_else(|| config.voice_agent.agent_id.clone());

    let client = match integrations::client::build_client(&config) {
        Some(c) => c,
        None => {
            tracing::warn!("[voice_agent] get_signed_url: no auth token — user not signed in");
            return Ok(SignedUrlOutput {
                ok: false,
                signed_url: String::new(),
                expires_at: 0,
                error: Some("not_authenticated".to_string()),
            });
        }
    };

    let body = if let Some(id) = &agent_id {
        json!({ "agent_id": id })
    } else {
        json!({})
    };

    tracing::debug!(
        agent_id = ?agent_id,
        backend_url = %client.backend_url,
        "[voice_agent] get_signed_url: calling backend POST /api/v1/elevenlabs/signed-url"
    );

    let started = Instant::now();
    let result: Result<super::types::SignedUrlResponse, anyhow::Error> =
        client.post("/api/v1/elevenlabs/signed-url", &body).await;
    let elapsed_ms = started.elapsed().as_millis();

    match result {
        Ok(resp) => {
            tracing::debug!(
                elapsed_ms = %elapsed_ms,
                expires_at = %resp.expires_at,
                "[voice_agent] get_signed_url: success"
            );
            Ok(SignedUrlOutput {
                ok: true,
                signed_url: resp.signed_url,
                expires_at: resp.expires_at,
                error: None,
            })
        }
        Err(e) => {
            let err_str = e.to_string();
            tracing::warn!(
                elapsed_ms = %elapsed_ms,
                error = %err_str,
                "[voice_agent] get_signed_url: backend call failed"
            );

            // Classify the error by inspecting the message text.
            if err_str.contains("401") || err_str.contains("Unauthorized") {
                tracing::warn!("[voice_agent] get_signed_url: 401 → publishing SessionExpired");
                publish_global(DomainEvent::SessionExpired {
                    source: "voice_agent.signed_url".to_string(),
                    reason: format!("backend returned 401: {err_str}"),
                });
                Ok(SignedUrlOutput {
                    ok: false,
                    signed_url: String::new(),
                    expires_at: 0,
                    error: Some("session_expired".to_string()),
                })
            } else {
                // 404 (route not yet deployed) or 502 (backend unavailable).
                let message = if err_str.contains("404") {
                    "backend route not yet deployed".to_string()
                } else if err_str.contains("502") || err_str.contains("503") {
                    "backend unavailable".to_string()
                } else {
                    err_str.clone()
                };

                publish_global(DomainEvent::VoiceAgentError {
                    conversation_id: String::new(),
                    message: message.clone(),
                });

                Ok(SignedUrlOutput {
                    ok: false,
                    signed_url: String::new(),
                    expires_at: 0,
                    error: Some(message),
                })
            }
        }
    }
}

// ── config get ────────────────────────────────────────────────────────────────

/// Return the current `voice_agent` config section.
pub async fn config_get() -> Result<VoiceAgentConfigGetOutput, String> {
    tracing::debug!("[voice_agent] config_get: entry");
    let config = config_rpc::load_config_with_timeout()
        .await
        .map_err(|e| format!("[voice_agent] failed to load config: {e}"))?;
    let out = VoiceAgentConfigGetOutput::from(&config.voice_agent);
    tracing::debug!(
        enabled = %out.enabled,
        model = %out.model,
        "[voice_agent] config_get: exit"
    );
    Ok(out)
}

// ── config set ────────────────────────────────────────────────────────────────

/// Apply a partial patch to the `voice_agent` config section and persist.
pub async fn config_set(input: VoiceAgentConfigSetInput) -> Result<VoiceAgentConfigSetOutput, String> {
    tracing::debug!(?input, "[voice_agent] config_set: entry");

    let mut config = config_rpc::load_config_with_timeout()
        .await
        .map_err(|e| format!("[voice_agent] failed to load config: {e}"))?;

    // Partial-update: only sent fields get written.
    if let Some(v) = input.enabled {
        config.voice_agent.enabled = v;
    }
    if let Some(v) = input.agent_id {
        config.voice_agent.agent_id = if v.trim().is_empty() { None } else { Some(v) };
    }
    if let Some(v) = input.voice_id {
        config.voice_agent.voice_id = if v.trim().is_empty() { None } else { Some(v) };
    }
    if let Some(v) = input.model {
        if !v.trim().is_empty() {
            config.voice_agent.model = v;
        }
    }
    if let Some(v) = input.turn_eagerness {
        if !v.trim().is_empty() {
            config.voice_agent.turn_eagerness = v;
        }
    }
    if let Some(v) = input.auto_reconnect {
        config.voice_agent.auto_reconnect = v;
    }

    // Persist to TOML.
    config
        .save()
        .await
        .map_err(|e| format!("[voice_agent] failed to save config: {e}"))?;

    let out = VoiceAgentConfigGetOutput::from(&config.voice_agent);
    tracing::debug!(
        enabled = %out.enabled,
        model = %out.model,
        "[voice_agent] config_set: persisted"
    );

    Ok(VoiceAgentConfigSetOutput { ok: true, config: out })
}

// ── telemetry ─────────────────────────────────────────────────────────────────

/// Record that a voice-agent WebSocket session has started.
pub async fn session_started(input: SessionStartedInput) -> Result<OkOutput, String> {
    tracing::debug!(
        conversation_id = %input.conversation_id,
        agent_id = %input.agent_id,
        "[voice_agent] session_started"
    );
    publish_global(DomainEvent::VoiceAgentSessionStarted {
        conversation_id: input.conversation_id,
    });
    Ok(OkOutput { ok: true })
}

/// Record that a voice-agent WebSocket session has ended.
pub async fn session_ended(input: SessionEndedInput) -> Result<OkOutput, String> {
    tracing::debug!(
        conversation_id = %input.conversation_id,
        duration_ms = %input.duration_ms,
        turn_count = %input.turn_count,
        end_reason = %input.end_reason,
        "[voice_agent] session_ended"
    );
    publish_global(DomainEvent::VoiceAgentSessionEnded {
        conversation_id: input.conversation_id,
        duration_ms: input.duration_ms,
        turn_count: input.turn_count,
    });
    Ok(OkOutput { ok: true })
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::types::{VoiceAgentConfig, VoiceAgentConfigSetInput};
    use super::super::types::{default_voice_agent_model, default_turn_eagerness, yes};

    // ── VoiceAgentConfig defaults ────────────────────────────────────

    #[test]
    fn voice_agent_config_default_values() {
        let cfg = VoiceAgentConfig::default();
        assert!(!cfg.enabled, "enabled should default to false");
        assert!(cfg.agent_id.is_none(), "agent_id should default to None");
        assert!(cfg.voice_id.is_none(), "voice_id should default to None");
        assert_eq!(cfg.model, "eleven_flash_v2");
        assert_eq!(cfg.turn_eagerness, "normal");
        assert!(cfg.auto_reconnect, "auto_reconnect should default to true");
    }

    #[test]
    fn voice_agent_config_round_trips_through_toml() {
        let original = VoiceAgentConfig {
            enabled: true,
            agent_id: Some("agent_test123".to_string()),
            voice_id: Some("voice_abc".to_string()),
            model: "eleven_flash_v2".to_string(),
            turn_eagerness: "eager".to_string(),
            auto_reconnect: false,
        };

        let toml_str = toml::to_string(&original).expect("serialize to TOML");
        let parsed: VoiceAgentConfig = toml::from_str(&toml_str).expect("parse from TOML");

        assert_eq!(parsed.enabled, original.enabled);
        assert_eq!(parsed.agent_id, original.agent_id);
        assert_eq!(parsed.voice_id, original.voice_id);
        assert_eq!(parsed.model, original.model);
        assert_eq!(parsed.turn_eagerness, original.turn_eagerness);
        assert_eq!(parsed.auto_reconnect, original.auto_reconnect);
    }

    #[test]
    fn voice_agent_config_parses_with_all_defaults_from_empty_toml() {
        // An empty [voice_agent] section (or missing entirely) should produce
        // all default values — every field has #[serde(default)].
        let cfg: VoiceAgentConfig = toml::from_str("").expect("parse empty TOML");
        assert!(!cfg.enabled);
        assert_eq!(cfg.model, default_voice_agent_model());
        assert_eq!(cfg.turn_eagerness, default_turn_eagerness());
        assert_eq!(cfg.auto_reconnect, yes());
    }

    // ── partial config_set logic ─────────────────────────────────────

    /// Simulate the field-patching logic from `config_set` without touching the
    /// file system: apply an input to a base config and verify untouched fields
    /// are preserved.
    #[test]
    fn config_set_partial_update_preserves_untouched_fields() {
        let mut cfg = VoiceAgentConfig {
            enabled: false,
            agent_id: Some("old_agent".to_string()),
            voice_id: Some("old_voice".to_string()),
            model: "eleven_flash_v2".to_string(),
            turn_eagerness: "patient".to_string(),
            auto_reconnect: true,
        };

        // Only flip `enabled` and change `model`; everything else should be intact.
        let input = VoiceAgentConfigSetInput {
            enabled: Some(true),
            model: Some("eleven_flash_v2".to_string()),
            agent_id: None,
            voice_id: None,
            turn_eagerness: None,
            auto_reconnect: None,
        };

        if let Some(v) = input.enabled {
            cfg.enabled = v;
        }
        if let Some(v) = input.agent_id {
            cfg.agent_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.voice_id {
            cfg.voice_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.model {
            if !v.trim().is_empty() {
                cfg.model = v;
            }
        }
        if let Some(v) = input.turn_eagerness {
            if !v.trim().is_empty() {
                cfg.turn_eagerness = v;
            }
        }
        if let Some(v) = input.auto_reconnect {
            cfg.auto_reconnect = v;
        }

        // Changed
        assert!(cfg.enabled);
        assert_eq!(cfg.model, "eleven_flash_v2");
        // Untouched
        assert_eq!(cfg.agent_id, Some("old_agent".to_string()));
        assert_eq!(cfg.voice_id, Some("old_voice".to_string()));
        assert_eq!(cfg.turn_eagerness, "patient");
        assert!(cfg.auto_reconnect);
    }

    // ── default helper fns ────────────────────────────────────────────

    #[test]
    fn default_model_is_eleven_flash_v2() {
        assert_eq!(default_voice_agent_model(), "eleven_flash_v2");
    }

    #[test]
    fn default_turn_eagerness_is_normal() {
        assert_eq!(default_turn_eagerness(), "normal");
    }

    #[test]
    fn yes_returns_true() {
        assert!(yes());
    }
}
