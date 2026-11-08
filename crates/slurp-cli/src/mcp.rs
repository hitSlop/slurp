//! `slurp mcp`: a Model Context Protocol server over stdio, so Claude Code, Claude Desktop, Cursor, Codex and any other MCP client
//! can read your events and build reports (and, only when started with `--allow-send`, send events).
//!
//! The wire format is MCP's stdio transport: one JSON-RPC 2.0 message per line in each direction, nothing else on stdout. It
//! implements the small part a tool server needs (`initialize`, `ping`, `tools/list`, `tools/call`) by hand, so there is no
//! extra dependency to keep in step with the protocol.
//!
//! Reads go through a sandboxed [`Workspace`]: read-only DuckDB with external file access off and settings locked, so SQL
//! an agent writes cannot read local files. `sync` and the two write tools run the `slurp` binary itself, which already knows how
//! to find the saved credentials and the project's publishable key.
use crate::{Workspace, health, report, report_check};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const SERVER_NAME: &str = "slurp";
/// How the send tools run the CLI: as the source `mcp`, so its events carry `sender = "mcp"` and are never mistaken for a
/// real user's activity.
const SEND: [&str; 4] = ["send", "--stdin", "--source", "mcp"];
/// The protocol versions this server implements, newest first. A client that asks for another version is answered with the
/// newest one here and decides for itself whether it can work with that (MCP's version negotiation).
const SUPPORTED_PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// The official Rust SDK (rmcp 3.9.0) was tried here and fixes the gaps below, but adds about 2.7 MB (8.5%) to the binary and does
// not by itself stop a running query on cancel, so the few protocol rules a tool server needs are kept here. Revisit if clients
// start to require the stateless protocol version (2026-07-28), which this server does not speak.

pub struct Server {
    workspace: Workspace,
    root: PathBuf,
    exe: PathBuf,
    allow_send: bool,
    /// Set by a successful `initialize`: until then only `initialize` and `ping` are answered.
    initialized: std::sync::atomic::AtomicBool,
}

impl Server {
    /// `root` is the project folder, `exe` the `slurp` binary to run for `sync` and for sending events.
    pub fn new(workspace: &Workspace, root: PathBuf, exe: PathBuf, allow_send: bool) -> Self {
        Self {
            workspace: workspace.sandboxed(),
            root,
            exe,
            allow_send,
            initialized: false.into(),
        }
    }

