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
/// Step 1 of the local database (`docs/contracts.md`, "Local import"): the tables of a fresh database.
const V1: &str = "CREATE SCHEMA _slurp;
CREATE TABLE _slurp.meta(schema INTEGER, backend VARCHAR, project VARCHAR);
CREATE TABLE _slurp.deliveries(project VARCHAR, sequence BIGINT, sha256 VARCHAR, bytes UBIGINT, imported_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(project, sequence));
CREATE TABLE _slurp.problems(kind VARCHAR, sender VARCHAR, id VARCHAR, archive_seq BIGINT, line BIGINT, record VARCHAR, detail VARCHAR, seen_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(kind, archive_seq, line));
CREATE TABLE events(sender VARCHAR, id VARCHAR, type VARCHAR, event VARCHAR, timestamp TIMESTAMPTZ, user_id VARCHAR, anonymous_id VARCHAR, session_id VARCHAR, data JSON, context JSON, geo JSON, received_at TIMESTAMPTZ, archive_seq BIGINT, line BIGINT, raw JSON, fingerprint VARCHAR, PRIMARY KEY(sender, id));";
/// The local database's migration steps. Step `i` takes schema `i` to `i + 1`. Steps are only ever appended: a shipped step is
/// never edited (`docs/contracts.md`, "Versions and upgrades").
const MIGRATIONS: &[&str] = &[V1];
/// How long a command waits for another Slurp process that holds DuckDB's write lock before it reports `Busy`.
const BUSY_WAIT: Duration = Duration::from_secs(10);
/// What a migration run is allowed: copying a large database takes longer than an ordinary query.
const MIGRATION_TIMEOUT: Duration = Duration::from_secs(600);
/// Marks the guard error of a migration that found the schema already changed by another process.
const SCHEMA_CHANGED: &str = "slurp_schema_changed";

