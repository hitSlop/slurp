use serde_json::{Value, json};
use slurp_app::{Cancellation, Workspace, system};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn cli(root: &Path, user_home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_slurp"))
        .arg("--workspace")
        .arg(root)
        .args(args)
        .env("HOME", user_home)
        .env_remove("SLURP_HOME")
        .env_remove("SLURP_BACKEND")
        .env_remove("SLURP_SOURCE_ID")
        .env_remove("SLURP_TOKEN")
        .env_remove("SLURP_READ_KEY")
        .env_remove("SLURP_PUBLISHABLE_KEY")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("run CLI")
}

fn value(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("JSON output")
}

#[test]
fn system_defaults_and_registry_survive_disconnected_storage() {
    let Some(engine) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let user = tempfile::tempdir().expect("user home");
    let project = tempfile::tempdir().expect("project");
    let drive = tempfile::tempdir().expect("external parent");
    let storage = drive.path().join("events");
    let home = user.path().join(".slurp");
    let initial = value(cli(project.path(), user.path(), &["config"]));
    assert_eq!(initial["home"], json!(home));
    assert_eq!(initial["settings"]["backend"], "http://127.0.0.1:8787");
    assert!(!home.exists(), "reading config does not create state");
    fs::create_dir(&home).expect("system home");
    let settings = "# My self-hosted server\nbackend = 'http://localhost:8080'\n";
    fs::write(home.join("config.toml"), settings).expect("system settings");
    value(cli(
        project.path(),
        user.path(),
        &[
            "init",
            "--source",
            "src_system",
            "--duckdb",
            engine.to_str().expect("engine"),
            "--data-dir",
            storage.to_str().expect("data path"),
        ],
    ));
    let first = value(cli(project.path(), user.path(), &["projects"]));
    assert_eq!(first.as_array().expect("projects").len(), 1);
    assert_eq!(
        first[0]["root"],
        json!(project.path().canonicalize().expect("root"))
    );
    assert_eq!(first[0]["backend"], "http://localhost:8080");
    assert_eq!(first[0]["storage_available"], true);
    value(cli(project.path(), user.path(), &["init", "--no-open"]));
    let again = value(cli(project.path(), user.path(), &["projects", "list"]));
    assert_eq!(first, again, "repeat setup keeps one stable registration");
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).expect("preserved settings"),
        settings
    );
    let offline = drive.path().join("offline");
    fs::rename(&storage, &offline).expect("disconnect storage");
    let listed = value(cli(project.path(), user.path(), &["projects"]));
    assert_eq!(listed[0]["project_available"], true);
    assert_eq!(listed[0]["storage_available"], false);
    assert!(
        !storage.exists(),
        "listing never recreates unavailable storage"
    );
    value(cli(
        project.path(),
        user.path(),
        &[
            "projects",
            "forget",
            project.path().to_str().expect("project path"),
        ],
    ));
    assert_eq!(
        value(cli(project.path(), user.path(), &["projects"])),
        json!([])
    );
    assert!(
        offline.join("events.duckdb").is_file(),
        "forget never deletes event data"
    );
    assert!(project.path().join(".slurp/project.toml").is_file());
    fs::write(home.join("projects.json"), "invalid index").expect("damaged index");
    let another = tempfile::tempdir().expect("another project");
    let result = value(cli(
        another.path(),
        user.path(),
        &[
            "init",
            "--source",
            "src_another",
            "--duckdb",
            engine.to_str().expect("engine"),
        ],
    ));
    assert!(
        result["registry_warning"].is_string(),
        "registration failure must be visible"
    );
    assert!(
        Workspace::load(another.path()).is_ok(),
        "registration failure does not undo initialization"
    );
    assert_eq!(
        fs::read_to_string(home.join("projects.json")).expect("damaged index preserved"),
        "invalid index"
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(home.join("projects.json"))
            .expect("index")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn old_preferences_and_duckdb_are_reused_without_moving_them() {
    let Some(engine) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let user = tempfile::tempdir().expect("user home");
    let project = tempfile::tempdir().expect("project");
    let legacy = user.path().join(".local/share/slurp");
    fs::create_dir_all(legacy.join("service")).expect("old preferences");
    let old = r#"{"backend":"http://localhost:8080","sources":[]}"#;
    fs::write(legacy.join("service/client.json"), old).expect("saved preference");
    fs::create_dir_all(legacy.join("bin")).expect("old install");
    let executable = legacy.join("bin/duckdb");
    std::os::unix::fs::symlink(engine, &executable).expect("existing engine");
    let output = Command::new(env!("CARGO_BIN_EXE_slurp"))
        .arg("--workspace")
        .arg(project.path())
        .args(["init", "--source", "src_legacy", "--no-open"])
        .env("HOME", user.path())
        .env("PATH", "/usr/bin:/bin")
        .env_remove("SLURP_HOME")
        .env_remove("SLURP_BACKEND")
        .env_remove("SLURP_SOURCE_ID")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("legacy setup");
    let result = value(output);
    assert_eq!(result["initialized"], true);
    let saved = Workspace::load(project.path()).expect("saved workspace");
    assert_eq!(saved.backend, "http://localhost:8080");
    assert_eq!(saved.duckdb, executable);
    assert!(
        result["setup_page"]
            .as_str()
            .expect("page")
            .contains("/.slurp/setup/")
    );
    assert_eq!(
        fs::read_to_string(legacy.join("service/client.json")).expect("old settings"),
        old
    );
    assert!(executable.is_file());
    assert!(!user.path().join(".slurp/bin/duckdb").exists());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(user.path().join(".slurp/config.toml"))
            .expect("settings")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn registry_updates_are_serialized_and_corrupt_indexes_are_preserved() {
    let home = tempfile::tempdir().expect("registry home");
    let projects = tempfile::tempdir().expect("projects");
    std::thread::scope(|scope| {
        for i in 0..8 {
            let root = projects.path().join(format!("project-{i}"));
            fs::create_dir(&root).expect("project folder");
            let home = home.path();
            scope.spawn(move || {
                let workspace = Workspace {
                    version: 1,
                    backend: "https://slurp.example.workers.dev".into(),
                    source: format!("src_{i}"),
                    database: root.join("events.duckdb"),
                    duckdb: "duckdb".into(),
                    cancellation: Cancellation::default(),
                    extensions: Vec::new(),
                };
                system::register(home, &root, &workspace).expect("register concurrently");
            });
        }
    });
    assert_eq!(
        system::projects(home.path()).expect("all projects").len(),
        8
    );
    let index = home.path().join("projects.json");
    fs::write(&index, "invalid index").expect("damaged index");
    assert!(system::forget(home.path(), projects.path()).is_err());
    assert_eq!(
        fs::read_to_string(index).expect("unchanged index"),
        "invalid index"
    );
}
