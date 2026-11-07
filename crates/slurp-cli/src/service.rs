use anyhow::{Result, anyhow, bail};
use clap::Subcommand;
use serde_json::{Value, json};
use slurp_client::rpc;
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
        #[arg(long)]
        anonymous_id: Option<String>,
        #[arg(long, default_value = "{}")]
        data: String,
    },
    /// Print a project's published events as NDJSON (what `slurp sync` would import).
    Read {
        /// The project's id or name.
        project: String,
        /// Keep waiting for newly published batches.
        #[arg(long)]
        follow: bool,
        #[arg(long)]
        archive: Option<String>,
        #[arg(long)]
        after: Option<i64>,
    },
}
#[derive(Subcommand)]
pub(crate) enum Project {
    /// Manage the keys of a project. One publishable key per sender (ios, web, github) tells their events apart.
    #[command(subcommand)]
    Key(KeyCommand),
    /// Create a project, or return the existing one with this name.
    Create {
        name: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        no_geo: bool,
    },
    List,
    Show {
        project: String,
    },
    /// Print the endpoint and the project's publishable keys for SDK setup. Changes nothing.
    Setup {
        project: String,
    },
    Update {
        project: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        geo: Option<bool>,
    },
}

#[derive(Subcommand)]
pub(crate) enum KeyCommand {
    /// Create a key. Name it for what sends with it; every event it sends is stamped with that name as `sender`.
    Create {
        project: String,
        #[arg(long,value_parser=["publishable","secret"])]
        scope: String,
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
use slurp_app::project_setup::service_error;
pub(crate) fn emit(value: &impl serde::Serialize) -> Result<()> {
    crate::output::emit(crate::output::Kind::General, value)
}
async fn resolve(client: &rpc::ProjectClient, project: &str) -> Result<rpc::ProjectInfo> {
    client
        .get_project(&rpc::GetProjectRequest {
            project: project.into(),
        })
        .await
        .map(|r| r.project)
        .map_err(service_error)
}

async fn run(cli: Global, command: Command) -> Result<u8> {
    if let Command::Send {
        to,
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
    let http = slurp_client::http_client()?;
    let backend = slurp_client::config::normalize_backend(backend)?;
    let backend = backend.as_str();
    if matches!(command, Command::Logout) {
        slurp_client::connection::forget(backend)?;
        emit(&json!({"ok":true}))?;
        return Ok(0);
    }
    let auth = crate::login::token(backend)?;
    let projects = rpc::ProjectClient::new(backend, http.clone(), Some(auth.clone()));
    match command {
        Command::Whoami => {
            let who = crate::login::whoami(backend, &auth)
                .await
                .map_err(service_error)?;
            emit(
                &json!({"backend": backend, "scope": who.scope, "project": who.project, "name": who.name}),
            )?
        }
        Command::Project(Project::List) => emit(
            &projects
                .list_projects(&rpc::ListProjectsRequest {})
                .await
                .map_err(service_error)?
                .projects,
        )?,
        Command::Project(Project::Key(command)) => match command {
            KeyCommand::Create {
                project,
                scope,
                name,
            } => {
                let project = resolve(&projects, &project).await?.id;
                emit(
                    &projects
                        .create_key(&rpc::CreateKeyRequest {
                            project,
                            scope,
                            name,
                        })
                        .await
                        .map_err(service_error)?,
                )?;
            }
            KeyCommand::List { project, scope } => {
                let project = resolve(&projects, &project).await?.id;
                emit(
                    &projects
                        .list_keys(&rpc::ListKeysRequest { project, scope })
                        .await
                        .map_err(service_error)?,
                )?;
            }
            KeyCommand::Revoke { project, key_id } => {
                let project = resolve(&projects, &project).await?.id;
                emit(
                    &projects
                        .revoke_key(&rpc::RevokeKeyRequest { project, key_id })
                        .await
                        .map_err(service_error)?,
                )?;
            }
        },
        Command::Project(Project::Show { project }) => emit(&resolve(&projects, &project).await?)?,
        Command::Project(Project::Create {
            name,
            title,
            no_geo,
        }) => emit(
            &projects
                .create_project(&rpc::CreateProjectRequest {
                    name,
                    title,
                    geo_enabled: Some(!no_geo),
                })
                .await
                .map_err(service_error)?,
        )?,
        Command::Project(Project::Update {
            project,
            name,
            title,
            geo,
        }) => emit(
            &projects
                .update_project(&rpc::UpdateProjectRequest {
                    project,
                    name,
                    title,
                    geo_enabled: geo,
                })
                .await
                .map_err(service_error)?
                .project,
        )?,
        Command::Project(Project::Setup { project }) => {
            let setup = projects
                .get_project(&rpc::GetProjectRequest { project })
                .await
                .map_err(service_error)?;
            let keys = projects
                .list_keys(&rpc::ListKeysRequest {
                    project: setup.project.id.clone(),
                    scope: Some("publishable".into()),
                })
                .await
                .map_err(service_error)?
                .keys
                .into_iter()
                .filter(|key| key.revoked_at.is_none())
                .collect::<Vec<_>>();
            let Some(first) = keys.first().and_then(|key| key.key.clone()) else {
                bail!(
                    "this project has no active publishable key; create one with slurp project key create {} --scope publishable --name <sender>",
                    setup.project.id
                );
            };
            emit(&json!({
                "project": setup.project.id,
                "keys": keys.iter().map(|key| json!({"name": key.name, "key": key.key})).collect::<Vec<_>>(),
                "environment": {"SLURP_BACKEND": backend, "SLURP_PUBLISHABLE_KEY": first, "SLURP_PROJECT_ID": setup.project.id, "SLURP_PROJECT_NAME": setup.project.name, "SLURP_INGEST_URL": setup.ingest_url},
                "note": "Each publishable key is one sender: events it sends carry its name as `sender`. Events are accepted durably, then published on the service schedule."
            }))?;
        }
        Command::Read {
            project,
            follow,
            archive,
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
                    "Following published batches; new events may take up to an hour to appear."
                );
            }
            slurp_client::reader::read_published(
                &remote,
                &mut std::io::stdout().lock(),
                archive,
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

fn validate_record(line: &str) -> Result<()> {
    if line.len() > MAX_RECORD_BYTES {
        bail!("record exceeds 1 MiB");
    }
    let record: Value = serde_json::from_str(line)?;
    if record
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty() || v.len() > 256)
        || !record.get("data").is_some_and(Value::is_object)
    {
        bail!("records require an id of 1 to 256 bytes and object data");
    }
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("record timestamp is required"))?;
    chrono::DateTime::parse_from_rfc3339(timestamp)?;
    // RFC 3339 allows a lowercase `t` between date and time; the Worker wants the usual capital.
    if timestamp.as_bytes().get(10) != Some(&b'T') {
        bail!("record timestamp must be RFC 3339 with a capital T");
    }
    match record.get("type").and_then(Value::as_str) {
        Some("track")
            if record
                .get("event")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.trim().is_empty() && v.chars().count() <= 200) => {}
        Some("identify")
            if record
                .get("user_id")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty()) => {}
        _ => bail!("track records require an event; identify records require a user_id"),
    }
    for field in ["user_id", "anonymous_id", "session_id"] {
        if record
            .get(field)
            .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
        {
            bail!("identity fields must be nonempty strings when provided");
        }
    }
    if record
        .get("context")
        .is_some_and(|value| !value.is_object())
    {
        bail!("context must be an object");
    }
    if record.get("received_at").is_some()
        || record.get("received_seq").is_some()
        || record.get("sender").is_some()
        || record.pointer("/context/geo").is_some()
    {
        bail!("server annotation fields are reserved");
    }
    Ok(())
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
                // HTTP 200 confirms durable acceptance. Optional timing must not turn that into a retry.
                // A slow optional response body must not delay an already acknowledged event.
                const MAX_ACK_WAIT: Duration = Duration::from_secs(1);
                let publication = tokio::time::timeout(MAX_ACK_WAIT, ingest_publication(response))
                    .await
                    .ok()
                    .flatten();
                let events = body
                    .split(|byte| *byte == b'\n')
                    .filter(|line| !line.is_empty())
                    .count();
                crate::output::emit(
                    crate::output::Kind::Send,
                    &json!({"accepted":true,"events":events,"publication":publication}),
                )?;
                return Ok(());
            }
            Ok(response)
                if response.status().as_u16() == 429 || response.status().is_server_error() =>
            {
                response
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(1 << attempt)
                    .min(30)
            }
            Ok(response) => bail!("event send rejected (HTTP {})", response.status().as_u16()),
            Err(_) => 1 << attempt,
        };
        if attempt == 3 {
            break;
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
    bail!("event acceptance could not be confirmed; retry the same canonical records with --stdin")
}

async fn ingest_publication(
    mut response: slurp_client::reqwest::Response,
) -> Option<rpc::PublicationStatus> {
    #[derive(serde::Deserialize)]
    struct Ack {
        publication: Option<rpc::PublicationStatus>,
    }
    // Metadata is small, optional, and never logged. The acknowledgement may be just {"ok":true}.
    const MAX_ACK_BYTES: usize = 16 * 1024;
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_ACK_BYTES => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return None,
        }
    }
    let ack = serde_json::from_slice::<Ack>(&bytes).ok()?;
    slurp_client::publication::validated(ack.publication)
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
    use super::validate_record;
    use serde_json::Value;

    /// The Worker is the authority on what a record may contain; the CLI's check is only a courtesy that saves a round trip.
    /// So the CLI must never refuse a record the Worker accepts. It may accept some the Worker refuses (the Worker scans the raw
    /// bytes for nesting depth, lone surrogates, duplicate keys and number forms; the CLI parses JSON), but that list is kept
    /// here, by name, so a new difference is noticed.
    const LENIENT: &[&str] = &[
        "duplicate key via escape at depth 2",
        "duplicate top-level id",
        "duplicate key at depth 2",
    ];

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
}
