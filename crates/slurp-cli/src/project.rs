//! Explicit and nearest-parent project discovery, independent of DuckDB availability.
use crate::{
    Workspace,
    error::{ErrorCode, Failure},
};
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Find the nearest initialized project without falling through invalid metadata.
///
/// # Errors
/// Returns an error for an unreadable search location or invalid nearest project.
pub fn discover(start: &Path) -> Result<Option<PathBuf>> {
    let start = start.canonicalize().context("resolving current folder")?;
    ensure!(start.is_dir(), "project search must start in a folder");
    for root in start.ancestors() {
        let path = root.join(".slurp/project.toml");
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                Workspace::read_binding(root)
                    .with_context(|| format!("nearest project configuration at {} is invalid or unreadable; repair it before retrying", root.display()))?;
                return Ok(Some(root.to_path_buf()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        }
    }
    Ok(None)
}

/// Select an exact explicit workspace, or discover the nearest parent of the current folder.
///
/// # Errors
/// Returns an actionable failure when no project exists or its binding is invalid.
pub fn resolve(start: &Path, explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        let root = if path.is_absolute() {
            path.to_path_buf()
        } else {
            start.join(path)
        };
        let root = root.canonicalize().context("resolving --project")?;
        Workspace::read_binding(&root).with_context(|| {
            format!(
                "--project must select an initialized project folder: {}",
                root.display()
            )
        })?;
        return Ok(root);
    }
    discover(start)?.ok_or_else(|| Failure::new(ErrorCode::WorkspaceUnavailable, "no Slurp project found; run inside an initialized app, pass --project PATH, or use --source for explicit ingestion").into())
}
