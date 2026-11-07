//! Read-only volume discovery and guarded project library creation.
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    process::Command,
};

/// A mounted storage candidate. Identity is rechecked before creating its library.
#[derive(Debug, Clone)]
pub struct Drive {
    pub name: String,
    pub mount: PathBuf,
    pub available_bytes: u64,
    pub solid_state: Option<bool>,
    device: u64,
    inode: u64,
}
impl Drive {
    /// Preview the shared library root without creating directories.
    ///
    /// # Errors
    /// Returns an error if the drive changed or the library is redirected.
    pub fn library_directory(&self) -> Result<PathBuf> {
        self.verify()?;
        let path = self.mount.join("SlurpLibrary");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            ensure!(
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && metadata.dev() == self.device,
                "library must be a directory on the selected drive"
            );
        }
        Ok(path)
    }
    /// Create only the library root on a selected drive after confirmation.
    ///
    /// # Errors
    /// Returns an error if the drive changes or the library is not writable.
    pub fn prepare_library(&self) -> Result<PathBuf> {
        let path = self.library_directory()?;
        self.verify()?;
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        self.library_directory()?;
        tempfile::NamedTempFile::new_in(&path).context("selected library is not writable")?;
        Ok(path)
    }
    /// Capture a selected directory's identity without writing to it.
    ///
    /// # Errors
    /// Returns an error if the selected location is unavailable or not a directory.
    pub fn from_path(path: &Path, name: String, solid_state: Option<bool>) -> Result<Self> {
        let mount = path.canonicalize()?;
        let metadata = fs::metadata(&mount)?;
        ensure!(metadata.is_dir(), "select a mounted directory");
        Ok(Self {
            available_bytes: fs2::available_space(&mount)?,
            mount,
            name,
            solid_state,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    /// Verify this captured directory still identifies the selected storage.
    ///
    /// # Errors
    /// Returns an error if the location is missing or has been replaced.
    pub fn verify(&self) -> Result<()> {
        let metadata = fs::metadata(&self.mount).with_context(|| {
            format!(
                "{} is unavailable; reconnect the drive",
                self.mount.display()
            )
        })?;
        ensure!(
            metadata.dev() == self.device && metadata.ino() == self.inode,
            "the selected drive changed at {}; rescan and select it again",
            self.mount.display()
        );
        Ok(())
    }
    /// Preview a project-specific path. Existing database files require another folder name.
    ///
    /// # Errors
    /// Returns an error for unsafe names, redirected folders, collisions or an unavailable drive.
    pub fn project_directory(&self, project: &str) -> Result<PathBuf> {
        self.verify()?;
        let mut parts = Path::new(project).components();
        ensure!(
            matches!(parts.next(), Some(Component::Normal(_)))
                && parts.next().is_none()
                && !project.trim().is_empty()
                && !project.contains('\\'),
            "enter one project folder name, without separators"
        );
        let library = self.mount.join("SlurpLibrary");
        let directory = library.join(project);
        for path in [&library, &directory] {
            if let Ok(metadata) = fs::symlink_metadata(path) {
                ensure!(
                    metadata.is_dir() && !metadata.file_type().is_symlink(),
                    "{} must be a regular directory, not a link or file",
                    path.display()
                );
            }
        }
        ensure!(
            !directory.join("events.duckdb").exists(),
            "that folder already contains events.duckdb; choose another project name"
        );
        Ok(directory)
    }
    /// Create a library beneath this verified volume, only after setup confirmation.
    ///
    /// # Errors
    /// Returns an error if the volume changes, a folder is redirected, or storage is unwritable.
    pub fn prepare_project(&self, project: &str) -> Result<PathBuf> {
        let directory = self.project_directory(project)?;
        for path in [self.mount.join("SlurpLibrary"), directory.clone()] {
            self.verify()?;
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            let metadata = fs::symlink_metadata(&path)?;
            ensure!(
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && metadata.dev() == self.device,
                "storage changed at {}; select the drive again",
                path.display()
            );
        }
        self.verify()?;
        tempfile::NamedTempFile::new_in(&directory).context("selected storage is not writable")?;
        Ok(directory)
    }
}

/// Discover writable external volumes on macOS or mounted local devices on Linux.
///
/// # Errors
/// Returns an error when the platform's mount inventory is unavailable; callers can offer manual entry.
pub fn discover() -> Result<Vec<Drive>> {
    #[cfg(target_os = "macos")]
    let mut drives = {
        let mut result = Vec::new();
        for entry in fs::read_dir("/Volumes")? {
            let path = entry?.path();
            let output = Command::new("/usr/sbin/diskutil")
                .args(["info", "-plist"])
                .arg(path)
                .output()?;
            if output.status.success()
                && let Ok(volume) = plist::from_bytes::<MacVolume>(&output.stdout)
                && let Some(drive) = volume.into_drive()
            {
                result.push(drive);
            }
        }
        result
    };
    #[cfg(target_os = "linux")]
    let mut drives = {
        let output = Command::new("findmnt")
            .args([
                "--list",
                "--json",
                "--real",
                "--output",
                "TARGET,SOURCE,FSTYPE,OPTIONS",
            ])
            .output()?;
        ensure!(
            output.status.success(),
            "mounted drive inventory is unavailable; enter a folder manually"
        );
        let mounts: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        mounts["filesystems"]
            .as_array()
            .context("mount inventory")?
            .iter()
            .filter_map(linux_drive)
            .collect::<Vec<_>>()
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let mut drives: Vec<Drive> = Vec::new();
    drives.sort_by(|a, b| a.mount.cmp(&b.mount));
    drives.dedup_by(|a, b| a.mount == b.mount);
    Ok(drives)
}

#[cfg(target_os = "macos")]
#[derive(serde::Deserialize)]
struct MacVolume {
    #[serde(rename = "Internal", default)]
    internal: Option<bool>,
    #[serde(rename = "WritableVolume", default)]
    writable: bool,
    #[serde(rename = "APFSSnapshot", default)]
    snapshot: bool,
    #[serde(rename = "MountPoint")]
    mount: Option<PathBuf>,
    #[serde(rename = "VolumeName")]
    name: Option<String>,
    #[serde(rename = "SolidState")]
    solid_state: Option<bool>,
}
#[cfg(target_os = "macos")]
impl MacVolume {
    fn into_drive(self) -> Option<Drive> {
        if self.internal != Some(false) || !self.writable || self.snapshot {
            return None;
        }
        let mount = self.mount?;
        if !mount.starts_with("/Volumes") || mount == Path::new("/Volumes") {
            return None;
        }
        Drive::from_path(
            &mount,
            self.name.unwrap_or_else(|| mount.display().to_string()),
            self.solid_state,
        )
        .ok()
    }
}
#[cfg(any(target_os = "linux", test))]
fn linux_drive(row: &serde_json::Value) -> Option<Drive> {
    let path = Path::new(row["target"].as_str()?);
    let device = row["source"].as_str()?;
    let options = row["options"].as_str()?;
    let fs = row["fstype"].as_str()?;
    if !["/media", "/run/media", "/mnt"]
        .iter()
        .any(|base| path.starts_with(base) && path != Path::new(base))
        || !device.starts_with("/dev/")
        || options.split(',').any(|v| v == "ro")
        || matches!(fs, "nfs" | "nfs4" | "cifs" | "smbfs" | "fuse" | "tmpfs")
    {
        return None;
    }
    Drive::from_path(path, path.file_name()?.to_string_lossy().into_owned(), None).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_inventory_excludes_root_network_and_readonly_mounts() {
        for (target, source, options) in [
            ("/", "/dev/sda1", "rw"),
            ("/mnt/nas", "server:/share", "rw"),
            ("/media/backup", "/dev/sdb1", "ro"),
        ] {
            assert!(linux_drive(&serde_json::json!({"target":target,"source":source,"options":options,"fstype":"ext4"})).is_none());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_inventory_excludes_internal_readonly_and_snapshots() {
        for fields in [
            "<key>Internal</key><true/><key>WritableVolume</key><true/>",
            "<key>Internal</key><false/><key>WritableVolume</key><false/>",
            "<key>Internal</key><false/><key>WritableVolume</key><true/><key>APFSSnapshot</key><true/>",
        ] {
            let xml = format!("<plist version=\"1.0\"><dict>{fields}</dict></plist>");
            let volume: MacVolume = plist::from_bytes(xml.as_bytes()).expect("parse fixture");
            assert!(volume.into_drive().is_none());
        }
    }
}
