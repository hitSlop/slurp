mod common;
use slurp_app::setup::{PageContext, write_page};
#[test]
fn personal_page_is_private_and_script_safe() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("temporary root");
    let page = dir.path().join("private/index.html");
    let context = PageContext {
        project: Some("prj_test".into()),
        publishable_key: Some("slurp_pk_fake</script><script>bad()</script>".into()),
        ..Default::default()
    };
    write_page(&page, &context).expect("write private page");
    let html = std::fs::read_to_string(&page).expect("page bytes");
    assert!(!html.contains("slurp_pk_fake</script>"));
    assert!(html.contains("slurp_pk_fake\\u003c/script"));
    assert_eq!(
        std::fs::metadata(&page)
            .expect("page metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(page.parent().expect("parent"))
            .expect("directory metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    write_page(&page, &PageContext::default()).expect("replace existing page");
    assert!(
        !std::fs::read_to_string(page)
            .expect("new page")
            .contains("slurp_pk_fake")
    );
}
#[test]
fn machine_setup_ignores_current_project_and_never_embeds_credentials() {
    let Some(engine) = common::duckdb() else {
        return;
    };
    let dir = tempfile::tempdir().expect("temporary root");
    let home = dir.path().join("home");
    let library = dir.path().join("library");
    std::fs::create_dir(&home).expect("system home");
    std::fs::write(home.join("config.toml"), "# Keep my preferences\nversion = 1\nbackend = 'https://slurp.example.workers.dev' # Account server\nfuture_setting = true\n").expect("existing settings");
    std::fs::create_dir(dir.path().join("slurp")).expect("project metadata");
    let project = dir.path().join("slurp/slurp.toml");
    std::fs::write(&project, "existing project metadata remains untouched")
        .expect("existing metadata");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_slurp"))
        .current_dir(dir.path())
        .args([
            "setup",
            "--library",
            library.to_str().expect("library"),
            "--duckdb",
            engine.to_str().expect("engine"),
            "--no-connect",
            "--no-open",
        ])
        .env("SLURP_HOME", &home)
        .env_remove("SLURP_BACKEND")
        .env("SLURP_PROJECT_ID", "prj_test")
        .env("SLURP_PUBLISHABLE_KEY", "slurp_pk_fixture")
        .env("SLURP_TOKEN", "human_session_fixture")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("machine setup");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).expect("stdout");
    assert!(!text.contains("slurp_pk_fixture"));
    assert!(!text.contains("human_session_fixture"));
    let result: serde_json::Value = serde_json::from_str(&text).expect("JSON result");
    assert_eq!(result["local_ready"], true);
    assert_eq!(result["connected"], false);
    assert!(result.get("setup_page").is_none());
    assert!(!home.join("setup").exists());
    assert!(!home.join("projects.json").exists());
    assert!(home.join("config.toml").is_file());
    let settings = std::fs::read_to_string(home.join("config.toml")).expect("saved settings");
    assert!(
        settings.contains("# Keep my preferences")
            && settings.contains("# Account server")
            && settings.contains("future_setting = true")
    );
    assert_eq!(
        std::fs::read_to_string(project).expect("preserved project"),
        "existing project metadata remains untouched"
    );
    assert_eq!(
        std::fs::read_dir(library).expect("empty library").count(),
        0
    );
    assert!(!dir.path().join(".agents").exists());
}

#[test]
fn missing_default_library_never_falls_back_to_project_storage() {
    let Some(engine) = common::duckdb() else {
        return;
    };
    let root = tempfile::tempdir().expect("project");
    let home = root.path().join("home");
    let library = root.path().join("library");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_slurp"))
        .current_dir(root.path())
        .args([
            "setup",
            "--library",
            library.to_str().expect("library"),
            "--duckdb",
            engine.to_str().expect("engine"),
            "--no-connect",
        ])
        .env("SLURP_HOME", &home)
        .env_remove("SLURP_BACKEND")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("setup");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::rename(&library, root.path().join("disconnected")).expect("disconnect library");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_slurp"))
        .current_dir(root.path())
        .args(["init", "--connect", "prj_test", "--no-open"])
        .env("SLURP_HOME", &home)
        .env_remove("SLURP_BACKEND")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("init");
    assert!(!output.status.success());
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("error");
    assert_eq!(error["error"]["code"], "storage_unavailable");
    assert!(!library.exists() && !root.path().join(".slurp").exists());
}

#[test]
fn setup_without_a_connected_worker_names_slurp_connect_not_login() {
    let Some(engine) = common::duckdb() else {
        return;
    };
    let dir = tempfile::tempdir().expect("temporary root");
    let home = dir.path().join("home");
    std::fs::create_dir(&home).expect("system home");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_slurp"))
        .current_dir(dir.path())
        .args([
            "setup",
            "--library",
            dir.path().join("library").to_str().expect("library"),
            "--duckdb",
            engine.to_str().expect("engine"),
            "--no-open",
        ])
        .env("SLURP_HOME", &home)
        .env_remove("SLURP_BACKEND")
        .env_remove("SLURP_TOKEN")
        .env_remove("SLURP_READ_KEY")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("setup without a Worker");
    assert!(!output.status.success());
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(text.contains("setup_required"), "{text}");
    assert!(text.contains("slurp connect"), "{text}");
    assert!(!text.contains("slurp login"), "{text}");
}

#[test]
fn moving_unsupported_config_aside_allows_setup_to_recover() {
    let Some(engine) = common::duckdb() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let config = home.join("config.toml");
    std::fs::write(&config, "backend='https://example.com'").unwrap();
    let setup = || {
        std::process::Command::new(env!("CARGO_BIN_EXE_slurp"))
            .args(["setup", "--no-connect", "--no-open", "--duckdb"])
            .arg(&engine)
            .arg("--library")
            .arg(dir.path().join("library"))
            .env("SLURP_HOME", &home)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    };
    let rejected = setup();
    assert!(!rejected.status.success());
    assert!(
        String::from_utf8_lossy(&rejected.stderr).contains("slurp setup")
            || String::from_utf8_lossy(&rejected.stdout).contains("slurp setup")
    );
    std::fs::rename(&config, home.join("config.saved")).unwrap();
    let recovered = setup();
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stderr)
    );
    assert!(
        std::fs::read_to_string(config)
            .unwrap()
            .contains("version = 1")
    );
}

