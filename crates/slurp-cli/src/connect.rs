//! Connect this computer to a self-hosted Worker: check it is a Slurp Worker, check the admin token, then save both.
use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use slurp_client::{
    auth::{SavedCredentials, Session},
    rpc,
};
use std::sync::Arc;

/// A verified connection that has been saved.
pub struct Connected {
    pub backend: String,
    pub user: rpc::AuthUser,
    pub token: String,
}

/// Verify `url` is a configured Slurp Worker and `token` is its admin token, then save the credentials as the
/// backend's static admin credential and make it this machine's default backend. Nothing is saved on failure.
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
    if health["configured"] != true {
        bail!("the Worker has no ADMIN_TOKEN configured; set the ADMIN_TOKEN secret on it first");
    }
    let user = rpc::AuthClient::new(&backend, http.clone(), Some(token.clone()))
        .current_user(&rpc::CurrentUserRequest {})
        .await
        .map_err(|error| match error.code() {
            Some(1000 | 1001) => anyhow!("the Worker rejected that admin token"),
            _ => anyhow!("could not verify the admin token; retry when the Worker is reachable"),
        })?
        .user;
    let home = slurp_client::config::home()?;
    let session = Session::new(
        &backend,
        http,
        home.join("cache/service-locks"),
        Arc::new(SavedCredentials),
    )?;
    session
        .save_login(&rpc::AuthCredentials {
            user: user.clone(),
            access_token: token.clone(),
            refresh_token: token.clone(),
        })
        .await?;
    slurp_client::config::set_backend(&home, &backend)?;
    Ok(Connected {
        backend,
        user,
        token,
    })
}
