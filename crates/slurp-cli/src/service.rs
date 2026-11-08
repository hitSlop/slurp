use anyhow::{Result, anyhow, bail};
use clap::Subcommand;
use serde_json::{Value, json};
use slurp_app::project_setup::{Api, service_error};
use slurp_client::api::{self, KeyScope};
use std::{io::BufRead, path::PathBuf, process::ExitCode, time::Duration};

/// The options every command accepts, parsed once by the root command in `main.rs`.
pub(crate) struct Global {
    pub backend: Option<String>,
    pub output: String,
    pub json: bool,
    pub workspace: Option<PathBuf>,
}
#[derive(Subcommand)]
pub(crate) enum Command {
    /// Deploy and operate your own Slurp Worker in your Cloudflare account.
    #[command(subcommand)]
    Cloud(crate::cloud::Command),
    /// Connect to your own Slurp Worker (self-hosted on Cloudflare) with its admin token.
    Connect {
        /// The Worker URL, for example https://slurp.your-subdomain.workers.dev
        url: String,
        /// Read the admin token from stdin (otherwise SLURP_TOKEN is used). It is never taken as an argument.
        #[arg(long)]
        token_stdin: bool,
    },
    Logout,
    Whoami,
    /// Create and manage projects and their keys on your Worker.
    #[command(subcommand)]
    Project(Project),
    /// Send a business event, or canonical NDJSON records with --stdin.
    Send {
        /// Send to this project (id or name) instead of the project of this folder.
        #[arg(long)]
        to: Option<String>,
        /// Send as this source (default: cli). Its events carry it as `sender`; the Worker supplies the source's key.
        #[arg(long)]
        source: Option<String>,
        #[arg(required_unless_present = "stdin", conflicts_with = "stdin")]
        event: Option<String>,
        #[arg(long, default_value = "{}")]
        data: String,
        #[arg(long)]
        user_id: Option<String>,
        #[arg(long)]
        stdin: bool,
    },
    Identify {
        user_id: String,
        /// Send to this project (id or name) instead of the project of this folder.
        #[arg(long)]
        to: Option<String>,
        /// Send as this source (default: cli). Its events carry it as `sender`; the Worker supplies the source's key.
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        anonymous_id: Option<String>,
        #[arg(long, default_value = "{}")]
        data: String,
    },
    /// Print a project's published events as NDJSON envelopes (what `slurp sync` would import).
    Read {
        /// The project's id or name.
        project: String,
        /// Keep waiting for newly published archives.
        #[arg(long)]
        follow: bool,
        /// Start after this archive sequence (default: the oldest retained archive).
        #[arg(long)]
        after: Option<u64>,
    },
}
#[derive(Subcommand)]
pub(crate) enum Project {
    /// Manage the keys of a project. A publishable key belongs to one source (ios, web, github), which tells their events apart.
    #[command(subcommand)]
    Key(KeyCommand),
    /// Create a project, or return the existing one with this name.
    Create {
        name: String,
        #[arg(long)]
        title: Option<String>,
    },
    List,
    Show {
        project: String,
    },
    /// Connect a webhook provider: prints the URL and secret to give it, and the provider's setup steps. Safe to repeat.
    /// To rotate the secret, revoke the webhook's key (slurp project key revoke), then run this again for a new URL and secret.
    Webhook {
        project: String,
        /// The provider, for example github, stripe, revenuecat or generic. The Worker says which it supports.
        provider: String,
        /// The signing secret the provider issued (Stripe's whsec_...). Stripe chooses its own, so it is given to Slurp.
        #[arg(long)]
        secret: Option<String>,
    },
    /// Print the endpoint and the project's publishable keys for SDK setup. Changes nothing.
    Setup {
        project: String,
    },
}

