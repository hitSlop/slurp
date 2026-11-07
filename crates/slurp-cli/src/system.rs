//! Shared system settings and a local project index; event data stays in each project's storage.
use crate::Workspace;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use slurp_client::config;
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

/// Editable system defaults. Credential values stay in the selected private store.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Settings {
    /// Private file storage by default; Keychain is an explicit alternative.
    #[serde(default)]
    pub credential_store: slurp_client::storage::Store,
    /// Default API for new workspaces and cloud commands outside a bound workspace.
    pub backend: Option<String>,
    /// Default library root, containing a separate folder for each new project.
    pub library_dir: Option<PathBuf>,
    /// Qualified external or managed DuckDB executable.
    pub duckdb: Option<PathBuf>,
}

fn set(document: &mut toml_edit::DocumentMut, name: &str, text: &str) {
    let decoration = document
        .get(name)
        .and_then(toml_edit::Item::as_value)
        .map(|value| value.decor().clone());
    let mut value = toml_edit::Value::from(text);
    if let Some(decoration) = decoration {
        *value.decor_mut() = decoration;
    }
    document[name] = toml_edit::Item::Value(value);
}

/// Change config.toml under a lock, retaining its comments and unrelated settings.
fn edit(home: &Path, change: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<()>) -> Result<()> {
    use fs2::FileExt;
    prepare(home)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(home.join("settings.lock"))?;
    lock.lock_exclusive()?;
    let path = home.join("config.toml");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let mut document: toml_edit::DocumentMut = text.parse().context("reading system settings")?;
    change(&mut document)?;
    let mut file = tempfile::NamedTempFile::new_in(home)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(document.to_string().as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}

/// Save machine preferences while retaining comments and unrelated TOML settings.
///
/// # Errors
/// Returns an error for invalid configuration or an unwritable Slurp home.
pub fn save_machine(home: &Path, backend: &str, library: &Path, duckdb: &Path) -> Result<()> {
    edit(home, |document| {
        set(document, "backend", &config::normalize_backend(backend)?);
        set(document, "library_dir", library.to_string_lossy().as_ref());
        set(document, "duckdb", duckdb.to_string_lossy().as_ref());
        Ok(())
    })
}

/// Make this Worker the machine's default, the one new projects and cloud commands use.
///
/// # Errors
/// Returns an error for an invalid URL or an unwritable Slurp home.
pub fn set_backend(home: &Path, backend: &str) -> Result<()> {
    edit(home, |document| {
        set(document, "backend", &config::normalize_backend(backend)?);
        Ok(())
    })
}

/// Read system settings without creating files.
///
/// # Errors
/// Returns an error for invalid TOML, invalid backend URLs, or unreadable settings.
pub fn settings(home: &Path) -> Result<Settings> {
    let path = home.join("config.toml");
    let mut settings: Settings = match fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).with_context(|| format!("reading {}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let backend = settings
        .backend
        .take()
        .unwrap_or_else(|| config::DEFAULT_BACKEND.to_owned());
    settings.backend = Some(config::normalize_backend(&backend)?);
    Ok(settings)
}

fn prepare(home: &Path) -> Result<()> {
    fs::create_dir_all(home)?;
    fs::set_permissions(home, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Create default settings only when absent, preserving user edits.
///
/// # Errors
/// Returns an error if settings are invalid or cannot be persisted.
pub fn ensure_settings(home: &Path) -> Result<()> {
    let settings = settings(home)?;
    prepare(home)?;
    let path = home.join("config.toml");
    if path.exists() {
        return Ok(());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(home)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    temporary.write_all(toml::to_string_pretty(&settings)?.as_bytes())?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(&path) {
        Ok(_) => {}
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Non-secret location and binding of a registered project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Project {
    pub name: String,
    pub root: PathBuf,
    pub backend: String,
    pub project: String,
    pub database: PathBuf,
    pub duckdb: PathBuf,
    pub registered_at: String,
}

#[derive(Serialize, Deserialize)]
struct Registry {
    version: u32,
    projects: Vec<Project>,
}

/// List registered metadata without opening databases or removing unavailable projects.
///
/// # Errors
/// Returns an error for an unreadable, invalid, or incompatible project index.
pub fn projects(home: &Path) -> Result<Vec<Project>> {
    let path = home.join("projects.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let registry: Registry = serde_json::from_slice(&bytes)
                .with_context(|| format!("reading {}", path.display()))?;
            ensure!(
                registry.version == 1,
                "project index version is incompatible"
            );
            Ok(registry.projects)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

fn update(home: &Path, edit: impl FnOnce(&mut Vec<Project>)) -> Result<()> {
    use fs2::FileExt;
    prepare(home)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(home.join("projects.lock"))?;
    lock.lock_exclusive()?;
    let mut projects = projects(home)?;
    edit(&mut projects);
    projects.sort_by(|a, b| a.root.cmp(&b.root));
    let mut file = tempfile::NamedTempFile::new_in(home)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer_pretty(
        &mut file,
        &Registry {
            version: 1,
            projects,
        },
    )?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    file.persist(home.join("projects.json"))?;
    Ok(())
}

/// Register a verified workspace by canonical project path, without moving any data.
///
/// # Errors
/// Returns an error when the project path, settings, or project index is unavailable.
pub fn register(home: &Path, root: &Path, workspace: &Workspace) -> Result<()> {
    let root = root.canonicalize()?;
    ensure_settings(home)?;
    update(home, |projects| {
        let previous = projects.iter().find(|project| project.root == root);
        let project = Project {
            name: root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.display().to_string()),
            root: root.clone(),
            backend: workspace.backend.clone(),
            project: workspace.project.clone(),
            database: workspace.database.clone(),
            duckdb: workspace.duckdb.clone(),
            registered_at: previous
                .map(|project| project.registered_at.clone())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        };
        projects.retain(|project| project.root != root);
        projects.push(project);
    })
}

/// Forget a location in the project index; no project or database files are removed.
///
/// # Errors
/// Returns an error if the project index cannot be updated.
pub fn forget(home: &Path, root: &Path) -> Result<()> {
    update(home, |projects| {
        projects.retain(|project| project.root != root)
    })
}
