mod common;
use serde_json::{Value, json};
use slurp_app::{Workspace, functions};
#[test]
fn discovery_is_offline_and_every_example_runs() {
    let temp = tempfile::tempdir().unwrap();
    let cli = |args: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_slurp"))
            .args(args)
            .arg("--json")
            .env("SLURP_HOME", temp.path().join("empty"))
            .env("SLURP_DUCKDB", "/no-engine")
            .current_dir(temp.path())
            .output()
            .unwrap()
    };
    let output = cli(&["functions"]);
    assert!(output.status.success(), "{:?}", output);
    let list: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(list, functions::lookup(None).unwrap());
    assert_eq!(list.as_array().unwrap().len(), 8);
    let named = cli(&["functions", "calendar"]);
    assert!(named.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&named.stdout).unwrap(),
        functions::lookup(Some("calendar")).unwrap()
    );
    let bad = cli(&["functions", "missing"]);
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("invalid_input"));
    assert!(!temp.path().join("empty").exists());
    let Some(engine) = common::duckdb() else {
        return;
    };
    let w = Workspace::init(
        &temp.path().join("home"),
        temp.path(),
        "http://localhost:8080".into(),
        "prj_test".into(),
        None,
        engine.into(),
    )
    .unwrap();
    for function in list.as_array().unwrap() {
        w.sandboxed()
            .query(function["example"].as_str().unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", function["name"]));
    }
    let server = slurp_app::mcp::Server::new(
        &w,
        temp.path().into(),
        env!("CARGO_BIN_EXE_slurp").into(),
        false,
    );
    server.handle_line(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}).to_string());
    for name in [None, Some("calendar")] {
        let response=server.handle_line(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"functions","arguments":name.map(|n|json!({"name":n})).unwrap_or(json!({}))}}).to_string()).unwrap();
        assert_eq!(response["result"]["isError"], false);
        let data: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(data, functions::lookup(name).unwrap());
    }
}
