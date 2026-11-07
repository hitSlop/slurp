//! Durable source-creation identity shared by CLI and desktop clients.
use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub struct PendingCreation {
    pub id: String,
    path: PathBuf,
    _lock: fs::File,
}

/// Stable account fingerprint for local retry state; tokens themselves are never persisted.
pub fn account(token: &str) -> String {
    token
        .split('.')
        .nth(1)
        .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
        .and_then(|part| serde_json::from_slice::<serde_json::Value>(&part).ok())
        .and_then(|part| {
            part["sub"]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| hex::encode(Sha256::digest(token)))
}
impl PendingCreation {
    pub async fn open(home: &Path, backend: &str, token: &str, name: &str) -> Result<Self> {
        let account = account(token);
        let directory = home.join("cache/source-requests");
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(format!("{backend}\n{account}\n{name}")))
        ));
        let lock = crate::locking::acquire(path.with_extension("lock")).await?;
        let id = if path.exists() {
            fs::read_to_string(&path)?
        } else {
            let id = uuid::Uuid::now_v7().to_string();
            let temporary = path.with_extension("tmp");
            let mut file = fs::File::create(&temporary)?;
            file.write_all(id.as_bytes())?;
            file.sync_all()?;
            fs::rename(temporary, &path)?;
            fs::File::open(directory)?.sync_all()?;
            id
        };
        Ok(Self {
            id,
            path,
            _lock: lock,
        })
    }
    pub fn finish(self) -> Result<()> {
        fs::remove_file(&self.path)?;
        fs::File::open(self.path.parent().unwrap())?.sync_all()?;
        Ok(())
    }
}
