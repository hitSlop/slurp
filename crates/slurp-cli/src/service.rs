use anyhow::{Result, anyhow, bail};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use slurp_client::{
    auth::{SavedCredentials, Session},
    folder::Folder,
    rpc,
};
use std::{
    ffi::OsString, io::BufRead, path::PathBuf, process::ExitCode, sync::Arc, time::Duration,
};

#[derive(Parser)]
#[command(
    name = "slurp",
    version,
    about = "Authenticate, manage event sources, send events and download archives"
)]
struct Cli {
    #[arg(long, global = true)]
    backend: Option<String>,
    #[arg(short = 'o', long, global = true, value_parser = ["auto", "text", "json"], default_value = "auto")]
    output: String,
    #[arg(long, global = true)]
    json: bool,
    /// Select an exact project folder instead of discovering a parent project.
    #[arg(long, global = true)]
    workspace: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Manage saved credentials without displaying their values.
    #[command(subcommand)]
    Credentials(CredentialsCommand),
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
    #[command(subcommand)]
    Source(Source),
    /// Send a business event, or canonical NDJSON records with --stdin.
    Send {
        /// Existing source override; otherwise use this project.
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
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        anonymous_id: Option<String>,
        #[arg(long, default_value = "{}")]
        data: String,
    },
    /// Download one catch-up run. Acceptance of an event does not imply publication.
    Sync {
        source: String,
        #[arg(long)]
        out: Option<PathBuf>,
        #[arg(long)]
        import: bool,
        #[arg(long)]
        accept_reset: bool,
    },
    /// Export a downloaded folder as NDJSON without contacting the service.
    Read {
        #[arg(required_unless_present = "folder", conflicts_with = "folder")]
        source: Option<String>,
        #[arg(long)]
        folder: Option<PathBuf>,
        #[arg(long, conflicts_with = "folder")]
        follow: bool,
        #[arg(long)]
        archive: Option<String>,
        #[arg(long)]
        after: Option<i64>,
    },
}
#[derive(Subcommand)]
enum CredentialsCommand {
    /// Import this backend's saved connection and cached SDK keys into the private file once.
    /// Keychain may prompt; existing file values and Keychain entries are retained.
    MigrateKeychain,
}
#[derive(Subcommand)]
enum Source {
    #[command(subcommand)]
    Key(KeyCommand),
    #[command(subcommand)]
    Member(MemberCommand),
    Create {
        name: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        no_geo: bool,
    },
    List {
        /// List local library sources (requires an analysis build).
        #[arg(long)]
        local: bool,
    },
    Show {
        source: String,
    },
    /// Mint a publishable key and print source-scoped setup instructions.
    Setup {
        source: String,
    },
    Update {
        source: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        geo: Option<bool>,
    },
}

#[derive(Subcommand)]
enum KeyCommand {
    Create {
        source: String,
        #[arg(long,value_parser=["publishable","secret"])]
        scope: String,
        #[arg(long)]
        name: Option<String>,
    },
    List {
        source: String,
        #[arg(long,value_parser=["publishable","secret"])]
        scope: Option<String>,
    },
    Revoke {
        source: String,
        key_id: String,
    },
}
#[derive(Subcommand)]
enum MemberCommand {
    List { source: String },
    Add { source: String, user_id: String },
    Remove { source: String, user_id: String },
}

fn command_index(args: &[OsString]) -> Option<usize> {
    let mut index = 1;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        if matches!(
            value.as_ref(),
            "--workspace"
                | "--backend"
                | "-o"
                | "--output"
                | "--timeout-ms"
                | "--rows"
                | "--max-rows"
        ) {
            index += 2;
        } else if value.starts_with('-') {
            index += 1;
        } else {
            return Some(index);
        }
    }
    None
}
pub fn handles(args: &[OsString]) -> bool {
    let Some(index) = command_index(args) else {
        return false;
    };
    let command = args[index].to_string_lossy();
    if command == "source" {
        return true;
    }
    matches!(
        command.as_ref(),
        "connect" | "cloud" | "logout" | "whoami" | "send" | "identify" | "read" | "credentials"
    )
}
pub fn main(args: Vec<OsString>) -> ExitCode {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => {
            let status = if error.use_stderr() { 2 } else { 0 };
            let _ = error.print();
            return ExitCode::from(status);
        }
    };
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| runtime.block_on(run(cli)));
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
fn service_error(error: rpc::Error) -> anyhow::Error {
    // Decode errors may contain credential-bearing response bodies. Keep them private.
    anyhow!(match error.code() {
        Some(1000) => "not connected; run slurp connect <worker-url> --token-stdin",
        Some(1001) => "permission denied",
        Some(2000) => "invalid service arguments",
        Some(2001) => "source name already exists for this owner",
        Some(2002) => "source name is ambiguous; use its ID",
        Some(3000) => "source not found",
        _ => "service unavailable or returned an invalid response",
    })
}
pub(crate) use crate::output::configure as configure_output;
pub(crate) fn emit(value: &impl serde::Serialize) -> Result<()> {
    crate::output::emit(crate::output::Kind::General, value)
}
async fn token(session: &Session) -> Result<String> {
    crate::login::token(session).await
}
async fn resolve(client: &rpc::SourceClient, source: &str) -> Result<rpc::SourceInfo> {
    client
        .get_source(&rpc::GetSourceRequest {
            source: source.into(),
        })
        .await
        .map(|r| r.source)
        .map_err(service_error)
}

