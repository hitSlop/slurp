use slurp_app::{drives::Drive, setup};
use std::fs;

#[test]
fn library_creation_is_deferred_scoped_and_refuses_collisions() {
    let volume = tempfile::tempdir().expect("volume");
    let drive =
        Drive::from_path(volume.path(), "Test SSD".into(), Some(true)).expect("capture mount");
    let preview = drive.project_directory("my-app").expect("preview");
    assert!(!preview.exists(), "preview must not create folders");
    assert!(drive.project_directory("../outside").is_err());
    assert!(drive.project_directory("nested/project").is_err());
    assert_eq!(
        drive.prepare_project("my-app").expect("confirmed creation"),
        preview
    );
    assert!(preview.is_dir());
    fs::write(preview.join("events.duckdb"), "existing data").expect("collision");
    assert!(drive.project_directory("my-app").is_err());
    assert_eq!(
        fs::read_to_string(preview.join("events.duckdb")).expect("unchanged"),
        "existing data"
    );
}

#[test]
fn unplugged_replaced_or_redirected_mounts_cannot_receive_writes() {
    let parent = tempfile::tempdir().expect("mount parent");
    let mount = parent.path().join("drive");
    fs::create_dir(&mount).expect("mount");
    let drive = Drive::from_path(&mount, "Test".into(), None).expect("capture mount");
    fs::rename(&mount, parent.path().join("unplugged")).expect("detach");
    assert!(drive.prepare_project("my-app").is_err());
    assert!(!mount.exists(), "never recreate a missing mountpoint");
    fs::create_dir(&mount).expect("replacement mountpoint");
    assert!(
        drive.prepare_project("my-app").is_err(),
        "directory identity must still match"
    );
    assert_eq!(fs::read_dir(&mount).expect("replacement").count(), 0);
    let current = Drive::from_path(&mount, "New mount".into(), None).expect("recapture");
    let outside = tempfile::tempdir().expect("outside");
    std::os::unix::fs::symlink(outside.path(), mount.join("SlurpLibrary")).expect("redirect");
    assert!(current.prepare_project("my-app").is_err());
    assert!(!outside.path().join("my-app").exists());
}

#[test]
fn public_guide_has_budget_tier_and_no_personalized_context() {
    let home = tempfile::tempdir().expect("guide home");
    let page = setup::write_storage_guide(home.path()).expect("write guide");
    let html = fs::read_to_string(&page).expect("guide HTML");
    assert!(html.contains("\"guide_only\":true"));
    assert!(html.contains("\"project\":null"));
    assert!(html.contains("\"publishable_key\":null"));
    assert!(html.contains("\"read_key\":null"));
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../assets/storage-options.json")).expect("catalog");
    assert_eq!(catalog["currency"], "USD");
    assert_eq!(catalog["options"][0]["price_range"], "US$50–100");
    assert!(
        catalog["options"][0]["reference_price"]
            .as_f64()
            .expect("price")
            <= 100.0
    );
    for option in catalog["options"].as_array().expect("tiers") {
        assert!(
            option["manufacturer_url"]
                .as_str()
                .expect("manufacturer")
                .starts_with("https://")
        );
        assert!(
            option["price_url"]
                .as_str()
                .expect("seller")
                .starts_with("https://")
        );
    }
}
