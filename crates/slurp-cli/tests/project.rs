use slurp_app::{Cancellation, Workspace, project};
use std::{fs, path::Path};

fn binding(root: &Path, project: &str) {
    fs::create_dir_all(root.join(".slurp")).expect("metadata folder");
    let workspace = Workspace {
        version: 1,
        backend: "https://slurp.example.workers.dev".into(),
        project: project.into(),
        database: root.join("unavailable/events.duckdb"),
        duckdb: "/unavailable/duckdb".into(),
        cancellation: Cancellation::default(),
        extensions: Vec::new(),
        sandbox: false,
    };
    fs::write(
        root.join(".slurp/project.toml"),
        toml::to_string(&workspace).expect("binding"),
    )
    .expect("write binding");
}

#[test]
fn discovery_uses_nearest_metadata_without_opening_storage() {
    let outer = tempfile::tempdir().expect("project");
    binding(outer.path(), "prj_outer");
    let inner = outer.path().join("apps/inner");
    let child = inner.join("src/lib");
    fs::create_dir_all(&child).expect("nested folders");
    assert_eq!(
        project::discover(&child).expect("outer discovery"),
        Some(outer.path().canonicalize().expect("outer"))
    );
    binding(&inner, "prj_inner");
    assert_eq!(
        project::discover(&child).expect("inner discovery"),
        Some(inner.canonicalize().expect("inner"))
    );
    assert_eq!(
        Workspace::read_binding(&inner)
            .expect("metadata only")
            .project,
        "prj_inner"
    );
    assert_eq!(
        project::resolve(&child, Some(outer.path())).expect("explicit project"),
        outer.path().canonicalize().expect("outer")
    );
    assert!(
        project::resolve(outer.path(), Some(&child)).is_err(),
        "explicit workspace must not search parents"
    );
    fs::write(inner.join(".slurp/project.toml"), "not valid metadata")
        .expect("damaged inner binding");
    assert!(
        project::discover(&child).is_err(),
        "never fall through to another project"
    );
}

#[test]
fn discovery_does_not_guess_from_the_registry_or_skip_broken_links() {
    let root = tempfile::tempdir().expect("folder");
    assert!(
        project::discover(root.path())
            .expect("no project")
            .is_none()
    );
    assert!(project::resolve(root.path(), None).is_err());
    binding(root.path(), "prj_outer");
    let child = root.path().join("child");
    fs::create_dir_all(child.join(".slurp")).expect("inner metadata directory");
    std::os::unix::fs::symlink(child.join("missing"), child.join(".slurp/project.toml"))
        .expect("broken metadata link");
    assert!(project::discover(&child).is_err());
}
