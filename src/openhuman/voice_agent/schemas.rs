//! Controller schema definitions and RPC handler wrappers for the voice_agent domain.
//!
//! Pattern mirrors `src/openhuman/cron/schemas.rs`.

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::core::all::{ControllerFuture, RegisteredController};
use crate::core::{ControllerSchema, FieldSchema, TypeSchema};
use crate::rpc::RpcOutcome;

use super::types::{
    GetSignedUrlInput, SessionEndedInput, SessionStartedInput, VoiceAgentConfigSetInput,
};

// ── Schema registry ───────────────────────────────────────────────────────────

pub fn all_controller_schemas() -> Vec<ControllerSchema> {
    vec![
        schemas("get_signed_url"),
        schemas("config_get"),
        schemas("config_set"),
        schemas("session_started"),
        schemas("session_ended"),
    ]
}

pub fn all_registered_controllers() -> Vec<RegisteredController> {
    vec![
        RegisteredController {
            schema: schemas("get_signed_url"),
            handler: handle_get_signed_url,
        },
        RegisteredController {
            schema: schemas("config_get"),
            handler: handle_config_get,
        },
        RegisteredController {
            schema: schemas("config_set"),
            handler: handle_config_set,
        },
        RegisteredController {
            schema: schemas("session_started"),
            handler: handle_session_started,
        },
        RegisteredController {
            schema: schemas("session_ended"),
            handler: handle_session_ended,
        },
    ]
}

// ── Schema definitions ────────────────────────────────────────────────────────

