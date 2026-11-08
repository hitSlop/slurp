//! One command tree: every command is reachable, and the global options work before or after the subcommand.
use std::process::{Command, Output};

fn slurp(args: &[&str]) -> Output {
    let home = tempfile::tempdir().expect("home");
    Command::new(env!("CARGO_BIN_EXE_slurp"))
        .args(args)
        .env("SLURP_HOME", home.path())
        .env_remove("SLURP_TOKEN")
        .env_remove("SLURP_READ_KEY")
        .env_remove("SLURP_BACKEND")
        .output()
        .expect("run slurp")
}
fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn help_lists_local_and_worker_commands_in_one_place() {
    let output = slurp(&["--help"]);
    assert!(output.status.success());
    let help = text(&output);
    for command in [
        "init", "sync", "sql", "report", "mcp", "notify", "cloud", "connect", "whoami", "project",
        "send", "identify", "read",
    ] {
        assert!(
            help.lines()
                .any(|line| line.trim_start().starts_with(command)),
            "`slurp --help` does not list {command}:\n{help}"
        );
    }
    assert!(help.contains("--backend"), "{help}");
    assert!(
        slurp(&["send", "--help"])
            .stdout
            .windows(14)
            .any(|w| w == b"--project <PAT"),
        "the folder option is documented as a PATH"
    );
}

#[test]
fn global_options_work_before_and_after_the_subcommand() {
    // Nothing listens on port 1, so these fail after parsing: with a runtime error (1), never a usage error (2).
    for args in [
        ["--backend", "http://127.0.0.1:1", "whoami"].as_slice(),
        ["whoami", "--backend", "http://127.0.0.1:1"].as_slice(),
        [
            "--json",
            "--backend",
            "http://127.0.0.1:1",
            "project",
            "list",
        ]
        .as_slice(),
        [
            "project",
            "list",
            "--json",
            "--backend",
            "http://127.0.0.1:1",
        ]
        .as_slice(),
    ] {
        let output = slurp(args);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{args:?} should parse and then fail to connect: {}",
            text(&output)
        );
    }
    // --backend also reaches the local commands, which no longer have a second parser to reject it.
    let output = slurp(&["--backend", "http://127.0.0.1:1", "projects"]);
    assert!(output.status.success(), "{}", text(&output));
}

#[test]
fn sync_is_one_command_that_takes_no_portable_folder_options() {
    for args in [
        ["sync", "--out", "folder"].as_slice(),
        ["sync", "prj_0123456789abcdef"].as_slice(),
    ] {
        let output = slurp(args);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {}", text(&output));
    }
    // With no project folder it is a runtime error from project discovery, not a usage error.
    let output = slurp(&["--backend", "http://127.0.0.1:1", "sync"]);
    assert_eq!(output.status.code(), Some(1), "{}", text(&output));
}

#[test]
fn read_takes_a_project_and_has_no_folder_mode() {
    let help = text(&slurp(&["read", "--help"]));
    assert!(
        help.contains("PROJECT") && help.contains("--follow"),
        "{help}"
    );
    assert!(!help.contains("--folder"), "{help}");
    assert_eq!(slurp(&["read"]).status.code(), Some(2));
}

#[test]
fn removed_options_and_an_invalid_source_are_refused_without_a_server() {
    let project = "prj_0123456789abcdef";
    for removed in [
        ["project", "webhook", project, "github", "--rotate"].as_slice(),
        ["project", "update", project, "--title", "x"].as_slice(),
        ["project", "create", "app", "--no-geo"].as_slice(),
        ["project", "key", "list", project, "--geo"].as_slice(),
    ] {
        let output = slurp(removed);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{removed:?}: {}",
            text(&output)
        );
    }
    // Refused by the CLI itself, before anything is sent (the backend below is unreachable).
    let output = slurp(&[
        "--backend",
        "http://127.0.0.1:1",
        "send",
        "x",
        "--to",
        project,
        "--source",
        "Web Site",
    ]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        text(&output).contains("a source is a lowercase name"),
        "{}",
        text(&output)
    );
}
