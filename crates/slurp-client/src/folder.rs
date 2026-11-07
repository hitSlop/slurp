//! Portable downloaded archives. Only source.json commits a delivery; temporary
//! files and renamed-but-uncommitted objects never advance download progress.
use crate::archive::{is_jsonl, open_jsonl};
use crate::{Remote, RemoteError, parse_key, protocol};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub backend: String,
    pub source: String,
    pub active_archive: Option<String>,
    pub archives: Vec<Archive>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Archive {
    pub id: String,
    /// Immutable first sequence this folder bootstrapped from.
    pub bootstrap: String,
    pub objects: Vec<Object>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Object {
    pub sequence: String,
    pub key: String,
    pub path: String,
    pub size: u64,
    pub sha256: String,
    /// Validation cache only; never used to derive download/import progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_modified: Option<String>,
}
impl Archive {
    pub fn checkpoint(&self) -> Result<i64> {
        Ok(match self.objects.last() {
            Some(object) => protocol::parse_sequence(&object.sequence)?,
            None => protocol::parse_sequence(&self.bootstrap)? - 1,
        })
    }
}
#[derive(Debug, Serialize)]
pub struct SyncReport {
    pub outcome: String,
    pub archive: Option<String>,
    pub checkpoint: Option<String>,
    pub downloaded: usize,
    pub reused: usize,
    pub expected: Option<String>,
    pub first_retained: Option<String>,
}

pub struct Folder {
    root: PathBuf,
    manifest: Manifest,
    _lock: File,
}
fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn backend_url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("invalid folder backend URL");
    }
    Ok(url.to_string().trim_end_matches('/').into())
}
fn digest(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0;
    let mut buffer = [0; 256 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        size += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), size))
}
fn modified(path: &Path) -> Result<String> {
    Ok(fs::metadata(path)?
        .modified()?
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .to_string())
}

impl Folder {
    pub async fn open(root: &Path, backend: &str, source: &str) -> Result<Self> {
        if !safe_component(source) {
            bail!("invalid source ID");
        }
        let backend = backend_url(backend)?;
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        let lock = checked_path(&root, ".slurp.lock")?;
        let lock = crate::locking::acquire(lock).await?;
        let path = checked_path(&root, "source.json")?;
        let manifest: Manifest = if path.exists() {
            serde_json::from_slice(&fs::read(path)?)?
        } else {
            for item in fs::read_dir(&root)? {
                let name = item?.file_name();
                if name != ".slurp.lock" && name != "source.json.tmp" {
                    bail!("destination is not an empty event folder");
                }
            }
            Manifest {
                version: 1,
                backend: backend.clone(),
                source: source.into(),
                active_archive: None,
                archives: vec![],
            }
        };
        if manifest.version != 1 || manifest.backend != backend || manifest.source != source {
            bail!("event folder binding/version mismatch");
        }
        let mut folder = Self {
            root,
            manifest,
            _lock: lock,
        };
        folder.validate_inventory(false)?;
        folder.save()?;
        Ok(folder)
    }