#[derive(Subcommand)]
pub(crate) enum KeyCommand {
    /// Create a key. A publishable key needs --source (every event it sends carries that source as `sender`); a secret key
    /// (read access to one project's archives) takes a label with --name.
    Create {
        project: String,
        #[arg(long,value_parser=["publishable","secret"])]
        scope: String,
        /// The source of a publishable key, such as web or ios.
        #[arg(long, conflicts_with = "name")]
        source: Option<String>,
        /// The label of a secret key.
        #[arg(long)]
        name: Option<String>,
    },
    List {
        project: String,
        #[arg(long,value_parser=["publishable","secret"])]
        scope: Option<String>,
    },
    Revoke {
        project: String,
        key_id: String,
    },
}
/// Run a Worker command. Exit status 0 is success; errors are printed as one JSON line.
pub(crate) fn main(global: Global, command: Command) -> ExitCode {
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| runtime.block_on(run(global, command)));
    match result {
        Ok(status) => ExitCode::from(status),
        Err(error) => {
            eprintln!("{}", json!({"error":{"message":error.to_string()}}));
            ExitCode::from(1)
        }
    }
}
pub(crate) fn home() -> Result<PathBuf> {
    slurp_client::config::home()
}
pub(crate) use crate::output::configure as configure_output;
pub(crate) fn emit(value: &impl serde::Serialize) -> Result<()> {
    crate::output::emit(crate::output::Kind::General, value)
}
async fn resolve(client: &Api, project: &str) -> Result<api::ProjectInfo> {
    client
        .call::<api::GetProject>(&api::GetProjectRequest {
            project: project.into(),
        })
        .await
        .map(|r| r.project)
        .map_err(service_error)
}

fn key_scope(scope: &str) -> KeyScope {
    if scope == "secret" {
        KeyScope::Secret
    } else {
        KeyScope::Publishable
    }
}

/// The request for `slurp project key create`: a publishable key needs a source, a secret key takes a label.
fn create_key_request(
    project: String,
    scope: &str,
    source: Option<String>,
    name: Option<String>,
) -> Result<api::CreateKeyRequest> {
    let scope = key_scope(scope);
    match scope {
        KeyScope::Publishable => {
            let source = source.ok_or_else(|| {
                anyhow!("a publishable key needs --source NAME (web, ios, ...): the source its events carry as `sender`")
            })?;
            if name.is_some() {
                bail!("--name labels a secret key; a publishable key is named by its --source");
            }
            if !slurp_app::project_setup::valid_source(&source) {
                bail!(
                    "a source is a lowercase name of 1 to 32 characters (letters, digits, underscore) starting with a letter, such as web or ios"
                );
            }
            Ok(api::CreateKeyRequest {
                project,
                scope,
                source: Some(source),
                name: None,
            })
        }
        KeyScope::Secret => {
            if source.is_some() {
                bail!("--source names the source of a publishable key; a secret key takes --name");
            }
            Ok(api::CreateKeyRequest {
                project,
                scope,
                source: None,
                name,
            })
        }
    }
}

