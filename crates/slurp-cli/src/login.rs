//! Terminal adapter for the saved Worker connection (admin token) used by setup and init.
use crate::terminal::Terminal;
use anyhow::{Result, anyhow, bail};
use slurp_app::error::{ErrorCode, Failure};
use slurp_client::{
    auth::{SavedCredentials, Session},
    rpc,
};
use std::{path::Path, sync::Arc};

pub fn session(backend: &str, home: &Path) -> Result<Session> {
    Session::new(
        backend,
        slurp_client::http_client()?,
        home.join("cache/service-locks"),
        Arc::new(SavedCredentials),
    )
}

pub fn environment_token() -> Option<String> {
    ["SLURP_TOKEN", "SLURP_READ_KEY"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}
pub async fn token(session: &Session) -> Result<String> {
    if let Some(token) = environment_token() {
        return Ok(token);
    }
    session.access_token().await.map_err(|error| {
        if error.to_string() == "login required" {
            anyhow!("not connected to a Worker; run slurp connect <worker-url> --token-stdin (or set SLURP_TOKEN), or import an existing connection once with slurp credentials migrate-keychain")
        } else { error }
    })
}

/// Make sure this computer is connected to a Worker and return `(backend, token)`.
///
/// A saved or environment token that the Worker accepts is reused. Otherwise an interactive terminal is offered the
/// chance to connect a Worker (its URL and admin token), and anything else fails with `setup_required` and the command to run.
pub async fn ensure(
    backend: &str,
    home: &Path,
    ui: &Terminal,
    no_open: bool,
) -> Result<(String, String)> {
    let session = session(backend, home)?;
    ui.credentials()?;
    match token(&session).await {
        Ok(token) => {
            let result =
                rpc::AuthClient::new(backend, slurp_client::http_client()?, Some(token.clone()))
                    .current_user(&rpc::CurrentUserRequest {})
                    .await;
            match result {
                Ok(verified) => {
                    let environment = environment_token().is_some();
                    ui.note(
                        "Worker connected",
                        &format!(
                            "{} as {} ({}).",
                            backend,
                            verified.user.email,
                            if environment {
                                "environment credentials"
                            } else {
                                "saved connection"
                            }
                        ),
                    )?;
                    return Ok((backend.to_owned(), token));
                }
                Err(error) if matches!(error.code(), Some(1000 | 1001)) => {}
                Err(_) => bail!(
                    "could not reach or verify the Worker at {backend}; saved connection retained"
                ),
            }
            if std::env::var_os("SLURP_TOKEN").is_some() {
                bail!("SLURP_TOKEN was rejected by {backend}; use the Worker's admin token");
            }
        }
        Err(error) if error.to_string().starts_with("not connected") => {}
        Err(error) => return Err(error),
    }
    if !ui.interactive {
        bail!(Failure::new(
            ErrorCode::SetupRequired,
            "no Worker connected; run slurp connect <worker-url> --token-stdin (or set SLURP_TOKEN), or use setup --no-connect for local preparation"
        ));
    }
    ui.note(
        "Connect your Worker",
        "Slurp runs in your own Cloudflare account. Deploy a Worker there now, or connect one you already have.",
    )?;
    let choice = ui.select(
        "How do you want to connect?",
        &[
            (
                "deploy".into(),
                "Deploy a new Worker to my Cloudflare account".into(),
                "About a minute; uses wrangler and your Cloudflare login".into(),
            ),
            (
                "existing".into(),
                "Connect an existing Worker".into(),
                "Paste its URL and admin token".into(),
            ),
        ],
        "deploy",
    )?;
    if choice == "deploy" {
        let deployed = crate::cloud::init_interactive(ui, no_open).await?;
        return Ok((deployed.backend, deployed.token));
    }
    connect_existing(ui).await
}

/// Ask for a Worker URL and its admin token, verify them and save the connection.
async fn connect_existing(ui: &Terminal) -> Result<(String, String)> {
    let url = ui.input("Worker URL", "", |value| {
        slurp_client::config::normalize_backend(value)
            .map(|_| ())
            .map_err(|_| {
                "Enter an https:// Worker URL, for example https://slurp.your-name.workers.dev"
                    .into()
            })
    })?;
    let token = ui.secret("Admin token")?;
    let connected = crate::connect::verify_and_save(&url, token).await?;
    ui.note(
        "Worker connected",
        &format!("{} as {}.", connected.backend, connected.user.email),
    )?;
    Ok((connected.backend, connected.token))
}
