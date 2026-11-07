//! Human presentation stays separate from the complete JSON results used by agents.
use anyhow::Result;
use serde_json::Value;
use std::{
    io::{self, IsTerminal, Write},
    sync::atomic::{AtomicBool, Ordering},
};

static JSON: AtomicBool = AtomicBool::new(true);

#[derive(Clone, Copy, Default)]
pub enum Kind {
    #[default]
    General,
    Init,
    Send,
    Sync,
    Sql,
    Health,
}

pub fn configure(mode: &str, json: bool) {
    JSON.store(
        json || mode == "json" || (mode == "auto" && !io::stdout().is_terminal()),
        Ordering::Relaxed,
    );
}

pub fn emit(kind: Kind, value: &impl serde::Serialize) -> Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if JSON.load(Ordering::Relaxed) {
        serde_json::to_writer(&mut out, value)?;
        writeln!(out)?;
    } else {
        let value = serde_json::to_value(value)?;
        render(
            kind,
            &value,
            console::Term::stdout().size().1.into(),
            &mut out,
        )?;
    }
    Ok(())
}

// Event properties and query results may contain terminal control sequences.
fn clean(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_control() {
            result.extend(c.escape_default());
        } else {
            result.push(c);
        }
    }
    result
}
fn cell(value: &Value) -> String {
    clean(
        value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned)
            .as_str(),
    )
}
fn noun(count: u64, singular: &str, plural: &str) -> String {
    format!("{count} {}", if count == 1 { singular } else { plural })
}

fn publication(value: &Value, out: &mut dyn Write) -> io::Result<()> {
    let Some(status) = value.get("publication").filter(|status| status.is_object()) else {
        return writeln!(
            out,
            "Events become available to sync after your Worker next seals an archive (about every 10 minutes by default); exact timing is unavailable."
        );
    };
    match status["state"].as_str() {
        Some("idle") => writeln!(out, "No pending batch reported by the server."),
        Some("publishing") => writeln!(
            out,
            "The next batch is being prepared. Retry slurp sync shortly."
        ),
        Some("blocked") => writeln!(
            out,
            "Publication is delayed and needs service attention. Previously downloaded events remain available locally."
        ),
        Some(state @ ("pending" | "retrying")) => {
            let seconds = status["estimatedAt"]
                .as_str()
                .zip(status["observedAt"].as_str())
                .and_then(|(at, observed)| {
                    Some(
                        (chrono::DateTime::parse_from_rfc3339(at).ok()?
                            - chrono::DateTime::parse_from_rfc3339(observed).ok()?)
                        .num_seconds()
                        .max(0),
                    )
                });
            let subject = if state == "retrying" {
                "Publication retry"
            } else {
                "Next batch"
            };
            match seconds {
                Some(0..=59) => {
                    writeln!(out, "{subject} is due shortly; publishing may take longer.")
                }
                Some(seconds) => writeln!(
                    out,
                    "{subject} expected in about {} min; this is an estimate.",
                    (seconds + 59) / 60
                ),
                None => writeln!(
                    out,
                    "The server has a pending batch; its publication time is unavailable."
                ),
            }
        }
        _ => writeln!(out, "Publication timing is unavailable."),
    }
}