async fn run(cli: Global, command: Command) -> Result<u8> {
    if let Command::Send {
        to,
        source,
        event,
        data,
        user_id,
        stdin,
    } = command
    {
        let line = if stdin {
            None
        } else {
            let line = record("track", event, user_id, None, &data)?;
            validate_record(&line)?;
            Some(line)
        };
        let target = crate::ingestion::resolve(
            cli.workspace.as_deref(),
            cli.backend.as_deref(),
            to.as_deref(),
            source.as_deref(),
        )
        .await?;
        let http = slurp_client::http_client()?;
        if let Some(line) = line {
            send(
                &http,
                &target.url,
                &target.key,
                format!("{line}\n").into_bytes(),
            )
            .await?;
        } else {
            stream_stdin(&http, &target.url, &target.key).await?;
        }
        return Ok(0);
    }
    if let Command::Identify {
        to,
        source,
        user_id,
        anonymous_id,
        data,
    } = command
    {
        let line = record("identify", None, Some(user_id), anonymous_id, &data)?;
        validate_record(&line)?;
        let target = crate::ingestion::resolve(
            cli.workspace.as_deref(),
            cli.backend.as_deref(),
            to.as_deref(),
            source.as_deref(),
        )
        .await?;
        send(
            &slurp_client::http_client()?,
            &target.url,
            &target.key,
            format!("{line}\n").into_bytes(),
        )
        .await?;
        return Ok(0);
    }
    if let Command::Connect { url, token_stdin } = &command {
        return connect(url, *token_stdin).await;
    }
    if let Command::Cloud(cloud) = &command {
        return crate::cloud::run(cloud, cli.json || cli.output == "json").await;
    }
    let cwd = std::env::current_dir()?;
    let root = slurp_app::project::root_for(&cwd, cli.workspace.as_deref())?;
    let backend =
        crate::backend::resolve_with_environment(&root, &home()?, cli.backend.as_deref())?;
    let backend = backend.as_str();
    let backend = slurp_client::config::normalize_backend(backend)?;
    let backend = backend.as_str();
    if matches!(command, Command::Logout) {
        slurp_client::connection::forget(backend)?;
        emit(&json!({"ok":true}))?;
        return Ok(0);
    }
    let auth = if matches!(command, Command::Whoami) && root.join("slurp/slurp.toml").is_file() {
        let binding = slurp_app::Workspace::read_binding(&root)?;
        crate::login::project_token(backend, &binding.project)?
    } else {
        crate::login::token(backend)?
    };
    let projects = Api::new(backend, &auth)?;
    match command {
        Command::Whoami => {
            let who = crate::login::whoami(backend, &auth)
                .await
                .map_err(service_error)?;
            emit(
                &json!({"backend": backend, "scope": who.scope, "project": who.project, "source": who.source, "name": who.name}),
            )?
        }
        Command::Project(Project::List) => emit(
            &projects
                .call::<api::ListProjects>(&api::ListProjectsRequest {})
                .await
                .map_err(service_error)?
                .projects,
        )?,
        Command::Project(Project::Key(command)) => match command {
            KeyCommand::Create {
                project,
                scope,
                source,
                name,
            } => {
                let project = resolve(&projects, &project).await?.id;
                let request = create_key_request(project, &scope, source, name)?;
                let created = projects
                    .call::<api::CreateKey>(&request)
                    .await
                    .map_err(service_error)?;
                let mut value = serde_json::to_value(&created)?;
                if matches!(request.scope, KeyScope::Secret) {
                    value["instructions"] = json!({"join":"In a clone of the project, run slurp init --token-stdin and supply this key. Share it through a password manager.","revoke":format!("slurp project key revoke {} {}", request.project, created.key.key_id)});
                }
                emit(&value)?;
            }
            KeyCommand::List { project, scope } => {
                let project = resolve(&projects, &project).await?.id;
                emit(
                    &projects
                        .call::<api::ListKeys>(&api::ListKeysRequest {
                            project,
                            scope: scope.as_deref().map(key_scope),
                        })
                        .await
                        .map_err(service_error)?,
                )?;
            }
            KeyCommand::Revoke { project, key_id } => {
                let project = resolve(&projects, &project).await?.id;
                emit(
                    &projects
                        .call::<api::RevokeKey>(&api::RevokeKeyRequest { project, key_id })
                        .await
                        .map_err(service_error)?,
                )?;
            }
        },
        Command::Project(Project::Show { project }) => emit(&resolve(&projects, &project).await?)?,
        Command::Project(Project::Create { name, title }) => emit(
            &projects
                .call::<api::CreateProject>(&api::CreateProjectRequest { name, title })
                .await
                .map_err(service_error)?,
        )?,
        Command::Project(Project::Webhook {
            project,
            provider,
            secret,
        }) => {
            let project = resolve(&projects, &project).await?.id;
            let hook = projects
                .call::<api::ConnectWebhook>(&api::ConnectWebhookRequest {
                    project,
                    provider,
                    secret,
                })
                .await
                .map_err(service_error)?;
            emit(&json!({
                "provider": hook.provider,
                "url": hook.url,
                "secret": hook.secret,
                "sender": hook.sender,
                "steps": hook.steps,
                "note": format!("Every event from this provider carries sender = {}.", hook.sender)
            }))?;
        }
        Command::Project(Project::Setup { project }) => {
            let setup = projects
                .call::<api::GetProject>(&api::GetProjectRequest { project })
                .await
                .map_err(service_error)?;
            let keys = projects
                .call::<api::ListKeys>(&api::ListKeysRequest {
                    project: setup.project.id.clone(),
                    scope: Some(KeyScope::Publishable),
                })
                .await
                .map_err(service_error)?
                .keys
                .into_iter()
                .filter(|key| key.revoked_at.is_none())
                .collect::<Vec<_>>();
            let Some(first) = keys
                .iter()
                .find(|key| key.source.as_deref() == Some("default"))
                .or(keys.first())
                .and_then(|key| key.key.clone())
            else {
                bail!(
                    "this project has no active publishable key; create one with slurp project key create {} --scope publishable --source <source>",
                    setup.project.id
                );
            };
            emit(&json!({
                "project": setup.project.id,
                "keys": keys.iter().map(|key| json!({"source": key.source, "key": key.key})).collect::<Vec<_>>(),
                "environment": {"SLURP_BACKEND": backend, "SLURP_PUBLISHABLE_KEY": first, "SLURP_PROJECT_ID": setup.project.id, "SLURP_PROJECT_NAME": setup.project.name, "SLURP_INGEST_URL": setup.ingest_url},
                "note": "Each publishable key is one source: events it sends carry its source as `sender`. Events are accepted durably, then published on the Worker's schedule."
            }))?;
        }
        Command::Read {
            project,
            follow,
            after,
        } => {
            let project = if project.starts_with("prj_") {
                project
            } else {
                resolve(&projects, &project).await?.id
            };
            let remote = slurp_client::HttpRemote::new(backend, &project, &auth)?;
            if follow {
                eprintln!(
                    "Following published archives; new events may take several minutes to appear."
                );
            }
            slurp_client::reader::read_published(
                &remote,
                &mut std::io::stdout().lock(),
                &mut std::io::stderr().lock(),
                after,
                follow,
            )
            .await?;
        }
        Command::Connect { .. }
        | Command::Cloud(_)
        | Command::Logout
        | Command::Send { .. }
        | Command::Identify { .. } => unreachable!(),
    }
    Ok(0)
}
/// Save a self-hosted Worker as this machine's backend. Verifies the Worker and the admin token before saving anything.
async fn connect(url: &str, token_stdin: bool) -> Result<u8> {
    let token = if token_stdin {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        line.trim().to_owned()
    } else {
        crate::login::environment_token().ok_or_else(|| {
            anyhow!(
                "provide the admin token with --token-stdin or the SLURP_TOKEN environment variable"
            )
        })?
    };
    let connected = crate::connect::verify_and_save(url, token).await?;
    emit(&json!({
        "backend": connected.backend,
        "scope": connected.scope,
        "next": ["slurp setup", "slurp init --name <your app>"],
    }))?;
    Ok(0)
}
#[derive(serde::Serialize)]
struct Record {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<String>,
    data: Box<serde_json::value::RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anonymous_id: Option<String>,
}
fn record(
    kind: &'static str,
    event: Option<String>,
    user_id: Option<String>,
    anonymous_id: Option<String>,
    data: &str,
) -> Result<String> {
    Ok(serde_json::to_string(&Record {
        id: uuid::Uuid::now_v7().to_string(),
        kind,
        timestamp: chrono::Utc::now().to_rfc3339(),
        event,
        data: serde_json::value::RawValue::from_string(data.into())?,
        user_id,
        anonymous_id,
    })?)
}
/// Largest single record the Worker accepts. Records are stored whole, never truncated.
const MAX_RECORD_BYTES: usize = 1024 * 1024;

