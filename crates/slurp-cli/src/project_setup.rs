//! Resumable cloud project creation. Checkpoints contain metadata, never credentials.
use crate::error::{ErrorCode, Failure};
use anyhow::{Context, Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use slurp_client::{config, rpc, storage};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

/// Convert a friendly display name into a valid, owner-scoped service alias.
pub fn alias(title: &str) -> String {
    let mut slug = String::new();
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('_') {
            slug.push('_');
        }
        if slug.len() >= 59 {
            break;
        }
    }
    let slug = slug.trim_matches('_');
    format!("app_{}", if slug.is_empty() { "project" } else { slug })
}

#[cfg(test)]
mod tests {
    use super::alias;

    #[test]
    fn display_names_produce_bounded_valid_internal_aliases() {
        assert_eq!(alias("My SaaS"), "app_my_saas");
        assert_eq!(alias("7-day app"), "app_7_day_app");
        for title in [
            "select",
            "src_events",
            "hello___world",
            "🌊",
            &"x".repeat(200),
        ] {
            let name = alias(title);
            assert!(
                name.starts_with("app_") && name.len() <= 63 && !name.contains("__"),
                "invalid alias {name}"
            );
            assert!(
                name.bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
            );
        }
    }
}

/// Sanitize transport failures so credential-bearing response bodies are never displayed.
pub fn service_error(error: rpc::Error) -> anyhow::Error {
    anyhow!(match error.code() {
        Some(1000) => "not connected; run slurp connect <worker-url> --token-stdin",
        Some(1001) => "this account does not have permission for that project",
        Some(2000) => "invalid project details",
        Some(2001) => "project already exists; connect to it or choose another name",
        Some(2002) =>
            "that project alias is ambiguous; select the project interactively or use its stable ID",
        Some(3000) => "project not found; select an available project or create a new one",
        _ => "Slurp service request failed; retry when the service is available",
    })
}

#[derive(Debug, Serialize, Deserialize)]
struct Checkpoint {
    title: String,
    request_id: String,
    source: Option<rpc::SourceInfo>,
    ingest_url: Option<String>,
}
/// A locked, durable initialization attempt associated with a folder, backend and account.
#[derive(Debug)]
pub struct Creation {
    path: PathBuf,
    backend: String,
    state: Checkpoint,
    _lock: fs::File,
}
impl Creation {
    fn path(home: &Path, root: &Path, backend: &str, token: &str) -> Result<PathBuf> {
        let identity = hex::encode(Sha256::digest(format!(
            "{}\n{backend}\n{}",
            root.canonicalize()?.display(),
            slurp_client::source::account(token)
        )));
        Ok(home.join("cache/init").join(format!("{identity}.json")))
    }
    /// Read the name of an unfinished attempt without creating any state.
    ///
    /// # Errors
    /// Returns an error if existing retry state cannot be read or decoded.
    pub fn pending_name(
        home: &Path,
        root: &Path,
        backend: &str,
        token: &str,
    ) -> Result<Option<String>> {
        match fs::read(Self::path(home, root, backend, token)?) {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice::<Checkpoint>(&bytes)
                    .context("reading initialization checkpoint")?
                    .title,
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    /// Open or resume an initialization attempt before issuing a create request.
    ///
    /// # Errors
    /// Returns an error for conflicting attempts, incompatible names or unavailable state.
    pub fn open(home: &Path, root: &Path, backend: &str, token: &str, title: &str) -> Result<Self> {
        use fs2::FileExt;
        let directory = home.join("cache/init");
        fs::create_dir_all(&directory)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        let path = Self::path(home, root, backend, token)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))?;
        lock.try_lock_exclusive().map_err(|_| {
            Failure::new(
                ErrorCode::Busy,
                "another initialization is using this project",
            )
        })?;
        let state = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Checkpoint>(&bytes)
                .context("reading project initialization checkpoint")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Checkpoint {
                title: title.into(),
                request_id: uuid::Uuid::now_v7().to_string(),
                source: None,
                ingest_url: None,
            },
            Err(error) => return Err(error.into()),
        };
        ensure!(
            state.title == title,
            "an unfinished initialization exists for {}; rerun init with that name",
            state.title
        );
        let creation = Self {
            path,
            backend: backend.into(),
            state,
            _lock: lock,
        };
        creation.save()?;
        Ok(creation)
    }
    fn save(&self) -> Result<()> {
        let mut file =
            tempfile::NamedTempFile::new_in(self.path.parent().context("checkpoint parent")?)?;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
        serde_json::to_writer(&mut file, &self.state)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(&self.path)?;
        Ok(())
    }
    /// Create once, or resume an acknowledged source without replaying its key-rotating request.
    ///
    /// # Errors
    /// Returns an error for unavailable service, credential storage, or checkpoint persistence.
    pub async fn create(
        &mut self,
        client: &rpc::SourceClient,
    ) -> Result<(rpc::SourceInfo, String)> {
        if let Some(source) = &self.state.source {
            ensure!(
                storage::get(&config::publishable_account(&self.backend, &source.id))?.is_some(),
                "the saved SDK key is missing; connect with init --source {} to recover explicitly",
                source.id
            );
            return Ok((
                source.clone(),
                self.state.ingest_url.clone().context("saved ingest URL")?,
            ));
        }
        let created = client
            .create_source(&rpc::CreateSourceRequest {
                name: alias(&self.state.title),
                title: Some(self.state.title.clone()),
                geo_enabled: Some(true),
                request_id: self.state.request_id.clone(),
            })
            .await
            .map_err(service_error)?;
        storage::set(
            &config::publishable_account(&self.backend, &created.source.id),
            &created.publishable_key,
        )?;
        self.state.source = Some(created.source.clone());
        self.state.ingest_url = Some(created.ingest_url.clone());
        self.save()?;
        Ok((created.source, created.ingest_url))
    }
    /// Clear the checkpoint only after the local workspace has committed.
    ///
    /// # Errors
    /// Returns an error if retry metadata cannot be removed.
    pub fn finish(self) -> Result<()> {
        fs::remove_file(&self.path)?;
        Ok(())
    }
}
