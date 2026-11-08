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
    /// Import one verified immutable archive atomically with its receipt (`docs/contracts.md`, "Local import").
    ///
    /// Rust reads the gzip NDJSON and parses each envelope; one DuckDB transaction then applies the defaults, sets aside
    /// lines of the wrong shape, keeps the first copy of every `(sender, id)` by `(archive_seq, line)`, and writes the
    /// events and the receipt. Content problems never fail the import: they become rows of `_slurp.problems`. Importing an
    /// archive again changes nothing.
    ///
    /// # Errors
    /// Returns an error for an unreadable or truncated archive, a receipt for the same sequence with a different digest
    /// or size, or a DuckDB failure.
    pub fn import(&self, seq: u64, sha: &str, bytes: u64, path: &Path) -> Result<ImportStats> {
        let scratch = self.scratch()?;
        let mut staged = tempfile::NamedTempFile::new_in(scratch.path())?;
        let mut lines = 0u64;
        let mut reader = std::io::BufReader::new(slurp_client::open_jsonl(path)?);
        let mut buffer = Vec::new();
        let mut number = 0u64;
        loop {
            buffer.clear();
            // A truncated gzip stream fails here, before anything is written to the database.
            if reader.read_until(b'\n', &mut buffer)? == 0 {
                break;
            }
            number += 1;
            let line = String::from_utf8_lossy(&buffer);
            let line = line.trim_matches(['\r', '\n']);
            if line.trim().is_empty() {
                continue;
            }
            lines += 1;
            writeln!(
                staged,
                "{}",
                stage_line(number, line, std::str::from_utf8(&buffer).is_ok())
            )?;
        }
        let (p, h) = (literal(&self.project), literal(sha));
        let stage = if lines == 0 {
            "SELECT NULL::BIGINT AS line, NULL::VARCHAR AS sender, NULL::VARCHAR AS received_at, NULL::JSON AS geo, NULL::JSON AS record, NULL::VARCHAR AS fingerprint, NULL::VARCHAR AS invalid, NULL::VARCHAR AS text WHERE false".to_owned()
        } else {
            format!(
                "SELECT * FROM read_json({}, columns={{line:'BIGINT',sender:'VARCHAR',received_at:'VARCHAR',geo:'JSON',record:'JSON',fingerprint:'VARCHAR',invalid:'VARCHAR',text:'VARCHAR'}}, format='newline_delimited')",
                literal(&staged.path().to_string_lossy())
            )
        };
        let stats = self.execute(&format!(r#"BEGIN;
CREATE TEMP TABLE replay AS SELECT CASE WHEN EXISTS(SELECT 1 FROM _slurp.deliveries WHERE project={p} AND sequence={seq} AND (sha256<>{h} OR bytes<>{bytes})) THEN error('delivery_conflict') ELSE EXISTS(SELECT 1 FROM _slurp.deliveries WHERE project={p} AND sequence={seq}) END AS done;
CREATE TEMP TABLE stage AS SELECT * FROM ({stage}) WHERE NOT (SELECT done FROM replay);
CREATE TEMP TABLE shaped AS
WITH x AS (
  SELECT line, sender, received_at::TIMESTAMPTZ AS received_at, geo, record, fingerprint,
         coalesce(json_extract_string(record,'$.id'), 'slurp:' || {seq} || ':' || line) AS id,
         json_type(record,'$.id') AS id_t,
         coalesce(json_extract_string(record,'$.type'), 'track') AS type,
         json_extract_string(record,'$.event') AS event,
         json_extract_string(record,'$.timestamp') AS ts_text,
         json_extract_string(record,'$.user_id') AS user_id,
         json_extract_string(record,'$.anonymous_id') AS anonymous_id,
         json_extract_string(record,'$.session_id') AS session_id,
         json_type(record,'$.data') AS data_t,
         json_type(record,'$.context') AS context_t
  FROM stage WHERE invalid IS NULL
)
SELECT line, sender, id, type, event,
       coalesce(try_cast(ts_text AS TIMESTAMPTZ), received_at) AS timestamp,
       user_id, anonymous_id, session_id,
       CASE WHEN data_t = 'OBJECT' THEN record->'$.data' ELSE '{{}}'::JSON END AS data,
       CASE WHEN context_t = 'OBJECT' THEN record->'$.context' END AS context,
       geo, received_at, record, fingerprint,
       CASE WHEN id_t IS NOT NULL AND id_t NOT IN ('VARCHAR', 'NULL') THEN 'id is not a string'
            WHEN type NOT IN ('track', 'identify') THEN 'unknown type ' || type
            WHEN type = 'track' AND coalesce(event, '') = '' THEN 'a track record needs an event'
            WHEN type = 'identify' AND coalesce(user_id, '') = '' THEN 'an identify record needs a user_id'
            WHEN ts_text IS NOT NULL AND try_cast(ts_text AS TIMESTAMPTZ) IS NULL THEN 'timestamp is not RFC 3339'
            WHEN data_t IS NOT NULL AND data_t NOT IN ('OBJECT', 'NULL') THEN 'data is not an object'
            WHEN context_t IS NOT NULL AND context_t NOT IN ('OBJECT', 'NULL') THEN 'context is not an object'
       END AS reason
FROM x;
CREATE TEMP TABLE cand AS SELECT * FROM shaped WHERE reason IS NULL;
CREATE TEMP TABLE copies AS
  SELECT sender, id, fingerprint, {seq}::BIGINT AS archive_seq, line, true AS is_new FROM cand
  UNION ALL
  SELECT e.sender, e.id, e.fingerprint, e.archive_seq, e.line, false FROM events e WHERE EXISTS(SELECT 1 FROM cand c WHERE c.sender = e.sender AND c.id = e.id);
CREATE TEMP TABLE winner AS SELECT sender, id, fingerprint, archive_seq, line FROM copies QUALIFY row_number() OVER (PARTITION BY sender, id ORDER BY archive_seq, line, is_new) = 1;
CREATE TEMP TABLE verdict AS
  SELECT c.*, w.archive_seq AS win_seq, w.line AS win_line,
         CASE WHEN w.archive_seq = {seq} AND w.line = c.line
                THEN CASE WHEN EXISTS(SELECT 1 FROM events e WHERE e.sender = c.sender AND e.id = c.id AND e.archive_seq = {seq} AND e.line = c.line) THEN 'same' ELSE 'insert' END
              WHEN w.fingerprint = c.fingerprint THEN 'duplicate'
              ELSE 'conflict' END AS verdict
  FROM cand c JOIN winner w USING (sender, id);
CREATE TEMP TABLE import_stats AS SELECT
  count(*) FILTER (WHERE verdict = 'insert') AS imported,
  count(*) FILTER (WHERE verdict = 'duplicate') AS duplicates,
  count(*) FILTER (WHERE verdict = 'conflict') AS conflicts,
  (SELECT count(*) FROM stage WHERE invalid IS NOT NULL) + (SELECT count(*) FROM shaped WHERE reason IS NOT NULL) AS invalid
  FROM verdict;
INSERT INTO events SELECT sender, id, type, event, timestamp, user_id, anonymous_id, session_id, data, context, geo, received_at, {seq}, line, record, fingerprint FROM verdict WHERE verdict = 'insert' ON CONFLICT DO NOTHING;
INSERT INTO _slurp.problems(kind, sender, id, archive_seq, line, record, detail)
  SELECT 'invalid', sender, NULL, {seq}, line, text, invalid FROM stage WHERE invalid IS NOT NULL
  UNION ALL
  SELECT 'invalid', sender, id, {seq}, line, record::VARCHAR, reason FROM shaped WHERE reason IS NOT NULL
  UNION ALL
  SELECT 'conflict', sender, id, {seq}, line, record::VARCHAR, 'the same (sender, id) as archive ' || win_seq || ' line ' || win_line || ', with different content; that first copy is kept' FROM verdict WHERE verdict = 'conflict'
  ON CONFLICT DO NOTHING;
INSERT INTO _slurp.deliveries(project, sequence, sha256, bytes) VALUES({p}, {seq}, {h}, {bytes}) ON CONFLICT DO NOTHING;
COMMIT;
SELECT imported, duplicates, conflicts, invalid FROM import_stats;"#), false)?;
        let count = |name: &str| stats[0][name].as_u64().unwrap_or(0);
        Ok(ImportStats {
            imported: count("imported"),
            duplicates: count("duplicates"),
            conflicts: count("conflicts"),
            invalid: count("invalid"),
        })
    }
    /// Record archives that retention deleted before they were read. Safe to repeat.
    pub fn record_gap(&self, gap: &slurp_client::api::Gap) -> Result<()> {
        let detail = format!(
            "archives {} to {} were deleted by retention before they were read",
            gap.from, gap.to
        );
        self.execute(
            &format!(
                "INSERT INTO _slurp.problems(kind, sender, id, archive_seq, line, record, detail) VALUES('gap', NULL, NULL, {}, 0, NULL, {}) ON CONFLICT DO NOTHING",
                gap.from,
                literal(&detail)
            ),
            false,
        )?;
        Ok(())
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
        Ok(json!({
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
        }))
    }
}

/// What importing one archive did, as counts of lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImportStats {
    /// New events stored.
    pub imported: u64,
    /// Copies of an event already stored, with identical content.
    pub duplicates: u64,
    /// Copies of an event already stored, with different content: set aside as `conflict` problems.
    pub conflicts: u64,
    /// Lines of the wrong shape: set aside as `invalid` problems.
    pub invalid: u64,
}

