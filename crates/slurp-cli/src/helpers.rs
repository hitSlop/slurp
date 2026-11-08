//! The SQL helpers (macros and views) installed into every project database; see `assets/helpers.sql`.
use crate::Workspace;

/// Bump when `assets/helpers.sql` changes so existing databases pick the new version up.
pub const VERSION: u32 = 6;
const SQL: &str = include_str!("../assets/helpers.sql");

/// The script that installs the helpers and records their version, as one transaction.
pub fn script() -> String {
    format!("BEGIN;\n{SQL}\nCREATE OR REPLACE MACRO slurp_helpers_version() AS {VERSION};\nCOMMIT;")
}

impl Workspace {
    /// Update derived helpers transactionally when their version changes.
    ///
    /// Failed refreshes warn without preventing ordinary reads.
    pub fn ensure_helpers(&self) {
        let current = self
            .execute("SELECT slurp_helpers_version() AS v", true)
            .ok()
            .and_then(|rows| rows[0]["v"].as_u64());
        if current != Some(u64::from(VERSION)) {
            // Optional writes should not wait for other readers to close.
            if let Err(error) =
                self.run_once(&script(), false, false, std::time::Duration::from_secs(60))
            {
                let cause = error
                    .to_string()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                eprintln!("could not update Slurp helper views: {cause}; a later open will retry");
            }
        }
    }

    /// Check only the derived views an operation needs; ordinary SQL stays available.
    pub fn require_helper(&self, name: &str) -> anyhow::Result<()> {
        let rows = self.execute(&format!("SELECT count(*) AS n FROM information_schema.views WHERE table_schema = 'main' AND table_name = {}", crate::literal(name)), true)?;
        if rows[0]["n"].as_u64() != Some(1) {
            return Err(crate::error::Failure::new(crate::error::ErrorCode::WorkspaceUnavailable,
                format!("required Slurp helper view `{name}` is unavailable; retry with a writable database after other connections close")).into());
        }
        Ok(())
    }
}
