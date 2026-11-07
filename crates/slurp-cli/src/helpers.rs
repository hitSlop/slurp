//! The SQL helpers (macros and views) installed into every project database; see `assets/helpers.sql`.
use crate::Workspace;

/// Bump when `assets/helpers.sql` changes so existing databases pick the new version up.
pub const VERSION: u32 = 2;
const SQL: &str = include_str!("../assets/helpers.sql");

/// The script that installs the helpers and records their version, as one transaction.
pub fn script() -> String {
    format!("BEGIN;\n{SQL}\nCREATE OR REPLACE MACRO slurp_helpers_version() AS {VERSION};\nCOMMIT;")
}

impl Workspace {
    /// Install the helpers when this database does not have the current version yet (a new database, or one created before
    /// they existed). A database that cannot be written right now is left alone: the helpers are a convenience, so a
    /// busy or read-only file must not stop a read.
    pub fn ensure_helpers(&self) {
        let current = self
            .execute("SELECT slurp_helpers_version() AS v", true)
            .ok()
            .and_then(|rows| rows[0]["v"].as_u64());
        if current != Some(u64::from(VERSION)) {
            let _ = self.execute(&script(), false);
        }
    }
}