pub fn schemas(function: &str) -> ControllerSchema {
    match function {
        "get_signed_url" => ControllerSchema {
            namespace: "voice_agent",
            function: "get_signed_url",
            description: "Fetch a signed ElevenLabs WebSocket URL via the OpenHuman backend. \
                          On auth failure publishes SessionExpired; on backend unavailability \
                          publishes VoiceAgentError.",
            inputs: vec![FieldSchema {
                name: "agent_id",
                ty: TypeSchema::Option(Box::new(TypeSchema::String)),
                comment: "Optional agent_id override. Defaults to config.voice_agent.agent_id \
                          (or the backend's ELEVENLABS_AGENT_ID env var).",
                required: false,
            }],
            outputs: vec![
                FieldSchema {
                    name: "ok",
                    ty: TypeSchema::Bool,
                    comment: "True when a valid signed URL was returned.",
                    required: true,
                },
                FieldSchema {
                    name: "signed_url",
                    ty: TypeSchema::String,
                    comment: "WebSocket URL (wss://...) to pass to the ElevenLabs SDK. \
                              Empty string on failure.",
                    required: true,
                },
                FieldSchema {
                    name: "expires_at",
                    ty: TypeSchema::U64,
                    comment: "Unix seconds when the URL expires. 0 on failure.",
                    required: true,
                },
                FieldSchema {
                    name: "error",
                    ty: TypeSchema::Option(Box::new(TypeSchema::String)),
                    comment: "Short error slug when ok=false.",
                    required: false,
                },
            ],
        },

        "config_get" => ControllerSchema {
            namespace: "voice_agent",
            function: "config_get",
            description: "Return the current voice_agent configuration section.",
            inputs: vec![],
            outputs: config_get_output_fields(),
        },

        "config_set" => ControllerSchema {
            namespace: "voice_agent",
            function: "config_set",
            description: "Apply a partial patch to the voice_agent config and persist. \
                          Only provided fields are updated.",
            inputs: vec![
                FieldSchema {
                    name: "enabled",
                    ty: TypeSchema::Option(Box::new(TypeSchema::Bool)),
                    comment: "Enable or disable the voice agent.",
                    required: false,
                },
                FieldSchema {
                    name: "agent_id",
                    ty: TypeSchema::Option(Box::new(TypeSchema::String)),
                    comment: "ElevenLabs agent_id override.",
                    required: false,
                },
                FieldSchema {
                    name: "voice_id",
                    ty: TypeSchema::Option(Box::new(TypeSchema::String)),
                    comment: "TTS voice id override.",
                    required: false,
                },
                FieldSchema {
                    name: "model",
                    ty: TypeSchema::Option(Box::new(TypeSchema::String)),
                    comment: "TTS model id (e.g. eleven_flash_v2).",
                    required: false,
                },
                FieldSchema {
                    name: "turn_eagerness",
                    ty: TypeSchema::Option(Box::new(TypeSchema::Enum {
                        variants: vec!["patient", "normal", "eager"],
                    })),
                    comment: "How eagerly the agent takes the turn.",
                    required: false,
                },
                FieldSchema {
                    name: "auto_reconnect",
                    ty: TypeSchema::Option(Box::new(TypeSchema::Bool)),
                    comment: "Whether to auto-reconnect on session loss.",
                    required: false,
                },
            ],
            outputs: vec![
                FieldSchema {
                    name: "ok",
                    ty: TypeSchema::Bool,
                    comment: "True when the config was persisted successfully.",
                    required: true,
                },
                FieldSchema {
                    name: "config",
                    ty: TypeSchema::Object {
                        fields: config_get_output_fields(),
                    },
                    comment: "Full config after applying the patch.",
                    required: true,
                },
            ],
        },

        "session_started" => ControllerSchema {
            namespace: "voice_agent",
            function: "session_started",
            description: "Telemetry: call once after the ElevenLabs WebSocket handshake \
                          succeeds. Publishes VoiceAgentSessionStarted.",
            inputs: vec![
                FieldSchema {
                    name: "conversation_id",
                    ty: TypeSchema::String,
                    comment: "ElevenLabs conversation id from the WS handshake.",
                    required: true,
                },
                FieldSchema {
                    name: "agent_id",
                    ty: TypeSchema::String,
                    comment: "ElevenLabs agent id that was used.",
                    required: true,
                },
            ],
            outputs: vec![FieldSchema {
                name: "ok",
                ty: TypeSchema::Bool,
                comment: "Always true.",
                required: true,
            }],
        },

        "session_ended" => ControllerSchema {
            namespace: "voice_agent",
            function: "session_ended",
            description: "Telemetry: call on session close (clean or error). \
                          Publishes VoiceAgentSessionEnded.",
            inputs: vec![
                FieldSchema {
                    name: "conversation_id",
                    ty: TypeSchema::String,
                    comment: "ElevenLabs conversation id.",
                    required: true,
                },
                FieldSchema {
                    name: "duration_ms",
                    ty: TypeSchema::U64,
                    comment: "Wall-clock session duration in milliseconds.",
                    required: true,
                },
                FieldSchema {
                    name: "turn_count",
                    ty: TypeSchema::U64,
                    comment: "Number of complete conversation turns.",
                    required: true,
                },
                FieldSchema {
                    name: "end_reason",
                    ty: TypeSchema::Enum {
                        variants: vec!["user_closed", "error", "fallback", "expired"],
                    },
                    comment: "Why the session ended.",
                    required: true,
                },
            ],
            outputs: vec![FieldSchema {
                name: "ok",
                ty: TypeSchema::Bool,
                comment: "Always true.",
                required: true,
            }],
        },

        _other => ControllerSchema {
            namespace: "voice_agent",
            function: "unknown",
            description: "Unknown voice_agent controller function.",
            inputs: vec![FieldSchema {
                name: "function",
                ty: TypeSchema::String,
                comment: "The unknown function name that was requested.",
                required: true,
            }],
            outputs: vec![FieldSchema {
                name: "error",
                ty: TypeSchema::String,
                comment: "Lookup error details.",
                required: true,
            }],
        },
    }
}

/// Shared output field list for both `config_get` output and the nested
/// `config` object inside `config_set` output.
fn config_get_output_fields() -> Vec<FieldSchema> {
    vec![
        FieldSchema {
            name: "enabled",
            ty: TypeSchema::Bool,
            comment: "Whether the voice agent is enabled.",
            required: true,
        },
        FieldSchema {
            name: "agent_id",
            ty: TypeSchema::Option(Box::new(TypeSchema::String)),
            comment: "ElevenLabs agent_id override (None = use backend default).",
            required: false,
        },
        FieldSchema {
            name: "voice_id",
            ty: TypeSchema::Option(Box::new(TypeSchema::String)),
            comment: "TTS voice id override (None = frontend fallback to MASCOT_VOICE_ID).",
            required: false,
        },
        FieldSchema {
            name: "model",
            ty: TypeSchema::String,
            comment: "TTS model id (e.g. eleven_flash_v2).",
            required: true,
        },
        FieldSchema {
            name: "turn_eagerness",
            ty: TypeSchema::Enum {
                variants: vec!["patient", "normal", "eager"],
            },
            comment: "How eagerly the agent takes the turn.",
            required: true,
        },
        FieldSchema {
            name: "auto_reconnect",
            ty: TypeSchema::Bool,
            comment: "Whether to auto-reconnect on session loss.",
            required: true,
        },
    ]
}

