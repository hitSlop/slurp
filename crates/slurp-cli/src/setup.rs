//! Explicit DuckDB installation support; callers own confirmation.
use anyhow::{Context, Result, bail};
use std::{fs, path::PathBuf, process::Command};
/// Pinned, qualified DuckDB release used by setup.
pub const DUCKDB_VERSION: &str = "2.0.0";

/// DuckDB community extensions a report or query may load. Extensions are native code, so a Markdown file can only
/// name one of these; anything else is refused.
pub const COMMUNITY_EXTENSIONS: &[&str] = &["behavioral"];

/// Check that every name is an allowed community extension.
///
/// # Errors
/// Returns an error naming the first extension that is not allowed.
pub fn check_extension_names(names: &[String]) -> Result<()> {
    for name in names {
        anyhow::ensure!(
            COMMUNITY_EXTENSIONS.contains(&name.as_str()),
            "unsupported DuckDB extension {name:?}; allowed: {}",
            COMMUNITY_EXTENSIONS.join(", ")
        );
    }
    Ok(())
}

/// Make sure a community extension is installed for this DuckDB. The first call downloads it from DuckDB's community
/// repository; afterwards it works offline.
///
/// # Errors
/// Returns an error if the name is not allowed or the extension cannot be installed and loaded.
pub fn install_extension(engine: &std::path::Path, name: &str) -> Result<()> {
    check_extension_names(&[name.to_owned()])?;
    let output = Command::new(engine)
        .args(["-no-agent", "-init", "/dev/null", "-bail", "-c"])
        .arg(format!("INSTALL {name} FROM community; LOAD {name};"))
        .output()
        .with_context(|| format!("DuckDB unavailable at {}", engine.display()))?;
    anyhow::ensure!(
        output.status.success(),
        "could not install the DuckDB extension {name:?}. It is downloaded once from DuckDB's community repository, so this \
         computer needs to be online the first time. Connect and run the command again. DuckDB said: {}",
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .last()
            .unwrap_or("nothing")
    );
    Ok(())
}

/// Default private executable destination, without changing shell configuration.
pub fn destination() -> Result<PathBuf> {
    Ok(slurp_client::config::home()?.join("bin/duckdb"))
}

/// Find a managed executable, including installations under earlier default locations.
///
/// # Errors
/// Returns an error if the home cannot be resolved or an installed engine is incompatible.
pub fn managed_engine() -> Result<Option<PathBuf>> {
    let home = slurp_client::config::home()?;
    for location in std::iter::once(home.clone()).chain(slurp_client::config::legacy_homes(&home)) {
        let path = location.join("bin/duckdb");
        if path.is_file() {
            check_engine(&path)?;
            return Ok(Some(path));
        }
    }
    Ok(None)
}
/// Find a qualified executable from an override, saved preference, PATH, or prior install.
///
/// # Errors
/// Returns an error when an explicitly selected executable is unavailable or incompatible.
pub fn find_engine(
    explicit: Option<&std::path::Path>,
    saved: Option<&std::path::Path>,
) -> Result<Option<PathBuf>> {
    if let Some(path) = explicit.or(saved) {
        check_engine(path)?;
        return Ok(Some(
            path.canonicalize().context("resolving DuckDB executable")?,
        ));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let path = directory.join("duckdb");
            if path.is_file() && check_engine(&path).is_ok() {
                return Ok(Some(path.canonicalize()?));
            }
        }
    }
    managed_engine()
}
/// Validate the external engine before creating or opening a workspace.
///
/// # Errors
/// Returns an error when DuckDB is unavailable or is not a supported 2.x release.
pub fn check_engine(path: &std::path::Path) -> Result<String> {
    let output = Command::new(path)
        .arg("--version")
        .output()
        .with_context(|| format!("DuckDB unavailable at {}", path.display()))?;
    anyhow::ensure!(output.status.success(), "DuckDB version check failed");
    let text = String::from_utf8(output.stdout).context("DuckDB version output")?;
    let version = text
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_start_matches('v');
    anyhow::ensure!(
        version.split('.').next() == Some("2"),
        "Slurp requires DuckDB 2.x; found {version} at {}. Supply --duckdb with a DuckDB 2 executable when initializing.",
        path.display()
    );
    Ok(version.to_owned())
}

/// Download a pinned official release after the caller has obtained confirmation.
pub fn install() -> Result<PathBuf> {
    let asset = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "osx-universal",
        ("linux", "x86_64") => "linux-amd64",
        ("linux", "aarch64") => "linux-arm64",
        _ => bail!("unsupported installation platform"),
    };
    let tmp = tempfile::tempdir()?;
    let zip = tmp.path().join("duckdb.tar.gz");
    let url = format!(
        "https://github.com/duckdb/duckdb/releases/download/v{DUCKDB_VERSION}/duckdb-cli-{asset}.tar.gz"
    );
    anyhow::ensure!(
        Command::new("curl")
            .args([
                "--fail",
                "--location",
                "--proto",
                "=https",
                "--tlsv1.2",
                "--output"
            ])
            .arg(&zip)
            .arg(url)
            .status()?
            .success(),
        "DuckDB download failed"
    );
    anyhow::ensure!(
        Command::new("tar")
            .arg("-xzf")
            .arg(&zip)
            .arg("-C")
            .arg(tmp.path())
            .status()?
            .success(),
        "DuckDB extraction failed"
    );
    let path = destination()?;
    if path.exists() {
        bail!("private DuckDB already exists; refusing overwrite")
    }
    fs::create_dir_all(path.parent().context("installation parent")?)?;
    fs::copy(tmp.path().join("duckdb"), &path)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

/// Personal context for the local setup page. Never serialize this into logs or URLs.
#[derive(Default, serde::Serialize)]
pub struct PageContext {
    pub project_name: Option<String>,
    pub backend: Option<String>,
    pub source: Option<String>,
    pub ingest_url: Option<String>,
    pub publishable_key: Option<String>,
    pub read_key: Option<String>,
    pub generated_at: String,
    pub workspace: Option<String>,
    pub database: Option<String>,
    pub data_dir: Option<String>,
    pub workspace_initialized: bool,
    pub init_command: Option<String>,
    pub sync_commands: Option<String>,
    pub guide_only: bool,
}
/// Write an atomically replaced, owner-only page; external scripts and connections are blocked.
pub fn write_page(path: &std::path::Path, context: &PageContext) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let parent = path.parent().context("setup page parent")?;
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    // Escape HTML-significant characters even though the payload is inert JSON.
    let payload = serde_json::to_string(context)?
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    let html = include_str!("../assets/setup.html").replace("__SLURP_CONTEXT__", &payload);
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(html.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}

/// Write a public-content storage guide without source context or credentials.
///
/// # Errors
/// Returns an error if the private local guide cannot be written.
pub fn write_storage_guide(home: &std::path::Path) -> Result<PathBuf> {
    let path = home.join("setup/storage-guide.html");
    write_page(
        &path,
        &PageContext {
            guide_only: true,
            ..Default::default()
        },
    )?;
    Ok(path)
}
