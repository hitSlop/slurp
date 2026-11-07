//! Machine setup: storage preferences, an external engine, and account access.
use crate::{login, terminal::Terminal};
use anyhow::{Context, Result, ensure};
use clap::Args;
use serde_json::{Value, json};
use slurp_app::{
    drives::{self, Drive},
    error::{ErrorCode, Failure},
    setup, storage, system,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Args, Default)]
pub struct Options {
    /// Default library folder for future projects.
    #[arg(long)]
    pub library: Option<PathBuf>,
    /// Use an existing DuckDB 2 executable instead of a managed installation.
    #[arg(long)]
    pub duckdb: Option<PathBuf>,
    /// Override the Slurp Worker URL; defaults to the local `wrangler dev` Worker (http://127.0.0.1:8787).
    #[arg(long, env = "SLURP_BACKEND")]
    pub backend: Option<String>,
    /// Prepare local preferences without connecting a Worker.
    #[arg(long)]
    pub no_connect: bool,
    /// Print browser destinations instead of opening them.
    #[arg(long)]
    pub no_open: bool,
    /// Open the bundled public-content SSD guide.
    #[arg(long)]
    pub storage_guide: bool,
}
pub fn open_target(target: impl AsRef<std::ffi::OsStr>) -> bool {
    Command::new(if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    })
    .arg(target)
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .is_ok_and(|status| status.success())
}
fn guide(ui: &Terminal, no_open: bool) -> Result<Value> {
    let path = setup::write_storage_guide(&slurp_client::config::home()?)?;
    let opened = ui.interactive && !no_open && open_target(&path);
    let catalog: Value = serde_json::from_str(include_str!("../assets/storage-options.json"))?;
    let mut summary = String::new();
    for option in catalog["options"].as_array().context("storage catalog")? {
        summary.push_str(&format!(
            "{} · {} {} · {}\n",
            option["tier"].as_str().unwrap_or_default(),
            option["model"].as_str().unwrap_or_default(),
            option["capacity"].as_str().unwrap_or_default(),
            option["price_range"].as_str().unwrap_or_default()
        ));
    }
    summary.push_str(&format!("\nUSD reference prices, reviewed {}. Check current availability.\nGuide: {}\nReturn here to choose storage, or connect a drive and choose Rescan.", catalog["reviewed_at"].as_str().unwrap_or_default(), path.display()));
    ui.note("Storage buying guide", &summary)?;
    Ok(json!({"storage_guide":path,"opened":opened,"guide_only":true,"catalog":catalog}))
}
struct Library {
    path: PathBuf,
    external: Option<Drive>,
    anchor: Drive,
}
fn library(path: PathBuf, external: Option<Drive>) -> Result<Library> {
    ensure!(
        !path.exists() || path.is_dir(),
        "library must be a directory"
    );
    let anchor = if path.is_dir() {
        path.as_path()
    } else {
        path.parent().context("library parent")?
    };
    ensure!(
        anchor.is_dir(),
        "library parent is unavailable; connect the drive or choose an existing parent"
    );
    let anchor = Drive::from_path(anchor, "Library".into(), None)?;
    Ok(Library {
        path,
        external,
        anchor,
    })
}
fn inventory(ui: &Terminal) -> Result<Vec<Drive>> {
    match drives::discover() {
        Ok(drives) => Ok(drives),
        Err(_) => {
            ui.note("Drive discovery", "Automatic discovery is unavailable. You can still enter a library folder manually.")?;
            Ok(Vec::new())
        }
    }
}
fn choose_library(ui: &Terminal, saved: Option<&Path>, no_open: bool) -> Result<Library> {
    let cwd = std::env::current_dir()?;
    let internal =
        PathBuf::from(std::env::var_os("HOME").context("HOME is required")?).join("SlurpLibrary");
    ui.note("Room for your events", "An external SSD is recommended for large or long-lived event histories. Your internal disk is fine to start.\nChoose a library once. Each app gets its own folder and events.duckdb file inside it.")?;
    let mut drives = inventory(ui)?;
    loop {
        let mut items = vec![
            (
                "external".into(),
                "External drive".into(),
                "Recommended for large histories".into(),
            ),
            (
                "internal".into(),
                "Internal disk".into(),
                internal.display().to_string(),
            ),
            (
                "custom".into(),
                "Another folder".into(),
                "Enter your default library folder".into(),
            ),
            (
                "guide".into(),
                "Compare / buy an SSD".into(),
                "Optional · US$50–100 budget tier and larger options".into(),
            ),
        ];
        if let Some(saved) = saved {
            items.push((
                "saved".into(),
                "Keep current library".into(),
                saved.display().to_string(),
            ));
        }
        let initial = if saved.is_some() {
            "saved"
        } else if drives.is_empty() {
            "internal"
        } else {
            "external"
        };
        match ui
            .select("Where should your event library live?", &items, initial)?
            .as_str()
        {
            "saved" => return library(saved.context("saved library")?.to_path_buf(), None),
            "internal" => return library(storage::resolve(&cwd, &internal)?, None),
            "custom" => {
                let root = cwd.clone();
                let folder = ui.input("Event library folder", "", move |value| {
                    if value.is_empty() {
                        return Err("Enter a library folder.".into());
                    }
                    let path = storage::resolve(&root, Path::new(value))
                        .map_err(|error| error.to_string())?;
                    library(path, None)
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                })?;
                return library(storage::resolve(&cwd, Path::new(&folder))?, None);
            }
            "guide" => {
                guide(ui, no_open)?;
            }
            "external" => loop {
                let mut choices = drives
                    .iter()
                    .enumerate()
                    .map(|(i, d)| {
                        (
                            i.to_string(),
                            d.name.clone(),
                            format!(
                                "{} · {:.1} GiB available",
                                d.mount.display(),
                                d.available_bytes as f64 / 1_073_741_824.0
                            ),
                        )
                    })
                    .collect::<Vec<_>>();
                choices.extend([
                    (
                        "rescan".into(),
                        "Rescan drives".into(),
                        "After connecting a drive".into(),
                    ),
                    ("back".into(), "Back".into(), "Other storage choices".into()),
                ]);
                let picked = ui.select("Choose a connected drive", &choices, "back")?;
                if picked == "back" {
                    break;
                }
                if picked == "rescan" {
                    drives = inventory(ui)?;
                    continue;
                }
                let drive = drives[picked.parse::<usize>()?].clone();
                return library(drive.library_directory()?, Some(drive));
            },
            _ => unreachable!("fixed storage choices"),
        }
    }
}
pub fn required(message: impl Into<String>) -> anyhow::Error {
    Failure::new(ErrorCode::SetupRequired, message).into()
}

