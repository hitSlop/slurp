//! Resolve where to send events and with which publishable key.
use anyhow::{Result, anyhow, ensure};
use slurp_app::{Workspace, project};
use slurp_client::{api, config};
use std::path::Path;

// Deliberately not Debug/Serialize: the publishable key stays out of diagnostics and output.
pub struct Target {
    pub url: String,
    pub key: String,
}
fn env(name: &str) -> Option<String> {
    config::env_value(name)
}

/// The source `slurp send` and `slurp identify` send as, unless `--source` says otherwise.
pub const DEFAULT_SOURCE: &str = "cli";

/// The project to send to and its backend: an explicit reference (`--to`), or the project the current folder is bound to.
///
/// The key is the publishable key of `source` (default `cli`), which the Worker supplies. `SLURP_PUBLISHABLE_KEY` is an
/// explicit key and is used only when no `--source` is given.
pub async fn resolve(
    explicit_workspace: Option<&Path>,
    backend_override: Option<&str>,
    explicit_project: Option<&str>,
    explicit_source: Option<&str>,
) -> Result<Target> {
    let source = explicit_source.unwrap_or(DEFAULT_SOURCE);
    ensure!(
        slurp_app::project_setup::valid_source(source),
        "a source is a lowercase name of 1 to 32 characters (letters, digits, underscore) starting with a letter, such as web or mcp"
    );
    let cwd = std::env::current_dir()?;
    let home = config::home()?;
    let project_mode = explicit_project.is_none();
    let (backend, project) = if let Some(reference) = explicit_project {
        let root = project::root_for(&cwd, explicit_workspace)?;
        let backend = crate::backend::resolve_with_environment(&root, &home, backend_override)?;
        let project = if reference.starts_with("prj_") {
            reference.to_owned()
        } else {
            let token = crate::login::token(&backend)?;
            slurp_app::project_setup::Api::new(&backend, &token)?
                .call::<api::GetProject>(&api::GetProjectRequest {
                    project: reference.into(),
                })
                .await
                .map_err(slurp_app::project_setup::service_error)?
                .project
                .id
        };
        (backend, project)
    } else {
        let root = project::resolve(&cwd, explicit_workspace)?;
        let saved = Workspace::read_binding(&root)?;
        let backend = config::normalize_backend(&saved.backend)?;
        if let Some(value) = backend_override {
            ensure!(
                config::normalize_backend(value)? == backend,
                "backend override differs from this project's binding; use --to and --backend for another connection"
            );
        }
        (backend, saved.project)
    };
    let scoped_environment = env("SLURP_PROJECT_ID").is_some_and(|value| value == project)
        && env("SLURP_BACKEND").is_some_and(|value| {
            config::normalize_backend(&value).is_ok_and(|value| value == backend)
        });
    let allow_environment = !project_mode || scoped_environment;
    let key = match (allow_environment && explicit_source.is_none())
        .then(|| env("SLURP_PUBLISHABLE_KEY"))
        .flatten()
    {
        Some(key) => key,
        // A publishable key is public by design and the Worker can always say what it is, so nothing is kept on this machine.
        None => {
            let token = crate::login::token(&backend)?;
            let client = slurp_app::project_setup::Api::new(&backend, &token)?;
            slurp_app::project_setup::source_key(&client, &project, source)
                .await
                .map_err(|error| anyhow!("could not get the publishable key for source {source} ({error}); connect as the Worker's admin (slurp connect), or set SLURP_PUBLISHABLE_KEY"))?
        }
    };
    ensure!(
        key.starts_with("slurp_pk_"),
        "sending events requires a publishable key"
    );
    let url = if allow_environment {
        env("SLURP_INGEST_URL")
    } else {
        None
    }
    .unwrap_or_else(|| format!("{backend}/v1/events"));
    let url = config::normalize_backend(&url)?;
    Ok(Target { url, key })
}
