//! Reusable workspace operations. No terminal interaction or daemon is required.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
pub mod agent_notes;
pub mod drives;
pub mod error;
pub mod project;
pub mod project_setup;
pub mod skills;
pub mod storage;
pub mod system;
use error::{ErrorCode, Failure};
pub use import::ImportStats;
pub mod health;
pub mod helpers;
pub mod import;
pub mod mcp;
pub mod notify;
pub mod report;
pub mod report_check;
pub mod report_format;
pub mod report_hover;
pub mod report_style;
pub mod setup;
/// Cooperative cancellation shared by a caller and an operation.
#[derive(Debug, Clone, Default)]
pub struct Cancellation(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Cancellation {
    /// Request cancellation; already committed archives remain committed.
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}
/// Structured progress independent of terminal presentation.
#[derive(Debug, Serialize)]
pub struct SyncProgress {
    pub sequence: u64,
    pub downloaded: usize,
}

/// Versioned, non-secret binding of a local workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub version: u32,
    pub backend: String,
    pub project: String,
    pub database: PathBuf,
    pub duckdb: PathBuf,
    #[serde(skip)]
    pub cancellation: Cancellation,
    /// Community extensions loaded into every query run through this value (see [`Workspace::with_extensions`]).
    #[serde(skip)]
    pub extensions: Vec<String>,
    /// Read-only queries run with DuckDB's external file access switched off and its settings locked, so SQL written by an
    /// agent cannot read local files (`read_csv('/etc/...')`) or change its own limits. Off for `slurp sql`, where joining a
    /// local file is a feature; on for the MCP server (see [`Workspace::sandboxed`]).
    #[serde(skip)]
    pub sandbox: bool,
}
/// Replace the bare `Infinity`, `-Infinity` and `NaN` words DuckDB writes for non-finite doubles with `null`, leaving
/// everything inside strings alone.
pub fn null_non_finite(json: &str) -> std::borrow::Cow<'_, str> {
    if !json.contains("Infinity") && !json.contains("NaN") {
        return json.into();
    }
    let mut out = String::with_capacity(json.len());
    let (mut in_string, mut escaped) = (false, false);
    let mut rest = json;
    while let Some(c) = rest.chars().next() {
        if in_string {
            in_string = !(c == '"' && !escaped);
            escaped = c == '\\' && !escaped;
        } else if c == '"' {
            in_string = true;
        } else if let Some(after) = rest
            .strip_prefix("-Infinity")
            .or_else(|| rest.strip_prefix("Infinity"))
            .or_else(|| rest.strip_prefix("NaN"))
        {
            out.push_str("null");
            rest = after;
            continue;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out.into()
}
/// The tables of a fresh database (`docs/contracts.md`, "Local import"). There is no migration from earlier layouts.
const SCHEMA: &str = "BEGIN;
CREATE SCHEMA _slurp;
CREATE TABLE _slurp.identity(version INTEGER, backend VARCHAR, project VARCHAR);
CREATE TABLE _slurp.deliveries(project VARCHAR, sequence BIGINT, sha256 VARCHAR, bytes UBIGINT, imported_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(project, sequence));
CREATE TABLE _slurp.problems(kind VARCHAR, sender VARCHAR, id VARCHAR, archive_seq BIGINT, line BIGINT, record VARCHAR, detail VARCHAR, seen_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(kind, archive_seq, line));
CREATE TABLE events(sender VARCHAR, id VARCHAR, type VARCHAR, event VARCHAR, timestamp TIMESTAMPTZ, user_id VARCHAR, anonymous_id VARCHAR, session_id VARCHAR, data JSON, context JSON, geo JSON, received_at TIMESTAMPTZ, archive_seq BIGINT, line BIGINT, raw JSON, fingerprint VARCHAR, PRIMARY KEY(sender, id));";

/// Quote SQL data; identifiers in generated SQL are fixed by Slurp.
pub fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
impl Workspace {
    /// Initialize a fresh database and project binding. Existing files are never overwritten.
    pub fn init(
        root: &Path,
        backend: String,
        project: String,
        database: Option<PathBuf>,
        duckdb: PathBuf,
    ) -> Result<Self> {
        if !project.starts_with("prj_") {
            bail!("use a stable prj_ project ID")
        }
        let backend = slurp_client::config::normalize_backend(&backend)?;
        let root = root.canonicalize()?;
        let config = root.join(".slurp/project.toml");
        let database = storage::database_path(&root, None, database.as_deref())?;
        if config.exists() || database.exists() {
            bail!("workspace or database already exists")
        }
        let duckdb = if duckdb == Path::new("duckdb")
            && setup::check_engine(&duckdb).is_err()
            && let Some(managed) = setup::managed_engine()?
        {
            managed
        } else {
            duckdb
        };
        setup::check_engine(&duckdb)?;
        storage::prepare(&root, &database)?;
        let staging = tempfile::Builder::new()
            .prefix(".slurp-init-")
            .tempdir_in(database.parent().context("database parent")?)?;
        let mut w = Self {
            version: 1,
            backend,
            project,
            database: staging.path().join("events.duckdb"),
            duckdb,
            cancellation: Cancellation::default(),
            extensions: Vec::new(),
            sandbox: false,
        };
        w.execute_inner(
            &format!(
                "{SCHEMA}\nINSERT INTO _slurp.identity VALUES(1,{},{}); COMMIT;",
                literal(&w.backend),
                literal(&w.project)
            ),
            false,
            true,
        )?;
        w.execute_inner(&helpers::script(), false, true)?;
        fs::create_dir_all(root.join(".slurp/reports"))?;
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&database)
            .context("database destination already exists or cannot be created")?;
        let staged_database = w.database.clone();
        w.database = database;
        let persisted = (|| -> Result<()> {
            std::io::copy(&mut fs::File::open(&staged_database)?, &mut destination)?;
            destination.sync_all()?;
            let mut file =
                tempfile::NamedTempFile::new_in(config.parent().context("config parent")?)?;
            file.write_all(toml::to_string_pretty(&w)?.as_bytes())?;
            file.as_file().sync_all()?;
            let ignore = root.join(".slurp/.gitignore");
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(ignore)
            {
                Ok(mut file) => file.write_all(b"data/\noutput/\n")?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            file.persist_noclobber(&config)?;
            Ok(())
        })();
        if let Err(error) = persisted {
            fs::remove_file(&w.database)
                .context("initialization failed; cannot remove new database")?;
            return Err(error);
        }
        Ok(w)
    }
    /// Read a project's binding without opening its database or requiring its drive.
    ///
    /// # Errors
    /// Returns an error for missing, malformed or incompatible project metadata.
    pub fn read_binding(root: &Path) -> Result<Self> {
        let text = fs::read_to_string(root.join(".slurp/project.toml"))?;
        let w: Self = toml::from_str(&text)?;
        if w.version != 1 {
            bail!(Failure::new(
                ErrorCode::WorkspaceUnavailable,
                "project configuration version is incompatible"
            ))
        }
        slurp_client::config::normalize_backend(&w.backend)?;
        anyhow::ensure!(
            w.project.starts_with("prj_"),
            "project configuration requires a stable project ID"
        );
        Ok(w)
    }
    /// A copy of this workspace whose queries also load the named community extensions, installing them on first use.
    ///
    /// # Errors
    /// Returns an error if a name is not allowed or an extension cannot be installed.
    pub fn with_extensions(&self, names: &[String]) -> Result<Self> {
        setup::check_extension_names(names)?;
        for name in names {
            setup::install_extension(&self.duckdb, name)?;
        }
        let mut w = self.clone();
        for name in names {
            if !w.extensions.contains(name) {
                w.extensions.push(name.clone());
            }
        }
        Ok(w)
    }
    /// A copy whose read-only queries cannot touch files outside the database (see the `sandbox` field).
    pub fn sandboxed(&self) -> Self {
        let mut w = self.clone();
        w.sandbox = true;
        w
    }
    /// Load and verify a workspace without creating missing storage.
    pub fn load(root: &Path) -> Result<Self> {
        let w = Self::read_binding(root)?;
        storage::require_database(&w.database)?;
        setup::check_engine(&w.duckdb)?;
        let identity = w.execute("SELECT version,backend,project FROM _slurp.identity", true)?;
        if identity != json!([{"version":1,"backend":w.backend,"project":w.project}]) {
            bail!(Failure::new(
                ErrorCode::BindingMismatch,
                "database binding mismatch"
            ))
        }
        w.ensure_helpers();
        Ok(w)
    }
    /// Run bounded-time SQL using the configured external engine.
    pub fn execute(&self, sql: &str, readonly: bool) -> Result<Value> {
        self.execute_inner(sql, readonly, false)
    }
    fn scratch(&self) -> Result<tempfile::TempDir> {
        storage::require_database(&self.database)?;
        Ok(tempfile::Builder::new()
            .prefix(".slurp-tmp-")
            .tempdir_in(self.database.parent().context("database parent")?)?)
    }
    fn execute_inner(&self, sql: &str, readonly: bool, initializing: bool) -> Result<Value> {
        if !initializing {
            storage::require_database(&self.database)?;
        }
        let scratch = tempfile::Builder::new()
            .prefix(".slurp-query-")
            .tempdir_in(self.database.parent().context("database parent")?)?;
        let mut input = tempfile::NamedTempFile::new_in(scratch.path())?;
        input.write_all(sql.as_bytes())?;
        let stdout = tempfile::tempfile_in(scratch.path())?;
        let stderr = tempfile::tempfile_in(scratch.path())?;
        let mut cmd = Command::new(&self.duckdb);
        cmd.args(["-no-agent", "-init", "/dev/null", "-bail", "-json"]);
        cmd.arg("-cmd").arg(format!(
            "SET temp_directory = {};",
            literal(&scratch.path().join("spill").to_string_lossy())
        ));
        for name in &self.extensions {
            // Names were checked against the allow-list in `with_extensions`.
            cmd.arg("-cmd").arg(format!("LOAD {name};"));
        }
        if readonly && self.sandbox {
            // After the extensions are loaded (loading needs file access), and before any user SQL runs.
            cmd.arg("-cmd")
                .arg("SET enable_external_access = false; SET lock_configuration = true;");
        }
        if readonly {
            cmd.arg("-readonly");
        }
        let mut child = cmd
            .arg(&self.database)
            .stdin(fs::File::open(input.path())?)
            .stdout(Stdio::from(stdout.try_clone()?))
            .stderr(Stdio::from(stderr.try_clone()?))
            .spawn()
            .context("DuckDB not found; run setup or supply --duckdb")?;
        let start = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait()? {
                break s;
            }
            if self.cancellation.is_cancelled() {
                child.kill()?;
                child.wait()?;
                bail!(Failure::new(ErrorCode::Cancelled, "cancelled"))
            }
            if start.elapsed() > Duration::from_secs(60) {
                child.kill()?;
                child.wait()?;
                bail!(Failure::new(
                    ErrorCode::QueryTimeout,
                    "DuckDB exceeded 60 seconds"
                ))
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        use std::io::{Read, Seek};
        let mut err = stderr;
        err.rewind()?;
        let mut message = String::new();
        err.take(8192).read_to_string(&mut message)?;
        if !status.success() {
            let code = if message.contains("delivery_conflict") {
                ErrorCode::DeliveryConflict
            } else if message.contains("Could not set lock") {
                ErrorCode::Busy
            } else {
                ErrorCode::QueryFailed
            };
            bail!(Failure::new(code, format!("DuckDB: {message}")))
        }
        let mut out = stdout;
        out.rewind()?;
        let mut bytes = Vec::new();
        out.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 32 * 1024 * 1024 {
            bail!("query output exceeds 32 MiB")
        }
        if bytes.is_empty() {
            Ok(json!([]))
        } else {
            match serde_json::from_slice(&bytes) {
                Ok(value) => Ok(value),
                Err(error) => {
                    // DuckDB writes a non-finite double (1.0 / 0, a NaN ratio) as the bare words Infinity and NaN, which is
                    // not JSON. Show those as null (there is no JSON number for them) rather than failing the whole query.
                    let text = String::from_utf8(bytes).map_err(|_| error)?;
                    Ok(serde_json::from_str(&null_non_finite(&text))?)
                }
            }
        }
    }
    /// Read a bounded query result. Raw JSON numbers are parsed without float conversion.
    pub fn query(&self, sql: &str) -> Result<Value> {
        let start = Instant::now();
        let columns = self.execute(&format!("DESCRIBE SELECT * FROM ({sql})"), true)?;
        let data = self.execute(&format!("SELECT * FROM ({sql}) LIMIT 1001"), true)?;
        let columns: Vec<Value> = columns
            .as_array()
            .context("column descriptions")?
            .iter()
            .map(|c| json!({"name":c["column_name"],"type":c["column_type"]}))
            .collect();
        let data = data.as_array().context("query rows")?;
        let truncated = data.len() > 1000;
        let rows: Vec<Vec<Value>> = data
            .iter()
            .take(1000)
            .map(|r| {
                columns
                    .iter()
                    .map(|c| r[c["name"].as_str().unwrap_or_default()].clone())
                    .collect()
            })
            .collect();
        Ok(
            json!({"columns":columns,"row_count":rows.len(),"rows":rows,"truncated":truncated,"elapsed_ms":start.elapsed().as_secs_f64()*1000.0}),
        )
    }
    /// Import one verified immutable archive atomically with its receipt (see [`import::import_archive`]).
    ///
    /// # Errors
    /// Returns an error for an unreadable or truncated archive, a receipt for the same sequence with a different digest
    /// or size, or a DuckDB failure.
    pub fn import(&self, seq: u64, sha: &str, bytes: u64, path: &Path) -> Result<ImportStats> {
        import::import_archive(self, seq, sha, bytes, path)
    }
    /// Record archives that retention deleted before they were read. Safe to repeat. The row's `record` keeps the whole range
    /// (`{"from":3,"to":7}`), since a gap row's key holds only where it starts.
    pub fn record_gap(&self, gap: &slurp_client::api::Gap) -> Result<()> {
        let detail = format!(
            "archives {} to {} were deleted by retention before they were read",
            gap.from, gap.to
        );
        let range = json!({"from": gap.from, "to": gap.to}).to_string();
        self.execute(
            &format!(
                "INSERT INTO _slurp.problems(kind, sender, id, archive_seq, line, record, detail) VALUES('gap', NULL, NULL, {}, 0, {}, {}) ON CONFLICT DO NOTHING",
                gap.from,
                literal(&range),
                literal(&detail)
            ),
            false,
        )?;
        Ok(())
    }
    /// The archives retention deleted before this database read them, as `{"from": n, "to": m}` (the union of every gap
    /// recorded), or `None` when nothing is missing. Those events are lost; every status-like output reports this.
    pub fn history_incomplete(&self) -> Result<Option<Value>> {
        let rows = self.execute(
            "SELECT min(archive_seq)::BIGINT AS \"from\", max(coalesce(try_cast(json_extract_string(record, '$.to') AS BIGINT), archive_seq))::BIGINT AS \"to\" FROM _slurp.problems WHERE kind = 'gap' HAVING count(*) > 0",
            true,
        )?;
        Ok(rows
            .as_array()
            .and_then(|rows| rows.first())
            .map(|row| json!({"from": row["from"], "to": row["to"]})))
    }
    /// The workspace at a glance: binding, event count, import problems, the last receipt, and `history_incomplete` when
    /// retention deleted archives before they were read.
    pub fn status(&self) -> Result<Value> {
        let mut status = json!({
            "version": self.version, "project": self.project, "backend": self.backend, "database": self.database,
            "events": self.execute("SELECT count(*) AS count FROM events", true)?,
            "problems": self.execute("SELECT kind, count(*) AS count FROM _slurp.problems GROUP BY kind ORDER BY kind", true)?,
            "last_delivery": self.execute("SELECT * FROM _slurp.deliveries ORDER BY imported_at DESC LIMIT 1", true)?,
        });
        if let Some(incomplete) = self.history_incomplete()? {
            status["history_incomplete"] = incomplete;
        }
        Ok(status)
    }
    /// Ask the Worker to publish everything it has buffered now (`Publish`). Needs the admin token.
    ///
    /// # Errors
    /// Returns an error when the token is not the admin token, or the Worker refuses or is unavailable.
    pub async fn publish_now(&self, token: &str) -> Result<()> {
        use slurp_client::api;
        project_setup::Api::new(&self.backend, token)?
            .call::<api::Publish>(&api::PublishRequest {
                project: self.project.clone(),
            })
            .await
            .map_err(|error| match error {
                api::CallError::Api {
                    code: Some(api::ErrorCode::Forbidden),
                    ..
                } => anyhow::anyhow!(
                    "sync --now needs the admin token: it asks the Worker to publish what it has buffered, and a secret key can only read archives. Connect with the admin token (slurp connect), or run slurp sync without --now to read what is already published"
                ),
                other => project_setup::service_error(other),
            })?;
        Ok(())
    }
    /// Catch up published archives; receipts are the sole durable sync cursor.
    pub async fn sync(&self, token: &str) -> Result<Value> {
        self.sync_with_progress(token, false, |_| std::ops::ControlFlow::Continue(()))
            .await
    }
    /// Publish what the Worker has buffered (admin token), then catch up.
    pub async fn sync_now(&self, token: &str) -> Result<Value> {
        self.sync_with_progress(token, true, |_| std::ops::ControlFlow::Continue(()))
            .await
    }
    /// Catch up with progress and cooperative cancellation between archive commits. With `now`, the Worker is first asked to
    /// publish what it has buffered.
    pub async fn sync_with_progress(
        &self,
        token: &str,
        now: bool,
        mut progress: impl FnMut(&SyncProgress) -> std::ops::ControlFlow<()>,
    ) -> Result<Value> {
        storage::require_database(&self.database)?;
        // Receipts are keyed by project: a database that holds another project's archives cannot be continued.
        let receipts = self.execute(
            "SELECT project, max(sequence) AS sequence FROM _slurp.deliveries GROUP BY project",
            true,
        )?;
        let receipts = receipts.as_array().context("receipts")?;
        if receipts.iter().any(|r| r["project"] != self.project) {
            bail!(Failure::new(
                ErrorCode::BindingMismatch,
                "this database holds archives of a different project; preserve it and initialize a new workspace"
            ))
        }
        if now {
            self.publish_now(token).await?;
        }
        let mut after = receipts.first().and_then(|r| r["sequence"].as_u64());
        let remote = slurp_client::HttpRemote::new(&self.backend, &self.project, token)?;
        let (mut downloaded, mut imported, mut duplicates, mut conflicts, mut invalid, mut gaps) =
            (0usize, 0u64, 0u64, 0u64, 0u64, 0u64);
        let mut walk = slurp_client::walk::Walk::new(&remote, after, 100);
        loop {
            if self.cancellation.is_cancelled() {
                bail!(Failure::new(ErrorCode::Cancelled, "cancelled"))
            }
            let archive = match walk.next(|| self.scratch()).await? {
                None => break,
                Some(slurp_client::walk::Step::Gap(gap)) => {
                    self.record_gap(&gap)?;
                    gaps += 1;
                    continue;
                }
                Some(slurp_client::walk::Step::Archive(archive)) => archive,
            };
            let sequence = archive.sequence;
            let stats = self.import(
                sequence,
                &archive.archive.sha256,
                archive.archive.size,
                &archive.path,
            )?;
            imported += stats.imported;
            duplicates += stats.duplicates;
            conflicts += stats.conflicts;
            invalid += stats.invalid;
            after = Some(sequence);
            downloaded += 1;
            if progress(&SyncProgress {
                sequence,
                downloaded,
            })
            .is_break()
            {
                bail!(Failure::new(ErrorCode::Cancelled, "cancelled"))
            }
        }
        let coverage = walk
            .coverage()
            .cloned()
            .unwrap_or(slurp_client::api::Coverage {
                first: None,
                last: None,
                last_at: None,
                pending: false,
            });
        let mut result = json!({
            "downloaded": downloaded,
            "imported": imported,
            "duplicates": duplicates,
            "conflicts": conflicts,
            "invalid": invalid,
            "gaps": gaps,
            "checkpoint": after.unwrap_or(0).to_string(),
            "published_at": coverage.last_at,
            "has_published_archives": coverage.last.is_some(),
            "pending": coverage.pending,
            "published_now": now,
        });
        if let Some(incomplete) = self.history_incomplete()? {
            result["history_incomplete"] = incomplete;
        }
        Ok(result)
    }
}
