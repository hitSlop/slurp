use sha2::{Digest, Sha256};
use slurp_client::{DirRemote, folder::Folder};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const BACKEND: &str = "https://events.example.test";
fn coverage(root: &Path, archive: &str, floor: i64, latest: i64) {
    fs::write(root.join("coverage.json"), serde_json::to_vec(&serde_json::json!({
        "archive_id":archive,"first_retained":floor.to_string(),"latest_published":latest.to_string(),"retention_seconds":3600
    })).unwrap()).unwrap();
}
fn publish(root: &Path, archive: &str, sequence: i64) -> PathBuf {
    let body = format!("{{\"id\":\"{archive}-{sequence}\",\"value\":{sequence}}}\n");
    let bytes = zstd::encode_all(body.as_bytes(), 1).unwrap();
    let name = format!(
        "{sequence:020}-{}.jsonl.zst",
        hex::encode(Sha256::digest(&bytes))
    );
    let path = root.join(format!("archives/{archive}/events/{name}"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    path
}
#[tokio::test]
async fn incremental_download_offline_copy_reset_and_integrity() {
    let remote_root = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let first = publish(remote_root.path(), "a_first", 1);
    publish(remote_root.path(), "a_first", 2);
    coverage(remote_root.path(), "a_first", 1, 2);
    let remote = DirRemote::new(remote_root.path().into(), "source_id");
    remote.expire_once(first.file_name().unwrap().to_str().unwrap());
    let mut folder = Folder::open(local.path(), BACKEND, "source_id")
        .await
        .unwrap();
    let report = folder.sync(&remote, false).await.unwrap();
    assert_eq!(
        (
            report.outcome.as_str(),
            report.downloaded,
            report.checkpoint.as_deref()
        ),
        ("complete", 2, Some("2"))
    );
    assert_eq!(folder.sync(&remote, false).await.unwrap().downloaded, 0);
    let before = fs::read(local.path().join("source.json")).unwrap();
    let mut output = Vec::new();
    folder.read(&mut output, None, None).unwrap();
    assert_eq!(String::from_utf8(output).unwrap().lines().count(), 2);
    assert_eq!(before, fs::read(local.path().join("source.json")).unwrap());
    drop(folder);
    assert!(
        Folder::open(local.path(), BACKEND, "other_id")
            .await
            .is_err()
    );
    assert_eq!(before, fs::read(local.path().join("source.json")).unwrap());

    // File rename completed, but its manifest commit was interrupted.
    let third = publish(remote_root.path(), "a_first", 3);
    let relative = third.strip_prefix(remote_root.path()).unwrap();
    fs::copy(&third, local.path().join(relative)).unwrap();
    coverage(remote_root.path(), "a_first", 1, 3);
    let mut folder = Folder::load(local.path()).await.unwrap();
    let report = folder.sync(&remote, false).await.unwrap();
    assert_eq!(
        (
            report.downloaded,
            report.reused,
            report.checkpoint.as_deref()
        ),
        (0, 1, Some("3"))
    );

    publish(remote_root.path(), "a_next", 1);
    coverage(remote_root.path(), "a_next", 1, 1);
    assert_eq!(folder.sync(&remote, false).await.unwrap().outcome, "reset");
    assert_eq!(folder.manifest().active_archive.as_deref(), Some("a_first"));
    assert_eq!(folder.sync(&remote, true).await.unwrap().downloaded, 1);
    assert!(folder.read(&mut Vec::new(), None, None).is_err());
    let mut output = Vec::new();
    folder.read(&mut output, Some("a_first"), Some(1)).unwrap();
    assert_eq!(String::from_utf8(output).unwrap().lines().count(), 2);
    // Copy every object through ordinary writes, independent of hard links.
    let copied = tempfile::tempdir().unwrap();
    fs::copy(
        local.path().join("source.json"),
        copied.path().join("source.json"),
    )
    .unwrap();
    for archive in &folder.manifest().archives {
        for object in &archive.objects {
            let path = copied.path().join(&object.path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::copy(local.path().join(&object.path), path).unwrap();
        }
    }
    drop(folder);
    let mut offline = Folder::load(copied.path()).await.unwrap();
    offline
        .read(&mut Vec::new(), Some("a_first"), None)
        .unwrap();
    let path = copied
        .path()
        .join(&offline.manifest().archives[0].objects[0].path);
    drop(offline);
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    fs::write(&path, bytes).unwrap();
    assert!(
        Folder::load(copied.path()).await.is_err(),
        "changed bytes must fail inventory verification"
    );
}

#[tokio::test]
async fn bootstrap_gaps_missing_files_and_unsafe_paths_are_explicit() {
    let remote_root = tempfile::tempdir().unwrap();
    publish(remote_root.path(), "a_first", 3);
    coverage(remote_root.path(), "a_first", 2, 3);
    let remote = DirRemote::new(remote_root.path().into(), "source_id");
    let local = tempfile::tempdir().unwrap();
    let mut folder = Folder::open(local.path(), BACKEND, "source_id")
        .await
        .unwrap();
    let gap = folder.sync(&remote, false).await.unwrap();
    assert_eq!(
        (gap.outcome.as_str(), gap.expected.as_deref()),
        ("gap", Some("2"))
    );
    assert_eq!(folder.manifest().archives[0].bootstrap, "2");
    publish(remote_root.path(), "a_first", 2);
    assert_eq!(folder.sync(&remote, false).await.unwrap().downloaded, 2);
    coverage(remote_root.path(), "a_first", 5, 6);
    let gap = folder.sync(&remote, false).await.unwrap();
    assert_eq!(
        (
            gap.outcome.as_str(),
            gap.expected.as_deref(),
            gap.first_retained.as_deref()
        ),
        ("gap", Some("4"), Some("5"))
    );
    let path = local
        .path()
        .join(&folder.manifest().archives[0].objects[0].path);
    drop(folder);
    fs::remove_file(path).unwrap();
    assert!(Folder::load(local.path()).await.is_err());
    let manifest = local.path().join("source.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    value["archives"][0]["objects"][0]["path"] = "../outside".into();
    fs::write(manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(Folder::load(local.path()).await.is_err());
}

#[test]
fn folder_crash_child() {
    let Some(root) = std::env::var_os("SLURP_TEST_FOLDER_ROOT") else {
        return;
    };
    let remote = DirRemote::new(
        std::env::var_os("SLURP_TEST_FOLDER_REMOTE").unwrap().into(),
        "source_id",
    );
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let mut folder = Folder::open(Path::new(&root), BACKEND, "source_id")
            .await
            .unwrap();
        folder.sync(&remote, false).await.unwrap();
    });
}

#[tokio::test]
async fn sigkill_before_and_after_manifest_commit_never_skips_a_delivery() {
    for phase in ["after_download", "after_rename", "after_manifest"] {
        let remote_root = tempfile::tempdir().unwrap();
        publish(remote_root.path(), "a_first", 1);
        coverage(remote_root.path(), "a_first", 1, 1);
        let local = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "folder_crash_child"])
            .env("SLURP_TEST_FOLDER_ROOT", local.path())
            .env("SLURP_TEST_FOLDER_REMOTE", remote_root.path())
            .env("SLURP_TEST_FOLDER_PAUSE", phase)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !local.path().join(".paused").exists() {
            if Instant::now() > deadline || child.try_wait().unwrap().is_some() {
                let _ = child.kill();
                let _ = child.wait();
                panic!("child did not pause at {phase}");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let remote = DirRemote::new(remote_root.path().into(), "source_id");
        let mut recovered = Folder::load(local.path()).await.unwrap();
        let report = recovered.sync(&remote, false).await.unwrap();
        assert_eq!(report.checkpoint.as_deref(), Some("1"), "{phase}");
        assert_eq!(recovered.manifest().archives[0].objects.len(), 1);
        assert_eq!(report.downloaded, usize::from(phase == "after_download"));
        assert_eq!(report.reused, usize::from(phase == "after_rename"));
        let mut output = Vec::new();
        recovered.read(&mut output, None, None).unwrap();
        assert_eq!(String::from_utf8(output).unwrap().lines().count(), 1);
    }
}

/// Both syncs download through `download_verified`; these pin its behaviour on its own.
mod download_verified {
    use super::*;
    use slurp_client::{Remote, RemoteError, download_verified};

    async fn first_object(remote: &DirRemote) -> slurp_client::ListedObject {
        remote.list(Some(0), 10).await.unwrap().objects.remove(0)
    }

    #[tokio::test]
    async fn an_expired_link_is_refreshed_and_the_download_succeeds() {
        let root = tempfile::tempdir().unwrap();
        let path = publish(root.path(), "a_one", 1);
        coverage(root.path(), "a_one", 1, 1);
        let remote = DirRemote::new(root.path().into(), "s");
        remote.expire_once(path.file_name().unwrap().to_str().unwrap());
        let object = first_object(&remote).await;
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("o.jsonl.zst");
        download_verified(&remote, &object, &dest).await.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), fs::read(&path).unwrap());
        assert_eq!(
            remote.counts().object_gets,
            2,
            "one expired attempt, one that worked"
        );
    }

    #[tokio::test]
    async fn an_object_deleted_meanwhile_reports_expired_not_a_checksum_error() {
        let root = tempfile::tempdir().unwrap();
        let path = publish(root.path(), "a_two", 1);
        coverage(root.path(), "a_two", 1, 1);
        let remote = DirRemote::new(root.path().into(), "s");
        let object = first_object(&remote).await;
        fs::remove_file(&path).unwrap();
        let out = tempfile::tempdir().unwrap();
        let error = download_verified(&remote, &object, &out.path().join("o"))
            .await
            .unwrap_err();
        assert!(matches!(error, RemoteError::Expired), "{error}");
    }

    #[tokio::test]
    async fn bytes_that_do_not_match_the_listing_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let path = publish(root.path(), "a_three", 1);
        coverage(root.path(), "a_three", 1, 1);
        let remote = DirRemote::new(root.path().into(), "s");
        let object = first_object(&remote).await;
        fs::write(&path, b"tampered").unwrap();
        let out = tempfile::tempdir().unwrap();
        let error = download_verified(&remote, &object, &out.path().join("o"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("SHA256 verification"), "{error}");
    }
}
