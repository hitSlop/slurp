//! Helpers shared by the integration tests.
#![allow(dead_code)]
use std::ffi::OsString;

/// The DuckDB 2 executable the native tests run against (`SLURP_TEST_DUCKDB`).
///
/// Without it the native tests are skipped on a developer machine, where DuckDB may not be installed. In CI (`CI` is set)
/// a skip would hide that the tests never ran, so a missing executable fails instead.
pub fn duckdb() -> Option<OsString> {
    let found = std::env::var_os("SLURP_TEST_DUCKDB");
    assert!(
        found.is_some() || std::env::var_os("CI").is_none(),
        "SLURP_TEST_DUCKDB is not set but CI is: the native tests must run in CI, not skip"
    );
    found
}

/// Whether a test that needs the network (or something else CI provides) may skip: never in CI.
pub fn may_skip(reason: &str) -> bool {
    assert!(
        std::env::var_os("CI").is_none(),
        "this test cannot skip in CI: {reason}"
    );
    eprintln!("skipped: {reason}");
    true
}
