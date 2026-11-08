//! The saved connection to a Worker: one bearer token per backend URL, the admin token (or a read key) that `slurp connect` verified.
//!
//! A self-hosted Worker has no logins, sessions or refresh tokens, so the token is saved as itself, as a plain string, through the
//! [`storage`](crate::storage) layer (a private file by default, the OS keychain when selected). `SLURP_TOKEN` and `SLURP_READ_KEY` in
//! the environment take precedence over what is saved, so a bot never needs a saved connection.
use crate::{config, storage};
use anyhow::Result;

/// There is no token for this Worker: nothing saved and nothing in the environment.
#[derive(Debug, thiserror::Error)]
#[error(
    "not connected to a Worker; run slurp connect <worker-url> --token-stdin (or set SLURP_TOKEN)"
)]
pub struct NotConnected;

/// The token from `SLURP_TOKEN`, else `SLURP_READ_KEY`, when one is set and not empty.
pub fn environment_token() -> Option<String> {
    ["SLURP_TOKEN", "SLURP_READ_KEY"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

/// Save the token for a backend (replacing any earlier one).
///
/// # Errors
/// Returns an error for an invalid backend URL or an unsafe or unwritable credential store.
pub fn save(backend: &str, token: &str) -> Result<()> {
    storage::set(&config::normalize_backend(backend)?, token)
}

/// The saved token for a backend, ignoring the environment.
///
/// # Errors
/// Returns an error for an invalid backend URL or an unreadable credential store.
pub fn load(backend: &str) -> Result<Option<String>> {
    storage::get(&config::normalize_backend(backend)?)
}

/// Forget the saved token for a backend. Succeeds if there was none.
///
/// # Errors
/// Returns an error for an invalid backend URL or an unwritable credential store.
pub fn forget(backend: &str) -> Result<()> {
    storage::delete(&config::normalize_backend(backend)?)
}

/// The token to use for a backend: the environment's, else the saved one.
///
/// # Errors
/// Returns [`NotConnected`] when there is neither, or a storage error.
pub fn resolve(backend: &str, project: Option<&str>) -> Result<String> {
    resolve_with(backend, project, environment_token(), storage::get)
}
fn resolve_with(
    backend: &str,
    project: Option<&str>,
    environment: Option<String>,
    mut read: impl FnMut(&str) -> Result<Option<String>>,
) -> Result<String> {
    if let Some(token) = environment {
        return Ok(token);
    }
    let backend = config::normalize_backend(backend)?;
    if let Some(project) = project
        && let Some(token) = read(&format!("{backend}#{project}"))?
    {
        return Ok(token);
    }
    read(&backend)?.ok_or_else(|| NotConnected.into())
}

/// Save a verified project secret independently of the Worker's admin connection.
pub fn save_project(backend: &str, project: &str, token: &str) -> Result<()> {
    storage::set(
        &format!("{}#{project}", config::normalize_backend(backend)?),
        token,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_scoped_and_environment_wins_without_reading_saved_state() {
        let saved = std::collections::HashMap::from([
            ("https://example.com", "admin"),
            ("https://example.com#prj_a", "alice"),
            ("https://example.com#prj_b", "bob"),
        ]);
        let read = |key: &str| Ok(saved.get(key).map(|v| (*v).to_string()));
        assert_eq!(
            resolve_with("https://example.com/", Some("prj_a"), None, read).unwrap(),
            "alice"
        );
        assert_eq!(
            resolve_with("https://example.com", Some("prj_b"), None, read).unwrap(),
            "bob"
        );
        assert_eq!(
            resolve_with("https://example.com", Some("prj_c"), None, read).unwrap(),
            "admin"
        );
        assert_eq!(
            resolve_with("https://example.com", None, None, read).unwrap(),
            "admin"
        );
        assert_eq!(
            resolve_with(
                "https://example.com",
                Some("prj_a"),
                Some("environment".into()),
                |_| panic!("environment must not read the credential store")
            )
            .unwrap(),
            "environment"
        );
        assert!(resolve_with("https://another.example", Some("prj_a"), None, read).is_err());
    }
}
