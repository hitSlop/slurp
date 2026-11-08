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

pub use slurp_client::config::Settings;

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
    if path.exists() {
        config::settings_at(home)?;
    }
    document["version"] = toml_edit::value(1);
    change(&mut document)?;
    slurp_client::files::write_atomic(&path, document.to_string().as_bytes())
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
    let mut settings = config::settings_at(home)?;
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
            let header: serde_json::Value = serde_json::from_slice(&bytes)?;
            config::check_version(&path, header["version"].as_u64(), 1, "slurp init")?;
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
    let mut text = serde_json::to_string_pretty(&Registry {
        version: 1,
        projects,
    })?;
    text.push('\n');
    slurp_client::files::write_atomic(&home.join("projects.json"), text.as_bytes())
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
            name: workspace.name.clone(),
            root: root.clone(),
            backend: workspace.backend.clone(),
            project: workspace.project.clone(),
            database: workspace.database.clone(),
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

pub fn registration_for(home: &Path, root: &Path) -> Result<Option<Project>> {
    let root = root.canonicalize()?;
    Ok(projects(home)?.into_iter().find(|p| p.root == root))
}
pub fn set_engine(home: &Path, engine: &Path) -> Result<()> {
    edit(home, |document| {
        set(document, "duckdb", engine.to_string_lossy().as_ref());
        Ok(())
    })
}

/// Preserve the old location before explicitly resetting a checkout's local registration.
pub fn reset_registration(home: &Path, root: &Path) -> Result<()> {
    if let Some(registration) = registration_for(home, root)? {
        let backup = home
            .join("registration-backups")
            .join(format!("{}.json", uuid::Uuid::now_v7()));
        slurp_client::files::write_atomic(&backup, &serde_json::to_vec_pretty(&registration)?)?;
        forget(home, root)?;
        eprintln!("previous registration saved at {}", backup.display());
    }
    Ok(())
}

#[cfg(test)]
mod version_tests {
    #[test]
    fn future_project_index_is_neither_read_nor_rewritten() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("projects.json");
        for text in [r#"{"version":2}"#, r#"{"version":0}"#, r#"{}"#] {
            std::fs::write(&path, text).unwrap();
            assert!(super::projects(home.path()).is_err());
            assert!(super::forget(home.path(), home.path()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        }
    }
    #[test]
    fn project_binding_version_is_checked_before_its_payload() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("slurp")).unwrap();
        let path = root.path().join("slurp/slurp.toml");
        std::fs::write(&path, "version=2").unwrap();
        let error = crate::Workspace::read_binding(root.path()).unwrap_err();
        assert!(error.to_string().contains("newer Slurp"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "version=2");
    }
    #[test]
    fn settings_writes_refuse_unsupported_documents() {
        let home = tempfile::tempdir().unwrap();
        for text in ["version=2", "version=0", "backend='https://example.com'"] {
            let path = home.path().join("config.toml");
            std::fs::write(&path, text).unwrap();
            assert!(super::set_backend(home.path(), "https://example.com").is_err());
            assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        }
    }
}
