//! Project initialization: a named cloud connection, one local database, and a private quickstart.
use crate::{backend, login, onboarding, terminal::Terminal};
use anyhow::{Context, Result, ensure};
use clap::Args;
use serde_json::{Value, json};
use slurp_app::{
    Workspace, agent_notes,
    drives::Drive,
    error::{ErrorCode, Failure},
    project_setup,
    setup::{self, PageContext},
    storage, system,
};
use slurp_client::{api, config};
use std::path::{Path, PathBuf};

#[derive(Args, Default)]
pub struct Options {
    /// Create a cloud project with this friendly name, or join the one that already has it.
    #[arg(long, conflicts_with = "connect")]
    name: Option<String>,
    /// Read a project secret key or admin token from stdin.
    #[arg(long)]
    token_stdin: bool,
    /// Use defaults without prompting.
    #[arg(long, short = 'y')]
    yes: bool,
    /// Forget this checkout's registration and choose local storage again. Existing data is kept.
    #[arg(long)]
    reset_local: bool,
    /// Connect an existing cloud project by its ID or name.
    #[arg(long)]
    connect: Option<String>,
    #[arg(long, env = "SLURP_BACKEND")]
    backend: Option<String>,
    /// Use an existing DuckDB 2 executable for this app.
    #[arg(long)]
    duckdb: Option<PathBuf>,
    /// Store events.duckdb in this exact project-specific data folder.
    #[arg(long, conflicts_with = "database")]
    data_dir: Option<PathBuf>,
    /// Choose an exact database filename instead of a data folder.
    #[arg(long)]
    database: Option<PathBuf>,
    /// Write the private quickstart without opening a browser.
    #[arg(long)]
    no_open: bool,
    /// Install the bundled product learning skills into this app.
    #[arg(long, conflicts_with = "no_install_skills")]
    install_skills: bool,
    /// Skip the interactive skill installation offer.
    #[arg(long)]
    no_install_skills: bool,
    /// Append the feedback reminder to existing AGENTS.md / CLAUDE.md files.
    #[arg(long, conflicts_with = "no_agent_notes")]
    agent_notes: bool,
    /// Skip the interactive agent reminder offer.
    #[arg(long)]
    no_agent_notes: bool,
}

/// The source of the key `slurp init` hands to an app's SDK.
const DEFAULT_SOURCE: &str = "default";

fn validate_database(root: &Path, database: &Path) -> Result<()> {
    ensure!(
        !database.exists(),
        "that folder already contains a database; choose another data folder"
    );
    let parent = database.parent().context("data folder")?;
    ensure!(
        parent.starts_with(root) || parent.is_dir() || parent.parent().is_some_and(Path::is_dir),
        "storage parent is unavailable; reconnect the drive or choose an existing parent"
    );
    Ok(())
}
fn bound_environment(backend: &str, project: &str) -> bool {
    std::env::var("SLURP_PROJECT_ID").is_ok_and(|value| value == project)
        && std::env::var("SLURP_BACKEND").ok().is_none_or(|value| {
            config::normalize_backend(&value).is_ok_and(|value| value == backend)
        })
}
fn environment(name: &str) -> Option<String> {
    config::env_value(name)
}
fn shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[derive(Default)]
struct Handoff {
    key: Option<String>,
    ingest_url: Option<String>,
    installed: bool,
    notes: Option<agent_notes::NoteReport>,
}

