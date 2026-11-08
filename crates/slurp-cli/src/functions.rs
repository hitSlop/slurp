//! Offline discovery for the built-in SQL macros; examples need no user data.
use crate::error::{ErrorCode, Failure};
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
struct Function {
    name: &'static str,
    signature: &'static str,
    description: &'static str,
    example: &'static str,
}
const FUNCTIONS: &[Function] = &[
    Function {
        name: "safe_num",
        signature: "safe_num(x) -> DOUBLE",
        description: "Convert to a number; invalid values become NULL.",
        example: "SELECT safe_num('12.5'), safe_num('unknown')",
    },
    Function {
        name: "pct",
        signature: "pct(part, total) -> DOUBLE",
        description: "Percentage (0–100); zero or invalid denominators become NULL.",
        example: "SELECT pct(25, 200)",
    },
    Function {
        name: "share",
        signature: "share(x) -> DOUBLE",
        description: "Fraction of the result total; contains a window expression.",
        example: "SELECT x, share(x) FROM (VALUES (1), (3)) t(x)",
    },
    Function {
        name: "biz_tz",
        signature: "biz_tz() -> VARCHAR",
        description: "Business calendar zone, UTC by default. For explicit local dates use timezone('America/Regina', timestamp)::DATE.",
        example: "SELECT biz_tz()",
    },
    Function {
        name: "biz_date",
        signature: "biz_date(ts TIMESTAMPTZ) -> DATE",
        description: "Date in the business calendar zone.",
        example: "SELECT biz_date(TIMESTAMPTZ '2026-11-08 03:00:00+00')",
    },
    Function {
        name: "biz_trunc",
        signature: "biz_trunc(part, ts TIMESTAMPTZ) -> TIMESTAMP",
        description: "Truncate business wall-clock time; returns a timestamp without a timezone.",
        example: "SELECT biz_trunc('day', TIMESTAMPTZ '2026-11-08 03:00:00+00')",
    },
    Function {
        name: "calendar",
        signature: "calendar(start, end, step := '1 day', tz := biz_tz()) -> TABLE(ts, local_time, biz_date, weekday, is_weekday, is_weekend)",
        description: "Inclusive calendar, including zero-activity days; use explicit tz for a local calendar.",
        example: "SELECT * FROM calendar(DATE '2026-03-07', DATE '2026-03-09', tz := 'America/Chicago')",
    },
    Function {
        name: "session_start",
        signature: "session_start(ts, previous_ts, gap_minutes) -> INTEGER",
        description: "1 for the first event or a gap strictly greater than the threshold; 0 otherwise; NULL for invalid inputs.",
        example: "SELECT session_start(TIMESTAMP '2026-01-01 11:00:00', TIMESTAMP '2026-01-01 10:00:00', 30)",
    },
];

/// List the bundled macros, or look up one exact name, without opening a database.
pub fn lookup(name: Option<&str>) -> Result<Value> {
    match name {
        None => Ok(serde_json::to_value(FUNCTIONS)?),
        Some(name) => {
            let function = FUNCTIONS.iter().find(|f| f.name == name).ok_or_else(|| {
                Failure::new(
                    ErrorCode::InvalidInput,
                    format!(
                        "unknown Slurp function '{name}'; available: {}",
                        FUNCTIONS
                            .iter()
                            .map(|f| f.name)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )
            })?;
            Ok(serde_json::to_value(function)?)
        }
    }
}
