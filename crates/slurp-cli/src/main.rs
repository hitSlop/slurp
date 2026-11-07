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
    after_help = "Worker commands: cloud, connect, logout, whoami, source, send, identify, read, credentials.\nUse slurp source --help for source/key management; Worker commands accept --backend."
)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
    #[arg(short = 'o', long, global = true, value_parser = ["auto", "text", "json"], default_value = "auto")]
    output: String,
    /// Select an exact project folder instead of finding the nearest parent project.
    #[arg(long, global = true)]
    workspace: Option<PathBuf>,
    #[command(subcommand)]
    command: Operation,
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
    Describe,
    Sync,
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
}
#[derive(Subcommand)]
enum ProjectCommand {
    List,
    /// Remove only a registry entry; project files and event data stay in place.
    Forget {
        directory: PathBuf,
    },
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
        out: PathBuf,
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
    let args: Vec<_> = std::env::args_os().collect();
    if service::handles(&args) {
        return service::main(args);
    }
    let cli = Cli::parse();
    service::configure_output(&cli.output, cli.json);
    let presentation = match &cli.command {
        Operation::Init(_) => output::Kind::Init,
        Operation::Sync => output::Kind::Sync,
        Operation::Sql { .. } => output::Kind::Sql,
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
                    let project_available = project.root.join(".slurp/project.toml").is_file();
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
            let workspace = slurp_app::project::resolve(&cwd, cli.workspace.as_deref())
                .ok()
                .and_then(|root| Workspace::load(&root).ok())
                .and_then(|w| w.with_extensions(&doc.extensions).ok());
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
        Operation::Sync => {
            let token = login::environment_token();
            tokio::runtime::Runtime::new()?.block_on(async {
                let auth = if let Some(t) = token {
                    t
                } else {
                    let home = service::home()?;
                    let session = slurp_client::auth::Session::new(
                        &w.backend,
                        slurp_client::http_client()?,
                        home.join("cache/service-locks"),
                        std::sync::Arc::new(slurp_client::auth::SavedCredentials),
                    )?;
                    login::token(&session).await?
                };
                w.sync(&auth).await
            })
        }
        Operation::Doctor | Operation::Status => Ok(
            json!({"version":w.version,"source":w.source,"backend":w.backend,"database":w.database,"events":w.execute("SELECT count(*) AS count FROM events",true)?,"last_delivery":w.execute("SELECT * FROM _slurp.deliveries ORDER BY imported_at DESC LIMIT 1",true)?}),
        ),
        Operation::Describe => w.execute("DESCRIBE events", true),
        Operation::Sql {
            query,
            file,
            extensions,
        } => {
            let w = &w.with_extensions(&extensions)?;
            let sql = match file {
                Some(path) => std::fs::read_to_string(path)?,
                None => query.ok_or_else(|| anyhow::anyhow!("provide a query or --file"))?,
            };
            w.query(sql.trim().trim_end_matches(';'))
        }
        Operation::Duckdb => {
            let status = std::process::Command::new(&w.duckdb)
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
            slurp_app::report::build_with_params(&w, &file, &out, &look, png, pdf, &values)
        }
        _ => unreachable!(),
    }
}
