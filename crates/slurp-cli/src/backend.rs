//! Resolve a backend consistently for setup, initialization, and cloud commands.
use anyhow::{Context, Result};
use slurp_app::system;
use slurp_client::config;
use std::{fs, path::Path};

#[derive(serde::Deserialize)]
struct Project {
    backend: String,
}

pub fn resolve(root: &Path, home: &Path, explicit: Option<&str>) -> Result<String> {
    if let Some(value) = explicit {
        return config::normalize_backend(value);
    }
    for path in [root.join(".slurp/project.toml"), root.join("slurp.toml")] {
        match fs::read_to_string(&path) {
            Ok(contents) => {
                let saved: Project = toml::from_str(&contents)
                    .with_context(|| format!("reading backend from {}", path.display()))?;
                return config::normalize_backend(&saved.backend);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        }
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
        config::set_backend(home.path(), "http://localhost:8080").expect("saved preference");
        assert_eq!(resolve(None).expect("saved"), "http://localhost:8080");
        fs::write(
            home.path().join("config.toml"),
            "backend = 'http://localhost:8079'\n",
        )
        .expect("system setting");
        assert_eq!(resolve(None).expect("system"), "http://localhost:8079");
        fs::write(
            root.path().join("slurp.toml"),
            "backend = 'http://localhost:8081/'\n",
        )
        .expect("self-hosted settings");
        assert_eq!(resolve(None).expect("settings"), "http://localhost:8081");
        fs::create_dir(root.path().join(".slurp")).expect("project directory");
        fs::write(
            root.path().join(".slurp/project.toml"),
            "backend = 'http://localhost:8082/'\n",
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
        fs::create_dir(root.path().join(".slurp")).expect("project directory");
        for contents in [
            "backend = 42",
            "backend = 'file:///tmp/events'",
            "version = 1",
        ] {
            fs::write(root.path().join(".slurp/project.toml"), contents).expect("invalid config");
            assert!(
                resolve(root.path(), home.path(), None).is_err(),
                "invalid backend: {contents}"
            );
        }
    }
}
