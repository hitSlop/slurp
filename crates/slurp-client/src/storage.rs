//! Backend/source credentials live in a private file by default, never in event storage.
use anyhow::{Context, Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

/// Explicit credential-store selection. Missing files never cause a Keychain fallback.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Store {
    #[default]
    File,
    Keychain,
}

/// Read the machine's credential-store preference without accessing credentials.
///
/// # Errors
/// Returns an error for unreadable or invalid system settings.
pub fn selected() -> Result<Store> {
    selected_at(&crate::config::home()?)
}
fn selected_at(home: &Path) -> Result<Store> {
    #[derive(Default, Deserialize)]
    struct Settings {
        #[serde(default)]
        credential_store: Store,
    }
    match fs::read_to_string(home.join("config.toml")) {
        Ok(text) => Ok(toml::from_str::<Settings>(&text)
            .context("invalid credential_store setting; use file or keychain")?
            .credential_store),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Store::File),
        Err(_) => Err(anyhow!("could not read credential-store settings")),
    }
}

fn fixture_path() -> Option<PathBuf> {
    std::env::var_os("SLURP_TEST_SERVICE_SECRETS").map(PathBuf::from)
}

/// Read from the selected store without prompting when file storage is selected.
///
/// # Errors
/// Returns an error for invalid settings, unsafe file access, or denied native access.
pub fn get(account: &str) -> Result<Option<String>> {
    if let Some(path) = fixture_path() {
        return Ok(read_file(&path)?.remove(account));
    }
    match selected()? {
        Store::File => {
            Ok(read_file(&crate::config::home()?.join("credentials.json"))?.remove(account))
        }
        Store::Keychain => native_get(account),
    }
}

/// Atomically save a credential in the selected store.
///
/// # Errors
/// Returns an error if the selected store cannot be safely read or written.
pub fn set(account: &str, value: &str) -> Result<()> {
    if let Some(path) = fixture_path() {
        return update_file(&path, |values| {
            values.insert(account.into(), value.into());
        });
    }
    match selected()? {
        Store::File => update_file(&crate::config::home()?.join("credentials.json"), |values| {
            values.insert(account.into(), value.into());
        }),
        Store::Keychain => entry(account)?
            .set_password(value)
            .map_err(|_| anyhow!("could not save Keychain credentials")),
    }
}

/// Remove only this account from the selected store.
///
/// # Errors
/// Returns an error if the selected store cannot be safely read or written.
pub fn delete(account: &str) -> Result<()> {
    if let Some(path) = fixture_path() {
        return remove_file_account(&path, account);
    }
    match selected()? {
        Store::File => {
            remove_file_account(&crate::config::home()?.join("credentials.json"), account)
        }
        Store::Keychain => match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(anyhow!("could not clear Keychain credentials")),
        },
    }
}

fn native_get(account: &str) -> Result<Option<String>> {
    match entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(anyhow!("Keychain access unavailable")),
    }
}
fn entry(account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("dev.slurp.service", account)
        .map_err(|_| anyhow!("Keychain access unavailable"))
}

fn private_file(file: &fs::File) -> Result<()> {
    let metadata = file.metadata().context("checking credential file")?;
    // SAFETY: geteuid takes no arguments, only reads process identity, and cannot fail.
    let user = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_file() && metadata.uid() == user && metadata.nlink() <= 1,
        "credential files must be regular, owned by this user, and have no hard links"
    );
    ensure!(
        metadata.mode() & 0o077 == 0,
        "credential file permissions are too open; use chmod 600 on the credential file"
    );
    Ok(())
}
fn read_file(path: &Path) -> Result<BTreeMap<String, String>> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => {
            return Err(anyhow!(
                "could not open credential file; links are not supported"
            ));
        }
    };
    private_file(&file)?;
    serde_json::from_reader(file).map_err(|_| {
        anyhow!(
            "credential file is invalid; restore it or move it aside and run slurp connect again"
        )
    })
}
fn prepare(parent: &Path) -> Result<()> {
    fs::create_dir_all(parent).context("creating private credential folder")?;
    let metadata = fs::symlink_metadata(parent)?;
    // SAFETY: geteuid takes no arguments and cannot fail.
    let user = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_dir() && metadata.uid() == user,
        "credential folder must be a real directory owned by this user"
    );
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn update_file(path: &Path, change: impl FnOnce(&mut BTreeMap<String, String>)) -> Result<()> {
    use fs2::FileExt;
    let parent = path.parent().context("credential folder")?;
    prepare(parent)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path.with_extension("lock"))
        .map_err(|_| anyhow!("could not lock credential file; links are not supported"))?;
    private_file(&lock)?;
    lock.lock_exclusive()?;
    let mut values = read_file(path)?;
    change(&mut values);
    let mut temporary = tempfile::Builder::new()
        .prefix(".credentials-")
        .tempfile_in(parent)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer(&mut temporary, &values)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|_| anyhow!("could not save credential file"))?;
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
fn remove_file_account(path: &Path, account: &str) -> Result<()> {
    if !read_file(path)?.contains_key(account) {
        return Ok(());
    }
    update_file(path, |values| {
        values.remove(account);
    })
}

