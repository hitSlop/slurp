//! Where Slurp keeps its files, and the backend URL rules.
use anyhow::{Result, anyhow, bail};
use std::path::PathBuf;

/// Backend used when none is configured: the Worker started by `wrangler dev`. Real deployments are saved with `slurp connect <url>`.
pub const DEFAULT_BACKEND: &str = "http://127.0.0.1:8787";

/// Resolve the shared Slurp home without creating any files.
///
/// # Errors
/// Returns an error if neither SLURP_HOME nor HOME is available.
pub fn home() -> Result<PathBuf> {
    std::env::var_os("SLURP_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|value| PathBuf::from(value).join(".slurp")))
        .ok_or_else(|| anyhow!("SLURP_HOME or HOME is required"))
}

pub fn normalize_backend(value: &str) -> Result<String> {
    let url = crate::reqwest::Url::parse(value.trim())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("enter an HTTP(S) backend URL without credentials, query or fragment");
    }
    Ok(url.to_string().trim_end_matches('/').into())
}