pub fn render(kind: Kind, value: &Value, width: usize, out: &mut dyn Write) -> io::Result<()> {
    match kind {
        Kind::Sql => table(value, width.max(16), out),
        Kind::Health => {
            let events = value["events"].as_u64().unwrap_or(0);
            let findings = value["findings"].as_array().cloned().unwrap_or_default();
            if findings.is_empty() {
                return writeln!(
                    out,
                    "No problems found in {}. Checked event spelling, clocks, repeated events and unusually busy ids.",
                    noun(events, "event", "events")
                );
            }
            writeln!(
                out,
                "{} to look at in {}:",
                noun(findings.len() as u64, "finding", "findings"),
                noun(events, "event", "events")
            )?;
            for finding in findings {
                writeln!(out)?;
                writeln!(
                    out,
                    "[{}] {}",
                    finding["severity"].as_str().unwrap_or("info"),
                    finding["title"].as_str().unwrap_or_default()
                )?;
                writeln!(out, "  {}", finding["detail"].as_str().unwrap_or_default())?;
                writeln!(
                    out,
                    "  What to do: {}",
                    finding["suggestion"].as_str().unwrap_or_default()
                )?;
            }
            writeln!(out, "\nNothing was changed. Use --json for the evidence.")
        }
        Kind::Send => {
            let count = value["events"].as_u64().unwrap_or(1);
            writeln!(out, "Accepted {}.", noun(count, "event", "events"))?;
            publication(value, out)
        }
        Kind::Sync => {
            let downloaded = value["downloaded"].as_u64().unwrap_or(0);
            if downloaded > 0 {
                writeln!(
                    out,
                    "Imported {} from {}.",
                    noun(value["imported"].as_u64().unwrap_or(0), "event", "events"),
                    noun(downloaded, "batch", "batches")
                )?;
                if let Some(n @ 1..) = value["duplicates"].as_u64() {
                    writeln!(
                        out,
                        "Skipped {} already stored locally.",
                        noun(n, "duplicate", "duplicates")
                    )?;
                }
                writeln!(
                    out,
                    "Your local database is up to date with published archives."
                )?;
            } else if value["has_published_archives"] == false {
                writeln!(out, "No published batches yet. No events imported.")?;
            } else {
                writeln!(out, "Already caught up. No new events imported.")?;
            }
            publication(value, out)
        }
        Kind::Init => {
            writeln!(out, "Connected: {}", cell(&value["project_name"]))?;
            writeln!(out, "Database: {}", cell(&value["database"]))?;
            if let Some(path) = value["skills_installed"].as_str() {
                writeln!(out, "Agent skills: {}", clean(path))?;
            }
            if let Some(path) = value["setup_page"].as_str() {
                writeln!(
                    out,
                    "Quickstart{}: {}",
                    if value["opened"] == true {
                        " (opened)"
                    } else {
                        ""
                    },
                    clean(path)
                )?;
            }
            if let Some(notes) = value["agent_notes"].as_object() {
                let updated = notes
                    .get("updated")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                let skipped = notes
                    .get("skipped")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                if updated > 0 {
                    writeln!(
                        out,
                        "Updated agent reminders in {updated} instruction file(s)."
                    )?;
                }
                if skipped > 0 {
                    writeln!(
                        out,
                        "Skipped {skipped} instruction file(s); see --json output for details."
                    )?;
                }
            }
            if let Some(warnings) = value["warnings"].as_array() {
                for warning in warnings {
                    writeln!(out, "Warning: {}", cell(warning))?;
                }
            }
            if let Some(warning) = value["registry_warning"].as_str() {
                writeln!(out, "Warning: {}", clean(warning))?;
            }
            if let Some(commands) = value["next_steps"].as_str() {
                writeln!(out, "\nNext:\n{}", clean_commands(commands))?;
            }
            Ok(())
        }
        Kind::General => general(value, 0, out),
    }
}

