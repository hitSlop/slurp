mod backend;
mod cloud;
mod connect;
mod ingestion;
mod initialization;
mod login;
mod onboarding;
mod output;
mod service;
mod terminal;
use anyhow::Result;
use clap::{Parser, Subcommand};
use slurp_app::Workspace;
use std::path::PathBuf;
#[derive(Parser)]
#[command(
    version,
    about = "Sync your self-hosted events into DuckDB and build reports",
    after_help = "Worker commands: cloud, connect, logout, whoami, project, send, identify, read.\nUse slurp project --help for project and key management."
)]
struct Cli {
    /// The Worker to talk to. Defaults to the project's binding, then your saved connection.
    #[arg(long, global = true)]
    backend: Option<String>,
    #[arg(long, global = true)]
    json: bool,
    #[arg(short = 'o', long, global = true, value_parser = ["auto", "text", "json"], default_value = "auto")]
    output: String,
    /// Select an exact project folder instead of finding the nearest parent project.
    #[arg(long = "project", value_name = "PATH", global = true)]
    workspace: Option<PathBuf>,
    #[command(subcommand)]
    command: Operation,
}
#[derive(Subcommand)]
enum Notify {
    /// Slack: a bot token (SLACK_BOT_TOKEN, scopes chat:write and files:write) can attach a file; an incoming webhook (SLACK_WEBHOOK_URL) posts text only.
    Slack {
        /// The message; use - to read it from stdin.
        #[arg(long)]
        text: String,
        /// Channel (use the channel id, like C0123ABCD, to attach a file). Required with SLACK_BOT_TOKEN.
        #[arg(long, env = "SLACK_CHANNEL")]
        channel: Option<String>,
        /// A report image or PDF to attach (bot token only).
        #[arg(long)]
        file: Option<PathBuf>,
        /// Title for the attached file.
        #[arg(long)]
        title: Option<String>,
    },
    /// Discord: a webhook (DISCORD_WEBHOOK_URL), with an optional attached file. Messages are limited to 2000 characters.
    Discord {
        /// The message; use - to read it from stdin.
        #[arg(long)]
        text: String,
        #[arg(long)]
        file: Option<PathBuf>,
    },
}
#[derive(Subcommand)]
enum Operation {
    /// Show the system settings and config path in ~/.slurp (or SLURP_HOME).
    Config,
    /// List registered projects, including those whose drives are disconnected.
    Projects {
        #[command(subcommand)]
        command: Option<ProjectCommand>,
    },
    /// Connect this app to Slurp and initialize its event database.
    Init(initialization::Options),
    /// Prepare this computer: library, DuckDB and your Worker connection.
    Setup(onboarding::Options),
    Doctor,
    Status,
    /// Check the events for common data problems (spelling variants, bad clocks, bots, double tracking). Changes nothing.
    Health,
    Describe,
    /// Discover built-in SQL macros and runnable examples; no project is required.
    Functions {
        name: Option<String>,
    },
    /// List this project's shared SQL definitions (slurp/definitions/*.sql) and check that they load. Name one to see its SQL.
    Definitions {
        name: Option<String>,
    },
    /// Download newly published archives into the local database.
    Sync {
        /// First ask the Worker to publish what it has buffered, so events sent a moment ago are included. Needs the admin token.
        #[arg(long)]
        now: bool,
    },
    /// Post a message, and optionally a report image, to Slack or Discord. Credentials come from the environment (SLACK_BOT_TOKEN, SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL).
    #[command(subcommand)]
    Notify(Notify),
    /// Serve this project's events to an AI client over the Model Context Protocol (stdio). Add it to Claude Code, Cursor, Codex or Claude Desktop.
    Mcp {
        /// Also expose send_event and identify, which write to the real event stream. Off by default.
        #[arg(long)]
        allow_send: bool,
    },
    Sql {
        #[arg(required_unless_present = "file", conflicts_with = "file")]
        query: Option<String>,
        #[arg(long)]
        file: Option<PathBuf>,
        /// Load a DuckDB community extension for this query (allowed: behavioral). Installed on first use.
        #[arg(long = "extension", value_name = "NAME")]
        extensions: Vec<String>,
    },
    Duckdb,
    #[command(subcommand)]
    Report(Report),
    #[command(subcommand)]
    Agent(Agent),
    /// Commands that talk to your Worker: cloud, connect, logout, whoami, project, send, identify, read.
    #[command(flatten)]
    Worker(service::Command),
}
#[derive(Subcommand)]
enum ProjectCommand {
    /// Remove only a registry entry; project files and event data stay in place.
    Forget { directory: PathBuf },
}
#[derive(Subcommand)]
enum Agent {
    Setup {
        #[arg(long)]
        out: PathBuf,
        /// Install the instrument, analyze and improve skills beside this skill.
        #[arg(long)]
        all: bool,
        /// Replace locally modified bundled resources.
        #[arg(long)]
        force: bool,
    },
}
#[derive(Clone, clap::ValueEnum)]
enum ShowWhat {
    List,
    Theme,
    Style,
}
#[derive(Subcommand)]
enum Report {
    Check {
        file: PathBuf,
    },
    Build {
        file: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
        /// Shorthand for `--theme pro-dark`.
        #[arg(long)]
        dark: bool,
        /// Color theme: a built-in id (pro-light, gruvbox-light, solarized, pro-dark, ...; see `report show list`) or the
        /// path to your own theme .json file.
        #[arg(long)]
        theme: Option<String>,
        /// Page template: `grid` (built in) or the path to your own .css template.
        #[arg(long)]
        style: Option<String>,
        /// A CSS file appended after the template, for small tweaks.
        #[arg(long)]
        css: Option<PathBuf>,
        #[arg(long = "param")]
        params: Vec<String>,
        #[arg(long)]
        png: bool,
        #[arg(long)]
        pdf: bool,
    },
    /// Print a built-in theme or template to copy and edit, or list the theme ids.
    Show {
        /// `list`, `theme` or `style`.
        what: ShowWhat,
        /// The theme id or style name (for `theme` and `style`).
        name: Option<String>,
    },
    Open {
        directory: PathBuf,
    },
}
fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    service::configure_output(&cli.output, cli.json);
    if let Operation::Worker(command) = cli.command {
        let global = service::Global {
            backend: cli.backend,
            output: cli.output,
            json: cli.json,
            workspace: cli.workspace,
        };
        return service::main(global, command);
    }
    let presentation = match &cli.command {
        Operation::Init(_) => output::Kind::Init,
        Operation::Sync { .. } => output::Kind::Sync,
        Operation::Sql { .. } => output::Kind::Sql,
        Operation::Health => output::Kind::Health,
        Operation::Doctor | Operation::Status => output::Kind::Status,
        _ => output::Kind::General,
    };
    match run(cli) {
        Ok(v) => match output::emit(presentation, &v) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                std::process::ExitCode::FAILURE
            }
        },
        Err(e) => {
            eprintln!(
                "{}",
                serde_json::json!({"error":slurp_app::error::Failure::from_error(&e)})
            );
            std::process::ExitCode::FAILURE
        }
    }
}
fn run(cli: Cli) -> Result<serde_json::Value> {
    if let Operation::Functions { name } = &cli.command {
        return slurp_app::functions::lookup(name.as_deref());
    }
    use serde_json::json;
    let cwd = std::env::current_dir()?;
    match cli.command {
        Operation::Config => {
            let home = service::home()?;
            let path = home.join("config.toml");
            return Ok(
                json!({"home":home,"config":path,"exists":path.is_file(),"settings":slurp_app::system::settings(&home)?}),
            );
        }
        Operation::Projects { command } => {
            let home = service::home()?;
            if let Some(ProjectCommand::Forget { directory }) = command {
                let root = slurp_app::storage::resolve(
                    cli.workspace.as_deref().unwrap_or(&cwd),
                    &directory,
                )?;
                slurp_app::system::forget(&home, &root)?;
                return Ok(json!({"forgotten":root}));
            }
            let projects = slurp_app::system::projects(&home)?
                .into_iter()
                .map(|project| {
                    let project_available = project.root.join("slurp/slurp.toml").is_file();
                    let storage_available = project.database.is_file();
                    let mut value = serde_json::to_value(project)?;
                    value["project_available"] = json!(project_available);
                    value["storage_available"] = json!(storage_available);
                    Ok(value)
                })
                .collect::<Result<Vec<_>>>()?;
            return Ok(json!(projects));
        }
        Operation::Init(options) => {
            return initialization::run(
                cli.workspace.as_deref().unwrap_or(&cwd),
                options,
                cli.json || cli.output == "json",
            );
        }
        Operation::Setup(options) => {
            return onboarding::run(options, cli.json || cli.output == "json");
        }
        Operation::Notify(target) => {
            let config = slurp_app::notify::Config::from_env();
            let read_text = |text: String| -> Result<String> {
                if text == "-" {
                    let mut buffer = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer)?;
                    Ok(buffer.trim_end().to_owned())
                } else {
                    Ok(text)
                }
            };
            let result = match target {
                Notify::Slack {
                    text,
                    channel,
                    file,
                    title,
                } => {
                    let text = read_text(text)?;
                    let file = file
                        .as_deref()
                        .map(slurp_app::notify::Attachment::read)
                        .transpose()?;
                    tokio::runtime::Runtime::new()?.block_on(slurp_app::notify::slack(
                        &config,
                        &text,
                        channel.as_deref(),
                        file,
                        title.as_deref(),
                    ))?
                }
                Notify::Discord { text, file } => {
                    let text = read_text(text)?;
                    let file = file
                        .as_deref()
                        .map(slurp_app::notify::Attachment::read)
                        .transpose()?;
                    tokio::runtime::Runtime::new()?
                        .block_on(slurp_app::notify::discord(&config, &text, file))?
                }
            };
            return Ok(result);
        }
        Operation::Agent(Agent::Setup { out, all, force }) => {
            slurp_app::skills::install(&out, force, all)?;
            return Ok(json!({"installed":out}));
        }
        Operation::Report(Report::Check { file }) => {
            use slurp_app::{
                error::{ErrorCode, Failure},
                report_check,
            };
            let doc = slurp_app::report::parse(&std::fs::read_to_string(&file)?)?;
            slurp_app::report::resolve_look(&doc, &slurp_app::report::Look::default(), &file)?;
            // With a project (and its database) the queries are checked for real; without one only the structure is.
            let root = match cli.workspace.as_deref() {
                Some(path) => Some(slurp_app::project::resolve(&cwd, Some(path))?),
                None => slurp_app::project::discover(&cwd)?,
            };
            let workspace = root
                .map(|root| {
                    Workspace::load(&root)?
                        .with_definitions(&root)
                        .with_extensions(&doc.extensions)
                })
                .transpose()?;
            let problems = report_check::validate(&doc, workspace.as_ref())?;
            if let Some(summary) = report_check::error_summary(&problems) {
                return Err(Failure::new(ErrorCode::InvalidInput, summary).into());
            }
            return Ok(json!({
                "ok": true,
                "queries": doc.queries.keys().collect::<Vec<_>>(),
                "blocks": doc.blocks.len(),
                "checked_against_data": workspace.is_some(),
                "warnings": problems,
            }));
        }
        Operation::Report(Report::Show { what, name }) => {
            match what {
                ShowWhat::List => {
                    let themes: Vec<_> = slurp_render::palettes()
                        .iter()
                        .map(|p| json!({"id":p.id,"name":p.name,"scheme":p.scheme}))
                        .collect();
                    return Ok(json!({"styles":["grid"],"themes":themes}));
                }
                ShowWhat::Style => {
                    let name = name.unwrap_or_else(|| "grid".into());
                    anyhow::ensure!(name == "grid", "the only built-in style is grid");
                    println!("{}", slurp_app::report_style::Style::builtin().source());
                }
                ShowWhat::Theme => {
                    let id = name.unwrap_or_else(|| "pro-light".into());
                    let theme = slurp_render::Theme::named(&id)
                        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                    println!("{}", serde_json::to_string_pretty(theme.palette())?);
                }
            }
            std::process::exit(0);
        }
        Operation::Report(Report::Open { directory }) => {
            let command = if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            };
            std::process::Command::new(command)
                .arg(directory.join("report.html"))
                .spawn()?;
            return Ok(json!({"opened":directory}));
        }
        _ => {}
    }
    let root = slurp_app::project::resolve(&cwd, cli.workspace.as_deref())?;
    let w = Workspace::load(&root)?;
    let cancellation = w.cancellation.clone();
    ctrlc::set_handler(move || cancellation.cancel())?;
    match cli.command {
        Operation::Sync { now } => {
            let auth = login::project_token(&w.backend, &w.project)?;
            tokio::runtime::Runtime::new()?.block_on(async {
                if now {
                    w.sync_now(&auth).await
                } else {
                    w.sync(&auth).await
                }
            })
        }
        Operation::Mcp { allow_send } => {
            // stdout carries only protocol messages; nothing is printed afterwards.
            let server =
                slurp_app::mcp::Server::new(&w, root.clone(), std::env::current_exe()?, allow_send);
            server.run(std::io::stdin().lock(), std::io::stdout().lock())?;
            std::process::exit(0);
        }
        Operation::Doctor | Operation::Status => w.status(),
        Operation::Health => slurp_app::health::run(&w),
        Operation::Describe => w.execute("DESCRIBE events", true),
        Operation::Definitions { name } => {
            let w = w.with_definitions(&root);
            match name {
                Some(name) => Ok(serde_json::to_value(slurp_app::definitions::show(
                    &w, &name,
                )?)?),
                None => Ok(json!({
                    "folder": slurp_app::definitions::FOLDER,
                    "definitions": slurp_app::definitions::list(&w)?,
                })),
            }
        }
        Operation::Sql {
            query,
            file,
            extensions,
        } => {
            let w = &w.with_extensions(&extensions)?.with_definitions(&root);
            let sql = match file {
                Some(path) => std::fs::read_to_string(path)?,
                None => query.ok_or_else(|| anyhow::anyhow!("provide a query or --file"))?,
            };
            w.query(sql.trim().trim_end_matches(';'))
        }
        Operation::Duckdb => {
            let mut shell = std::process::Command::new(&w.duckdb);
            // The project's definitions load through an -init script, so they exist when the prompt appears. The file
            // lives until the shell exits.
            let _init = match slurp_app::definitions::shell_init(&w, &root)? {
                Some(script) => {
                    let file = tempfile::Builder::new()
                        .prefix("slurp-definitions-")
                        .suffix(".sql")
                        .tempfile()?;
                    std::fs::write(file.path(), script)?;
                    shell.arg("-init").arg(file.path());
                    Some(file)
                }
                None => None,
            };
            let status = shell
                .args(["-cmd", slurp_app::SESSION_SETTINGS])
                .arg("-readonly")
                .arg(&w.database)
                .status()?;
            anyhow::ensure!(status.success(), "DuckDB shell failed");
            Ok(json!({"closed":true}))
        }
        Operation::Report(Report::Build {
            file,
            out,
            dark,
            theme,
            style,
            css,
            params,
            png,
            pdf,
        }) => {
            let look = slurp_app::report::Look {
                dark,
                theme,
                style,
                css,
            };
            let mut values = std::collections::BTreeMap::new();
            for p in params {
                let (k, v) = p
                    .split_once('=')
                    .ok_or_else(|| anyhow::anyhow!("use --param NAME=VALUE"))?;
                values.insert(
                    k.into(),
                    serde_json::from_str(v).unwrap_or_else(|_| json!(v)),
                );
            }
            let out = out.unwrap_or_else(|| {
                root.join("slurp/out").join(format!(
                    "{}-{}",
                    file.file_stem().unwrap_or_default().to_string_lossy(),
                    chrono::Utc::now().timestamp_millis()
                ))
            });
            slurp_app::report::build_with_params(
                &w.with_definitions(&root),
                &file,
                &out,
                &look,
                png,
                pdf,
                &values,
            )
        }
        _ => unreachable!(),
    }
}
