//! Resolve ingestion credentials from a selected source or metadata-only project binding.
use anyhow::{Result, anyhow, ensure};
use slurp_app::{Workspace, project};
use slurp_client::{config, rpc};
use std::path::Path;

// Deliberately not Debug/Serialize: the publishable key stays out of diagnostics and output.
pub struct Target {
    pub source: String,
    pub url: String,
    pub key: String,
}
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

pub async fn resolve(
    explicit_workspace: Option<&Path>,
    backend_override: Option<&str>,
    explicit_source: Option<&str>,
) -> Result<Target> {
    let cwd = std::env::current_dir()?;
    let home = config::home()?;
    let project_mode = explicit_source.is_none();
    let (backend, source) = if let Some(reference) = explicit_source {
        let environment_backend = env("SLURP_BACKEND");
        let backend = if let Some(value) = backend_override.or(environment_backend.as_deref()) {
            config::normalize_backend(value)?
        } else {
            let root = if let Some(root) = explicit_workspace {
                if root.is_absolute() {
                    root.to_path_buf()
                } else {
                    cwd.join(root)
                }
            } else {
                project::discover(&cwd)?.unwrap_or(cwd.clone())
            };
            crate::backend::resolve(&root, &home, None)?
        };
        let source = if reference.starts_with("src_") {
            reference.to_owned()
        } else {
            let cached = config::load(&home)?
                .sources
                .into_iter()
                .filter(|source| source.backend == backend && source.source.name == reference)
                .collect::<Vec<_>>();
            ensure!(
                cached.len() <= 1,
                "project alias is ambiguous; use --source with its stable ID"
            );
            if let Some(cached) = cached.first() {
                cached.source.id.clone()
            } else {
                let session = crate::login::session(&backend, &home)?;
                let token = crate::login::token(&session).await?;
                rpc::SourceClient::new(&backend, slurp_client::http_client()?, Some(token))
                    .get_source(&rpc::GetSourceRequest {
                        source: reference.into(),
                    })
                    .await
                    .map_err(slurp_app::project_setup::service_error)?
                    .source
                    .id
            }
        };
        (backend, source)
    } else {
        let root = project::resolve(&cwd, explicit_workspace)?;
        let saved = Workspace::read_binding(&root)?;
        let backend = config::normalize_backend(&saved.backend)?;
        if let Some(value) = backend_override {
            ensure!(
                config::normalize_backend(value)? == backend,
                "backend override differs from this project's binding; use explicit --source and --backend for another connection"
            );
        }
        (backend, saved.source)
    };
    let scoped_environment = env("SLURP_SOURCE_ID").is_some_and(|value| value == source)
        && env("SLURP_BACKEND").is_some_and(|value| {
            config::normalize_backend(&value).is_ok_and(|value| value == backend)
        });
    let allow_environment = !project_mode || scoped_environment;
    let key = if allow_environment {
        env("SLURP_PUBLISHABLE_KEY")
    } else {
        None
    };
    let key = match key {
        Some(key) => key,
        None => slurp_client::storage::get(&config::publishable_account(&backend,&source))?
            .ok_or_else(||anyhow!("no publishable SDK key is saved for this project; import existing keys once with slurp credentials migrate-keychain, or ask the owner for a key (owners can run slurp source setup {source})"))?,
    };
    ensure!(
        key.starts_with("slurp_pk_"),
        "sending events requires a publishable SDK key"
    );
    let cached_url = config::load(&home)?
        .sources
        .into_iter()
        .find(|cached| cached.backend == backend && cached.source.id == source)
        .map(|cached| cached.ingest_url);
    let url = if allow_environment {
        env("SLURP_INGEST_URL")
    } else {
        None
    }
    .or(cached_url)
    .unwrap_or_else(|| format!("{backend}/v1/events"));
    let url = config::normalize_backend(&url)?;
    Ok(Target { source, url, key })
}