    /// Open a copied folder without contacting the service or loading credentials.
    pub async fn load(root: &Path) -> Result<Self> {
        let path = checked_path(&root.canonicalize()?, "source.json")?;
        let binding: Manifest = serde_json::from_slice(&fs::read(path)?)?;
        Self::open(root, &binding.backend, &binding.source).await
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn save(&self) -> Result<()> {
        let temporary = checked_path(&self.root, "source.json.tmp")?;
        let mut file = File::create(&temporary)?;
        serde_json::to_writer_pretty(&mut file, &self.manifest)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(temporary, self.root.join("source.json"))?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    pub fn validate_inventory(&mut self, full_hash: bool) -> Result<()> {
        let mut seen = HashSet::new();
        for archive in &mut self.manifest.archives {
            if !safe_component(&archive.id) || !seen.insert(archive.id.clone()) {
                bail!("invalid or duplicate archive ID");
            }
            let mut expected = protocol::parse_sequence(&archive.bootstrap)?;
            if expected < 1 {
                bail!("invalid archive bootstrap position");
            }
            for (position, object) in archive.objects.iter_mut().enumerate() {
                if position > 0 {
                    expected = expected
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("archive sequence overflow"))?;
                }
                let key = parse_key(object.path.rsplit('/').next().unwrap_or_default())
                    .ok_or_else(|| anyhow::anyhow!("invalid manifest object name"))?;
                let relative = format!("archives/{}/events/{}", archive.id, key.name);
                if !is_jsonl(key.ext)
                    || object.path != relative
                    || object.key != relative
                    || key.sha256 != object.sha256
                    || protocol::parse_sequence(&object.sequence)? != expected
                    || key.sequence != expected
                {
                    bail!("manifest has a gap or conflicting object identity");
                }
                let path = checked_path(&self.root, &object.path)?;
                if !path.is_file() || fs::metadata(&path)?.len() != object.size {
                    bail!(
                        "manifest-listed object is missing or has the wrong size: {}",
                        object.path
                    );
                }
                let stamp = modified(&path)?;
                if full_hash || object.verified_modified.as_ref() != Some(&stamp) {
                    if digest(&path)? != (object.sha256.clone(), object.size) {
                        bail!(
                            "manifest-listed object failed SHA256 verification: {}",
                            object.path
                        );
                    }
                    object.verified_modified = Some(stamp);
                }
            }
        }
        if !self.manifest.archives.is_empty() && self.manifest.active_archive.is_none() {
            bail!("manifest archives have no active archive");
        }
        if self
            .manifest
            .active_archive
            .as_ref()
            .is_some_and(|id| !seen.contains(id))
        {
            bail!("active archive is missing from manifest");
        }
        Ok(())
    }

    pub async fn sync(&mut self, remote: &dyn Remote, accept_reset: bool) -> Result<SyncReport> {
        self.validate_inventory(false)?;
        let mut report = SyncReport {
            outcome: "complete".into(),
            archive: self.manifest.active_archive.clone(),
            checkpoint: None,
            downloaded: 0,
            reused: 0,
            expected: None,
            first_retained: None,
        };
        let Some(coverage) = remote.get_coverage().await? else {
            return Ok(report);
        };
        crate::Coverage::try_from(&coverage)?;
        if !safe_component(&coverage.archive_id) {
            bail!("invalid archive ID");
        }
        report.archive = Some(coverage.archive_id.clone());
        if self
            .manifest
            .active_archive
            .as_ref()
            .is_some_and(|id| id != &coverage.archive_id)
            && !accept_reset
        {
            report.outcome = "reset".into();
            return Ok(report);
        }
        let index = match self
            .manifest
            .archives
            .iter()
            .position(|a| a.id == coverage.archive_id)
        {
            Some(index) => index,
            None => {
                self.manifest.archives.push(Archive {
                    id: coverage.archive_id.clone(),
                    bootstrap: coverage.first_retained.clone(),
                    objects: vec![],
                });
                self.manifest.archives.len() - 1
            }
        };
        self.manifest.active_archive = Some(coverage.archive_id.clone());
        self.save()?;
        let directory = checked_path(
            &self.root,
            &format!("archives/{}/events", coverage.archive_id),
        )?;
        let mut local_names = HashMap::new();
        match fs::read_dir(directory) {
            Ok(entries) => {
                for entry in entries {
                    let name = entry?.file_name();
                    if let Some(key) = parse_key(&name.to_string_lossy())
                        && local_names
                            .insert(key.sequence, key.name.clone())
                            .is_some_and(|old| old != key.name)
                    {
                        bail!("local archive sequence has conflicting identities");
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut expired = 0;
        let mut delayed_for_test = false;
        loop {
            let checkpoint = self.manifest.archives[index].checkpoint()?;
            report.checkpoint = (checkpoint > 0).then(|| checkpoint.to_string());
            let page = match remote.list(Some(checkpoint), 1000).await {
                Ok(page) => page,
                Err(RemoteError::RetentionGap) => {
                    report.outcome = "gap".into();
                    report.expected = Some((checkpoint.saturating_add(1)).to_string());
                    report.first_retained = remote.get_coverage().await?.map(|c| c.first_retained);
                    return Ok(report);
                }
                Err(error) => return Err(error.into()),
            };
            protocol::validate_page(&page)?;
            let Some(current) = &page.coverage else {
                bail!("archive disappeared during synchronization");
            };
            if current.archive_id != coverage.archive_id {
                report.outcome = "reset".into();
                report.archive = Some(current.archive_id.clone());
                return Ok(report);
            }
            let floor = protocol::parse_sequence(&current.first_retained)?;
            if floor > checkpoint.saturating_add(1) {
                report.outcome = "gap".into();
                report.expected = Some((checkpoint.saturating_add(1)).to_string());
                report.first_retained = Some(current.first_retained.clone());
                return Ok(report);
            }
            let mut relist = false;
            for object in &page.objects {
                let expected = self.manifest.archives[index]
                    .checkpoint()?
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("sequence overflow"))?;
                let key = parse_key(&object.name)
                    .ok_or_else(|| anyhow::anyhow!("invalid archive object name"))?;
                if !is_jsonl(key.ext)
                    || key.sha256 != object.sha256
                    || key.sequence != protocol::parse_sequence(&object.seq)?
                {
                    bail!("conflicting archive object identity");
                }
                if key.sequence > expected {
                    report.outcome = "gap".into();
                    report.expected = Some(expected.to_string());
                    return Ok(report);
                }
                if key.sequence != expected {
                    bail!("nonascending or conflicting archive listing");
                }
                let relative = format!("archives/{}/events/{}", current.archive_id, key.name);
                let final_path = checked_path(&self.root, &relative)?;
                let parent = final_path.parent().unwrap();
                fs::create_dir_all(parent)?;
                checked_path(&self.root, &relative)?;
                if local_names
                    .get(&key.sequence)
                    .is_some_and(|name| name != &key.name)
                {
                    bail!("uncommitted local sequence has a conflicting identity");
                }
                let renamed = !final_path.exists();
                if !renamed {
                    if digest(&final_path)? != (object.sha256.clone(), object.size) {
                        bail!("uncommitted local object conflicts with published bytes");
                    }
                    report.reused += 1;
                } else {
                    let temporary = format!("{relative}.part");
                    let temporary = checked_path(&self.root, &temporary)?;
                    // Live-storage qualification can expire a freshly listed URL once.
                    // This leaves the production retry path and URL verification unchanged.
                    if !delayed_for_test {
                        delayed_for_test = true;
                        if let Ok(delay) = std::env::var("SLURP_TEST_FOLDER_DELAY_ONCE_MS") {
                            let delay: u64 = delay.parse()?;
                            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        }
                    }
                    match remote.download(object, &temporary).await {
                        Ok(identity) if identity == (object.sha256.clone(), object.size) => {}
                        Ok(_) => bail!("download failed size/SHA256 verification"),
                        Err(RemoteError::Expired) if expired < 3 => {
                            expired += 1;
                            relist = true;
                            break;
                        }
                        Err(error) => return Err(error.into()),
                    }
                    pause_for_test("after_download", &self.root)?;
                    File::open(&temporary)?.sync_all()?;
                    fs::rename(temporary, &final_path)?;
                    report.downloaded += 1;
                }
                File::open(&final_path)?.sync_all()?;
                let mut directory = Some(parent);
                while let Some(path) = directory {
                    File::open(path)?.sync_all()?;
                    if path == self.root {
                        break;
                    }
                    directory = path.parent();
                }
                if renamed {
                    pause_for_test("after_rename", &self.root)?;
                }
                local_names.insert(key.sequence, key.name.clone());
                self.manifest.archives[index].objects.push(Object {
                    sequence: object.seq.clone(),
                    key: relative.clone(),
                    path: relative,
                    size: object.size,
                    sha256: object.sha256.clone(),
                    verified_modified: Some(modified(&final_path)?),
                });
                self.save()?;
                pause_for_test("after_manifest", &self.root)?;
                expired = 0;
            }
            let checkpoint = self.manifest.archives[index].checkpoint()?;
            report.checkpoint = (checkpoint > 0).then(|| checkpoint.to_string());
            if relist {
                continue;
            }
            if let Some(after) = &page.next_after {
                if page.objects.is_empty() || protocol::parse_sequence(after)? != checkpoint {
                    bail!("invalid pagination cursor");
                }
            } else {
                if current
                    .latest_published
                    .as_ref()
                    .map(|s| protocol::parse_sequence(s))
                    .transpose()?
                    .is_some_and(|latest| latest > checkpoint)
                {
                    report.outcome = "gap".into();
                    report.expected = Some((checkpoint.saturating_add(1)).to_string());
                }
                return Ok(report);
            }
        }
    }

    /// Export without changing either download or import progress.
    pub fn read(
        &mut self,
        output: &mut dyn Write,
        archive: Option<&str>,
        after: Option<i64>,
    ) -> Result<()> {
        if after.is_some_and(|value| value < 0) {
            bail!("object sequence must be nonnegative");
        }
        if after.is_some() && archive.is_none() {
            bail!("--after requires an explicitly selected archive");
        }
        self.validate_inventory(true)?;
        let selected = match archive {
            Some(id) => self
                .manifest
                .archives
                .iter()
                .find(|a| a.id == id)
                .ok_or_else(|| anyhow::anyhow!("unknown archive"))?,
            None if self.manifest.archives.len() == 1 => &self.manifest.archives[0],
            None if self.manifest.archives.is_empty() => return Ok(()),
            None => bail!("select an archive when reading a folder with archive resets"),
        };
        for object in &selected.objects {
            if after.is_some_and(|after| {
                protocol::parse_sequence(&object.sequence).is_ok_and(|seq| seq <= after)
            }) {
                continue;
            }
            std::io::copy(
                &mut open_jsonl(&checked_path(&self.root, &object.path)?)?,
                output,
            )?;
        }
        Ok(())
    }
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        let std::path::Component::Normal(name) = component else {
            bail!("unsafe event folder path");
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!("event folders cannot contain symlink paths")
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    Ok(path)
}

// The integration harness SIGKILLs an isolated child at the durability boundaries.
fn pause_for_test(point: &str, root: &Path) -> Result<()> {
    if std::env::var("SLURP_TEST_FOLDER_PAUSE").as_deref() == Ok(point) {
        fs::write(root.join(".paused"), point)?;
        loop {
            std::thread::park();
        }
    }
    Ok(())
}
