//! Project-local and user-selected data paths; no global library preference.
use crate::error::{ErrorCode, Failure};
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// Resolve a path relative to a workspace, expanding only the current user's `~/`.
///
/// # Errors
/// Returns an error when the workspace or home cannot be resolved.
pub fn resolve(root: &Path, path: &Path) -> Result<PathBuf> {
    let path = if path == Path::new("~") || path.starts_with("~/") {
        let home =
            PathBuf::from(std::env::var_os("HOME").context("HOME is required for ~/ paths")?);
        home.join(path.strip_prefix("~")?)
    } else {
        path.to_path_buf()
    };
    let absolute = if path.is_absolute() {
        path
    } else {
        root.canonicalize()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            _ => normalized.push(part.as_os_str()),
        }
    }
    // Resolve existing ancestors, including symlinked mount aliases, without creating anything.
    let mut ancestor = normalized.as_path();
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(
            ancestor
                .file_name()
                .context("invalid storage path")?
                .to_os_string(),
        );
        ancestor = ancestor.parent().context("storage parent")?;
    }
    let mut result = ancestor.canonicalize()?;
    for component in suffix.into_iter().rev() {
        result.push(component);
    }
    Ok(result)
}

/// Choose the database file. A data directory contains `events.duckdb`.
///
/// # Errors
/// Returns an error for conflicting options or invalid paths.
pub fn database_path(
    root: &Path,
    data_dir: Option<&Path>,
    database: Option<&Path>,
) -> Result<PathBuf> {
    ensure!(
        data_dir.is_none() || database.is_none(),
        "use either --data-dir or --database, not both"
    );
    let path = match (data_dir, database) {
        (Some(dir), _) => {
            ensure!(
                !dir.as_os_str().is_empty(),
                "data directory cannot be empty"
            );
            dir.join("events.duckdb")
        }
        (_, Some(file)) => file.to_path_buf(),
        _ => anyhow::bail!(
            "choose --data-dir or --database; project initialization selects the machine library"
        ),
    };
    resolve(root, &path)
}

/// Prepare writable storage, creating only the final directory outside the workspace.
///
/// # Errors
/// Returns an error for an unavailable external parent, read-only storage, or I/O failure.
pub fn prepare(root: &Path, database: &Path) -> Result<()> {
    let parent = database.parent().context("database parent")?;
    if !parent.starts_with(root.canonicalize()?) && !parent.is_dir() {
        let base = parent.parent().context("data directory parent")?;
        ensure!(
            base.is_dir(),
            "storage parent {} is unavailable; connect the drive or choose an existing parent folder",
            base.display()
        );
        fs::create_dir(parent)?;
    } else {
        fs::create_dir_all(parent)?;
    }
    tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("data directory {} is not writable", parent.display()))?;
    Ok(())
}

/// Require the configured file; ordinary operations never recreate missing storage.
///
/// # Errors
/// Returns `storage_unavailable` if the database file is absent.
pub fn require_database(database: &Path) -> Result<()> {
    if !database.is_file() {
        return Err(Failure::new(ErrorCode::StorageUnavailable, format!("Event storage is unavailable at {}. Reconnect the drive or restore the original database; Slurp will not create a replacement.", database.display())).into());
    }
    Ok(())
}
