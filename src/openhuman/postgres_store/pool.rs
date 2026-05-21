//! Async Postgres connection + process-global client handle.
//!
//! Call [`init_postgres`] once at server startup (inside `serve_core`)
//! when `OPENHUMAN_STORAGE_BACKEND=postgres` is set.  All subsequent
//! callers reach the live client via [`postgres_client`].
//!
//! The stored value is the `Arc`-wrapped `tokio_postgres::Client`.
//! `tokio_postgres::Client` is `Send + Sync`; wrapping in `Arc` lets
//! multiple async tasks clone a cheap handle without copying the
//! connection state.  The background `Connection` future is spawned as a
//! detached tokio task (standard `tokio-postgres` pattern) and lives for
//! the process lifetime.

use std::sync::OnceLock;

use tokio_postgres::{Client, NoTls};

/// Env var that opts the runtime into Postgres storage.
pub const STORAGE_BACKEND_ENV: &str = "OPENHUMAN_STORAGE_BACKEND";
/// Env var that carries the Postgres connection URL.
pub const DATABASE_URL_ENV: &str = "OPENHUMAN_DATABASE_URL";

/// Process-global Postgres client, set by [`init_postgres`].
static PG_CLIENT: OnceLock<std::sync::Arc<Client>> = OnceLock::new();

/// Returns `true` when `OPENHUMAN_STORAGE_BACKEND=postgres` (case-insensitive).
pub fn is_postgres_enabled() -> bool {
    std::env::var(STORAGE_BACKEND_ENV)
        .ok()
        .map(|v| v.trim().to_ascii_lowercase() == "postgres")
        .unwrap_or(false)
}

/// Connect to Postgres, verify the connection with `SELECT 1`, and store
/// the client in the process-global [`PG_CLIENT`].
///
/// # Errors
///
/// Returns an error if:
/// - `OPENHUMAN_DATABASE_URL` is unset or empty.
/// - The connection cannot be established (wrong credentials, host
///   unreachable, TLS mismatch, etc.).
/// - The `SELECT 1` ping fails.
///
/// Calling this function when [`is_postgres_enabled`] returns `false` is
/// a no-op and returns `Ok(())` — the caller does not need to gate on
/// the feature flag before calling.
pub async fn init_postgres() -> anyhow::Result<()> {
    if !is_postgres_enabled() {
        log::debug!("[postgres_store] {STORAGE_BACKEND_ENV} is not 'postgres' — skipping init");
        return Ok(());
    }

    if PG_CLIENT.get().is_some() {
        log::debug!("[postgres_store] already initialized, skipping");
        return Ok(());
    }

    let url = std::env::var(DATABASE_URL_ENV)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if url.is_empty() {
        anyhow::bail!(
            "[postgres_store] {DATABASE_URL_ENV} is required when \
             {STORAGE_BACKEND_ENV}=postgres but was not set"
        );
    }

    log::info!("[postgres_store] connecting (url redacted for security)…");

    let (client, connection) = tokio_postgres::connect(&url, NoTls).await.map_err(|e| {
        anyhow::anyhow!(
            "[postgres_store] failed to connect to Postgres: {e}. \
             Check {DATABASE_URL_ENV} and ensure the server is reachable."
        )
    })?;

    // The `Connection` object must be driven to completion for the client
    // to send and receive data.  Spawn it as a background task that runs
    // for the process lifetime — the standard tokio-postgres pattern.
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            log::error!("[postgres_store] connection driver terminated: {e}");
        }
    });

    // Verify reachability with a cheap ping.
    client
        .execute("SELECT 1", &[])
        .await
        .map_err(|e| anyhow::anyhow!("[postgres_store] ping failed: {e}"))?;

    log::info!("[postgres_store] connected and ping OK");

    let _ = PG_CLIENT.set(std::sync::Arc::new(client));
    Ok(())
}

/// Returns a clone of the process-global Postgres client, if initialised.
///
/// Returns `None` when [`init_postgres`] has not been called or when
/// `OPENHUMAN_STORAGE_BACKEND` is not `postgres`.
pub fn postgres_client() -> Option<std::sync::Arc<Client>> {
    PG_CLIENT.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_postgres_enabled_false_when_unset() {
        // Guard: don't interfere with a real env in a parallel test run.
        let _val = std::env::var(STORAGE_BACKEND_ENV).ok();
        unsafe { std::env::remove_var(STORAGE_BACKEND_ENV) };
        assert!(!is_postgres_enabled());
    }

    #[test]
    fn is_postgres_enabled_true_for_postgres_value() {
        unsafe { std::env::set_var(STORAGE_BACKEND_ENV, "postgres") };
        assert!(is_postgres_enabled());
        unsafe { std::env::remove_var(STORAGE_BACKEND_ENV) };
    }

    #[test]
    fn is_postgres_enabled_case_insensitive() {
        unsafe { std::env::set_var(STORAGE_BACKEND_ENV, "POSTGRES") };
        assert!(is_postgres_enabled());
        unsafe { std::env::remove_var(STORAGE_BACKEND_ENV) };
    }

    #[test]
    fn is_postgres_enabled_false_for_sqlite() {
        unsafe { std::env::set_var(STORAGE_BACKEND_ENV, "sqlite") };
        assert!(!is_postgres_enabled());
        unsafe { std::env::remove_var(STORAGE_BACKEND_ENV) };
    }

    #[tokio::test]
    async fn init_postgres_noop_when_feature_disabled() {
        unsafe { std::env::remove_var(STORAGE_BACKEND_ENV) };
        // Should return Ok(()) without touching the network.
        assert!(init_postgres().await.is_ok());
    }

    #[tokio::test]
    async fn init_postgres_errors_when_url_missing() {
        unsafe {
            std::env::set_var(STORAGE_BACKEND_ENV, "postgres");
            std::env::remove_var(DATABASE_URL_ENV);
        }
        let result = init_postgres().await;
        unsafe { std::env::remove_var(STORAGE_BACKEND_ENV) };
        // Must error — no URL configured.
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains(DATABASE_URL_ENV));
    }
}