#[test]
fn offline_setup_reports_credentials_without_contacting_the_worker() {
    let Some(engine) = common::duckdb() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let backend = format!("http://{}", listener.local_addr().unwrap());
    let credentials = home.join("credentials.json");
    std::fs::write(
        &credentials,
        serde_json::to_vec(
            &serde_json::json!({"version":1,"entries":{backend.clone():"saved-offline-token"}}),
        )
        .unwrap(),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&credentials, std::fs::Permissions::from_mode(0o600)).unwrap();
    let run = |offline: bool| {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_slurp"));
        cmd.args(["setup", "--no-open", "--json"])
            .env("SLURP_HOME", &home)
            .env_remove("SLURP_TOKEN")
            .env_remove("SLURP_READ_KEY")
            .env_remove("SLURP_BACKEND")
            .stdin(std::process::Stdio::null());
        if offline {
            cmd.args(["--no-connect", "--backend", &backend, "--library"])
                .arg(root.path().join("library"))
                .arg("--duckdb")
                .arg(&engine);
        }
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    for result in [run(true), run(false)] {
        assert_eq!(result["connected"], false);
        assert_eq!(result["connection_checked"], false);
        assert_eq!(result["credentials_present"], true);
        assert_eq!(result["missing"], serde_json::json!([]));
        assert!(
            result["next_steps"]
                .as_str()
                .unwrap()
                .contains("not checked")
        );
    }
    std::fs::remove_file(credentials).unwrap();
    let result = run(true);
    assert_eq!(result["credentials_present"], false);
    assert_eq!(result["missing"], serde_json::json!(["login"]));
    assert!(
        result["next_steps"]
            .as_str()
            .unwrap()
            .contains("slurp connect")
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