/// Migration steps as one script: each step ends with a semicolon, so a step may omit its own.
fn join_steps(steps: &[&str]) -> String {
    steps
        .iter()
        .map(|step| {
            let step = step.trim_end();
            if step.ends_with(';') {
                step.to_string()
            } else {
                format!("{step};")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn is_busy(error: &anyhow::Error) -> bool {
    matches!(error.downcast_ref::<Failure>(), Some(f) if matches!(f.code, ErrorCode::Busy))
}
fn is_schema_changed(error: &anyhow::Error) -> bool {
    matches!(error.downcast_ref::<Failure>(), Some(f) if f.message.contains(SCHEMA_CHANGED))
}

/// Cleanup must not replace the error that determines whether the caller retries.
fn discard_attempt(directory: &Path, error: anyhow::Error) -> anyhow::Error {
    if let Err(cleanup) = fs::remove_dir_all(directory) {
        eprintln!(
            "could not remove migration attempt {}: {cleanup}",
            directory.display()
        );
    }
    let message =
        format!("database migration failed; this attempt did not change its schema: {error}");
    error.context(message)
}

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
                "BEGIN;\n{}\nINSERT INTO _slurp.meta VALUES({},{},{}); COMMIT;",
                join_steps(MIGRATIONS),
                MIGRATIONS.len(),
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
        let header: toml::Value = toml::from_str(&text)?;
        slurp_client::config::check_version(
            &root.join(".slurp/project.toml"),
            header
                .get("version")
                .and_then(toml::Value::as_integer)
                .and_then(|v| u64::try_from(v).ok()),
            1,
            "slurp init",
        )?;
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
    /// Load and verify a workspace without creating missing storage. A database made by an older schema is backed up and
    /// migrated first (see [`Workspace::load_with_migrations`]).
    pub fn load(root: &Path) -> Result<Self> {
        Self::load_with_migrations(root, MIGRATIONS)
    }
    /// [`Workspace::load`] with an explicit list of migration steps, so tests can exercise a longer list than the shipped one.
    ///
    /// - A database without baseline metadata is refused.
    /// - A schema newer than `steps` is refused.
    /// - A schema older than `steps` is copied to a uniquely reserved directory beside the database and migrated in one DuckDB process,
    ///   so DuckDB's write lock covers the copy and the whole migration. A failing step leaves the database as it was.
    #[doc(hidden)]
    pub fn load_with_migrations(root: &Path, steps: &[&str]) -> Result<Self> {
        let w = Self::read_binding(root)?;
        storage::require_database(&w.database)?;
        setup::check_engine(&w.duckdb)?;
        let started = Instant::now();
        loop {
            let (alias, schema) = w.read_schema()?;
            if schema > steps.len() as u64 {
                bail!(Failure::new(
                    ErrorCode::WorkspaceUnavailable,
                    format!(
                        "this database was made by a newer Slurp; upgrade the CLI (its schema is {schema}, this version reads up to {})",
                        steps.len()
                    )
                ))
            }
            if schema < steps.len() as u64 {
                match w.migrate(&alias, schema as usize, steps) {
                    Err(error)
                        if (is_schema_changed(&error) || is_busy(&error))
                            && started.elapsed() < BUSY_WAIT
                            && !w.cancellation.is_cancelled() =>
                    {
                        // Another Slurp process migrated, or holds the lock: read the schema again.
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    Err(error) => return Err(error),
                    Ok(()) => {}
                }
            }
            break;
        }
        w.ensure_helpers();
        Ok(w)
    }
    /// The database's name inside DuckDB and its schema version, after checking that it is a Slurp database made for this
    /// workspace's backend and project.
    fn read_schema(&self) -> Result<(String, u64)> {
        let tables = self.execute(
            "SELECT current_database() AS alias, (SELECT count(*) FROM information_schema.tables WHERE table_schema = '_slurp' AND table_name = 'meta') AS meta",
            true,
        )?;
        let row = &tables[0];
        if row["meta"].as_u64() != Some(1) {
            bail!(Failure::new(
                ErrorCode::WorkspaceUnavailable,
                format!("{} is not a Slurp database", self.database.display())
            ))
        }
        let alias = row["alias"].as_str().context("database name")?.to_string();
        let meta = self.execute("SELECT schema, backend, project FROM _slurp.meta", true)?;
        let [row] = meta.as_array().map(Vec::as_slice).unwrap_or_default() else {
            bail!(Failure::new(
                ErrorCode::WorkspaceUnavailable,
                format!(
                    "{} is not a Slurp database (its `_slurp.meta` is damaged)",
                    self.database.display()
                )
            ))
        };
        let schema = row["schema"].as_u64().context("database schema version")?;
        if row["backend"] != json!(self.backend) || row["project"] != json!(self.project) {
            bail!(Failure::new(
                ErrorCode::BindingMismatch,
                "database binding mismatch"
            ))
        }
        Ok((alias, schema))
    }
    /// Back the database up and apply `steps[from..]` in one DuckDB process, which holds DuckDB's write lock throughout.
    ///
    /// The first statement fails if another process migrated the database after `from` was read (the caller reads again);
    /// otherwise nothing is copied or changed before the lock is held. A failing step rolls back and leaves the backup.
    fn migrate(&self, alias: &str, from: usize, steps: &[&str]) -> Result<()> {
        let directory = tempfile::Builder::new()
            .prefix(&format!(
                "{}.schema{from}-",
                self.database
                    .file_name()
                    .context("database filename")?
                    .to_string_lossy()
            ))
            .suffix(".bak")
            .tempdir_in(self.database.parent().context("database parent")?)?
            .keep();
        let backup = directory.join(self.database.file_name().context("database filename")?);
        let destination = if alias.eq_ignore_ascii_case("slurp_backup") {
            "slurp_backup_2"
        } else {
            "slurp_backup"
        };
        let script = format!(
            "CREATE TEMP TABLE _slurp_guard AS SELECT CASE WHEN (SELECT schema FROM _slurp.meta) = {from} THEN 0 ELSE error('{SCHEMA_CHANGED}') END AS ok;\nCHECKPOINT;\nATTACH {} AS {destination};\nCOPY FROM DATABASE \"{}\" TO {destination};\nDETACH {destination};\nBEGIN;\n{}\nUPDATE _slurp.meta SET schema = {};\nCOMMIT;",
            literal(&backup.to_string_lossy()),
            alias.replace('"', "\"\""),
            join_steps(&steps[from..]),
            steps.len()
        );
        let result = self.run_once(&script, false, false, MIGRATION_TIMEOUT);
        match result {
            Ok(_) => {
                eprintln!(
                    "upgraded the database from schema {from} to {} (backup at {})",
                    steps.len(),
                    backup.display()
                );
                Ok(())
            }
            Err(error) => {
                let unchanged = if is_busy(&error) || is_schema_changed(&error) {
                    true // This process never passed the guard or acquired the write lock.
                } else {
                    matches!(self.read_schema(), Ok((_, schema)) if schema == from as u64)
                };
                if unchanged {
                    Err(discard_attempt(&directory, error))
                } else {
                    let message = format!(
                        "database migration did not finish; attempt files retained at {} (the copy may be incomplete): {error}",
                        directory.display()
                    );
                    Err(error.context(message))
                }
            }
        }
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
    /// Run SQL, waiting up to [`BUSY_WAIT`] for another Slurp process that holds DuckDB's write lock.
    fn execute_inner(&self, sql: &str, readonly: bool, initializing: bool) -> Result<Value> {
        let start = Instant::now();
        let mut pause = Duration::from_millis(50);
        let bytes = loop {
            match self.run_once(sql, readonly, initializing, Duration::from_secs(60)) {
                Err(error)
                    if is_busy(&error)
                        && start.elapsed() + pause < BUSY_WAIT
                        && !self.cancellation.is_cancelled() =>
                {
                    std::thread::sleep(pause);
                    pause = (pause * 2).min(Duration::from_millis(1000));
                }
                other => break other?,
            }
        };
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
    /// One DuckDB process run, with no retry: its standard output, or the failure it reported.
    fn run_once(
        &self,
        sql: &str,
        readonly: bool,
        initializing: bool,
        timeout: Duration,
    ) -> Result<Vec<u8>> {
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
            if start.elapsed() > timeout {
                child.kill()?;
                child.wait()?;
                bail!(Failure::new(
                    ErrorCode::QueryTimeout,
                    format!("DuckDB exceeded {} seconds", timeout.as_secs())
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
        Ok(bytes)
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

#[cfg(test)]
mod migration_failure_tests {
    #[test]
    fn cleanup_failure_does_not_replace_busy_classification() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let error = super::Failure::new(super::ErrorCode::Busy, "original busy error").into();
        let error = super::discard_attempt(file.path(), error);
        assert!(super::is_busy(&error));
        assert!(format!("{error:#}").contains("original busy error"));
        assert!(file.path().exists());
    }
}
