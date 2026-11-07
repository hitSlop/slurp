//! Non-secret service preferences and hosted metadata, shared across native clients.
use crate::rpc;
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

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

/// Prior default locations, used only to read existing state beneath the same user home.
pub fn legacy_homes(home: &Path) -> Vec<PathBuf> {
    if home.file_name().is_none_or(|name| name != ".slurp") {
        return Vec::new();
    }
    let Some(user_home) = home.parent() else {
        return Vec::new();
    };
    let mut locations = Vec::new();
    if cfg!(target_os = "macos") {
        locations.push(user_home.join("Library/Application Support/Slurp"));
    }
    locations.push(user_home.join(".local/share/slurp"));
    locations
}

#[derive(Default, Serialize, Deserialize)]
pub struct Config {
    pub backend: Option<String>,
    #[serde(default)]
    pub sources: Vec<CachedSource>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct CachedSource {
    pub backend: String,
    pub source: rpc::SourceInfo,
    pub ingest_url: String,
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
pub fn load(home: &Path) -> Result<Config> {
    for location in std::iter::once(home.to_path_buf()).chain(legacy_homes(home)) {
        match fs::read(location.join("service/client.json")) {
            Ok(bytes) => return Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(Config::default())
}
fn update(home: &Path, work: impl FnOnce(&mut Config)) -> Result<()> {
    use fs2::FileExt;
    let directory = home.join("service");
    fs::create_dir_all(&directory)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("config.lock"))?;
    lock.lock_exclusive()?;
    let mut config = load(home)?;
    work(&mut config);
    let temporary = directory.join("client.json.tmp");
    let mut file = fs::File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, &config)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, directory.join("client.json"))?;
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}
pub fn set_backend(home: &Path, backend: &str) -> Result<()> {
    let backend = normalize_backend(backend)?;
    update(home, |config| config.backend = Some(backend))
}
pub fn cache_source(home: &Path, source: CachedSource) -> Result<()> {
    update(home, |config| {
        config
            .sources
            .retain(|row| row.backend != source.backend || row.source.id != source.source.id);
        config.sources.push(source);
    })
}
pub fn event_folder(home: &Path, backend: &str, source: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    home.join("events")
        .join(hex::encode(Sha256::digest(backend)))
        .join(source)
}
pub fn publishable_account(backend: &str, source: &str) -> String {
    format!("publishable:{backend}#{source}")
}