/// One archive line for the staging file DuckDB reads: the envelope's parts and the record's exact text, or why the line
/// is invalid.
fn stage_line(number: u64, line: &str, utf8: bool) -> String {
    use sha2::{Digest, Sha256};
    #[derive(Deserialize)]
    struct Envelope {
        sender: Option<String>,
        received_at: Option<String>,
        geo: Option<Box<serde_json::value::RawValue>>,
        record: Option<Box<serde_json::value::RawValue>>,
    }
    let invalid = |sender: Option<&str>, detail: &str| {
        json!({"line": number, "sender": sender, "invalid": detail, "text": line}).to_string()
    };
    if !utf8 {
        return invalid(None, "the line is not valid UTF-8");
    }
    let envelope: Envelope = match serde_json::from_str(line) {
        Ok(envelope) => envelope,
        Err(error) => return invalid(None, &format!("the line is not a JSON envelope: {error}")),
    };
    let sender = envelope.sender.as_deref().filter(|s| !s.is_empty());
    let Some(record) = envelope.record else {
        return invalid(sender, "the envelope has no record");
    };
    if !record.get().starts_with('{') {
        return invalid(sender, "the record is not a JSON object");
    }
    let Some(sender) = sender else {
        return invalid(None, "the envelope has no sender");
    };
    let Some(received_at) = envelope
        .received_at
        .filter(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
    else {
        return invalid(Some(sender), "the envelope has no valid received_at");
    };
    let fingerprint = hex::encode(Sha256::digest(record.get().as_bytes()));
    format!(
        "{{\"line\":{number},\"sender\":{},\"received_at\":{},\"geo\":{},\"record\":{},\"fingerprint\":\"{fingerprint}\"}}",
        json!(sender),
        json!(received_at),
        envelope.geo.as_ref().map_or("null", |geo| geo.get()),
        record.get()
    )
}