/// A courtesy check of the minimal record in `docs/contracts.md` ("Sending events"), so a mistake shows before a round trip.
/// The Worker is the authority: it also checks nesting depth and lone surrogates, which this does not.
fn validate_record(line: &str) -> Result<()> {
    if line.len() > MAX_RECORD_BYTES {
        bail!("record exceeds 1 MiB");
    }
    let record: Value = serde_json::from_str(line)?;
    let object = record
        .as_object()
        .ok_or_else(|| anyhow!("a record is one JSON object"))?;
    // Optional fields are type-checked when present; an explicit null is invalid.
    let text = |name: &str| -> Result<Option<&str>> {
        match object.get(name) {
            None => Ok(None),
            Some(Value::String(value)) => Ok(Some(value)),
            Some(_) => bail!("{name} must be a string"),
        }
    };
    let kind = text("type")?.unwrap_or("track");
    if kind != "track" && kind != "identify" {
        bail!("type must be \"track\" or \"identify\"");
    }
    if let Some(id) = text("id")?
        && !(1..=256).contains(&id.len())
    {
        bail!("id must be 1 to 256 bytes");
    }
    if let Some(timestamp) = text("timestamp")? {
        // Upper-case T and Z only, like the Worker: DuckDB cannot read the lower-case forms RFC 3339 also allows.
        anyhow::ensure!(
            !timestamp.contains(['t', 'z']),
            "timestamp must be RFC 3339"
        );
        chrono::DateTime::parse_from_rfc3339(timestamp)
            .map_err(|_| anyhow!("timestamp must be RFC 3339"))?;
    }
    for field in ["data", "context"] {
        if object.get(field).is_some_and(|value| !value.is_object()) {
            bail!("{field} must be an object");
        }
    }
    for field in ["user_id", "anonymous_id", "session_id"] {
        if text(field)?.is_some_and(str::is_empty) {
            bail!("{field} must be a non-empty string when provided");
        }
    }
    let event = text("event")?;
    if event.is_some_and(|name| !(1..=200).contains(&name.chars().count())) {
        bail!("event must be 1 to 200 characters");
    }
    if kind == "track" && event.is_none() {
        bail!("a track record needs an event");
    }
    if kind == "identify" && text("user_id")?.is_none() {
        bail!("an identify record needs a user_id");
    }
    Ok(())
}