/// Non-secret result of an explicit, copy-only Keychain import.
#[derive(Debug, Serialize)]
pub struct Migration {
    pub imported: usize,
    pub already_saved: usize,
    pub not_found: usize,
    pub credentials_file: PathBuf,
}

/// Import the selected backend's saved session and cached source SDK keys once.
/// Existing file values win. Keychain entries are retained; ordinary reads never import.
///
/// # Errors
/// Returns an error for invalid settings, denied Keychain access, or an unsafe/unwritable file.
pub fn migrate_keychain(home: &Path, backend: &str) -> Result<Migration> {
    ensure!(
        selected_at(home)? == Store::File,
        "set credential_store = \"file\" in config.toml before importing from Keychain"
    );
    let backend = crate::config::normalize_backend(backend)?;
    let mut accounts = vec![backend.clone()];
    for cached in crate::config::load(home)?.sources {
        if cached.backend == backend {
            accounts.push(crate::config::publishable_account(
                &backend,
                &cached.source.id,
            ));
        }
    }
    accounts.sort();
    accounts.dedup();
    import_accounts(&home.join("credentials.json"), &accounts, native_get)
}
fn import_accounts(
    path: &Path,
    accounts: &[String],
    read: impl Fn(&str) -> Result<Option<String>>,
) -> Result<Migration> {
    let existing = read_file(path)?;
    let mut incoming = BTreeMap::new();
    let mut result = Migration {
        imported: 0,
        already_saved: 0,
        not_found: 0,
        credentials_file: path.to_path_buf(),
    };
    // Complete reads before writing, so denied access cannot leave a half-imported file.
    for account in accounts {
        if existing.contains_key(account) {
            result.already_saved += 1;
            continue;
        }
        match read(account)? {
            Some(value) => {
                incoming.insert(account.clone(), value);
            }
            None => result.not_found += 1,
        }
    }
    if !incoming.is_empty() {
        update_file(path, |values| {
            for (account, value) in incoming {
                if let std::collections::btree_map::Entry::Vacant(entry) = values.entry(account) {
                    entry.insert(value);
                    result.imported += 1;
                } else {
                    result.already_saved += 1;
                }
            }
        })?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_is_default_and_native_access_requires_an_explicit_setting() {
        let dir = tempfile::tempdir().expect("home");
        assert_eq!(selected_at(dir.path()).expect("default"), Store::File);
        assert!(!dir.path().join("credentials.json").exists());
        fs::write(
            dir.path().join("config.toml"),
            "backend='http://127.0.0.1:8787'\n",
        )
        .expect("settings");
        assert_eq!(selected_at(dir.path()).expect("old settings"), Store::File);
        fs::write(
            dir.path().join("config.toml"),
            "credential_store='keychain'\n",
        )
        .expect("settings");
        assert_eq!(
            selected_at(dir.path()).expect("native opt-in"),
            Store::Keychain
        );
        fs::write(dir.path().join("config.toml"), "credential_store='typo'\n").expect("settings");
        assert!(selected_at(dir.path()).is_err());
    }

    #[test]
    fn file_updates_preserve_accounts_and_are_private_and_atomic() {
        let dir = tempfile::tempdir().expect("home");
        let path = dir.path().join("private/credentials.json");
        assert!(read_file(&path).expect("missing").is_empty());
        assert!(
            !path.parent().expect("parent").exists(),
            "read must not create state"
        );
        // A reader may hold the previous inode after an atomic replacement (nlink == 0).
        let read_path = path.clone();
        let reader = std::thread::spawn(move || {
            for _ in 0..200 {
                read_file(&read_path).expect("concurrent atomic read");
                std::thread::yield_now();
            }
        });
        let threads: Vec<_> = (0..12)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    update_file(&path, |values| {
                        values.insert(format!("backend-{n}"), format!("secret-{n}"));
                    })
                    .expect("write")
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("writer");
        }
        reader.join().expect("reader");
        assert_eq!(read_file(&path).expect("complete JSON").len(), 12);
        assert_eq!(fs::metadata(&path).expect("file").mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(path.with_extension("lock"))
                .expect("lock")
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().expect("parent"))
                .expect("directory")
                .mode()
                & 0o777,
            0o700
        );
        remove_file_account(&path, "backend-0").expect("logout");
        assert_eq!(read_file(&path).expect("other accounts remain").len(), 11);
        assert!(
            fs::read_dir(path.parent().expect("parent"))
                .expect("directory")
                .all(|entry| !entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".credentials-"))
        );
    }

    #[test]
    fn corrupt_insecure_and_linked_files_are_not_read_or_overwritten() {
        let dir = tempfile::tempdir().expect("home");
        let path = dir.path().join("credentials.json");
        fs::write(&path, b"not JSON: do-not-log-this-token").expect("corrupt file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("permissions");
        let error = update_file(&path, |values| {
            values.clear();
        })
        .expect_err("corrupt file rejected");
        assert!(!error.to_string().contains("do-not-log-this-token"));
        assert_eq!(
            fs::read(&path).expect("unchanged"),
            b"not JSON: do-not-log-this-token"
        );
        fs::write(&path, b"{}").expect("valid file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("permissions");
        assert!(read_file(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("permissions");
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&path, &link).expect("link");
        assert!(read_file(&link).is_err());
        assert!(update_file(&link, |_| {}).is_err());
        fs::remove_file(&link).expect("remove link");
        fs::remove_file(path.with_extension("lock")).expect("remove lock");
        std::os::unix::fs::symlink(&path, path.with_extension("lock")).expect("lock link");
        assert!(update_file(&path, |_| {}).is_err());
    }

    #[test]
    fn keychain_import_is_explicit_repeatable_and_never_replaces_saved_values() {
        let dir = tempfile::tempdir().expect("home");
        let path = dir.path().join("credentials.json");
        let accounts = vec![
            "backend".into(),
            "publishable:backend#src_one".into(),
            "missing".into(),
        ];
        let read = |account: &str| {
            Ok(if account == "missing" {
                None
            } else {
                Some(format!("secret-{account}"))
            })
        };
        let first = import_accounts(&path, &accounts, read).expect("import");
        assert_eq!(
            (first.imported, first.already_saved, first.not_found),
            (2, 0, 1)
        );
        update_file(&path, |values| {
            values.insert("backend".into(), "newer-file-session".into());
        })
        .expect("refresh");
        let again = import_accounts(&path, &accounts, |account| {
            assert_eq!(
                account, "missing",
                "saved values must not touch Keychain again"
            );
            Ok(None)
        })
        .expect("repeat");
        assert_eq!(
            (again.imported, again.already_saved, again.not_found),
            (0, 2, 1)
        );
        assert_eq!(
            read_file(&path).expect("file")["backend"],
            "newer-file-session"
        );
        assert!(
            !serde_json::to_string(&again)
                .expect("safe summary")
                .contains("secret-")
        );
        let before = fs::read(&path).expect("before");
        let error = import_accounts(&path, &["first".into(), "denied".into()], |account| {
            if account == "denied" {
                Err(anyhow!("Keychain access denied"))
            } else {
                Ok(Some("never-partially-saved".into()))
            }
        });
        assert!(error.is_err());
        assert_eq!(fs::read(&path).expect("after"), before);
    }
}
