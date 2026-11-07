//! Offline installation of the bundled Slurp skills and analytical resources.
//!
//! The whole `skills/` tree is embedded at build time, so adding a query or reference file to `skills/slurp/` ships
//! automatically (and `cargo install` works, because the sources live inside this crate).
use anyhow::{Context, Result, ensure};
use include_dir::{Dir, DirEntry, include_dir};
use std::{fs, path::Path};

static SKILLS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/skills");

/// Skills installed beside `slurp` by `--all`.
const COMPANIONS: [&str; 3] = ["slurp-instrument", "slurp-analyze", "slurp-improve"];

/// One file to write, relative to its skill folder.
struct File {
    relative: String,
    content: &'static [u8],
}

fn skill_file(name: &str) -> Result<&'static [u8]> {
    SKILLS
        .get_file(format!("{name}/SKILL.md"))
        .map(|file| file.contents())
        .with_context(|| format!("bundled skill {name} is missing SKILL.md"))
}

/// Shared analytical resources (queries, references): everything under `skills/slurp` except its SKILL.md.
fn resources(dir: &'static Dir<'static>, root: &Path, out: &mut Vec<File>) {
    for entry in dir.entries() {
        match entry {
            DirEntry::Dir(child) => resources(child, root, out),
            DirEntry::File(file) => {
                let relative = file
                    .path()
                    .strip_prefix(root)
                    .unwrap_or(file.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative != "SKILL.md" {
                    out.push(File {
                        relative,
                        content: file.contents(),
                    });
                }
            }
        }
    }
}

fn package_files(name: &str) -> Result<Vec<File>> {
    let base = SKILLS
        .get_dir("slurp")
        .context("bundled slurp skill is missing")?;
    let mut files = vec![File {
        relative: "SKILL.md".into(),
        content: skill_file(name)?,
    }];
    resources(base, Path::new("slurp"), &mut files);
    Ok(files)
}

/// Install a self-contained skill. Existing edits require explicit replacement.
///
/// # Errors
/// Returns an error for symlinks, conflicting files, or filesystem failures.
pub fn install(out: &Path, force: bool, all: bool) -> Result<()> {
    let mut packages = vec![(out.to_path_buf(), package_files("slurp")?)];
    if all {
        let parent = out.parent().context("skill output parent")?;
        for name in COMPANIONS {
            packages.push((parent.join(name), package_files(name)?));
        }
    }
    for (root, files) in &packages {
        for file in files {
            let path = root.join(&file.relative);
            let mut ancestor = Some(path.as_path());
            while let Some(p) = ancestor {
                if let Ok(meta) = fs::symlink_metadata(p) {
                    ensure!(
                        !meta.file_type().is_symlink(),
                        "refusing symlink: {}",
                        p.display()
                    );
                }
                if p == root {
                    break;
                }
                ancestor = p.parent();
            }
            if path.exists() {
                ensure!(path.is_file(), "not a file: {}", path.display());
                ensure!(
                    force || fs::read(&path)? == file.content,
                    "modified skill file {}; use --force to replace it",
                    path.display()
                );
            }
        }
    }
    for (root, files) in packages {
        for file in files {
            let path = root.join(&file.relative);
            slurp_client::files::write_atomic(&path, file.content)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_skill_installs_with_the_shared_resources() {
        let dir = tempfile::tempdir().unwrap();
        install(&dir.path().join("slurp"), false, true).unwrap();
        for name in [
            "slurp",
            "slurp-instrument",
            "slurp-analyze",
            "slurp-improve",
        ] {
            let skill = fs::read_to_string(dir.path().join(name).join("SKILL.md")).unwrap();
            assert!(
                skill.contains(&format!("\nname: {name}\n")),
                "{name} installs its own SKILL.md"
            );
            for shared in ["queries/activation.sql", "references/analysis.md"] {
                assert!(
                    dir.path().join(name).join(shared).is_file(),
                    "{name}/{shared}"
                );
            }
        }
        // installing again is idempotent; edits are protected unless forced
        install(&dir.path().join("slurp"), false, true).unwrap();
        fs::write(dir.path().join("slurp/SKILL.md"), "edited").unwrap();
        assert!(install(&dir.path().join("slurp"), false, false).is_err());
        install(&dir.path().join("slurp"), true, false).unwrap();
        assert_ne!(
            fs::read_to_string(dir.path().join("slurp/SKILL.md")).unwrap(),
            "edited"
        );
    }
}