// ── Handler functions ─────────────────────────────────────────────────────────

fn handle_get_signed_url(params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        tracing::debug!("[voice_agent] handle_get_signed_url: entry");
        let input = read_optional_struct::<GetSignedUrlInput>(&params).unwrap_or_default();
        let result = super::ops::get_signed_url(input).await?;
        tracing::debug!(ok = %result.ok, "[voice_agent] handle_get_signed_url: exit");
        to_json(RpcOutcome::new(result, vec![]))
    })
}

fn handle_config_get(_params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async {
        tracing::debug!("[voice_agent] handle_config_get: entry");
        let result = super::ops::config_get().await?;
        tracing::debug!("[voice_agent] handle_config_get: exit");
        to_json(RpcOutcome::new(result, vec![]))
    })
}

fn handle_config_set(params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        tracing::debug!("[voice_agent] handle_config_set: entry");
        let input = read_optional_struct::<VoiceAgentConfigSetInput>(&params).unwrap_or_default();
        let result = super::ops::config_set(input).await?;
        tracing::debug!(ok = %result.ok, "[voice_agent] handle_config_set: exit");
        to_json(RpcOutcome::new(result, vec![]))
    })
}

fn handle_session_started(params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        tracing::debug!("[voice_agent] handle_session_started: entry");
        let conversation_id = read_required::<String>(&params, "conversation_id")?;
        let agent_id = read_required::<String>(&params, "agent_id")?;
        let result = super::ops::session_started(SessionStartedInput {
            conversation_id,
            agent_id,
        })
        .await?;
        to_json(RpcOutcome::new(result, vec![]))
    })
}

fn handle_session_ended(params: Map<String, Value>) -> ControllerFuture {
    Box::pin(async move {
        tracing::debug!("[voice_agent] handle_session_ended: entry");
        let conversation_id = read_required::<String>(&params, "conversation_id")?;
        let duration_ms = read_required_u64(&params, "duration_ms")?;
        let turn_count = read_required_u32(&params, "turn_count")?;
        let end_reason = read_required::<String>(&params, "end_reason")?;
        let result = super::ops::session_ended(SessionEndedInput {
            conversation_id,
            duration_ms,
            turn_count,
            end_reason,
        })
        .await?;
        to_json(RpcOutcome::new(result, vec![]))
    })
}

// ── Param helpers ─────────────────────────────────────────────────────────────

fn read_required<T: DeserializeOwned>(params: &Map<String, Value>, key: &str) -> Result<T, String> {
    let value = params
        .get(key)
        .cloned()
        .ok_or_else(|| format!("missing required param '{key}'"))?;
    serde_json::from_value(value).map_err(|e| format!("invalid '{key}': {e}"))
}

fn read_required_u64(params: &Map<String, Value>, key: &str) -> Result<u64, String> {
    match params.get(key) {
        Some(Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| format!("invalid '{key}': expected unsigned integer")),
        Some(_) => Err(format!("invalid '{key}': expected unsigned integer")),
        None => Err(format!("missing required param '{key}'")),
    }
}

fn read_required_u32(params: &Map<String, Value>, key: &str) -> Result<u32, String> {
    let raw = read_required_u64(params, key)?;
    u32::try_from(raw).map_err(|_| format!("'{key}' is too large for u32"))
}

/// Deserialise the entire params map as `T`.  Returns `None` on empty params
/// so callers can `.unwrap_or_default()` for fully-optional input structs.
fn read_optional_struct<T: DeserializeOwned + Default>(params: &Map<String, Value>) -> Option<T> {
    if params.is_empty() {
        return None;
    }
    serde_json::from_value(Value::Object(params.clone())).ok()
}