fn prepare_library(selected: Library) -> Result<PathBuf> {
    if let Some(drive) = selected.external {
        drive.prepare_library()?;
    } else {
        selected.anchor.verify()?;
        match fs::create_dir(&selected.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        selected.anchor.verify()?;
        tempfile::NamedTempFile::new_in(&selected.path).context("library is not writable")?;
    }
    Ok(selected.path)
}

fn configured_status(home: &Path, saved: &system::Settings) -> Value {
    let library_available = saved.library_dir.as_ref().is_some_and(|path| path.is_dir());
    let duckdb_available = saved.duckdb.as_ref().is_some_and(|path| path.is_file());
    json!({"already_configured":true,"home":home,"config":home.join("config.toml"),"backend":saved.backend,"library_dir":saved.library_dir,"duckdb":saved.duckdb,"library_available":library_available,"duckdb_available":duckdb_available,"local_ready":library_available && duckdb_available,"authenticated":null,"next_steps":"Run slurp init inside your app. Reconnect unavailable storage before syncing or querying."})
}

fn settings_menu(
    home: &Path,
    mut saved: system::Settings,
    ui: &Terminal,
    no_open: bool,
) -> Result<Value> {
    if !ui.interactive {
        return Ok(configured_status(home, &saved));
    }
    ui.heading("Slurp is already configured on this computer.")?;
    let mut connected = None;
    loop {
        let status = configured_status(home, &saved);
        ui.note(
            "Machine settings",
            &format!(
                "Backend: {}\nLibrary: {}{}\nDuckDB: {}{}",
                saved
                    .backend
                    .as_deref()
                    .unwrap_or(slurp_client::config::DEFAULT_BACKEND),
                saved
                    .library_dir
                    .as_deref()
                    .context("saved library")?
                    .display(),
                if status["library_available"] == true {
                    ""
                } else {
                    " (unavailable; reconnect the drive)"
                },
                saved.duckdb.as_deref().context("saved DuckDB")?.display(),
                if status["duckdb_available"] == true {
                    ""
                } else {
                    " (unavailable)"
                }
            ),
        )?;
        let choice = ui.select(
            "What would you like to do?",
            &[
                (
                    "done".into(),
                    "Done".into(),
                    "Use slurp init inside an app to connect it".into(),
                ),
                (
                    "library".into(),
                    "Change the default library".into(),
                    "For new projects; existing data stays where it is".into(),
                ),
                (
                    "guide".into(),
                    "Compare / buy an SSD".into(),
                    "Open the offline storage guide".into(),
                ),
                (
                    "check".into(),
                    "Check setup and Worker connection".into(),
                    "Validate storage, DuckDB, and your Worker".into(),
                ),
            ],
            "done",
        )?;
        match choice.as_str() {
            "done" => {
                ui.success("Run slurp init inside your app to connect a project.")?;
                let mut result = configured_status(home, &saved);
                result["connected"] = json!(connected);
                return Ok(result);
            }
            "guide" => {
                guide(ui, no_open)?;
            }
            "library" => {
                let change = (|| -> Result<()> {
                    let selected = choose_library(ui, saved.library_dir.as_deref(), no_open)?;
                    if Some(&selected.path) == saved.library_dir.as_ref() {
                        return Ok(());
                    }
                    ui.note("Default library for new projects", &format!("New library: {}\nExisting project files and databases will stay in their current locations.",selected.path.display()))?;
                    if !ui.confirm("Save this default library?", true)? {
                        return Ok(());
                    }
                    let path = prepare_library(selected)?;
                    system::save_machine(
                        home,
                        saved
                            .backend
                            .as_deref()
                            .unwrap_or(slurp_client::config::DEFAULT_BACKEND),
                        &path,
                        saved.duckdb.as_deref().context("saved DuckDB")?,
                    )?;
                    saved = system::settings(home)?;
                    ui.note("Default library saved", "New projects will use this library. Existing projects keep their saved storage.")?;
                    Ok(())
                })();
                if let Err(error) = change {
                    if error
                        .downcast_ref::<Failure>()
                        .is_some_and(|failure| matches!(failure.code, ErrorCode::Cancelled))
                    {
                        return Err(error);
                    }
                    ui.note("Default library not changed", &error.to_string())?;
                }
            }
            "check" => {
                let engine = setup::check_engine(saved.duckdb.as_deref().context("saved DuckDB")?);
                ui.note(
                    "Local setup check",
                    &format!(
                        "Library: {}\nDuckDB: {}",
                        if saved.library_dir.as_ref().is_some_and(|path| path.is_dir()) {
                            "available"
                        } else {
                            "unavailable; reconnect it or change the default for new projects"
                        },
                        engine
                            .as_ref()
                            .map(|version| format!("{version} available"))
                            .unwrap_or_else(|error| format!(
                                "{error}; run setup --duckdb PATH to select another engine"
                            ))
                    ),
                )?;
                match tokio::runtime::Runtime::new()?.block_on(login::ensure(
                    saved
                        .backend
                        .as_deref()
                        .unwrap_or(slurp_client::config::DEFAULT_BACKEND),
                    ui,
                    no_open,
                )) {
                    Ok(_) => {
                        connected = Some(true);
                        ui.note("Worker connected", "Ready to connect projects.")?;
                    }
                    Err(error) => {
                        connected = Some(false);
                        ui.note("Worker connection incomplete", &error.to_string())?;
                    }
                }
            }
            _ => unreachable!("fixed machine settings actions"),
        }
    }
}

pub fn run(options: Options, machine_output: bool) -> Result<Value> {
    let ui = Terminal::new(machine_output);
    if options.storage_guide {
        return guide(&ui, options.no_open);
    }
    let home = slurp_client::config::home()?;
    let saved = system::settings(&home)?;
    let backend_changed = options
        .backend
        .as_deref()
        .map(slurp_client::config::normalize_backend)
        .transpose()?
        .is_some_and(|backend| Some(&backend) != saved.backend.as_ref());
    if saved.library_dir.is_some()
        && saved.duckdb.is_some()
        && options.library.is_none()
        && options.duckdb.is_none()
        && !options.no_connect
        && !backend_changed
    {
        return settings_menu(&home, saved, &ui, options.no_open);
    }
    ui.welcome(saved.library_dir.is_none() || saved.duckdb.is_none())?;
    let backend = slurp_client::config::normalize_backend(
        options
            .backend
            .as_deref()
            .or(saved.backend.as_deref())
            .unwrap_or(slurp_client::config::DEFAULT_BACKEND),
    )?;
    let selected = if let Some(path) = &options.library {
        library(storage::resolve(&std::env::current_dir()?, path)?, None)?
    } else if ui.interactive {
        choose_library(&ui, saved.library_dir.as_deref(), options.no_open)?
    } else {
        library(
            saved.library_dir.clone().ok_or_else(|| {
                required(
                    "choose a library with setup --library PATH, or run slurp setup interactively",
                )
            })?,
            None,
        )?
    };
    let mut executable =
        match setup::find_engine(options.duckdb.as_deref(), saved.duckdb.as_deref()) {
            Ok(executable) => executable,
            Err(error) if ui.interactive && options.duckdb.is_none() => {
                ui.note("DuckDB needs attention", &error.to_string())?;
                setup::find_engine(None, None).ok().flatten()
            }
            Err(error) => return Err(error),
        };
    let mut install = false;
    if executable.is_none() {
        if !ui.interactive {
            return Err(required(
                "DuckDB is unavailable; pass --duckdb PATH or run slurp setup interactively",
            ));
        }
        let choice = ui.select(
            "How would you like to provide DuckDB?",
            &[
                (
                    "install".into(),
                    "Install official DuckDB 2.0.0".into(),
                    "Managed in ~/.slurp/bin; no shell changes".into(),
                ),
                (
                    "path".into(),
                    "Use my own DuckDB".into(),
                    "Choose an existing DuckDB 2 executable".into(),
                ),
            ],
            "install",
        )?;
        if choice == "install" {
            install = true;
        } else {
            let path = ui.input("DuckDB executable", "", |value| {
                setup::check_engine(Path::new(value))
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })?;
            executable = setup::find_engine(Some(Path::new(&path)), None)?;
        }
    }
    if ui.interactive {
        ui.note(
            "Review machine setup",
            &format!(
                "Library: {}\nDuckDB: {}\nWorker: {}\nConnect a Worker: {}",
                selected.path.display(),
                executable
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "install official 2.0.0".into()),
                backend,
                !options.no_connect
            ),
        )?;
        ensure!(
            ui.confirm("Prepare this computer?", true)?,
            Failure::new(
                ErrorCode::Cancelled,
                "setup cancelled; no preferences applied"
            )
        );
    }
    if !ui.interactive && !options.no_connect {
        tokio::runtime::Runtime::new()?.block_on(login::ensure(&backend, &ui, options.no_open))?;
    }
    if install {
        executable = Some(setup::install()?);
    }
    let executable = executable.context("DuckDB executable")?;
    let library_path = prepare_library(selected)?;
    system::save_machine(&home, &backend, &library_path, &executable)?;
    if ui.interactive && !options.no_connect {
        tokio::runtime::Runtime::new()?
            .block_on(login::ensure(&backend, &ui, options.no_open))
            .context(
                "machine preferences saved; Worker connection incomplete; rerun slurp setup to continue",
            )?;
    }
    let next = if options.no_connect {
        "Run slurp connect <worker-url> when ready, then run slurp init inside your app's folder."
    } else {
        "This computer is ready. Run slurp init inside your app's folder."
    };
    ui.success(next)?;
    Ok(
        json!({"home":home,"config":home.join("config.toml"),"library_dir":library_path,"duckdb":executable,"connected":!options.no_connect,"local_ready":true,"missing":if options.no_connect {vec!["login"]}else{Vec::<&str>::new()},"next_steps":next}),
    )
}
