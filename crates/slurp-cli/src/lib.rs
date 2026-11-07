//! Reusable workspace operations. No terminal interaction or daemon is required.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, Write},
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
pub mod health;
pub mod helpers;
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
    pub archive: String,
    pub sequence: i64,
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
        w.execute_inner(&format!("BEGIN; CREATE SCHEMA _slurp; CREATE TABLE _slurp.identity(version INTEGER, backend VARCHAR, project VARCHAR); INSERT INTO _slurp.identity VALUES(1,{},{}); CREATE TABLE _slurp.deliveries(archive VARCHAR, sequence BIGINT, sha256 VARCHAR, bytes UBIGINT, imported_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(archive,sequence)); CREATE TABLE events(id VARCHAR PRIMARY KEY, type VARCHAR, event VARCHAR, timestamp TIMESTAMPTZ, user_id VARCHAR, anonymous_id VARCHAR, session_id VARCHAR, data JSON, context JSON, received_at TIMESTAMPTZ, received_seq VARCHAR, sender VARCHAR, raw_record JSON, fingerprint VARCHAR); COMMIT;",literal(&w.backend),literal(&w.project)),false, true)?;
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
            let code = if message.contains("conflicting_event_id") {
                ErrorCode::ConflictingEventId
            } else if message.contains("delivery_conflict") {
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
    /// Import one verified immutable archive atomically with its receipt.
    pub fn import(
        &self,
        archive: &str,
        seq: i64,
        sha: &str,
        bytes: u64,
        path: &Path,
    ) -> Result<Value> {
        let scratch = self.scratch()?;
        let mut staged = tempfile::NamedTempFile::new_in(scratch.path())?;
        let decoder = slurp_client::open_jsonl(path)?;
        for line in std::io::BufReader::new(decoder).lines() {
            let line = line?;
            let raw: Value = serde_json::from_str(&line)?;
            if !raw["id"].is_string() {
                bail!("invalid event ID")
            }
            anyhow::ensure!(raw["data"].is_object(), "invalid event data");
            anyhow::ensure!(
                raw["type"] == "track" || raw["type"] == "identify",
                "invalid event type"
            );
            let timestamp = raw["timestamp"]
                .as_str()
                .context("missing event timestamp")?;
            chrono::DateTime::parse_from_rfc3339(timestamp).context("invalid event timestamp")?;
            if raw["type"] == "track" {
                anyhow::ensure!(
                    raw["event"].as_str().is_some_and(|v| !v.is_empty()),
                    "missing event name"
                );
            }
            if raw["type"] == "identify" {
                anyhow::ensure!(
                    raw["user_id"].as_str().is_some_and(|v| !v.is_empty()),
                    "missing user ID"
                );
            }
            let mut producer = raw.clone();
            let obj = producer.as_object_mut().context("invalid event")?;
            obj.remove("received_at");
            obj.remove("received_seq");
            obj.remove("sender");
            if let Some(context) = obj.get_mut("context").and_then(Value::as_object_mut) {
                context.remove("geo");
                if context.is_empty() {
                    obj.remove("context");
                }
            }
            use sha2::{Digest, Sha256};
            let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&producer)?));
            writeln!(
                staged,
                "{{\"record\":{line},\"fingerprint\":{}}}",
                json!(fingerprint)
            )?;
        }
        let a = literal(archive);
        let h = literal(sha);
        let f = literal(&staged.path().to_string_lossy());
        self.execute(&format!(r#"BEGIN;
CREATE TEMP TABLE delivery_check AS SELECT CASE WHEN EXISTS(SELECT 1 FROM _slurp.deliveries WHERE archive={a} AND sequence={seq} AND (sha256<>{h} OR bytes<>{bytes})) THEN error('delivery_conflict') ELSE NULL END;
CREATE TEMP TABLE stage AS SELECT json_extract_string(record,'$.id') AS id, record, fingerprint FROM read_json({f}, columns={{record:'JSON',fingerprint:'VARCHAR'}},format='newline_delimited');
CREATE TEMP TABLE event_check AS SELECT CASE WHEN EXISTS(SELECT id FROM stage GROUP BY id HAVING count(DISTINCT fingerprint)>1) OR EXISTS(SELECT 1 FROM stage s JOIN events e USING(id) WHERE s.fingerprint<>e.fingerprint) THEN error('conflicting_event_id') ELSE NULL END;
CREATE TEMP TABLE import_stats AS SELECT count(*) AS total,count(DISTINCT s.id) FILTER(WHERE e.id IS NULL) AS imported FROM stage s LEFT JOIN events e USING(id);
INSERT INTO events SELECT id,record->>'type',record->>'event',(record->>'timestamp')::TIMESTAMPTZ,record->>'user_id',record->>'anonymous_id',record->>'session_id',record->'data',record->'context',(record->>'received_at')::TIMESTAMPTZ,record->>'received_seq',record->>'sender',record,fingerprint FROM stage QUALIFY row_number() OVER(PARTITION BY id)=1 ON CONFLICT DO NOTHING;
INSERT INTO _slurp.deliveries(archive,sequence,sha256,bytes) VALUES({a},{seq},{h},{bytes}) ON CONFLICT DO NOTHING;
COMMIT; SELECT imported,total-imported AS duplicates FROM import_stats;"#),false)
    }
    /// Catch up published archives; receipts are the sole durable sync cursor.
    pub async fn sync(&self, token: &str) -> Result<Value> {
        self.sync_with_progress(token, |_| std::ops::ControlFlow::Continue(()))
            .await
    }
    /// Catch up with progress and cooperative cancellation between archive commits.
    pub async fn sync_with_progress(
        &self,
        token: &str,
        mut progress: impl FnMut(&SyncProgress) -> std::ops::ControlFlow<()>,
    ) -> Result<Value> {
        storage::require_database(&self.database)?;
        use slurp_client::Remote;
        let remote = slurp_client::HttpRemote::new(&self.backend, &self.project, token)?;
        let status = remote.get_status().await?;
        let Some(c) = status.coverage else {
            return Ok(
                json!({"downloaded":0,"imported":0,"duplicates":0,"has_published_archives":false,"publication":status.publication}),
            );
        };
        let receipts = self.execute(
            "SELECT archive, max(sequence) AS sequence FROM _slurp.deliveries GROUP BY archive",
            true,
        )?;
        if receipts
            .as_array()
            .context("receipts")?
            .iter()
            .any(|r| r["archive"] != c.archive_id)
        {
            bail!("archive reset; preserve this workspace and initialize a new one")
        }
        let floor = slurp_client::protocol::parse_sequence(&c.first_retained)?;
        let mut after = receipts[0]["sequence"].as_i64().unwrap_or(floor - 1);
        if after < floor - 1 {
            bail!(Failure::new(
                ErrorCode::RetentionGap,
                "history expired; initialize a new workspace"
            ))
        }
        let head = c
            .latest_published
            .as_deref()
            .map(slurp_client::protocol::parse_sequence)
            .transpose()?
            .unwrap_or(after);
        let mut downloaded = 0;
        let mut imported = 0;
        let mut duplicates = 0;
        while after < head {
            if self.cancellation.is_cancelled() {
                bail!(Failure::new(ErrorCode::Cancelled, "cancelled"))
            }
            let page = remote.list(Some(after), 100).await?;
            if page
                .coverage
                .as_ref()
                .is_none_or(|v| v.archive_id != c.archive_id)
            {
                bail!("archive reset during sync")
            }
            if page.objects.is_empty() {
                bail!("publication gap")
            }
            for obj in page.objects {
                let seq = slurp_client::protocol::parse_sequence(&obj.seq)?;
                if seq > head {
                    break;
                }
                if seq != after + 1 {
                    bail!("publication gap")
                }
                let tmp = self.scratch()?;
                slurp_client::parse_key(&obj.name)
                    .ok_or_else(|| anyhow::anyhow!("unsupported archive object name"))?;
                let path = tmp.path().join("events.jsonl.gz");
                // Verifies size and SHA-256 and asks for a fresh link if the listed one expired mid-sync.
                slurp_client::download_verified(&remote, &obj, &path).await?;
                let stats = self.import(&c.archive_id, seq, &obj.sha256, obj.size, &path)?;
                imported += stats[0]["imported"].as_u64().unwrap_or(0);
                duplicates += stats[0]["duplicates"].as_u64().unwrap_or(0);
                after = seq;
                downloaded += 1;
                if progress(&SyncProgress {
                    archive: c.archive_id.clone(),
                    sequence: seq,
                    downloaded,
                })
                .is_break()
                {
                    bail!(Failure::new(ErrorCode::Cancelled, "cancelled"))
                }
            }
        }
        Ok(
            json!({"downloaded":downloaded,"imported":imported,"duplicates":duplicates,"checkpoint":after.to_string(),"published_at":c.latest_published_at,"has_published_archives":c.latest_published.is_some(),"publication":status.publication}),
        )
    }
}