fn clean_commands(commands: &str) -> String {
    commands
        .lines()
        .map(|line| format!("  {}", clean(line)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn table(value: &Value, width: usize, out: &mut dyn Write) -> io::Result<()> {
    let columns = value["columns"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let rows = value["rows"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let headers: Vec<_> = columns.iter().map(|c| cell(&c["name"])).collect();
    let cells: Vec<Vec<_>> = rows
        .iter()
        .map(|r| (0..headers.len()).map(|i| cell(&r[i])).collect())
        .collect();
    let mut clipped = false;
    let clip = |s: &str, max: usize, clipped: &mut bool| -> String {
        if console::measure_text_width(s) > max {
            *clipped = true;
        }
        console::truncate_str(s, max, "…").into_owned()
    };
    if headers.len().saturating_mul(6) > width {
        for (i, row) in cells.iter().enumerate() {
            writeln!(out, "Row {}", i + 1)?;
            for (header, item) in headers.iter().zip(row) {
                writeln!(
                    out,
                    "{}",
                    clip(&format!("  {header}: {item}"), width, &mut clipped)
                )?;
            }
        }
    } else if !headers.is_empty() {
        let mut widths: Vec<_> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                cells
                    .iter()
                    .map(|r| console::measure_text_width(&r[i]))
                    .chain([console::measure_text_width(h), 1])
                    .max()
                    .unwrap_or(1)
            })
            .collect();
        let separators = headers.len().saturating_sub(1) * 2;
        while widths.iter().sum::<usize>() + separators > width {
            let Some((_, longest)) = widths.iter_mut().enumerate().max_by_key(|(_, n)| **n) else {
                break;
            };
            *longest -= 1;
        }
        for (index, row) in std::iter::once(&headers).chain(cells.iter()).enumerate() {
            for (i, item) in row.iter().enumerate() {
                if i > 0 {
                    write!(out, "  ")?;
                }
                let item = clip(item, widths[i], &mut clipped);
                let padding =
                    " ".repeat(widths[i].saturating_sub(console::measure_text_width(&item)));
                let numeric = index > 0 && rows[index - 1][i].is_number();
                if numeric {
                    write!(out, "{padding}{item}")?;
                } else {
                    write!(out, "{item}{padding}")?;
                }
            }
            writeln!(out)?;
            if index == 0 {
                writeln!(
                    out,
                    "{}",
                    widths
                        .iter()
                        .map(|n| "-".repeat(*n))
                        .collect::<Vec<_>>()
                        .join("  ")
                )?;
            }
        }
    }
    if rows.is_empty() {
        writeln!(out, "(no rows)")?;
    }
    writeln!(
        out,
        "\n{} · {:.0} ms",
        noun(rows.len() as u64, "row", "rows"),
        value["elapsed_ms"].as_f64().unwrap_or(0.0)
    )?;
    if value["truncated"] == true {
        writeln!(
            out,
            "Result limit reached; add filters or aggregate the query."
        )?;
    }
    if clipped {
        writeln!(
            out,
            "Some cells are clipped to fit. Use --json for full returned values."
        )?;
    }
    Ok(())
}

fn general(value: &Value, indent: usize, out: &mut dyn Write) -> io::Result<()> {
    match value {
        Value::Object(fields) => {
            for (name, value) in fields {
                if value.is_array() || value.is_object() {
                    writeln!(out, "{}{}:", " ".repeat(indent), clean(name))?;
                    general(value, indent + 2, out)?;
                } else {
                    writeln!(
                        out,
                        "{}{}: {}",
                        " ".repeat(indent),
                        clean(name),
                        cell(value)
                    )?;
                }
            }
        }
        Value::Array(rows) => {
            if rows.is_empty() {
                writeln!(out, "{}None", " ".repeat(indent))?;
            }
            for row in rows {
                general(row, indent, out)?;
            }
        }
        _ => writeln!(out, "{}{}", " ".repeat(indent), cell(value))?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(kind: Kind, value: Value, width: usize) -> String {
        let mut out = Vec::new();
        render(kind, &value, width, &mut out).expect("render output");
        String::from_utf8(out).expect("UTF-8 output")
    }

    #[test]
    fn sql_is_a_table_with_exact_values_and_no_metadata_dump() {
        let value = json!({"columns":[{"name":"event"},{"name":"n"}],"rows":[["signed_up",3],["project_created",2],["report_built",1]],"row_count":3,"elapsed_ms":100.2,"truncated":false});
        let out = text(Kind::Sql, value, 80);
        assert!(
            out.contains("event") && out.contains("signed_up        3"),
            "{out}"
        );
        assert!(out.contains("3 rows · 100 ms"));
        assert!(!out.contains("columns:") && !out.contains("elapsed_ms:"));
        let out = text(
            Kind::Sql,
            json!({"columns":[{"name":"value"}],"rows":[[900719925474099312345_u128]],"elapsed_ms":1}),
            80,
        );
        assert!(out.contains("900719925474099312345"));
    }

    #[test]
    fn sql_handles_empty_narrow_unicode_and_clipped_results() {
        let out = text(
            Kind::Sql,
            json!({"columns":[{"name":"event"}],"rows":[],"elapsed_ms":1}),
            20,
        );
        assert!(out.contains("(no rows)") && out.contains("0 rows"));
        let value = json!({"columns":[{"name":"名称"},{"name":"value"},{"name":"other"}],"rows":[["界".repeat(30),"line\nwith\u{1b}[31mcolor",null]],"truncated":true});
        let out = text(Kind::Sql, value.clone(), 32);
        assert!(!out.contains('\u{1b}') && out.contains("Some cells are clipped"));
        assert!(out.contains("Result limit reached"));
        for line in out.lines().take_while(|line| !line.is_empty()) {
            assert!(console::measure_text_width(line) <= 32, "{line}");
        }
        let out = text(Kind::Sql, value, 16);
        assert!(out.contains("Row 1"));
    }

    #[test]
    fn eta_uses_server_clock_and_sync_distinguishes_empty_from_caught_up() {
        let pending = json!({"state":"pending","observedAt":"2026-11-06T12:00:00Z","estimatedAt":"2026-11-06T12:42:00Z","intervalSeconds":3600});
        let out = text(
            Kind::Send,
            json!({"accepted":true,"events":1,"publication":pending}),
            80,
        );
        assert!(out.contains("Accepted 1 event.") && out.contains("about 42 min"));
        assert!(!out.contains("published: false"));
        let out = text(
            Kind::Sync,
            json!({"downloaded":0,"has_published_archives":false,"publication":null}),
            80,
        );
        assert!(
            out.contains("No published batches yet") && out.contains("exact timing is unavailable")
        );
        let out = text(
            Kind::Sync,
            json!({"downloaded":0,"has_published_archives":true,"publication":{"state":"idle"}}),
            80,
        );
        assert!(out.contains("Already caught up") && out.contains("No pending batch"));
        let out = text(
            Kind::Sync,
            json!({"downloaded":1,"imported":6,"duplicates":2,"publication":{"state":"publishing"}}),
            80,
        );
        assert!(
            out.contains("Imported 6 events from 1 batch")
                && out.contains("2 duplicates")
                && out.contains("being prepared")
        );
        for (state, message) in [
            ("retrying", "Publication retry"),
            ("blocked", "service attention"),
        ] {
            let out = text(
                Kind::Send,
                json!({"publication":{"state":state,"observedAt":"2026-11-06T12:00:00Z","estimatedAt":"2026-11-06T11:59:00Z"}}),
                80,
            );
            assert!(out.contains(message) && !out.contains("-1"));
        }
    }

    #[test]
    fn init_hides_empty_fields_but_preserves_actionable_warnings() {
        let out = text(
            Kind::Init,
            json!({"project_name":"Demo","database":"/drive/events.duckdb","setup_page":"/private/start.html","opened":true,"skills_installed":null,"agent_notes":null,"warnings":[],"registry_warning":null,"next_steps":"slurp sync\nslurp sql 'SELECT 1'"}),
            80,
        );
        assert!(out.contains("Connected: Demo") && out.contains("Quickstart (opened)"));
        assert!(!out.contains("null") && !out.contains("None") && !out.contains("agent_notes"));
        let out = text(
            Kind::Init,
            json!({"project_name":"Demo","database":"/data","warnings":["Browser unavailable"],"registry_warning":"Project registration failed"}),
            80,
        );
        assert!(
            out.contains("Warning: Browser unavailable")
                && out.contains("Warning: Project registration failed")
        );
    }
}