    /// Serve until the client closes its input.
    pub fn run(&self, input: impl BufRead, mut output: impl Write) -> Result<()> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            if let Some(response) = self.handle_line(&line) {
                writeln!(output, "{response}")?;
                output.flush()?;
            }
        }
        Ok(())
    }

    /// One incoming message. Notifications (no `id`) get no answer.
    pub fn handle_line(&self, line: &str) -> Option<Value> {
        let message: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Some(error_response(Value::Null, -32700, "parse error")),
        };
        // The envelope: one JSON-RPC 2.0 object with a string method. Batches are not part of MCP's current versions.
        let id = message
            .get("id")
            .filter(|id| id.is_string() || id.is_number())
            .cloned();
        let valid = message.is_object()
            && message.get("jsonrpc") == Some(&json!("2.0"))
            && message.get("method").is_some_and(Value::is_string)
            && (message.get("id").is_none() || id.is_some());
        if !valid {
            return Some(error_response(
                id.unwrap_or(Value::Null),
                -32600,
                "invalid request: expected a JSON-RPC 2.0 request or notification",
            ));
        }
        let method = message["method"].as_str().unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id else {
            return None; // notifications/initialized, notifications/cancelled, ...
        };
        let ready = self.initialized.load(std::sync::atomic::Ordering::Relaxed);
        let result = match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            _ if !ready => Err((-32600, "call initialize first".to_owned())),
            "tools/list" => Ok(json!({ "tools": self.tools() })),
            "tools/call" => match params.get("name").and_then(Value::as_str) {
                Some(_) => Ok(self.call(&params)),
                None => Err((-32602, "tools/call needs a tool name".to_owned())),
            },
            other => Err((-32601, format!("method not found: {other}"))),
        };
        Some(match result {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, text)) => error_response(id, code, &text),
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        // Answer with the requested version when this server implements it, otherwise with its newest; never claim a version
        // it does not implement.
        let version = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .filter(|requested| SUPPORTED_PROTOCOLS.contains(requested))
            .unwrap_or(SUPPORTED_PROTOCOLS[0]);
        self.initialized
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let send = if self.allow_send {
            " Sending events is enabled: send_event and identify write to the real event stream, so only send events the user asked for."
        } else {
            ""
        };
        json!({
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")},
            "instructions": format!(
                "Slurp gives you this project's product events in a local DuckDB table named events. Start with describe_schema, then run read-only SQL with sql. Use events_with_person.person_id to count people, not user_id. New events arrive about every 10 minutes: call sync to fetch them. Reports: report_check then report_build.{send}"
            ),
        })
    }

    fn tools(&self) -> Vec<Value> {
        let mut tools = vec![
            tool(
                "status",
                "Project, database path, event count and the last sync.",
                json!({"type": "object", "properties": {}}),
            ),
            tool(
                "describe_schema",
                "The events table's columns, every event name with its count and first and last time, the event types, and the helper views and macros you can use. Call this before writing SQL.",
                json!({"type": "object", "properties": {}}),
            ),
            tool(
                "sql",
                "Run one read-only DuckDB SQL statement against the local events. At most 1000 rows come back (truncated says if there were more). It cannot read local files or change settings.",
                json!({"type": "object", "properties": {"query": {"type": "string", "description": "A single SELECT (or WITH ... SELECT) statement."}}, "required": ["query"]}),
            ),
            tool(
                "sync",
                "Download new archives from your Worker into the local database. Events become readable about 10 minutes after they are sent; pass now to ask the Worker to publish what it has buffered first (needs the admin token).",
                json!({"type": "object", "properties": {"now": {"type": "boolean", "description": "Publish buffered events first, so events sent a moment ago are included. Needs the admin token. Default false."}}}),
            ),
            tool(
                "health",
                "Check the events for common data problems (spelling variants of event names, bad clocks, bots, double tracking). Changes nothing.",
                json!({"type": "object", "properties": {}}),
            ),
            tool(
                "report_check",
                "Validate a Markdown report file (structure, and its SQL against the data) without building it.",
                json!({"type": "object", "properties": {"file": {"type": "string", "description": "Path to the report .md file."}}, "required": ["file"]}),
            ),
            tool(
                "report_build",
                "Build a report into a new folder: report.html, plus report.png (default) and optionally report.pdf. Returns the folder and files.",
                json!({"type": "object", "properties": {
                    "file": {"type": "string", "description": "Path to the report .md file."},
                    "out": {"type": "string", "description": "A new folder to write into. Defaults to .slurp/reports/<name>-<time> in the project."},
                    "png": {"type": "boolean", "description": "Also write report.png (default true)."},
                    "pdf": {"type": "boolean", "description": "Also write report.pdf (default false)."}
                }, "required": ["file"]}),
            ),
        ];
        if self.allow_send {
            tools.push(tool(
                "send_event",
                "Send one event to the real event stream (the project's publishable key). Events carry sender = \"mcp\". Only send events the user asked for.",
                json!({"type": "object", "properties": {
                    "event": {"type": "string", "description": "Event name, 1 to 200 characters."},
                    "data": {"type": "object", "description": "Event properties as a JSON object."},
                    "user_id": {"type": "string"},
                    "anonymous_id": {"type": "string"}
                }, "required": ["event"]}),
            ));
            tools.push(tool(
                "identify",
                "Link a user to their traits. Events carry sender = \"mcp\". Only send what the user asked for.",
                json!({"type": "object", "properties": {
                    "user_id": {"type": "string"},
                    "traits": {"type": "object", "description": "User traits as a JSON object."},
                    "anonymous_id": {"type": "string"}
                }, "required": ["user_id"]}),
            ));
        }
        tools
    }

    /// A tool call. Failures inside a tool are reported as a result with `isError`, so the model can read and react to them.
    fn call(&self, params: &Value) -> Value {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        match self.dispatch(name, &args) {
            Ok(value) => text_result(&value, false),
            Err(error) => text_result(&json!({"error": format!("{error:#}")}), true),
        }
    }

    fn dispatch(&self, name: &str, args: &Value) -> Result<Value> {
        let w = &self.workspace;
        match name {
            "status" => Ok(json!({
                "version": w.version, "project": w.project, "backend": w.backend, "database": w.database,
                "events": w.execute("SELECT count(*) AS count FROM events", true)?,
                "last_delivery": w.execute("SELECT * FROM _slurp.deliveries ORDER BY imported_at DESC LIMIT 1", true)?,
            })),
            "describe_schema" => describe_schema(w),
            "sql" => {
                let query = string_arg(args, "query")?;
                w.query(query.trim().trim_end_matches(';'))
            }
            "sync" => {
                let now = args.get("now").and_then(Value::as_bool).unwrap_or(false);
                let command: &[&str] = if now { &["sync", "--now"] } else { &["sync"] };
                self.run_cli(command, None)
            }
            "health" => health::run(w),
            "report_check" => self.report_check(&path_arg(args, "file")?),
            "report_build" => self.report_build(args),
            "send_event" | "identify" if !self.allow_send => {
                bail!("sending events is off; start the server with --allow-send to enable it")
            }
            "send_event" => {
                let line = record("track", Some(string_arg(args, "event")?), args, "data")?;
                self.run_cli(&SEND, Some(format!("{line}\n")))?;
                Ok(json!({"sent": true, "record": serde_json::from_str::<Value>(&line)?}))
            }
            "identify" => {
                let line = record("identify", None, args, "traits")?;
                self.run_cli(&SEND, Some(format!("{line}\n")))?;
                Ok(json!({"sent": true, "record": serde_json::from_str::<Value>(&line)?}))
            }
            other => bail!("unknown tool: {other}"),
        }
    }

    fn report_check(&self, file: &Path) -> Result<Value> {
        let doc = report::parse(
            &std::fs::read_to_string(file)
                .with_context(|| format!("reading {}", file.display()))?,
        )?;
        report::resolve_look(&doc, &report::Look::default(), file)?;
        let workspace = self.workspace.with_extensions(&doc.extensions)?;
        let problems = report_check::validate(&doc, Some(&workspace))?;
        if let Some(summary) = report_check::error_summary(&problems) {
            bail!("{summary}");
        }
        Ok(
            json!({"ok": true, "queries": doc.queries.keys().collect::<Vec<_>>(), "blocks": doc.blocks.len(), "warnings": problems}),
        )
    }

    fn report_build(&self, args: &Value) -> Result<Value> {
        let file = path_arg(args, "file")?;
        let stem = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("report");
        let out = match args.get("out").and_then(Value::as_str) {
            Some(out) => PathBuf::from(out),
            None => self.root.join(".slurp/reports").join(format!(
                "{stem}-{}",
                chrono::Utc::now().format("%Y%m%d-%H%M%S")
            )),
        };
        let png = args.get("png").and_then(Value::as_bool).unwrap_or(true);
        let pdf = args.get("pdf").and_then(Value::as_bool).unwrap_or(false);
        let manifest = report::build_with_params(
            &self.workspace,
            &file,
            &out,
            &report::Look::default(),
            png,
            pdf,
            &Default::default(),
        )?;
        let mut files: Vec<String> = std::fs::read_dir(&out)?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        Ok(json!({"out": out, "files": files, "manifest": manifest}))
    }

    /// Run `slurp <args> --project <root> --json`, optionally feeding stdin, and return its JSON output.
    fn run_cli(&self, args: &[&str], stdin: Option<String>) -> Result<Value> {
        let mut command = Command::new(&self.exe);
        command
            .args(args)
            .arg("--project")
            .arg(&self.root)
            .arg("--json");
        command
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .with_context(|| format!("could not run {}", self.exe.display()))?;
        if let Some(text) = stdin {
            child
                .stdin
                .take()
                .context("stdin")?
                .write_all(text.as_bytes())?;
        }
        let output = child.wait_with_output()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            };
            return Err(anyhow!("{message}"));
        }
        Ok(
            serde_json::from_str(stdout.trim())
                .unwrap_or_else(|_| json!({"output": stdout.trim()})),
        )
    }
}

