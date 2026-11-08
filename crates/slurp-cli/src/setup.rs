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

/// Find the managed DuckDB executable under the Slurp home.
///
/// # Errors
/// Returns an error if the home cannot be resolved or an installed engine is incompatible.
pub fn managed_engine() -> Result<Option<PathBuf>> {
    let home = slurp_client::config::home()?;
    let path = home.join("bin/duckdb");
    if path.is_file() {
        check_engine(&path)?;
        return Ok(Some(path));
    }
    Ok(None)
}
/// Find a qualified executable from an override, saved preference, PATH, or the managed install.
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

/// SHA-256 of each DuckDB release asset `install` can download, for [`DUCKDB_VERSION`]. They come from the `digest` field of
/// the GitHub release API (`gh api repos/duckdb/duckdb/releases/tags/v2.0.0`) and were checked by hashing the downloaded
/// files. Update them together with the version.
const DUCKDB_SHA256: &[(&str, &str)] = &[
    (
        "osx-universal",
        "8a8f67e7c7f7d1392fa63ba3971948391392fe2a25fca63e7008e33c50beb4c2",
    ),
    (
        "linux-amd64",
        "c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc",
    ),
    (
        "linux-arm64",
        "859e1875d2a9515fbb4bf8871061437a14af82320da68c753f094c4b776348fe",
    ),
];

/// Check a downloaded DuckDB archive against the digest pinned for its asset.
///
/// # Errors
/// Returns an error when the asset has no pinned digest, the file cannot be read, or its SHA-256 differs.
pub fn verify_download(asset: &str, file: &std::path::Path) -> Result<()> {
    use sha2::{Digest, Sha256};
    let expected = DUCKDB_SHA256
        .iter()
        .find(|(name, _)| *name == asset)
        .map(|(_, digest)| *digest)
        .with_context(|| format!("no pinned digest for the DuckDB asset {asset}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut fs::File::open(file)?, &mut hasher)
        .context("reading the DuckDB download")?;
    let actual = hex::encode(hasher.finalize());
    anyhow::ensure!(
        actual == expected,
        "the DuckDB download does not match its pinned SHA-256 (expected {expected}, got {actual}); nothing was installed"
    );
    Ok(())
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
    verify_download(asset, &zip)?;
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
    pub project: Option<String>,
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
    slurp_client::files::write_atomic(path, html.as_bytes())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_installable_asset_has_a_pinned_digest_and_a_wrong_download_is_refused() {
        for asset in ["osx-universal", "linux-amd64", "linux-arm64"] {
            let digest = DUCKDB_SHA256
                .iter()
                .find(|(name, _)| *name == asset)
                .unwrap_or_else(|| panic!("no digest for {asset}"))
                .1;
            assert!(
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                "{asset}: {digest}"
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("duckdb.tar.gz");
        fs::write(&file, b"not the DuckDB release").unwrap();
        let error = verify_download("linux-amd64", &file)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("does not match its pinned SHA-256"),
            "{error}"
        );
        assert!(verify_download("windows-amd64", &file).is_err());
        assert!(verify_download("linux-amd64", &dir.path().join("missing")).is_err());
    }
}