/// What the Worker said about a refused request: its `error`, and the first few rejected lines.
fn refusal(body: &[u8]) -> String {
    let Ok(body) = serde_json::from_slice::<Value>(body) else {
        return String::new();
    };
    let mut text = body["error"].as_str().unwrap_or_default().to_owned();
    if let Some(rejected) = body["rejected"].as_array() {
        for entry in rejected.iter().take(5) {
            text.push_str(&format!(
                "; line {}: {}",
                entry["line"],
                entry["reason"].as_str().unwrap_or_default()
            ));
        }
        if rejected.len() > 5 {
            text.push_str(&format!("; and {} more", rejected.len() - 5));
        }
    }
    text
}

/// A small response body, read in full only when it is small; the acknowledgement and error bodies are tiny.
async fn small_body(mut response: slurp_client::reqwest::Response) -> Vec<u8> {
    const MAX_BYTES: usize = 16 * 1024;
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Vec::new();
        }
        bytes.extend_from_slice(&chunk);
    }
    bytes
}

async fn send(
    http: &slurp_client::reqwest::Client,
    url: &str,
    key: &str,
    body: Vec<u8>,
) -> Result<()> {
    for attempt in 0..=3 {
        let result = http
            .post(url)
            .bearer_auth(key)
            .header("Content-Type", "application/x-ndjson")
            .body(body.clone())
            .send()
            .await;
        let delay = match result {
            Ok(response) if response.status().as_u16() == 200 => {
                // HTTP 200 confirms durable acceptance. A slow or odd acknowledgement body must not turn that into a retry.
                const MAX_ACK_WAIT: Duration = Duration::from_secs(1);
                let ack = tokio::time::timeout(MAX_ACK_WAIT, small_body(response))
                    .await
                    .unwrap_or_default();
                let sent = body
                    .split(|byte| *byte == b'\n')
                    .filter(|line| !line.is_empty())
                    .count();
                let accepted = serde_json::from_slice::<Value>(&ack)
                    .ok()
                    .and_then(|ack| ack["accepted"].as_u64())
                    .unwrap_or(sent as u64);
                crate::output::emit(
                    crate::output::Kind::Send,
                    &json!({"accepted":true,"events":accepted}),
                )?;
                return Ok(());
            }
            Ok(response)
                if response.status().as_u16() == 429 || response.status().is_server_error() =>
            {
                slurp_client::retry_after(response.headers())
                    .map_or(1 << attempt, |wait| wait.as_secs())
                    .min(30)
            }
            Ok(response) => {
                let status = response.status().as_u16();
                let detail = refusal(&small_body(response).await);
                bail!(
                    "event send rejected (HTTP {status}){}",
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!(": {detail}")
                    }
                )
            }
            Err(_) => 1 << attempt,
        };
        if attempt == 3 {
            break;
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
    bail!("event acceptance could not be confirmed; retry the same canonical records with --stdin")
}

async fn stream_stdin(
    http: &slurp_client::reqwest::Client,
    endpoint: &str,
    key: &str,
) -> Result<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut reader = std::io::stdin().lock();
        loop {
            let mut line = Vec::new();
            let result = reader
                .by_ref()
                .take(MAX_RECORD_BYTES as u64 + 2)
                .read_until(b'\n', &mut line);
            match result {
                Ok(0) => break,
                Ok(_) => {
                    if tx.blocking_send(Ok(line)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    break;
                }
            }
        }
    });
    let mut body = Vec::new();
    let mut events = 0;
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        tokio::select! {
            next=rx.recv()=> {
                let Some(line)=next else { if !body.is_empty() { send(http,endpoint,key,body).await?; } return Ok(()); };
                let line=line?;
                let text=std::str::from_utf8(&line)?.trim_end_matches(['\r','\n']);
                if text.trim().is_empty() { continue; }
                if text.len()>MAX_RECORD_BYTES { bail!("stdin record exceeds 1 MiB"); }
                validate_record(text)?;
                if !body.is_empty() && (events>=1000 || body.len()+text.len()+1>900*1024) {
                    send(http,endpoint,key,std::mem::take(&mut body)).await?; events=0;
                }
                if body.is_empty() { deadline=tokio::time::Instant::now()+Duration::from_secs(5); }
                body.extend_from_slice(text.as_bytes());body.push(b'\n');events+=1;
                if events>=1000 { send(http,endpoint,key,std::mem::take(&mut body)).await?; events=0; }
            }
            _=tokio::time::sleep_until(deadline),if !body.is_empty()=> {
                send(http,endpoint,key,std::mem::take(&mut body)).await?;events=0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{create_key_request, refusal, validate_record};
    use serde_json::Value;
    use slurp_client::api::KeyScope;

    #[test]
    fn a_minimal_record_is_enough_and_only_what_the_contract_names_is_checked() {
        for good in [
            r#"{"event":"signup"}"#,
            r#"{"type":"identify","user_id":"u1"}"#,
            r#"{"id":"x","event":"a","timestamp":"2026-11-07T12:00:00Z","data":{},"context":{},"custom":1}"#,
            // Nothing is reserved: server metadata lives outside the record.
            r#"{"event":"a","received_at":"x","sender":"y","context":{"geo":{}}}"#,
        ] {
            assert!(validate_record(good).is_ok(), "{good}");
        }
        for bad in [
            r#"[]"#,
            r#"{}"#,
            r#"{"type":"bad","event":"a"}"#,
            r#"{"type":null,"event":"a"}"#,
            r#"{"event":""}"#,
            r#"{"event":null}"#,
            r#"{"type":"track"}"#,
            r#"{"type":"identify"}"#,
            r#"{"event":"a","id":""}"#,
            r#"{"event":"a","timestamp":"today"}"#,
            r#"{"event":"a","timestamp":"2026-02-30T00:00:00Z"}"#,
            r#"{"event":"a","data":[]}"#,
            r#"{"event":"a","context":"x"}"#,
            r#"{"event":"a","user_id":""}"#,
            r#"{"event":"a","session_id":7}"#,
        ] {
            assert!(validate_record(bad).is_err(), "{bad}");
        }
        let long = format!(r#"{{"event":"{}"}}"#, "e".repeat(201));
        assert!(validate_record(&long).is_err());
        let wide = format!(r#"{{"event":"{}"}}"#, "雪".repeat(200));
        assert!(validate_record(&wide).is_ok(), "200 code points, 600 bytes");
        let big_id = format!(r#"{{"event":"a","id":"{}"}}"#, "i".repeat(257));
        assert!(validate_record(&big_id).is_err());
    }

    /// The Worker is the authority on what a record may contain; the CLI's check is only a courtesy that saves a round trip.
    /// So the CLI must never refuse a record the Worker accepts. It may accept some the Worker refuses (the Worker scans the raw
    /// bytes for nesting depth, lone surrogates, duplicate keys and number forms; the CLI parses JSON), but that list is kept
    /// here, by name, so a new difference is noticed.
    ///
    /// It is empty: the CLI and the Worker agree on every vector today.
    const LENIENT: &[&str] = &[];

    #[test]
    fn the_cli_never_refuses_what_the_worker_accepts_and_its_leniency_is_listed() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../backend/fixtures/canonical/records.json"
        );
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json");
        let mut lenient = vec![];
        for record in fixture["records"].as_array().expect("records") {
            let name = record["name"].as_str().unwrap();
            // Some vectors are raw bytes; the CLI reads its input as UTF-8 text before it validates, so bytes that are not text
            // are refused there.
            let line = match record["line"].as_str() {
                Some(line) => Some(line.to_owned()),
                None => {
                    use base64::Engine as _;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(record["line_b64"].as_str().unwrap())
                        .unwrap();
                    String::from_utf8(bytes).ok()
                }
            };
            let accepted = line.is_some_and(|line| validate_record(&line).is_ok());
            if record["valid"] == true {
                assert!(
                    accepted,
                    "the CLI refuses a record the Worker accepts: {name}"
                );
            } else if accepted {
                lenient.push(name.to_owned());
            }
        }
        assert_eq!(
            lenient, LENIENT,
            "the CLI accepts records the Worker refuses; update the list if that is intended"
        );
    }

    #[test]
    fn a_publishable_key_needs_a_source_and_a_secret_key_takes_a_name() {
        let project = || "prj_0123456789abcdef".to_owned();
        let publishable = create_key_request(project(), "publishable", Some("web".into()), None)
            .expect("publishable with a source");
        assert_eq!(publishable.scope, KeyScope::Publishable);
        assert_eq!(publishable.source.as_deref(), Some("web"));
        assert_eq!(publishable.name, None);
        let secret = create_key_request(project(), "secret", None, Some("ci".into()))
            .expect("secret with a name");
        assert_eq!(secret.scope, KeyScope::Secret);
        assert_eq!(secret.name.as_deref(), Some("ci"));
        assert_eq!(secret.source, None);
        assert!(create_key_request(project(), "secret", None, None).is_ok());
        for refused in [
            create_key_request(project(), "publishable", None, None),
            create_key_request(project(), "publishable", Some("Web".into()), None),
            create_key_request(
                project(),
                "publishable",
                Some("web".into()),
                Some("x".into()),
            ),
            create_key_request(project(), "secret", Some("web".into()), None),
        ] {
            assert!(refused.is_err());
        }
    }

    #[test]
    fn a_refusal_names_the_rejected_lines() {
        let body = br#"{"error":"invalid records","rejected":[{"line":3,"reason":"timestamp must be RFC 3339"}]}"#;
        assert_eq!(
            refusal(body),
            "invalid records; line 3: timestamp must be RFC 3339"
        );
        assert_eq!(refusal(b"<html>"), "");
    }
}
