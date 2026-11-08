//! Terminal adapter for the saved Worker connection (admin token) used by setup and init.
use crate::terminal::Terminal;
use anyhow::{Result, bail};
use slurp_app::error::{ErrorCode, Failure};
use slurp_client::{
    api::{self, CallError, TokenScope},
    connection,
};

pub use slurp_client::connection::environment_token;

/// The bearer token for a Worker: `SLURP_TOKEN` or `SLURP_READ_KEY` from the environment, else the one `slurp connect` saved.
/// Fails with [`connection::NotConnected`] when there is neither.
pub fn token(backend: &str) -> Result<String> {
    connection::resolve(backend)
}

/// Ask the Worker what a token is (admin, or a project's secret or publishable key). An `Err` carries the Worker's error code
/// (`unauthenticated` or `forbidden` for a token it does not accept; see [`slurp_app::project_setup::is_rejected`]) so callers can
/// tell "rejected" from "could not reach".
pub async fn whoami(backend: &str, token: &str) -> Result<api::WhoamiResponse, CallError> {
    let http = slurp_client::http_client().map_err(|e| CallError::Api {
        status: 0,
        code: None,
        message: e.to_string(),
    })?;
    api::call::<api::Whoami>(&http, backend, token, &api::WhoamiRequest {}).await
}

/// How a token scope reads in messages.
pub fn scope_name(scope: TokenScope) -> &'static str {
    match scope {
        TokenScope::Admin => "admin",
        TokenScope::Secret => "secret",
        TokenScope::Publishable => "publishable",
    }
}

/// Make sure this computer is connected to a Worker and return `(backend, token)`.
///
/// A saved or environment token that the Worker accepts is reused. Otherwise an interactive terminal is offered the
/// chance to connect a Worker (its URL and admin token), and anything else fails with `setup_required` and the command to run.
pub async fn ensure(backend: &str, ui: &Terminal, no_open: bool) -> Result<(String, String)> {
    ui.credentials()?;
    match token(backend) {
        Ok(token) => {
            let environment = environment_token().is_some();
            match whoami(backend, &token).await {
                Ok(who) if who.scope == TokenScope::Admin => {
                    ui.note(
                        "Worker connected",
                        &format!(
                            "{backend} ({}).",
                            if environment {
                                "environment credentials"
                            } else {
                                "saved connection"
                            }
                        ),
                    )?;
                    return Ok((backend.to_owned(), token));
                }
                Ok(who) => {
                    if environment {
                        bail!(
                            "SLURP_TOKEN is a {} key for {backend}; this needs the Worker's admin token",
                            scope_name(who.scope)
                        );
                    }
                }
                Err(error) if slurp_app::project_setup::is_rejected(&error) => {
                    if environment {
                        bail!(
                            "SLURP_TOKEN was rejected by {backend}; use the Worker's admin token"
                        );
                    }
                }
                Err(_) => bail!(
                    "could not reach or verify the Worker at {backend}; saved connection retained"
                ),
            }
        }
        Err(error) if error.downcast_ref::<connection::NotConnected>().is_some() => {}
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
        &format!("{} (admin token).", connected.backend),
    )?;
    Ok((connected.backend, connected.token))
}
