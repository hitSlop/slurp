//! `slurp health`: a few exact checks on the events in the local database.
//!
//! Each check is one SQL query that reads every row, so its numbers are exact, and each reports nothing unless it finds
//! something worth acting on. Findings only suggest; nothing is changed or deleted. Keeping the list short and the findings
//! actionable matters more than covering everything.
use crate::Workspace;
use anyhow::Result;
use serde_json::{Value, json};

fn finding(
    check: &str,
    severity: &str,
    title: String,
    detail: String,
    evidence: Value,
    suggestion: &str,
) -> Value {
    json!({"check": check, "severity": severity, "title": title, "detail": detail, "evidence": evidence, "suggestion": suggestion})
}
fn count(row: &Value, key: &str) -> i64 {
    match &row[key] {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}
fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Event names that differ only in case or separators (`Signed_Up`, `signed-up`, `signedUp`), which split one event in several.
fn casing_variants(w: &Workspace) -> Result<Option<Value>> {
    let rows = w.execute(
        "WITH names AS (SELECT event, count(*) AS n FROM events WHERE type = 'track' AND event IS NOT NULL GROUP BY 1), \
              norm AS (SELECT lower(regexp_replace(event, '[^A-Za-z0-9]+', '', 'g')) AS key, event, n FROM names) \
         SELECT key, list(event ORDER BY n DESC) AS spellings, list(n ORDER BY n DESC) AS counts, sum(n)::BIGINT AS total \
         FROM norm GROUP BY key HAVING count(*) > 1 ORDER BY total DESC LIMIT 10",
        true,
    )?;
    let rows = rows.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return Ok(None);
    }
    let groups: Vec<Value> = rows
        .iter()
        .map(|r| json!({"spellings": r["spellings"], "events": r["counts"]}))
        .collect();
    let example: Vec<String> = rows[0]["spellings"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| format!("`{s}`")))
                .collect()
        })
        .unwrap_or_default();
    Ok(Some(finding(
        "casing_variants",
        "warning",
        format!(
            "{} spelled more than one way",
            plural(rows.len() as i64, "event name is", "event names are")
        ),
        format!(
            "The same event is recorded under different spellings, for example {}. Counts and funnels will split it.",
            example.join(", ")
        ),
        json!({"groups": groups}),
        "Use one spelling in the app, and combine them in SQL until then: GROUP BY lower(regexp_replace(event, '[^A-Za-z0-9]+', '', 'g')).",
    )))
}

/// Events stamped later than the time the Worker received them: a client clock that is ahead.
fn future_timestamps(w: &Workspace) -> Result<Option<Value>> {
    let rows = w.execute(
        "SELECT count(*)::BIGINT AS n, count(DISTINCT coalesce(user_id, anonymous_id))::BIGINT AS people, \
                round(max(epoch(timestamp - received_at)))::BIGINT AS max_ahead_seconds, \
                any_value(event) AS example_event \
         FROM events WHERE received_at IS NOT NULL AND timestamp > received_at + INTERVAL 5 MINUTE",
        true,
    )?;
    let row = &rows[0];
    let n = count(row, "n");
    if n == 0 {
        return Ok(None);
    }
    let hours = count(row, "max_ahead_seconds") as f64 / 3600.0;
    Ok(Some(finding(
        "future_timestamps",
        "warning",
        format!(
            "{} timestamped in the future",
            plural(n, "event is", "events are")
        ),
        format!(
            "These events say they happened more than 5 minutes after the Worker received them (up to {hours:.1} hours ahead), so someone's clock is wrong. They land on the wrong day in daily charts."
        ),
        json!({"events": n, "people": count(row, "people"), "max_ahead_seconds": count(row, "max_ahead_seconds"), "example_event": row["example_event"]}),
        "Filter them out (WHERE timestamp <= received_at + INTERVAL 5 MINUTE) or use received_at for the date. Have the SDK send the device clock only when it is trustworthy.",
    )))
}

/// One or a few ids behind a large share of all events: a bot, a test account or a stuck client.
fn heavy_hitters(w: &Workspace) -> Result<Option<Value>> {
    let rows = w.execute(
        "WITH per AS (SELECT person_id, count(*)::BIGINT AS n FROM events_with_person WHERE person_id IS NOT NULL GROUP BY 1), \
              stats AS (SELECT median(n) AS m, quantile_cont(n, 0.95) AS p95, sum(n) AS total FROM per) \
         SELECT person_id, n, round(100.0 * n / total, 1) AS share_pct, round(n / m)::BIGINT AS times_median \
         FROM per, stats WHERE n > 1000 AND n >= 20 * m AND n >= 5 * p95 ORDER BY n DESC LIMIT 5",
        true,
    )?;
    let rows = rows.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return Ok(None);
    }
    let total: i64 = rows.iter().map(|r| count(r, "n")).sum();
    let top = rows[0]["person_id"].as_str().unwrap_or_default().to_owned();
    Ok(Some(finding(
        "heavy_hitters",
        "info",
        format!(
            "{} far busier than everyone else",
            plural(rows.len() as i64, "id is", "ids are")
        ),
        format!(
            "`{top}` alone has {} events, {}x the typical person. Automated traffic, a test account or a stuck client skews averages and counts.",
            count(&rows[0], "n"),
            count(&rows[0], "times_median")
        ),
        json!({"people": rows, "events": total}),
        "If they are not real users, exclude them: WHERE person_id NOT IN ('u:...'). Nothing was changed.",
    )))
}

/// The same person, event, time and properties recorded under different event ids: double tracking.
fn duplicate_events(w: &Workspace) -> Result<Option<Value>> {
    let rows = w.execute(
        "SELECT event, count(*)::BIGINT AS groups, sum(c - 1)::BIGINT AS extra FROM ( \
            SELECT event, count(*) AS c FROM events_with_person WHERE person_id IS NOT NULL \
            GROUP BY person_id, event, timestamp, md5(coalesce(data::VARCHAR, '')) HAVING count(*) > 1) \
         GROUP BY event ORDER BY extra DESC LIMIT 5",
        true,
    )?;
    let rows = rows.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return Ok(None);
    }
    let extra: i64 = rows.iter().map(|r| count(r, "extra")).sum();
    Ok(Some(finding(
        "duplicate_events",
        "warning",
        format!("{} look like repeats", plural(extra, "event", "events")),
        format!(
            "The same person, event, time and properties appear more than once under different event ids, most often `{}`. That is usually an event tracked twice.",
            rows[0]["event"].as_str().unwrap_or_default()
        ),
        json!({"by_event": rows, "extra_events": extra}),
        "Find the second track() call. To count each once meanwhile, take one row per (person_id, event, timestamp).",
    )))
}

/// Run every check. The result lists findings only; an empty list means nothing needs attention.
///
/// # Errors
/// Returns an error if a query fails or the database cannot be read.
pub fn run(w: &Workspace) -> Result<Value> {
    let events = count(
        &w.execute("SELECT count(*) AS n FROM events", true)?[0],
        "n",
    );
    let mut findings = vec![];
    for check in [
        casing_variants,
        future_timestamps,
        duplicate_events,
        heavy_hitters,
    ] {
        findings.extend(check(w)?);
    }
    Ok(json!({"events": events, "checks": 4, "ok": findings.is_empty(), "findings": findings}))
}
