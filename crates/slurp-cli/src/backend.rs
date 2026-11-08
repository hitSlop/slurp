//! Resolve a backend consistently for setup, initialization, and cloud commands.
use anyhow::{Context, Result};
use slurp_app::system;
use slurp_client::config;
use std::{fs, path::Path};

/// Like [`resolve`], but `SLURP_BACKEND` stands in for an explicit `--backend`.
pub fn resolve_with_environment(
    root: &Path,
    home: &Path,
    explicit: Option<&str>,
) -> Result<String> {
    let environment = config::env_value("SLURP_BACKEND");
    resolve(root, home, explicit.or(environment.as_deref()))
}

pub fn resolve(root: &Path, home: &Path, explicit: Option<&str>) -> Result<String> {
    if let Some(value) = explicit {
        return config::normalize_backend(value);
    }
    let path = root.join("slurp/slurp.toml");
    match fs::read_to_string(&path) {
        Ok(_) => {
            let saved = slurp_app::Workspace::read_binding(root)?;
            return config::normalize_backend(&saved.backend);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    }
    Ok(system::settings(home)?
        .backend
        .unwrap_or_else(|| config::DEFAULT_BACKEND.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_precedence_preserves_workspace_and_allows_self_hosted_settings() {
        let root = tempfile::tempdir().expect("project");
        let home = tempfile::tempdir().expect("preferences");
        let resolve = |value| super::resolve(root.path(), home.path(), value);
        assert_eq!(resolve(None).expect("default"), config::DEFAULT_BACKEND);
        fs::write(
            home.path().join("config.toml"),
            "version = 1\nbackend = 'http://localhost:8079'\n",
        )
        .expect("system setting");
        assert_eq!(resolve(None).expect("system"), "http://localhost:8079");
        fs::create_dir(root.path().join("slurp")).expect("project directory");
        fs::write(
            root.path().join("slurp/slurp.toml"),
            "version = 1\nname = 'test'\nproject = 'prj_test'\nbackend = 'http://localhost:8082/'\n",
        )
        .expect("project preference");
        assert_eq!(resolve(None).expect("project"), "http://localhost:8082");
        assert_eq!(
            resolve(Some("http://localhost:8083/")).expect("explicit"),
            "http://localhost:8083"
        );
    }

    #[test]
    fn invalid_project_backend_never_falls_back_to_hosted() {
        let root = tempfile::tempdir().expect("project");
        let home = tempfile::tempdir().expect("preferences");
        fs::create_dir(root.path().join("slurp")).expect("project directory");
        for contents in [
            "backend = 42",
            "backend = 'file:///tmp/events'",
            "version = 1",
        ] {
            fs::write(root.path().join("slurp/slurp.toml"), contents).expect("invalid config");
            assert!(
                resolve(root.path(), home.path(), None).is_err(),
                "invalid backend: {contents}"
            );
        }
    }
}
