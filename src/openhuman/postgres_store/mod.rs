//! Postgres storage backend — connection plumbing.
//!
//! Activated by setting `OPENHUMAN_STORAGE_BACKEND=postgres`.
//! When unset (or set to anything other than `"postgres"`) the runtime
//! continues to use the default SQLite / TOML stores so the desktop app
//! is completely unaffected.
//!
//! Current scope (Phase 1 — connection plumbing):
//! - Parse `OPENHUMAN_DATABASE_URL` and validate it at startup.
//! - Open a `tokio-postgres` connection and verify reachability with a
//!   `SELECT 1` ping.
//! - Expose the connected client via a process-global `OnceLock` so
//!   future phases can retrieve it without threading a `&Client` through
//!   every call stack.
//!
//! Phase 2 (follow-up issue): swap the memory write-path to use this
//! client when `OPENHUMAN_STORAGE_BACKEND=postgres`.
//!
//! ## Why `tokio-postgres` and not `sqlx`?
//!
//! `tokio-postgres` is already in the lockfile as a transitive dependency
//! of the synchronous `postgres` crate (which is already a direct dep for
//! existing code). Adding it as a direct dep costs zero extra compile time
//! and avoids introducing a new major dependency (`sqlx`) before the full
//! storage-swap design is locked in.

pub mod pool;

pub use pool::{init_postgres, is_postgres_enabled, postgres_client};
