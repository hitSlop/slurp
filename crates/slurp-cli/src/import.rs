//! Importing one verified archive into the local database (`docs/contracts.md`, "Local import").
//!
//! Rust reads the gzip NDJSON and stages each envelope for DuckDB; the SQL then runs as one transaction that stores the events,
//! the problems and the receipt together.
use crate::{Workspace, literal};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io::{BufRead, Write},
    path::Path,
};

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
pub fn import_archive(
    workspace: &Workspace,
    seq: u64,
    sha: &str,
    bytes: u64,
    path: &Path,
) -> Result<ImportStats> {
    let scratch = workspace.scratch()?;
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
    let (p, h) = (literal(&workspace.project), literal(sha));
    let stage = if lines == 0 {
        "SELECT NULL::BIGINT AS line, NULL::VARCHAR AS sender, NULL::VARCHAR AS received_at, NULL::JSON AS geo, NULL::JSON AS record, NULL::VARCHAR AS fingerprint, NULL::VARCHAR AS invalid, NULL::VARCHAR AS text WHERE false".to_owned()
    } else {
        format!(
            "SELECT * FROM read_json({}, columns={{line:'BIGINT',sender:'VARCHAR',received_at:'VARCHAR',geo:'JSON',record:'JSON',fingerprint:'VARCHAR',invalid:'VARCHAR',text:'VARCHAR'}}, format='newline_delimited')",
            literal(&staged.path().to_string_lossy())
        )
    };
    let stats = workspace.execute(&format!(r#"BEGIN;
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