pub fn run(root: &Path, options: Options, machine_output: bool) -> Result<Value> {
    let root = root.canonicalize()?;
    let home = config::home()?;
    let ui = Terminal::new(machine_output);
    let existing = root.join("slurp/slurp.toml").is_file();
    if existing
        && (system::registration_for(&home, &root)?.is_none()
            || options.reset_local
            || options.token_stdin)
    {
        return join_binding(&root, &home, &options, &ui);
    }
    let mut workspace = if existing {
        Some(Workspace::load(&root)?)
    } else {
        if !ui.interactive && options.name.is_none() && options.connect.is_none() {
            return Err(onboarding::required(
                "specify init --name NAME to create a project, or init --connect PROJECT to connect one",
            ));
        }
        None
    };
    let mut settings = system::settings(&home)?;
    let mut ingest_url = None;
    let mut sdk_key = None;
    if let Some(saved) = &workspace {
        ensure!(
            options.name.is_none(),
            "this folder is already connected; use a fresh folder for a new project"
        );
        ensure!(
            options
                .connect
                .as_ref()
                .is_none_or(|project| project == &saved.project),
            "that differs from this folder's project; connect by its ID ({})",
            saved.project
        );
        if let Some(backend) = &options.backend {
            ensure!(
                config::normalize_backend(backend)? == saved.backend,
                "backend differs from the saved project binding"
            );
        }
        if let Some(engine) = &options.duckdb {
            ensure!(
                engine.canonicalize()? == saved.duckdb.canonicalize()?,
                "DuckDB differs from the saved project engine"
            );
        }
        if options.data_dir.is_some() || options.database.is_some() {
            ensure!(
                storage::database_path(
                    &root,
                    options.data_dir.as_deref(),
                    options.database.as_deref()
                )? == saved.database,
                "storage is already configured; init does not move existing data"
            );
        }
        ui.intro()?;
        ui.credentials()?;
        ui.note(
            "Project already connected",
            &format!(
                "Project: {}\nEvent database: {}\nYour existing connection and keys will be reused.",
                root.file_name().and_then(|name|name.to_str()).unwrap_or("this app"),
                saved.database.display()
            ),
        )?;
    } else {
        let explicit_storage = options.data_dir.is_some() || options.database.is_some();
        let mut engine =
            match setup::find_engine(options.duckdb.as_deref(), settings.duckdb.as_deref()) {
                Ok(engine) => engine,
                Err(_) if ui.interactive && options.duckdb.is_none() => None,
                Err(error) => return Err(error),
            };
        if ui.interactive
            && (engine.is_none() || (!explicit_storage && settings.library_dir.is_none()))
        {
            onboarding::run(
                onboarding::Options {
                    duckdb: options.duckdb.clone(),
                    backend: options.backend.clone(),
                    no_connect: options.connect.is_some()
                        && environment("SLURP_TOKEN")
                            .or_else(|| environment("SLURP_READ_KEY"))
                            .is_some_and(|token| token.starts_with("slurp_sk_")),
                    no_open: options.no_open,
                    ..Default::default()
                },
                machine_output,
            )?;
            settings = system::settings(&home)?;
            engine = setup::find_engine(options.duckdb.as_deref(), settings.duckdb.as_deref())?;
        }
        let engine = engine.ok_or_else(|| {
            onboarding::required("DuckDB is unavailable; pass --duckdb PATH or run slurp setup")
        })?;
        let backend = backend::resolve(&root, &home, options.backend.as_deref())?;
        let anchor;
        let mut database = if explicit_storage {
            anchor = None;
            storage::database_path(
                &root,
                options.data_dir.as_deref(),
                options.database.as_deref(),
            )?
        } else if let Some(library) = &settings.library_dir {
            if !library.is_dir() {
                return Err(Failure::new(ErrorCode::StorageUnavailable, format!("Your event library at {} is unavailable. Reconnect the drive or explicitly choose --data-dir; Slurp will not switch disks.", library.display())).into());
            }
            anchor = Some(Drive::from_path(library, "Event library".into(), None)?);
            library
                .join(root.file_name().unwrap_or(std::ffi::OsStr::new("my-app")))
                .join("events.duckdb")
        } else {
            anchor = None;
            let library = home.join("library");
            std::fs::create_dir_all(&library)?;
            library
                .join(root.file_name().context("project name")?)
                .join("events.duckdb")
        };
        ui.intro()?;
        ui.credentials()?;
        let runtime = tokio::runtime::Runtime::new()?;
        let mut project = options.connect.clone();
        let mut project_name = root
            .file_name()
            .context("project name")?
            .to_string_lossy()
            .into_owned();
        let mut title = options.name.clone();
        let mut client = None;
        let offline_binding = project
            .as_ref()
            .is_some_and(|project| project.starts_with("prj_"));
        if !offline_binding {
            let (backend, access) =
                runtime.block_on(login::ensure(&backend, &ui, options.no_open))?;
            let projects = project_setup::Api::new(&backend, &access)?;
            if let Some(reference) = &project {
                let found = runtime
                    .block_on(projects.call::<api::GetProject>(&api::GetProjectRequest {
                        project: reference.clone(),
                    }))
                    .map_err(project_setup::service_error)?;
                project_name = found.project.name.clone();
                project = Some(found.project.id.clone());
                ingest_url = Some(found.ingest_url);
            } else {
                let available = runtime
                    .block_on(projects.call::<api::ListProjects>(&api::ListProjectsRequest {}))
                    .map_err(project_setup::service_error)?
                    .projects;
                if title.is_none() && !ui.interactive {
                    return Err(onboarding::required(
                        "specify init --name NAME to create a project, or init --connect PROJECT to connect one",
                    ));
                }
                if title.is_none() && !available.is_empty() {
                    let mut choices = vec![(
                        "new".into(),
                        "Create a new project".into(),
                        "Track events for a new app".into(),
                    )];
                    choices.extend(available.iter().enumerate().map(|(i, found)| {
                        (
                            i.to_string(),
                            found.title.clone().unwrap_or_else(|| found.name.clone()),
                            found.name.clone(),
                        )
                    }));
                    let choice = ui.select("What would you like to connect?", &choices, "new")?;
                    if choice != "new" {
                        let found = available[choice.parse::<usize>()?].clone();
                        let info = runtime
                            .block_on(projects.call::<api::GetProject>(&api::GetProjectRequest {
                                project: found.id.clone(),
                            }))
                            .map_err(project_setup::service_error)?;
                        project_name = found.name.clone();
                        project = Some(found.id);
                        ingest_url = Some(info.ingest_url);
                    }
                }
                if project.is_none() {
                    let validate = |value: &str| {
                        if value.is_empty() || value.len() > 200 {
                            return Err("Use an app name between 1 and 200 UTF-8 bytes.".to_owned());
                        }
                        Ok(())
                    };
                    if let Some(name) = &title {
                        validate(name).map_err(anyhow::Error::msg)?;
                    } else {
                        title = Some(
                            ui.input(
                                "What is your app called?",
                                root.file_name()
                                    .and_then(|name| name.to_str())
                                    .unwrap_or("My app"),
                                validate,
                            )?,
                        );
                    }
                }
            }
            client = Some(projects);
        }
        if ui.interactive && !explicit_storage {
            let project = root.clone();
            let folder = ui.input(
                "Event data folder",
                &database.parent().context("data folder")?.to_string_lossy(),
                move |value| {
                    storage::database_path(&project, Some(Path::new(value)), None)
                        .and_then(|database| validate_database(&project, &database))
                        .map_err(|error| error.to_string())
                },
            )?;
            database = storage::database_path(&root, Some(Path::new(&folder)), None)?;
        }
        validate_database(&root, &database)?;

        let install = options.install_skills
            || (ui.interactive
                && !options.no_install_skills
                && ui.confirm(
                    "Install Slurp's product learning skills in this project?",
                    true,
                )?);
        let append = options.agent_notes
            || (ui.interactive && !options.no_agent_notes && agent_notes::available(&root) && {
                ui.note("Suggested agent reminder", agent_notes::REMINDER)?;
                ui.confirm(
                    "Append this reminder to existing AGENTS.md / CLAUDE.md files?",
                    true,
                )?
            });
        if ui.interactive {
            ui.note("Review project setup", &format!("Project: {}\nBackend: {}\nEvent database: {}\nInstall skills: {}\nAppend agent reminder: {}", title.as_deref().or(project.as_deref()).unwrap_or("new project"),backend,database.display(),install,append))?;
            ensure!(
                ui.confirm("Connect this app?", true)?,
                Failure::new(
                    ErrorCode::Cancelled,
                    "initialization cancelled; no project created"
                )
            );
        }
        if let Some(anchor) = &anchor {
            anchor.verify()?;
        }
        validate_database(&root, &database)?;
        // Verify writability before creating remote resources; the database is still absent.
        storage::prepare(&root, &database)?;
        if project.is_none() {
            // Creating is idempotent by name, so a retry or a second machine gets the same project and the same key.
            let name = title.as_deref().context("project name")?;
            let created = runtime
                .block_on(
                    client
                        .as_ref()
                        .context("project client")?
                        .call::<api::CreateProject>(&api::CreateProjectRequest {
                            name: project_setup::alias(name),
                            title: Some(name.into()),
                        }),
                )
                .map_err(project_setup::service_error)?;
            if !created.created {
                ui.note(
                    "Joined an existing project",
                    &format!(
                        "A project named {} already exists, so this app is connected to it.",
                        created.project.name
                    ),
                )?;
            }
            project_name = created.project.name.clone();
            project = Some(created.project.id);
            ingest_url = Some(created.ingest_url);
            // The key `CreateProject` returns is for the source `default`.
            sdk_key = Some(created.publishable_key);
        } else if let Some(client) = &client {
            sdk_key = runtime
                .block_on(project_setup::source_key(
                    client,
                    project.as_deref().context("project")?,
                    DEFAULT_SOURCE,
                ))
                .ok();
        }
        if let Some(anchor) = &anchor {
            anchor.verify()?;
        }
        let project = project.context("project")?;
        if !explicit_storage {
            let library = settings
                .library_dir
                .clone()
                .unwrap_or_else(|| home.join("library"));
            database = library
                .join(format!(
                    "{}-{}",
                    project_name,
                    project.trim_start_matches("prj_")
                ))
                .join("events.duckdb");
        }
        let binding = slurp_app::Binding {
            version: 1,
            name: project_name,
            backend,
            project,
        };
        let saved = Workspace::init_bound(&home, &root, &binding, Some(database), engine)?;
        if install {
            slurp_app::skills::install(&root.join(".agents/skills/slurp"), false, true)?;
        }
        let notes = if append {
            Some(agent_notes::append(&root)?)
        } else {
            None
        };
        workspace = Some(saved);
        return finish(
            &root,
            workspace.as_ref().context("workspace")?,
            &options,
            &ui,
            Handoff {
                key: sdk_key,
                ingest_url,
                installed: install,
                notes,
            },
        );
    }
    let saved = workspace.as_ref().context("saved project")?;
    if options.install_skills {
        slurp_app::skills::install(&root.join(".agents/skills/slurp"), false, true)?;
    }
    let notes = if options.agent_notes {
        Some(agent_notes::append(&root)?)
    } else {
        None
    };
    finish(
        &root,
        saved,
        &options,
        &ui,
        Handoff {
            key: sdk_key,
            ingest_url,
            installed: options.install_skills,
            notes,
        },
    )
}

