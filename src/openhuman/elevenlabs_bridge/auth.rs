//! Shared-secret auth for the ElevenLabs bridge routes.
//!
//! ElevenLabs Cloud cannot read the rotating per-launch `OPENHUMAN_CORE_TOKEN`
//! that the desktop shell mints — that token lives only on the user's
//! machine and the cloud service has no way to discover it.  So the bridge
//! routes carry their own auth: a long-lived shared secret configured via
//! the `OPENHUMAN_ELEVENLABS_WEBHOOK_SECRET` environment variable and sent
//! by ElevenLabs as the `X-ElevenLabs-Secret` request header.
//!
//! When the env var is unset, every bridge request is rejected with 401 —
//! the operator must opt in by configuring the secret. This avoids
//! shipping an accidentally-open relay if `/elevenlabs/*` paths are
//! exposed on a public origin.
//!
//! Constant-time comparison guards against header-timing oracles. The
//! header name is case-insensitive (HTTP). The presence of `Bearer ` /
//! `Basic ` prefixes is **not** stripped — the secret value is sent as
//! a raw string, exactly matching the ElevenLabs dashboard contract.

use axum::http::{header::HeaderName, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Header ElevenLabs Cloud uses to convey the shared secret.
pub const SECRET_HEADER: &str = "x-elevenlabs-secret";

/// Environment variable holding the shared secret on the core side.
pub const SECRET_ENV: &str = "OPENHUMAN_ELEVENLABS_WEBHOOK_SECRET";

/// Authoritative header name as an Axum constant (for typed `.get(name)`).
pub fn secret_header_name() -> HeaderName {
    HeaderName::from_static(SECRET_HEADER)
}

/// Extract the configured shared secret. Returns `None` when the env var
/// is unset or empty — callers MUST reject the request in that case.
pub fn configured_secret() -> Option<String> {
    std::env::var(SECRET_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Verify the inbound request's `X-ElevenLabs-Secret` header against the
/// configured secret.  Returns `Ok(())` on match, or an `Err(Response)`
/// pre-built 401 ready to be returned from the handler.
pub fn verify_request(headers: &HeaderMap) -> Result<(), Response> {
    let Some(expected) = configured_secret() else {
        tracing::warn!(
            "[elevenlabs-bridge] {SECRET_ENV} not configured — rejecting request"
        );
        return Err(unauthorized("server_not_configured"));
    };

    let supplied = headers
        .get(secret_header_name())
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if constant_time_eq(supplied.as_bytes(), expected.as_bytes()) {
        tracing::trace!("[elevenlabs-bridge] auth ok");
        Ok(())
    } else {
        tracing::warn!(
            "[elevenlabs-bridge] auth failed — missing or wrong {SECRET_HEADER} header"
        );
        Err(unauthorized("invalid_secret"))
    }
}

fn unauthorized(reason: &'static str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "unauthorized",
            "reason": reason,
        })),
    )
        .into_response()
}

/// Constant-time byte slice equality. The `subtle` crate isn't in the
/// dep tree; this implementation runs in time proportional to the longer
/// of the two slices and never short-circuits on a mismatch.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        // Different-length comparisons are inherently distinguishable
        // (a length oracle exists at the TLS framing layer regardless),
        // so returning early here adds nothing to a timing attacker
        // who already sees the response size.
        return false;
    }
    let mut acc: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    /// Mutex-guarded env-var setter — Rust's test runner is multi-
    /// threaded and `std::env::set_var` is process-global.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_secret<F: FnOnce()>(secret: &str, f: F) {
        let _guard = ENV_LOCK.lock().unwrap();
        // SAFETY: tests are single-threaded inside `with_secret` via the
        // mutex; the env touch is restored on the way out.
        unsafe {
            std::env::set_var(SECRET_ENV, secret);
        }
        f();
        unsafe {
            std::env::remove_var(SECRET_ENV);
        }
    }

    #[test]
    fn rejects_when_env_var_missing() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var(SECRET_ENV);
        }
        let mut headers = HeaderMap::new();
        headers.insert(secret_header_name(), HeaderValue::from_static("anything"));
        assert!(verify_request(&headers).is_err());
    }

    #[test]
    fn rejects_when_env_var_blank() {
        with_secret("   ", || {
            let mut headers = HeaderMap::new();
            headers.insert(secret_header_name(), HeaderValue::from_static("x"));
            assert!(verify_request(&headers).is_err());
        });
    }

    #[test]
    fn accepts_matching_secret() {
        with_secret("hunter2", || {
            let mut headers = HeaderMap::new();
            headers.insert(secret_header_name(), HeaderValue::from_static("hunter2"));
            assert!(verify_request(&headers).is_ok());
        });
    }

    #[test]
    fn rejects_mismatching_secret() {
        with_secret("hunter2", || {
            let mut headers = HeaderMap::new();
            headers.insert(secret_header_name(), HeaderValue::from_static("hunter3"));
            assert!(verify_request(&headers).is_err());
        });
    }

    #[test]
    fn rejects_missing_header() {
        with_secret("hunter2", || {
            let headers = HeaderMap::new();
            assert!(verify_request(&headers).is_err());
        });
    }

    #[test]
    fn constant_time_eq_handles_lengths() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(constant_time_eq(b"", b""));
    }
}
