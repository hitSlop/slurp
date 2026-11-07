//! Project initialization: a named cloud connection, one local database, and a private quickstart.
use crate::{backend, login, onboarding, terminal::Terminal};
use anyhow::{Context, Result, ensure};
use clap::Args;
use serde_json::{Value, json};
use slurp_app::{
    Workspace, agent_notes,
    drives::Drive,
    error::{ErrorCode, Failure},
    project_setup::{self, Creation},
    setup::{self, PageContext},
    storage, system,
};
use slurp_client::{config, rpc};
use std::path::{Path, PathBuf};

#[derive(Args, Default)]
pub struct Options {
    /// Create a new cloud project with this friendly name.
    #[arg(long, conflicts_with = "source")]
    name: Option<String>,
    /// Connect an existing project by stable ID or service alias.
    #[arg(long)]
    source: Option<String>,
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
fn bound_environment(backend: &str, source: &str) -> bool {
    std::env::var("SLURP_SOURCE_ID").is_ok_and(|value| value == source)
        && std::env::var("SLURP_BACKEND").ok().is_none_or(|value| {
            config::normalize_backend(&value).is_ok_and(|value| value == backend)
        })
}
fn environment(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
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
    let existing = root.join(".slurp/project.toml").is_file();
    let mut workspace = if existing {
        Some(Workspace::load(&root)?)
    } else {
        if !ui.interactive && options.name.is_none() && options.source.is_none() {
            return Err(onboarding::required(
                "specify init --name NAME to create a project, or init --source SOURCE to connect one",
            ));
        }
        None
    };
    let mut settings = system::settings(&home)?;
    let mut creation = None;
    let mut ingest_url = None;
    let mut sdk_key = None;
    if let Some(saved) = &workspace {
        let metadata = config::load(&home)?
            .sources
            .into_iter()
            .find(|source| source.backend == saved.backend && source.source.id == saved.source)
            .map(|source| source.source);
        ensure!(
            options
                .name
                .as_ref()
                .is_none_or(
                    |name| metadata.as_ref().is_some_and(|source| source.title.as_ref()
                        == Some(name)
                        || &source.name == name)
                ),
            "this folder is already connected; use a fresh folder for a new project"
        );
        ensure!(
            options
                .source
                .as_ref()
                .is_none_or(|source| source == &saved.source
                    || metadata.as_ref().is_some_and(|info| &info.name == source)),
            "source differs from the saved project binding"
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
                metadata.as_ref().map(|project|project.title.as_deref().unwrap_or(&project.name)).unwrap_or_else(||root.file_name().and_then(|name|name.to_str()).unwrap_or("this app")),
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
                    no_connect: options.source.is_some()
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
        } else if !ui.interactive && options.source.is_some() {
            // An explicit existing-source binding remains useful for offline/scripted local work.
            anchor = None;
            storage::database_path(&root, None, None)?
        } else {
            return Err(onboarding::required(
                "choose an event library with slurp setup, or supply --data-dir",
            ));
        };
        ui.intro()?;
        ui.credentials()?;
        let runtime = tokio::runtime::Runtime::new()?;
        let mut source = options.source.clone();
        let mut title = options.name.clone();
        let mut selected = None;
        let mut client = None;
        let mut token = None;
        let offline_binding = source
            .as_ref()
            .is_some_and(|source| source.starts_with("src_"));
        if !offline_binding {
            let (backend, access) =
                runtime.block_on(login::ensure(&backend, &home, &ui, options.no_open))?;
            let sources = rpc::SourceClient::new(
                &backend,
                slurp_client::http_client()?,
                Some(access.clone()),
            );
            let pending_name = Creation::pending_name(&home, &root, &backend, &access)?;
            if title.is_none() && source.is_none() && pending_name.is_some() {
                ui.note(
                    "Resume project setup",
                    "Continuing your unfinished initialization with its original cloud project.",
                )?;
                title = pending_name.clone();
            }
            if let Some(reference) = &source {
                let found = runtime
                    .block_on(sources.get_source(&rpc::GetSourceRequest {
                        source: reference.clone(),
                    }))
                    .map_err(project_setup::service_error)?;
                source = Some(found.source.id.clone());
                ingest_url = Some(found.ingest_url);
                selected = Some(found.source);
            } else {
                let available = runtime
                    .block_on(sources.list_sources(&rpc::ListSourcesRequest {}))
                    .map_err(project_setup::service_error)?
                    .sources;
                if title.is_none() && !ui.interactive {
                    return Err(onboarding::required(
                        "specify init --name NAME to create a project, or init --source SOURCE to connect one",
                    ));
                }
                if title.is_none() && !available.is_empty() {
                    let mut choices = vec![(
                        "new".into(),
                        "Create a new project".into(),
                        "Track events for a new app".into(),
                    )];
                    choices.extend(available.iter().enumerate().map(|(i, project)| {
                        (
                            i.to_string(),
                            project
                                .title
                                .clone()
                                .unwrap_or_else(|| project.name.clone()),
                            format!("{} · {}", project.name, project.role),
                        )
                    }));
                    let choice = ui.select("What would you like to connect?", &choices, "new")?;
                    if choice != "new" {
                        let found = available[choice.parse::<usize>()?].clone();
                        source = Some(found.id.clone());
                        let info = runtime
                            .block_on(sources.get_source(&rpc::GetSourceRequest {
                                source: found.id.clone(),
                            }))
                            .map_err(project_setup::service_error)?;
                        ingest_url = Some(info.ingest_url);
                        selected = Some(found);
                    }
                }
                if source.is_none() {
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
                    loop {
                        let name = title.as_deref().context("app name")?;
                        let conflict = available.iter().find(|project| {
                            project.role == "owner"
                                && project.name == project_setup::alias(name)
                                && pending_name.as_deref() != Some(name)
                        });
                        let Some(found) = conflict else {
                            break;
                        };
                        if !ui.interactive {
                            anyhow::bail!(
                                "that project already exists; use init --source {} to connect it, or choose another name",
                                found.id
                            );
                        }
                        let choice = ui.select(
                            "Project already exists",
                            &[
                                (
                                    "connect".into(),
                                    "Connect the existing project".into(),
                                    found.title.clone().unwrap_or_else(|| found.name.clone()),
                                ),
                                (
                                    "rename".into(),
                                    "Choose another app name".into(),
                                    "Create a separate cloud project".into(),
                                ),
                            ],
                            "connect",
                        )?;
                        if choice == "connect" {
                            let info = runtime
                                .block_on(sources.get_source(&rpc::GetSourceRequest {
                                    source: found.id.clone(),
                                }))
                                .map_err(project_setup::service_error)?;
                            source = Some(info.source.id.clone());
                            ingest_url = Some(info.ingest_url);
                            selected = Some(info.source);
                            title = None;
                            break;
                        }
                        title = Some(ui.input("Choose another app name", "", validate)?);
                    }
                }
            }
            token = Some(access);
            client = Some(sources);
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
        let create_sdk_key = if selected
            .as_ref()
            .is_some_and(|project| project.role == "owner")
            && ui.interactive
        {
            let account = config::publishable_account(
                &backend,
                source.as_deref().context("selected source")?,
            );
            slurp_client::storage::get(&account)?.is_none()
                && ui.confirm("Create a publishable SDK key for this connection?", true)?
        } else {
            false
        };
        if ui.interactive {
            ui.note("Review project setup", &format!("Project: {}\nBackend: {}\nEvent database: {}\nInstall skills: {}\nAppend agent reminder: {}\nCreate SDK key: {}", title.as_deref().or_else(||selected.as_ref().map(|project|project.title.as_deref().unwrap_or(&project.name))).or(source.as_deref()).unwrap_or("new project"),backend,database.display(),install,append,create_sdk_key || source.is_none()))?;
            ensure!(
                ui.confirm("Connect this app?", true)?,
                Failure::new(
                    ErrorCode::Cancelled,
                    "initialization cancelled; no project or cloud source created"
                )
            );
        }
        if let Some(anchor) = &anchor {
            anchor.verify()?;
        }
        validate_database(&root, &database)?;
        // Verify writability before creating remote resources; the database is still absent.
        storage::prepare(&root, &database)?;
        if source.is_none() {
            let mut pending = Creation::open(
                &home,
                &root,
                &backend,
                token.as_deref().context("account token")?,
                title.as_deref().context("project name")?,
            )?;
            let (created, url) =
                runtime.block_on(pending.create(client.as_ref().context("project client")?))?;
            source = Some(created.id.clone());
            ingest_url = Some(url);
            selected = Some(created);
            creation = Some(pending);
        } else if create_sdk_key {
            let key = runtime
                .block_on(client.as_ref().context("project client")?.create_key(
                    &rpc::CreateKeyRequest {
                        source: source.clone().context("project")?,
                        scope: "publishable".into(),
                        name: Some("SDK setup".into()),
                    },
                ))
                .map_err(project_setup::service_error)?;
            slurp_client::storage::set(
                &config::publishable_account(&backend, source.as_deref().context("project")?),
                &key.key,
            )?;
            sdk_key = Some(key.key);
        }
        if let (Some(info), Some(url)) = (selected, &ingest_url) {
            config::cache_source(
                &home,
                config::CachedSource {
                    backend: backend.clone(),
                    source: info,
                    ingest_url: url.clone(),
                },
            )?;
        }
        if let Some(anchor) = &anchor {
            anchor.verify()?;
        }
        let saved = Workspace::init(
            &root,
            backend,
            source.context("project source")?,
            Some(database),
            engine,
        )?;
        if install {
            slurp_app::skills::install(&root.join(".agents/skills/slurp"), false, true)?;
        }
        let notes = if append {
            Some(agent_notes::append(&root)?)
        } else {
            None
        };
        workspace = Some(saved);
        // The workspace now records the source, so future init runs never issue CreateSource.
        if let Some(pending) = creation.take() {
            pending.finish()?;
        }
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
    let bound = bound_environment(&workspace.backend, &workspace.source);
    let mut warnings = Vec::new();
    if key.is_none() && bound {
        key = environment("SLURP_PUBLISHABLE_KEY").filter(|key| key.starts_with("slurp_pk_"));
    }
    if key.is_none() {
        match slurp_client::storage::get(&config::publishable_account(&workspace.backend, &workspace.source)) {
            Ok(saved) => key = saved,
            Err(_) => warnings.push("The SDK key is unavailable in the credential store; the project connection is ready for analysis.".to_owned()),
        }
    }
    let cached = config::load(&home)?
        .sources
        .into_iter()
        .find(|source| source.backend == workspace.backend && source.source.id == workspace.source);
    if ingest_url.is_none() {
        if bound {
            ingest_url = environment("SLURP_INGEST_URL");
        }
        if ingest_url.is_none() {
            ingest_url = cached.as_ref().map(|source| source.ingest_url.clone());
        }
    }
    let prefix = if std::env::current_dir()?.canonicalize()? == root {
        "slurp".to_owned()
    } else {
        format!("slurp --workspace {}", shell(&root.to_string_lossy()))
    };
    let commands = format!(
        "{prefix} sync\n{prefix} sql 'SELECT event, count(*) AS n FROM events GROUP BY event'"
    );
    let context = PageContext {
        project_name: cached
            .map(|source| source.source.title.unwrap_or(source.source.name))
            .or_else(|| {
                root.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            }),
        backend: Some(workspace.backend.clone()),
        source: Some(workspace.source.clone()),
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
    ui.success("This app is connected. Your project remembers its source and event storage.")?;
    let mut result = serde_json::to_value(workspace)?;
    let fields = json!({"initialized":true,"project_name":context.project_name,"setup_page":path,"opened":opened,"warnings":warnings,"registry_warning":registry_warning,"next_steps":commands,"skills_installed":if installed{Some(root.join(".agents/skills/slurp"))}else{None},"agent_notes":notes,"agent_notes_suggestion":agent_notes::REMINDER});
    result
        .as_object_mut()
        .context("workspace result")?
        .extend(fields.as_object().context("initialization result")?.clone());
    Ok(result)
}