fn finish(
    root: &Path,
    workspace: &Workspace,
    options: &Options,
    ui: &Terminal,
    handoff: Handoff,
) -> Result<Value> {
    let Handoff {
        mut key,
        mut ingest_url,
        installed,
        notes,
    } = handoff;
    let home = config::home()?;
    let bound = bound_environment(&workspace.backend, &workspace.project);
    let mut warnings = Vec::new();
    if key.is_none() && bound {
        key = environment("SLURP_PUBLISHABLE_KEY").filter(|key| key.starts_with("slurp_pk_"));
    }
    if key.is_none() {
        // The Worker knows every publishable key, so nothing is kept on this machine. Without a connection the page simply has no key.
        match fetch_key(&workspace.backend, &workspace.project) {
            Ok(fetched) => key = Some(fetched),
            Err(_) => warnings.push("Could not read the project's publishable key from your Worker; run slurp project setup to see it.".to_owned()),
        }
    }
    if ingest_url.is_none() {
        ingest_url = if bound {
            environment("SLURP_INGEST_URL")
        } else {
            None
        }
        .or_else(|| Some(format!("{}/v1/events", workspace.backend)));
    }
    let prefix = if std::env::current_dir()?.canonicalize()? == root {
        "slurp".to_owned()
    } else {
        format!("slurp --project {}", shell(&root.to_string_lossy()))
    };
    let commands = format!(
        "{prefix} sync\n{prefix} sql 'SELECT event, count(*) AS n FROM events GROUP BY event'"
    );
    let context = PageContext {
        project_name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        backend: Some(workspace.backend.clone()),
        project: Some(workspace.project.clone()),
        ingest_url,
        publishable_key: key,
        read_key: if bound {
            environment("SLURP_READ_KEY")
                .or_else(|| environment("SLURP_TOKEN"))
                .filter(|key| key.starts_with("slurp_sk_"))
        } else {
            None
        },
        generated_at: chrono::Utc::now().to_rfc3339(),
        workspace: Some(root.to_string_lossy().into_owned()),
        database: Some(workspace.database.to_string_lossy().into_owned()),
        data_dir: workspace
            .database
            .parent()
            .map(|path| path.to_string_lossy().into_owned()),
        workspace_initialized: true,
        init_command: None,
        sync_commands: Some(commands.clone()),
        guide_only: false,
    };
    use sha2::{Digest, Sha256};
    let path = home.join("setup").join(format!(
        "{}.html",
        hex::encode(Sha256::digest(root.to_string_lossy().as_bytes()))
    ));
    setup::write_page(&path, &context)?;
    let opened = ui.interactive && !options.no_open && onboarding::open_target(&path);
    if ui.interactive && !options.no_open && !opened {
        warnings.push("Browser unavailable; open setup_page manually.".into());
    }
    let registration = system::register(&home, root, workspace);
    let registry_warning = registration
        .err()
        .map(|error| format!("Project initialized, but registration failed: {error}"));
    ui.success(
        "This app is connected. Your project remembers its cloud project and event storage.",
    )?;
    let mut result = serde_json::to_value(workspace)?;
    let fields = json!({"initialized":true,"project_name":context.project_name,"setup_page":path,"opened":opened,"warnings":warnings,"registry_warning":registry_warning,"next_steps":commands,"skills_installed":if installed{Some(root.join(".agents/skills/slurp"))}else{None},"agent_notes":notes,"agent_notes_suggestion":agent_notes::REMINDER});
    result
        .as_object_mut()
        .context("workspace result")?
        .extend(fields.as_object().context("initialization result")?.clone());
    Ok(result)
}