fn to_json<T: serde::Serialize>(outcome: RpcOutcome<T>) -> Result<Value, String> {
    outcome.into_cli_compatible_json()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── schemas() branch coverage ────────────────────────────────────

    #[test]
    fn schemas_get_signed_url_has_optional_agent_id_input() {
        let s = schemas("get_signed_url");
        assert_eq!(s.namespace, "voice_agent");
        assert_eq!(s.function, "get_signed_url");
        // agent_id is optional
        let agent_id = s.inputs.iter().find(|f| f.name == "agent_id").unwrap();
        assert!(!agent_id.required);
    }

    #[test]
    fn schemas_get_signed_url_outputs_ok_signed_url_expires_at() {
        let s = schemas("get_signed_url");
        let names: Vec<_> = s.outputs.iter().map(|f| f.name).collect();
        assert!(names.contains(&"ok"));
        assert!(names.contains(&"signed_url"));
        assert!(names.contains(&"expires_at"));
    }

    #[test]
    fn schemas_config_get_has_no_inputs() {
        let s = schemas("config_get");
        assert!(s.inputs.is_empty());
        let names: Vec<_> = s.outputs.iter().map(|f| f.name).collect();
        assert!(names.contains(&"enabled"));
        assert!(names.contains(&"model"));
    }

    #[test]
    fn schemas_config_set_all_inputs_optional() {
        let s = schemas("config_set");
        for field in &s.inputs {
            assert!(!field.required, "field '{}' should be optional", field.name);
        }
    }

    #[test]
    fn schemas_session_started_requires_conversation_id_and_agent_id() {
        let s = schemas("session_started");
        let names: Vec<_> = s.inputs.iter().map(|f| f.name).collect();
        assert!(names.contains(&"conversation_id"));
        assert!(names.contains(&"agent_id"));
        assert!(s.inputs.iter().all(|f| f.required));
    }

    #[test]
    fn schemas_session_ended_requires_four_fields() {
        let s = schemas("session_ended");
        let names: Vec<_> = s.inputs.iter().map(|f| f.name).collect();
        assert!(names.contains(&"conversation_id"));
        assert!(names.contains(&"duration_ms"));
        assert!(names.contains(&"turn_count"));
        assert!(names.contains(&"end_reason"));
    }

    #[test]
    fn schemas_unknown_function_returns_placeholder() {
        let s = schemas("does-not-exist");
        assert_eq!(s.function, "unknown");
        assert_eq!(s.outputs[0].name, "error");
    }

    // ── registry helpers ─────────────────────────────────────────────

    #[test]
    fn all_controller_schemas_covers_five_functions() {
        let names: Vec<_> = all_controller_schemas()
            .into_iter()
            .map(|s| s.function)
            .collect();
        assert_eq!(
            names,
            vec![
                "get_signed_url",
                "config_get",
                "config_set",
                "session_started",
                "session_ended"
            ]
        );
    }

    #[test]
    fn all_registered_controllers_has_handler_per_schema() {
        let controllers = all_registered_controllers();
        assert_eq!(controllers.len(), 5);
        let names: Vec<_> = controllers.iter().map(|c| c.schema.function).collect();
        assert_eq!(
            names,
            vec![
                "get_signed_url",
                "config_get",
                "config_set",
                "session_started",
                "session_ended"
            ]
        );
    }

    // ── read_required ────────────────────────────────────────────────

    #[test]
    fn read_required_returns_value_for_present_key() {
        use serde_json::json;
        let mut params = Map::new();
        params.insert("conversation_id".into(), json!("conv-1"));
        let got: String = read_required(&params, "conversation_id").unwrap();
        assert_eq!(got, "conv-1");
    }

    #[test]
    fn read_required_errors_when_key_missing() {
        let params = Map::new();
        let err = read_required::<String>(&params, "conversation_id").unwrap_err();
        assert!(err.contains("missing required param 'conversation_id'"));
    }

    #[test]
    fn read_required_u64_rejects_negative() {
        use serde_json::json;
        let mut params = Map::new();
        params.insert("duration_ms".into(), json!(-1));
        let err = read_required_u64(&params, "duration_ms").unwrap_err();
        assert!(err.contains("expected unsigned integer"));
    }

    #[test]
    fn read_required_u32_errors_on_overflow() {
        use serde_json::json;
        let mut params = Map::new();
        params.insert("turn_count".into(), json!(u64::MAX));
        let err = read_required_u32(&params, "turn_count").unwrap_err();
        assert!(err.contains("too large for u32"));
    }
}
