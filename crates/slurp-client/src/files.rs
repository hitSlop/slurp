//! Small file helpers shared by the client and the CLI.
use anyhow::{Context, Result};
use std::{fs, io::Write, path::Path};

/// Replace `path` with `bytes` atomically: write a temporary file in the same folder, flush it to disk, then rename it over the
/// target. A reader sees the old file or the new one, never half of either. The file is private to the user (`0600`).
///
/// Credentials have stricter checks (owner, links, locking) and use `storage` instead.
///
/// # Errors
/// Returns an error if the folder cannot be created or the file cannot be written.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("the file needs a parent folder")?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)
        .with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn replaces_whole_files_privately_and_creates_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/value.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let names: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(names.len(), 1, "no temporary file is left behind");
    }
}
