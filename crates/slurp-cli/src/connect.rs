//! Connect this computer to a self-hosted Worker: check it is a Slurp Worker, check the admin token, then save both.
use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use slurp_client::api::TokenScope;

/// A verified connection that has been saved.
pub struct Connected {
    pub backend: String,
    /// What the Worker says the token is; always `admin` for a connection that was saved.
    pub scope: String,
    pub token: String,
}

/// Verify `url` is a configured Slurp Worker and `token` is its admin token, then save the credentials as the
/// backend's saved token and make it this machine's default backend. Nothing is saved on failure.
///
/// # Errors
/// Returns an error for an unreachable or non-Slurp URL, an unconfigured Worker, or a rejected token.
pub async fn verify_and_save(url: &str, token: String) -> Result<Connected> {
    let backend = slurp_client::config::normalize_backend(url)?;
    let token = token.trim().to_owned();
    if token.is_empty() {
        bail!("the admin token is empty");
    }
    let http = slurp_client::http_client()?;
    let health: Value = http
        .get(format!("{backend}/v1/health"))
        .send()
        .await
        .map_err(|_| anyhow!("could not reach {backend}; check the Worker URL"))?
        .json()
        .await
        .map_err(|_| anyhow!("{backend} is not a Slurp Worker (no /v1/health response)"))?;
    if health["ok"] != true {
        bail!("{backend} is not a Slurp Worker");
    }
    if health["apiVersion"] != 2 {
        bail!(
            "{backend} runs a different version of the Slurp Worker API than this CLI expects; deploy a matching Worker with slurp cloud upgrade (or install the matching CLI)"
        );
    }
    if health["configured"] != true {
        bail!("the Worker has no ADMIN_TOKEN configured; set the ADMIN_TOKEN secret on it first");
    }
    let who = crate::login::whoami(&backend, &token)
        .await
        .map_err(|error| {
            if slurp_app::project_setup::is_rejected(&error) {
                anyhow!("the Worker rejected that admin token")
            } else {
                anyhow!("could not verify the admin token; retry when the Worker is reachable")
            }
        })?;
    if who.scope != TokenScope::Admin {
        bail!(
            "that is a {} key; slurp connect needs the Worker's admin token (the ADMIN_TOKEN secret)",
            crate::login::scope_name(who.scope)
        );
    }
    let home = slurp_client::config::home()?;
    slurp_client::connection::save(&backend, &token)?;
    slurp_app::system::set_backend(&home, &backend)?;
    Ok(Connected {
        backend,
        scope: crate::login::scope_name(who.scope).to_owned(),
        token,
    })
}
