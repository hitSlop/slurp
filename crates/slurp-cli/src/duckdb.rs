//! Bounded DuckDB subprocess execution and result decoding.
use crate::error::{ErrorCode, Failure};
use crate::{
    BUSY_WAIT, QUERY_TIMEOUT, SESSION_SETTINGS, Workspace, is_busy, literal, null_non_finite,
    storage,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// What one DuckDB process printed, whether or not it succeeded.
pub(crate) struct RawRun {
    pub(crate) success: bool,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}

/// Whether a DuckDB process may write to the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Access {
    ReadOnly,
    ReadWrite,
}

impl Workspace {
    /// Run SQL, waiting up to [`BUSY_WAIT`] for another Slurp process that holds DuckDB's write lock.
    pub(crate) fn execute_script(
        &self,
        sql: &str,
        access: Access,
        initializing: bool,
    ) -> Result<Value> {
        let start = Instant::now();
        let mut pause = Duration::from_millis(50);
        let bytes = loop {
            match self.run_once(sql, access, initializing, QUERY_TIMEOUT) {
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
    pub(crate) fn run_once(
        &self,
        sql: &str,
        access: Access,
        initializing: bool,
        timeout: Duration,
    ) -> Result<Vec<u8>> {
        let run = self.run_raw(sql, access, initializing, timeout)?;
        if !run.success {
            let message = run.stderr;
            let code = if message.contains("delivery_conflict") {
                ErrorCode::DeliveryConflict
            } else if message.contains("Could not set lock") {
                ErrorCode::Busy
            } else {
                ErrorCode::QueryFailed
            };
            bail!(Failure::new(code, format!("DuckDB: {message}")))
        }
        Ok(run.stdout)
    }
    /// One DuckDB process run that keeps what it printed even when it fails (with `-bail`, the results of the statements
    /// before the failing one), so a caller can tell how far a script got.
    pub(crate) fn run_raw(
        &self,
        sql: &str,
        access: Access,
        initializing: bool,
        timeout: Duration,
    ) -> Result<RawRun> {
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
            "{SESSION_SETTINGS} SET temp_directory = {};",
            literal(&scratch.path().join("spill").to_string_lossy())
        ));
        for name in &self.extensions {
            // Names were checked against the allow-list in `with_extensions`.
            cmd.arg("-cmd").arg(format!("LOAD {name};"));
        }
        if access == Access::ReadOnly && self.sandbox {
            // After the extensions are loaded (loading needs file access), and before any user SQL runs.
            cmd.arg("-cmd")
                .arg("SET enable_external_access = false; SET lock_configuration = true;");
        }
        if access == Access::ReadOnly {
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
        let mut out = stdout;
        out.rewind()?;
        let mut bytes = Vec::new();
        out.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 32 * 1024 * 1024 {
            bail!("query output exceeds 32 MiB")
        }
        Ok(RawRun {
            success: status.success(),
            stdout: bytes,
            stderr: message,
        })
    }
}
