//! Resolve where to send events and with which publishable key.
use anyhow::{Result, anyhow, ensure};
use slurp_app::{Workspace, project};
use slurp_client::{config, rpc};
use std::path::Path;

// Deliberately not Debug/Serialize: the publishable key stays out of diagnostics and output.
pub struct Target {
    pub url: String,
    pub key: String,
}
fn env(name: &str) -> Option<String> {
    config::env_value(name)
}

/// The project to send to and its backend: an explicit reference (`--to`), or the project the current folder is bound to.
pub async fn resolve(
    explicit_workspace: Option<&Path>,
    backend_override: Option<&str>,
    explicit_project: Option<&str>,
) -> Result<Target> {
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
            rpc::ProjectClient::new(&backend, slurp_client::http_client()?, Some(token))
                .get_project(&rpc::GetProjectRequest {
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
    let key = match allow_environment
        .then(|| env("SLURP_PUBLISHABLE_KEY"))
        .flatten()
    {
        Some(key) => key,
        // A publishable key is public by design and the Worker can always say what it is, so nothing is kept on this machine.
        None => {
            let token = crate::login::token(&backend)?;
            let client =
                rpc::ProjectClient::new(&backend, slurp_client::http_client()?, Some(token));
            slurp_app::project_setup::publishable_key(&client, &project)
                .await
                .map_err(|_| anyhow!("could not get a publishable key for this project; connect as its admin (slurp connect) or set SLURP_PUBLISHABLE_KEY"))?
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
