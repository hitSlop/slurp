use serde_json::{Value, json};
use slurp_app::{
    Workspace, agent_notes,
    error::{ErrorCode, Failure},
    storage,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn cli(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_slurp"))
        .arg("--workspace")
        .arg(root)
        .args(args)
        .env_remove("SLURP_BACKEND")
        .env_remove("SLURP_SOURCE_ID")
        .env_remove("SLURP_PUBLISHABLE_KEY")
        .env_remove("SLURP_TOKEN")
        .env_remove("SLURP_READ_KEY")
        .env("SLURP_HOME", root.join("private-home"))
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
    serde_json::from_slice(&output.stdout).expect("JSON result")
}
fn init(root: &Path, database: Option<PathBuf>) -> Option<Workspace> {
    let exe = std::env::var_os("SLURP_TEST_DUCKDB")?;
    Some(
        Workspace::init(
            root,
            "http://localhost:8080".into(),
            "src_test".into(),
            database,
            exe.into(),
        )
        .expect("initialize"),
    )
}
fn storage_error(error: anyhow::Error) {
    assert!(matches!(
        error
            .downcast_ref::<Failure>()
            .expect("typed storage error")
            .code,
        ErrorCode::StorageUnavailable
    ));
}

#[test]
fn init_defaults_to_hosted_backend_and_allows_overrides() {
    let Some(exe) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    {
        let operation = "init";
        let project = tempfile::tempdir().expect("project");
        let result = value(cli(
            project.path(),
            &[
                operation,
                "--source",
                "src_test",
                "--duckdb",
                exe.to_str().expect("engine"),
            ],
        ));
        assert_eq!(result["initialized"], true);
        let saved = Workspace::load(project.path()).expect("configured workspace");
        assert_eq!(saved.backend, "http://127.0.0.1:8787");
        value(cli(project.path(), &["init", "--no-open"]));
        assert_eq!(
            Workspace::load(project.path())
                .expect("saved project")
                .backend,
            "http://127.0.0.1:8787"
        );
    }
    let self_hosted = tempfile::tempdir().expect("self-hosted project");
    fs::write(
        self_hosted.path().join("slurp.toml"),
        "backend = 'http://localhost:8080'\n",
    )
    .expect("self-hosted setting");
    let result = value(cli(
        self_hosted.path(),
        &[
            "init",
            "--source",
            "src_test",
            "--duckdb",
            exe.to_str().expect("engine"),
            "--no-open",
        ],
    ));
    assert_eq!(result["initialized"], true);
    value(cli(self_hosted.path(), &["init", "--no-open"]));
    assert_eq!(
        Workspace::load(self_hosted.path())
            .expect("self-hosted binding")
            .backend,
        "http://localhost:8080"
    );
    let project = tempfile::tempdir().expect("override project");
    let output = Command::new(env!("CARGO_BIN_EXE_slurp"))
        .arg("--workspace")
        .arg(project.path())
        .args([
            "init",
            "--source",
            "src_test",
            "--duckdb",
            exe.to_str().expect("engine"),
            "--no-open",
        ])
        .env("SLURP_BACKEND", "http://localhost:8081")
        .env_remove("SLURP_SOURCE_ID")
        .env("SLURP_HOME", project.path().join("private-home"))
        .stdin(std::process::Stdio::null())
        .output()
        .expect("environment override");
    assert_eq!(value(output)["initialized"], true);
    assert_eq!(
        Workspace::load(project.path())
            .expect("custom backend")
            .backend,
        "http://localhost:8081"
    );
}

#[test]
fn external_storage_setup_is_saved_and_never_relocated_implicitly() {
    let Some(exe) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let project = tempfile::tempdir().expect("project");
    let external = tempfile::tempdir().expect("external parent");
    let data = external.path().join("my app's events");
    let first = value(cli(
        project.path(),
        &[
            "init",
            "--source",
            "src_test",
            "--backend",
            "http://localhost:8080",
            "--duckdb",
            exe.to_str().expect("engine path"),
            "--data-dir",
            data.to_str().expect("data path"),
            "--no-open",
        ],
    ));
    let database = data
        .canonicalize()
        .expect("created folder")
        .join("events.duckdb");
    assert_eq!(first["initialized"], true);
    assert_eq!(first["database"], json!(database));
    assert!(project.path().join(".slurp/project.toml").is_file());
    assert!(!project.path().join(".slurp/data/events.duckdb").exists());
    assert!(
        !first["next_steps"]
            .as_str()
            .expect("commands")
            .contains(" init ")
    );
    assert!(
        first["next_steps"]
            .as_str()
            .expect("commands")
            .contains("--workspace")
    );
    let html = fs::read_to_string(first["setup_page"].as_str().expect("page")).expect("HTML");
    assert!(html.contains(database.to_str().expect("database path")));
    let saved = fs::read(project.path().join(".slurp/project.toml")).expect("config bytes");
    let again = value(cli(project.path(), &["init", "--no-open"]));
    assert_eq!(again["database"], first["database"]);
    assert_eq!(
        saved,
        fs::read(project.path().join(".slurp/project.toml")).expect("unchanged config")
    );
    let moved = external.path().join("another");
    let rejected = cli(
        project.path(),
        &[
            "init",
            "--data-dir",
            moved.to_str().expect("path"),
            "--no-open",
        ],
    );
    assert!(!rejected.status.success());
    assert!(!moved.exists());
    let w = Workspace::load(project.path()).expect("load saved workspace");
    let temp = w
        .query("SELECT current_setting('temp_directory') AS scratch")
        .expect("spill location");
    assert!(
        Path::new(temp["rows"][0][0].as_str().expect("scratch path"))
            .starts_with(database.parent().expect("data folder"))
    );
    assert_eq!(
        fs::read_dir(&data).expect("storage contents").count(),
        1,
        "temporary query files cleaned up"
    );
}

#[test]
fn missing_drive_or_database_never_creates_replacement_storage() {
    let project = tempfile::tempdir().expect("project");
    let external = tempfile::tempdir().expect("external parent");
    let data = external.path().join("events");
    let Some(w) = init(project.path(), Some(data.join("events.duckdb"))) else {
        return;
    };
    let hidden = external.path().join("disconnected");
    fs::rename(&data, &hidden).expect("simulate disconnect");
    storage_error(Workspace::load(project.path()).expect_err("missing drive"));
    storage_error(
        w.execute("CREATE TABLE accidental(i INT)", false)
            .expect_err("no writable fallback"),
    );
    storage_error(w.query("SELECT 1").expect_err("no query fallback"));
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    storage_error(
        runtime
            .block_on(w.sync("test"))
            .expect_err("storage checked before network"),
    );
    let setup = cli(project.path(), &["init", "--no-open"]);
    assert!(!setup.status.success());
    let error: Value = serde_json::from_slice(&setup.stderr).expect("structured error");
    assert_eq!(error["error"]["code"], "storage_unavailable");
    assert!(!data.exists());
    fs::rename(&hidden, &data).expect("reconnect");
    Workspace::load(project.path()).expect("restored original database");
    fs::remove_file(&w.database).expect("remove file");
    storage_error(w.execute("SELECT 1", false).expect_err("missing file"));
    assert!(!w.database.exists());
}

#[test]
fn path_selection_is_project_relative_and_external_parent_must_exist() {
    let project = tempfile::tempdir().expect("project");
    let root = project.path().canonicalize().expect("root");
    assert_eq!(
        storage::database_path(&root, None, None).expect("default"),
        root.join(".slurp/data/events.duckdb")
    );
    assert_eq!(
        storage::database_path(&root, Some(Path::new("some data/../event-data")), None)
            .expect("relative"),
        root.join("event-data/events.duckdb")
    );
    assert!(
        storage::database_path(&root, Some(Path::new("data")), Some(Path::new("a.duckdb")))
            .is_err()
    );
    if let Some(home) = std::env::var_os("HOME") {
        assert_eq!(
            storage::resolve(&root, Path::new("~/SlurpLibrary")).expect("home expansion"),
            PathBuf::from(home)
                .canonicalize()
                .expect("home")
                .join("SlurpLibrary")
        );
    }
    let external = tempfile::tempdir().expect("external");
    let database = external
        .path()
        .join("disconnected/library/project/events.duckdb");
    assert!(storage::prepare(&root, &database).is_err());
    assert!(!external.path().join("disconnected").exists());
}

#[test]
fn init_failure_preserves_existing_data_and_leaves_no_configuration() {
    let Some(exe) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let project = tempfile::tempdir().expect("project");
    let data = project.path().join("data");
    let database = data.join("events.duckdb");
    fs::create_dir(&data).expect("folder");
    fs::write(&database, "precious existing data").expect("existing file");
    assert!(
        Workspace::init(
            project.path(),
            "http://localhost:8080".into(),
            "src_test".into(),
            Some(database.clone()),
            exe.clone().into()
        )
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(&database).expect("preserved"),
        "precious existing data"
    );
    assert!(!project.path().join(".slurp/project.toml").exists());
    fs::remove_file(&database).expect("remove fixture");
    fs::create_dir(project.path().join(".slurp")).expect("metadata folder");
    std::os::unix::fs::symlink(
        project.path().join("not-created"),
        project.path().join(".slurp/project.toml"),
    )
    .expect("conflicting dangling link");
    assert!(
        Workspace::init(
            project.path(),
            "http://localhost:8080".into(),
            "src_test".into(),
            Some(database.clone()),
            exe.into()
        )
        .is_err()
    );
    assert!(
        !database.exists(),
        "failed config commit removes the newly created database"
    );
    assert!(!project.path().join("not-created").exists());
    assert_eq!(
        fs::read_dir(&data).expect("data dir").count(),
        0,
        "staged files cleaned up"
    );
}

#[test]
fn scripted_init_requires_explicit_agent_notes_and_preserves_instruction_files() {
    let Some(engine) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let project = tempfile::tempdir().expect("project");
    fs::write(
        project.path().join("AGENTS.md"),
        "Keep existing instructions.\n",
    )
    .expect("instructions");
    let output = cli(
        project.path(),
        &["init", "--data-dir", "event data", "--no-open"],
    );
    assert!(!output.status.success());
    let error: Value = serde_json::from_slice(&output.stderr).expect("structured error");
    assert_eq!(error["error"]["code"], "setup_required");
    assert!(!project.path().join("event data").exists());
    assert!(!project.path().join(".slurp/project.toml").exists());
    value(cli(
        project.path(),
        &[
            "init",
            "--source",
            "src_test",
            "--duckdb",
            engine.to_str().expect("engine"),
            "--no-open",
        ],
    ));
    assert_eq!(
        fs::read_to_string(project.path().join("AGENTS.md")).expect("unchanged"),
        "Keep existing instructions.\n"
    );
    for _ in 0..2 {
        value(cli(project.path(), &["init", "--agent-notes", "--no-open"]));
    }
    assert_eq!(
        fs::read_to_string(project.path().join("AGENTS.md"))
            .expect("reminder")
            .matches(agent_notes::REMINDER)
            .count(),
        1
    );
    assert!(!project.path().join("CLAUDE.md").exists());
    let blank = tempfile::tempdir().expect("blank project");
    let result = value(cli(
        blank.path(),
        &[
            "init",
            "--source",
            "src_test",
            "--duckdb",
            engine.to_str().expect("engine"),
            "--agent-notes",
            "--no-open",
        ],
    ));
    assert_eq!(result["agent_notes"]["updated"], json!([]));
    assert!(!blank.path().join("AGENTS.md").exists());
}

#[test]
fn reminders_preserve_text_permissions_aliases_and_scope() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let project = tempfile::tempdir().expect("project");
    let agents = project.path().join("AGENTS.md");
    fs::write(&agents, "Existing instructions\r\n").expect("instructions");
    fs::set_permissions(&agents, fs::Permissions::from_mode(0o640)).expect("permissions");
    symlink("AGENTS.md", project.path().join("CLAUDE.md")).expect("alias");
    let report = agent_notes::append(project.path()).expect("append");
    assert_eq!(report.updated.len(), 1);
    let text = fs::read_to_string(&agents).expect("contents");
    assert!(text.starts_with("Existing instructions\r\n"));
    assert!(!text.replace("\r\n", "").contains('\n'), "preserves CRLF");
    assert_eq!(
        fs::metadata(&agents)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    assert_eq!(
        agent_notes::append(project.path())
            .expect("repeat")
            .unchanged
            .len(),
        1
    );
    fs::remove_file(project.path().join("CLAUDE.md")).expect("remove alias");
    let outside = tempfile::NamedTempFile::new().expect("outside file");
    fs::write(outside.path(), "Outside instructions").expect("outside");
    symlink(outside.path(), project.path().join("CLAUDE.md")).expect("outside alias");
    assert_eq!(
        agent_notes::append(project.path())
            .expect("skip outside")
            .skipped
            .len(),
        1
    );
    assert_eq!(
        fs::read_to_string(outside.path()).expect("preserved outside"),
        "Outside instructions"
    );
}

#[test]
fn init_data_dir_flag_and_conflicts_are_machine_readable() {
    let Some(exe) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let project = tempfile::tempdir().expect("project");
    let root = project.path().canonicalize().expect("root");
    let result = value(cli(
        &root,
        &[
            "init",
            "--source",
            "src_test",
            "--backend",
            "http://localhost:8080",
            "--duckdb",
            exe.to_str().expect("engine"),
            "--data-dir",
            "event data",
        ],
    ));
    assert_eq!(
        result["database"],
        json!(root.join("event data/events.duckdb"))
    );
    let invalid = tempfile::tempdir().expect("invalid project");
    let output = cli(
        invalid.path(),
        &[
            "init",
            "--data-dir",
            "data",
            "--database",
            "file.duckdb",
            "--no-open",
        ],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(!invalid.path().join(".slurp").exists());
}

#[test]
fn selecting_a_different_source_does_not_embed_environment_keys() {
    let Some(engine) = std::env::var_os("SLURP_TEST_DUCKDB") else {
        return;
    };
    let root = tempfile::tempdir().expect("project");
    let output = Command::new(env!("CARGO_BIN_EXE_slurp"))
        .arg("--workspace")
        .arg(root.path())
        .args([
            "init",
            "--source",
            "src_new",
            "--duckdb",
            engine.to_str().expect("engine"),
            "--no-open",
        ])
        .env_remove("SLURP_BACKEND")
        .env("SLURP_SOURCE_ID", "src_old")
        .env("SLURP_PUBLISHABLE_KEY", "slurp_pk_old_fixture")
        .env("SLURP_READ_KEY", "slurp_sk_old_fixture")
        .env("SLURP_HOME", root.path().join("private-home"))
        .stdin(std::process::Stdio::null())
        .output()
        .expect("init");
    let result = value(output);
    let html = fs::read_to_string(result["setup_page"].as_str().expect("page")).expect("HTML");
    assert!(!html.contains("slurp_pk_old_fixture"));
    assert!(!html.contains("slurp_sk_old_fixture"));
    assert!(html.contains("src_new"));
}