/// The project's publishable key for source `default`, read from the Worker with this machine's saved connection.
fn fetch_key(backend: &str, project: &str) -> Result<String> {
    let token = login::token(backend)?;
    let client = project_setup::Api::new(backend, &token)?;
    tokio::runtime::Runtime::new()?.block_on(project_setup::source_key(
        &client,
        project,
        DEFAULT_SOURCE,
    ))
}

fn join_binding(root: &Path, home: &Path, options: &Options, ui: &Terminal) -> Result<Value> {
    let binding = Workspace::read_binding(root)?;
    if let Some(backend) = &options.backend {
        ensure!(
            config::normalize_backend(backend)? == binding.backend,
            "backend differs from project binding"
        );
    }
    ensure!(
        options.name.is_none(),
        "this folder already has a project binding"
    );
    if options.reset_local {
        system::reset_registration(home, root)?;
    }
    let saved_token = if options.token_stdin {
        None
    } else {
        match slurp_client::connection::resolve(&binding.backend, Some(&binding.project)) {
            Ok(token) => Some(token),
            Err(error)
                if error
                    .downcast_ref::<slurp_client::connection::NotConnected>()
                    .is_some() =>
            {
                None
            }
            Err(error) => return Err(error),
        }
    };
    let pasted = saved_token.is_none();
    let token = if options.token_stdin {
        let mut input = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
        input.trim().to_string()
    } else if let Some(token) = saved_token {
        token
    } else {
        ensure!(
            ui.interactive,
            "run slurp init --token-stdin or set SLURP_TOKEN to this project's secret key"
        );
        ui.secret("Project secret key or admin token")?
    };
    let runtime = tokio::runtime::Runtime::new()?;
    let who = runtime
        .block_on(login::whoami(&binding.backend, &token))
        .map_err(project_setup::service_error)?;
    match who.scope {
        api::TokenScope::Admin => {
            if pasted {
                slurp_client::connection::save(&binding.backend, &token)?;
            }
        }
        api::TokenScope::Secret => {
            ensure!(
                who.project.as_deref() == Some(&binding.project),
                "this secret key belongs to a different project"
            );
            if pasted {
                slurp_client::connection::save_project(&binding.backend, &binding.project, &token)?;
            }
        }
        api::TokenScope::Publishable => anyhow::bail!(
            "that key can only send events; ask an admin for a secret key with slurp project key create --scope secret"
        ),
    }
    let settings = system::settings(home)?;
    let engine = setup::find_engine(options.duckdb.as_deref(), settings.duckdb.as_deref())?
        .context("run slurp setup to install DuckDB")?;
    let saved = if system::registration_for(home, root)?.is_some() {
        Workspace::load_at(home, root)?
    } else {
        let database = if options.database.is_some() || options.data_dir.is_some() {
            storage::database_path(
                root,
                options.data_dir.as_deref(),
                options.database.as_deref(),
            )?
        } else {
            let library = settings.library_dir.unwrap_or_else(|| home.join("library"));
            if library == home.join("library") {
                std::fs::create_dir_all(&library)?;
            }
            ensure!(
                library.is_dir(),
                "event library is unavailable; reconnect the drive or choose --data-dir"
            );
            library
                .join(format!(
                    "{}-{}",
                    binding.name,
                    binding.project.trim_start_matches("prj_")
                ))
                .join("events.duckdb")
        };
        if database.exists() {
            Workspace::attach(home, root, &binding, database, engine)?
        } else {
            Workspace::init_bound(home, root, &binding, Some(database), engine)?
        }
    };
    let mut result = finish(root, &saved, options, ui, Handoff::default())?;
    result["next_steps"] = json!("slurp sync");
    Ok(result)
}