fn default_destination(backend: &str, id: &str, name: &str) -> Result<PathBuf> {
    let directory = PathBuf::from("slurp");
    let mut matched = None;
    match std::fs::read_dir(&directory) {
        Ok(entries) => {
            for entry in entries {
                let path = entry?.path();
                let manifest = path.join("source.json");
                if !manifest.is_file() {
                    continue;
                }
                let manifest: slurp_client::folder::Manifest =
                    serde_json::from_slice(&std::fs::read(manifest)?)?;
                if manifest.backend == backend && manifest.source == id {
                    if matched.is_some() {
                        bail!("multiple local folders match this source; choose one with --out");
                    }
                    matched = Some(path);
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(matched.unwrap_or_else(|| directory.join(name)))
}

async fn run(cli: Cli) -> Result<u8> {
    configure_output(&cli.output, cli.json);
    if let Command::Send {
        source,
        event,
        data,
        user_id,
        stdin,
    } = cli.command
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
            source.as_deref(),
        )
        .await?;
        let http = slurp_client::http_client()?;
        if let Some(line) = line {
            send(
                &http,
                &target.url,
                &target.source,
                &target.key,
                format!("{line}\n").into_bytes(),
            )
            .await?;
        } else {
            stream_stdin(&http, &target.url, &target.source, &target.key).await?;
        }
        return Ok(0);
    }
    if let Command::Identify {
        source,
        user_id,
        anonymous_id,
        data,
    } = cli.command
    {
        let line = record("identify", None, Some(user_id), anonymous_id, &data)?;
        validate_record(&line)?;
        let target = crate::ingestion::resolve(
            cli.workspace.as_deref(),
            cli.backend.as_deref(),
            source.as_deref(),
        )
        .await?;
        send(
            &slurp_client::http_client()?,
            &target.url,
            &target.source,
            &target.key,
            format!("{line}\n").into_bytes(),
        )
        .await?;
        return Ok(0);
    }
    if let Command::Read {
        folder: Some(path),
        archive,
        after,
        ..
    } = &cli.command
    {
        let mut folder = Folder::load(path).await?;
        folder.read(&mut std::io::stdout().lock(), archive.as_deref(), *after)?;
        return Ok(0);
    }
    if let Command::Connect { url, token_stdin } = &cli.command {
        return connect(url, *token_stdin).await;
    }
    if let Command::Cloud(command) = &cli.command {
        return crate::cloud::run(command, cli.json || cli.output == "json").await;
    }
    if matches!(cli.command, Command::Source(Source::List { local: true })) {
        bail!("local sources require an analysis build");
    }
    if matches!(cli.command, Command::Sync { import: true, .. }) {
        bail!("--import requires an analysis build; no files were downloaded");
    }
    let cwd = std::env::current_dir()?;
    let root = if let Some(root) = &cli.workspace {
        root.clone()
    } else {
        slurp_app::project::discover(&cwd)?.unwrap_or(cwd)
    };
    let environment_backend = std::env::var("SLURP_BACKEND")
        .ok()
        .filter(|value| !value.is_empty());
    let backend = crate::backend::resolve(
        &root,
        &home()?,
        cli.backend.as_deref().or(environment_backend.as_deref()),
    )?;
    let backend = backend.as_str();
    if matches!(
        cli.command,
        Command::Credentials(CredentialsCommand::MigrateKeychain)
    ) {
        let ui = crate::terminal::Terminal::new(cli.json || cli.output == "json");
        ui.note("Import saved credentials", "This one-time import may ask for Keychain access. Existing file values win, and the original Keychain entries stay in place.")?;
        emit(&slurp_client::storage::migrate_keychain(&home()?, backend)?)?;
        return Ok(0);
    }
    let http = slurp_client::http_client()?;
    let session = Session::new(
        backend,
        http.clone(),
        home()?.join("cache/service-locks"),
        Arc::new(SavedCredentials),
    )?;
    if matches!(cli.command, Command::Logout) {
        session.logout().await?;
        emit(&json!({"ok":true}))?;
        return Ok(0);
    }
    let backend = session.backend_url();
    let auth = token(&session).await?;
    let sources = rpc::SourceClient::new(backend, http.clone(), Some(auth.clone()));
    match cli.command {
        Command::Whoami => emit(
            &rpc::AuthClient::new(backend, http, Some(auth.clone()))
                .current_user(&rpc::CurrentUserRequest {})
                .await
                .map_err(service_error)?
                .user,
        )?,
        Command::Source(Source::List { local: true }) => {
            bail!("local sources require an analysis build")
        }
        Command::Source(Source::List { local: false }) => emit(
            &sources
                .list_sources(&rpc::ListSourcesRequest {})
                .await
                .map_err(service_error)?
                .sources,
        )?,
        Command::Source(Source::Key(command)) => match command {
            KeyCommand::Create {
                source,
                scope,
                name,
            } => {
                let source = resolve(&sources, &source).await?.id;
                emit(
                    &sources
                        .create_key(&rpc::CreateKeyRequest {
                            source,
                            scope,
                            name,
                        })
                        .await
                        .map_err(service_error)?,
                )?;
            }
            KeyCommand::List { source, scope } => {
                let source = resolve(&sources, &source).await?.id;
                emit(
                    &sources
                        .list_keys(&rpc::ListKeysRequest { source, scope })
                        .await
                        .map_err(service_error)?,
                )?;
            }
            KeyCommand::Revoke { source, key_id } => {
                let source = resolve(&sources, &source).await?.id;
                emit(
                    &sources
                        .revoke_key(&rpc::RevokeKeyRequest { source, key_id })
                        .await
                        .map_err(service_error)?,
                )?;
            }
        },
        Command::Source(Source::Member(command)) => match command {
            MemberCommand::List { source } => {
                let source = resolve(&sources, &source).await?.id;
                emit(
                    &sources
                        .list_memberships(&rpc::ListMembershipsRequest { source })
                        .await
                        .map_err(service_error)?,
                )?;
            }
            MemberCommand::Add { source, user_id } => {
                let source = resolve(&sources, &source).await?.id;
                emit(
                    &sources
                        .add_member(&rpc::SourceMemberRequest { source, user_id })
                        .await
                        .map_err(service_error)?,
                )?;
            }
            MemberCommand::Remove { source, user_id } => {
                let source = resolve(&sources, &source).await?.id;
                emit(
                    &sources
                        .remove_member(&rpc::SourceMemberRequest { source, user_id })
                        .await
                        .map_err(service_error)?,
                )?;
            }
        },
        Command::Source(Source::Show { source }) => emit(&resolve(&sources, &source).await?)?,
        Command::Source(Source::Create {
            name,
            title,
            no_geo,
        }) => {
            let pending =
                slurp_client::source::PendingCreation::open(&home()?, backend, &auth, &name)
                    .await?;
            let request_id = pending.id.clone();
            let created = sources
                .create_source(&rpc::CreateSourceRequest {
                    name,
                    title,
                    geo_enabled: Some(!no_geo),
                    request_id,
                })
                .await
                .map_err(service_error)?;
            emit(&created)?;
            pending.finish()?;
        }
        Command::Source(Source::Update {
            source,
            name,
            title,
            geo,
        }) => emit(
            &sources
                .update_source(&rpc::UpdateSourceRequest {
                    source,
                    name,
                    title,
                    geo_enabled: geo,
                })
                .await
                .map_err(service_error)?
                .source,
        )?,
        Command::Source(Source::Setup { source }) => {
            let setup = sources
                .get_source(&rpc::GetSourceRequest { source })
                .await
                .map_err(service_error)?;
            let source = setup.source;
            let key = sources
                .create_key(&rpc::CreateKeyRequest {
                    source: source.id.clone(),
                    scope: "publishable".into(),
                    name: Some("SDK setup".into()),
                })
                .await
                .map_err(service_error)?;
            emit(
                &json!({"source":source.id,"publishable_key":key.key,"environment":{"SLURP_BACKEND":backend,"SLURP_PUBLISHABLE_KEY":key.key,"SLURP_SOURCE_ID":source.id,"SLURP_SOURCE_NAME":source.name,"SLURP_INGEST_URL":setup.ingest_url},"note":"Use this publishable key for capture. Events are accepted durably, then published on the service schedule."}),
            )?;
        }
        Command::Sync {
            source,
            out,
            import,
            accept_reset,
        } => {
            let (id, name) = if source.starts_with("src_") {
                (source.clone(), source)
            } else {
                let source = resolve(&sources, &source).await?;
                (source.id, source.name)
            };
            let destination = match out {
                Some(path) => path,
                None => default_destination(backend, &id, &name)?,
            };
            let remote = slurp_client::HttpRemote::new(backend, &id, &auth)?;
            let mut folder = Folder::open(&destination, backend, &id).await?;
            let report = folder.sync(&remote, accept_reset).await?;
            let ready = folder
                .manifest()
                .archives
                .iter()
                .any(|a| !a.objects.is_empty());
            drop(folder);
            let status = match report.outcome.as_str() {
                "complete" => 0,
                "gap" => 3,
                "reset" => 4,
                _ => 1,
            };
            let imported = if import && ready {
                Some(import_downloads(destination, name).await?)
            } else {
                None
            };
            emit(&json!({"download":report,"import":imported}))?;
            return Ok(status);
        }
        Command::Read {
            source: Some(source),
            follow,
            archive,
            after,
            ..
        } => {
            let source = if source.starts_with("src_") {
                source
            } else {
                resolve(&sources, &source).await?.id
            };
            let remote = slurp_client::HttpRemote::new(backend, &source, &auth)?;
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
        Command::Read { .. }
        | Command::Connect { .. }
        | Command::Cloud(_)
        | Command::Logout
        | Command::Send { .. }
        | Command::Identify { .. }
        | Command::Credentials(_) => unreachable!(),
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
        "user": connected.user,
        "next": ["slurp setup", "slurp init --name <your app>"],
    }))?;
    Ok(0)
}
async fn import_downloads(_: PathBuf, _: String) -> Result<Value> {
    bail!("use workspace sync to load DuckDB")
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
        .is_none_or(|v| v.is_empty())
        || !record.get("data").is_some_and(Value::is_object)
    {
        bail!("records require a nonempty id and object data");
    }
    chrono::DateTime::parse_from_rfc3339(
        record
            .get("timestamp")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("record timestamp is required"))?,
    )?;
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
        || record.pointer("/context/geo").is_some()
    {
        bail!("server annotation fields are reserved");
    }
    Ok(())
}
async fn send(
    http: &slurp_client::reqwest::Client,
    url: &str,
    source_id: &str,
    key: &str,
    body: Vec<u8>,
) -> Result<()> {
    for attempt in 0..=3 {
        let result = http
            .post(url)
            .bearer_auth(key)
            .header("Slurp-Source", source_id)
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
    // Metadata is small, optional, and never logged. Older servers can return just {"ok":true}.
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
    source: &str,
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
                let Some(line)=next else { if !body.is_empty() { send(http,endpoint,source,key,body).await?; } return Ok(()); };
                let line=line?;
                let text=std::str::from_utf8(&line)?.trim_end_matches(['\r','\n']);
                if text.trim().is_empty() { continue; }
                if text.len()>MAX_RECORD_BYTES { bail!("stdin record exceeds 1 MiB"); }
                validate_record(text)?;
                if !body.is_empty() && (events>=1000 || body.len()+text.len()+1>900*1024) {
                    send(http,endpoint,source,key,std::mem::take(&mut body)).await?; events=0;
                }
                if body.is_empty() { deadline=tokio::time::Instant::now()+Duration::from_secs(5); }
                body.extend_from_slice(text.as_bytes());body.push(b'\n');events+=1;
                if events>=1000 { send(http,endpoint,source,key,std::mem::take(&mut body)).await?; events=0; }
            }
            _=tokio::time::sleep_until(deadline),if !body.is_empty()=> {
                send(http,endpoint,source,key,std::mem::take(&mut body)).await?;events=0;
            }
        }
    }
}
