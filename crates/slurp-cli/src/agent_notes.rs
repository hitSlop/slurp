//! Optional project reminders; existing instructions remain authoritative.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

/// Short reminder shown before setup offers to append it.
pub const REMINDER: &str = "When changing product workflows, use Slurp’s skills to instrument meaningful outcomes, review available usage data, and record findings and proposed improvements. Production experiments and releases require human approval.";
const START: &str = "<!-- slurp:feedback:start -->";
const END: &str = "<!-- slurp:feedback:end -->";

/// Outcome of an explicit request to append reminders to existing instruction files.
#[derive(Debug, Default, Serialize)]
pub struct NoteReport {
    pub updated: Vec<PathBuf>,
    pub unchanged: Vec<PathBuf>,
    pub skipped: Vec<PathBuf>,
    pub suggestion: String,
}

/// Whether the project has a root instruction file (including a symlink).
pub fn available(root: &Path) -> bool {
    ["AGENTS.md", "CLAUDE.md"]
        .iter()
        .any(|name| fs::symlink_metadata(root.join(name)).is_ok())
}

/// Append once to existing project-root instruction files, respecting aliases and permissions.
///
/// # Errors
/// Returns an error for unreadable or unwritable instruction files. Links outside the project are skipped.
pub fn append(root: &Path) -> Result<NoteReport> {
    let root = root.canonicalize()?;
    let mut result = NoteReport {
        suggestion: REMINDER.to_owned(),
        ..Default::default()
    };
    let mut seen = HashSet::new();
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
            Ok(_) => {}
        }
        let target = match path.canonicalize() {
            Ok(target) if target.starts_with(&root) && target.is_file() => target,
            _ => {
                result.skipped.push(path);
                continue;
            }
        };
        let mut file = fs::OpenOptions::new()
            .read(true)
            .append(true)
            .open(&target)
            .with_context(|| format!("cannot update {}", path.display()))?;
        file.lock_exclusive()?;
        let metadata = file.metadata()?;
        if !seen.insert((metadata.dev(), metadata.ino())) {
            continue;
        }
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        if contents.contains(START) {
            result.unchanged.push(path);
            continue;
        }
        ensure!(
            !contents.contains(END),
            "incomplete Slurp reminder in {}; repair the existing block first",
            path.display()
        );
        let newline = if contents.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let separator = if contents.is_empty() {
            "".to_owned()
        } else if contents.ends_with('\n') {
            newline.to_owned()
        } else {
            newline.repeat(2)
        };
        write!(
            file,
            "{separator}{START}{newline}{REMINDER}{newline}{END}{newline}"
        )?;
        file.sync_all()?;
        result.updated.push(path);
    }
    Ok(result)
}
