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

/// A non-empty environment variable, or `None`.
pub fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
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

use serde::{Deserialize, Serialize};
/// Editable system defaults. Credential values stay in the selected private store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Settings {
    pub version: u32,
    /// Private file storage by default; Keychain is an explicit alternative.
    #[serde(default)]
    pub credential_store: crate::storage::Store,
    /// Default API for new workspaces and cloud commands outside a bound workspace.
    pub backend: Option<String>,
    /// Default library root, containing a separate folder for each new project.
    pub library_dir: Option<std::path::PathBuf>,
    /// Qualified external or managed DuckDB executable.
    pub duckdb: Option<std::path::PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            credential_store: crate::storage::Store::default(),
            backend: None,
            library_dir: None,
            duckdb: None,
        }
    }
}
impl Settings {
    pub fn backend_url(&self) -> &str {
        self.backend.as_deref().unwrap_or(DEFAULT_BACKEND)
    }
}
pub fn settings_at(home: &std::path::Path) -> Result<Settings> {
    let path = home.join("config.toml");
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let value: toml::Value = toml::from_str(&text)?;
            check_version(
                &path,
                value
                    .get("version")
                    .and_then(toml::Value::as_integer)
                    .and_then(|v| u64::try_from(v).ok()),
                1,
                "slurp setup",
            )?;
            Ok(toml::from_str(&text)?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}
pub fn check_version(
    path: &std::path::Path,
    stored: Option<u64>,
    supported: u64,
    recovery: &str,
) -> Result<()> {
    match stored {
        Some(v) if v == supported => Ok(()),
        Some(v) if v > supported => bail!(
            "{} was written by a newer Slurp; upgrade the CLI",
            path.display()
        ),
        _ => bail!(
            "{} has unsupported or missing version metadata; move {} aside, then run {recovery}",
            path.display(),
            path.display()
        ),
    }
}

#[cfg(test)]
mod version_tests {
    #[test]
    fn recovery_hint_is_specific_and_newer_files_still_require_upgrade() {
        let path = std::path::Path::new("credentials.json");
        let error = super::check_version(path, None, 1, "slurp connect <backend>")
            .unwrap_err()
            .to_string();
        assert!(error.contains("move credentials.json aside, then run slurp connect <backend>"));
        let error = super::check_version(path, Some(2), 1, "slurp connect <backend>")
            .unwrap_err()
            .to_string();
        assert!(error.contains("upgrade the CLI"));
        assert!(!error.contains("move"));
    }
    #[test]
    fn settings_require_a_supported_header() {
        let home = tempfile::tempdir().unwrap();
        for text in [
            "backend='https://example.com'",
            "version=0",
            "version=-1",
            "version='one'",
            "version=2",
        ] {
            std::fs::write(home.path().join("config.toml"), text).unwrap();
            assert!(super::settings_at(home.path()).is_err());
            assert!(crate::storage::selected_at(home.path()).is_err());
        }
        std::fs::write(home.path().join("config.toml"), "version=1").unwrap();
        assert_eq!(super::settings_at(home.path()).unwrap().version, 1);
    }
}
