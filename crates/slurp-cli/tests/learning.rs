use serde_json::json;
use slurp_app::{Workspace, skills};

#[test]
fn skill_installation_is_complete_repeatable_and_preserves_edits() {
    let temp = tempfile::tempdir().expect("skill root");
    let out = temp.path().join("slurp");
    skills::install(&out, false, true).expect("install bundle");
    for name in [
        "slurp",
        "slurp-instrument",
        "slurp-analyze",
        "slurp-improve",
    ] {
        assert!(temp.path().join(name).join("SKILL.md").is_file());
        assert!(
            temp.path()
                .join(name)
                .join("queries/retention.sql")
                .is_file()
        );
    }
    skills::install(&out, false, true).expect("idempotent reinstall");
    std::fs::write(out.join("references/analysis.md"), "local edit").expect("edit");
    assert!(skills::install(&out, false, true).is_err());
    assert_eq!(
        std::fs::read_to_string(out.join("references/analysis.md")).expect("read"),
        "local edit"
    );
    skills::install(&out, true, true).expect("explicit replacement");
}

#[test]
fn skill_installation_rejects_symlink_resources() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().expect("skill root");
    let out = temp.path().join("slurp");
    std::fs::create_dir(&out).expect("root");
    symlink(temp.path(), out.join("queries")).expect("symlink");
    assert!(skills::install(&out, true, false).is_err());
    assert!(!out.join("SKILL.md").exists(), "preflight precedes writes");
}

#[test]
fn recipes_preserve_denominators_maturity_boundaries_and_zero_activity() {
    let Some(exe) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let temp = tempfile::tempdir().expect("workspace");
    let w = Workspace::init(
        temp.path(),
        "http://localhost:8080".into(),
        "src_test".into(),
        None,
        exe.into(),
    )
    .expect("initialize");
    w.execute(
        "INSERT INTO events(id,type,event,user_id,timestamp) VALUES
        ('1','track','signed_up','a','2026-01-01T00:00:00Z'),
        ('2','track','signed_up','b','2026-01-01T00:00:00Z'),
        ('3','track','signed_up','d','2026-01-01T00:00:00Z'),
        ('4','track','signed_up','c','2026-01-15T00:00:00Z'),
        ('5','track','value_delivered','a','2026-01-08T00:00:00Z'),
        ('6','track','value_delivered','a','2026-01-09T00:00:00Z'),
        ('7','track','value_delivered','d','2026-01-15T00:00:00Z'),
        ('8','track','value_delivered','c','2026-01-17T00:00:00Z'),
        ('9','track','value_delivered','b','2026-01-02T00:00:00Z')",
        false,
    )
    .expect("fixture");
    let retention = include_str!("../skills/slurp/queries/retention.sql");
    let result = w
        .query(retention.trim().trim_end_matches(';'))
        .expect("retention");
    assert_eq!(result["rows"][0][0], 3);
    assert_eq!(result["rows"][0][1], 1);
    let activation = include_str!("../skills/slurp/queries/activation.sql");
    let result = w
        .query(activation.trim().trim_end_matches(';'))
        .expect("activation");
    assert_eq!(result["rows"][0][0], 3);
    assert_eq!(result["rows"][0][1], 1);
    assert_eq!(result["rows"][0][3], 86400.0);
    let frequency = include_str!("../skills/slurp/queries/frequency.sql")
        .replace("2026-01-01", "2026-01-02")
        .replace("2026-02-01", "2026-01-03");
    assert_eq!(
        w.query(frequency.trim().trim_end_matches(';'))
            .expect("frequency")["rows"],
        json!([[0, 2], [1, 1]])
    );
    w.execute("DELETE FROM events", false)
        .expect("empty fixture");
    assert_eq!(
        w.query(retention.trim().trim_end_matches(';'))
            .expect("empty retention")["rows"],
        json!([[0, 0, null]])
    );
}

#[test]
fn local_json_flags_and_sql_file_work_through_the_cli() {
    let Some(exe) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let temp = tempfile::tempdir().expect("workspace");
    Workspace::init(
        temp.path(),
        "http://localhost:8080".into(),
        "src_test".into(),
        None,
        exe.into(),
    )
    .expect("initialize");
    let sql = temp.path().join("query.sql");
    std::fs::write(&sql, "SELECT 42 AS answer;\n").expect("query file");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_slurp"))
        .arg("--json")
        .arg("--workspace")
        .arg(temp.path())
        .args(["sql", "--file"])
        .arg(sql)
        .output()
        .expect("run query");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).expect("JSON")["rows"],
        json!([[42]])
    );
}