fn describe_schema(w: &Workspace) -> Result<Value> {
    Ok(json!({
        "columns": w.execute("DESCRIBE events", true)?,
        "summary": w.execute("SELECT count(*) AS events, count(DISTINCT coalesce(nullif(user_id, ''), anonymous_id)) AS people, min(timestamp) AS first_event, max(timestamp) AS last_event FROM events", true)?,
        "types": w.execute("SELECT type, count(*) AS count FROM events GROUP BY type ORDER BY count DESC", true)?,
        "events": w.execute("SELECT event, count(*) AS count, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events WHERE event IS NOT NULL GROUP BY event ORDER BY count DESC LIMIT 200", true)?,
        "views": w.execute("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'main' AND table_name <> 'events' ORDER BY 1", true)?,
        "notes": [
            "data and context are JSON columns: use data->>'plan' or json_extract_string(data, '$.plan').",
            "events_with_person adds person_id: 'u:<user>' when known (directly or through an identify), else 'a:<anonymous id>'. Count people with count(DISTINCT person_id).",
            "errors lists Sentry-style error events with exception, top frame, release and a group_key.",
            "Macros: pct(part, total), share(x), calendar(start, end), biz_date(ts), session_start(ts, previous_ts, gap_minutes).",
        ],
    }))
}

/// One event or identify record. The source is not in the record: `slurp send --source mcp` sends it with the `mcp` key.
fn record(kind: &str, event: Option<String>, args: &Value, data_key: &str) -> Result<String> {
    let mut record = json!({
        "id": uuid::Uuid::now_v7().to_string(),
        "type": kind,
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "data": match args.get(data_key) { Some(v) if v.is_object() => v.clone(), None | Some(Value::Null) => json!({}), _ => bail!("{data_key} must be a JSON object") },
    });
    if let Some(event) = event {
        record["event"] = json!(event);
    }
    for key in ["user_id", "anonymous_id"] {
        if let Some(v) = args
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            record[key] = json!(v);
        }
    }
    Ok(record.to_string())
}

fn string_arg(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("{key} is required and must be a string"))
}

fn path_arg(args: &Value, key: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(string_arg(args, key)?))
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": input_schema})
}

fn text_result(value: &Value, is_error: bool) -> Value {
    json!({"content": [{"type": "text", "text": serde_json::to_string(value).unwrap_or_default()}], "isError": is_error})
}

fn error_response(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}
