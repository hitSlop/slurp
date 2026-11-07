# Slurp service client

This crate has no dependency on the library, daemon, DuckDB or DuckLake.
`rpc` is generated from `backend/api/slurp.ridl`. `http_client()` provides the
shared TLS roots, timeouts and redirect policy.

`auth::Session` manages backend-scoped credentials using an injected
`CredentialStore` (normally `auth::SavedCredentials`). Native clients must share
the same credential-lock directory. Poll login at the server's interval, add five
seconds on `slow_down`, and stop on denial, expiry or cancellation. Completed
login saves the credentials. `access_token()` refreshes when needed;
`refresh_after_unauthenticated()` coordinates one refresh after a rejected token.
Provider outages retain credentials. Terminal invalid grants clear them.
`logout()` clears local credentials and reports remote revocation failures.
Environment credentials and source read keys can use the RPC/transport directly.

`folder::Folder::open(path, backend, source_id)` locks and binds a portable event
folder. `sync(&remote, accept_reset)` downloads one catch-up run using `HttpRemote`
or an injected `Remote`. `Folder::load(path)` and `read()` work offline.
The CLI's DuckDB sync (`Workspace::sync`) and this folder sync share one download path, `download_verified`: it checks size and
SHA-256 against the listing and asks for a fresh signed link when one expires mid-sync. The DuckDB sync keeps its own cursor (the
receipts table in the database); the folder keeps archives and a manifest on disk.

```text
events/
  source.json
  .slurp.lock
  archives/<archive-id>/events/<sequence>-<sha256>.jsonl.zst
```

The version-1 manifest records backend/source binding, active and previous
archives, immutable bootstrap positions and contiguous verified object entries.
Object keys are source-relative archive identities; paths are folder-relative.
There is no independent download cursor. Credentials and signed URLs are never
saved in the manifest. Renamed but uncommitted files are verified and reused
after an interruption; partial downloads cannot advance progress.

Sync checks size and modification time and rehashes changed files. The recorded
modification time is a validation cache, not progress. `validate_inventory(true)`
performs a full SHA256 check; reading verifies hashes as well. Missing or changed
bytes, conflicting identities and unsafe/symlink paths fail explicitly. Archive
resets require acceptance, retain previous objects and occupy separate folders.
Reading after an object sequence requires an explicitly selected archive.

The manifest owns download progress. It does not claim anything about lake
imports; the lake delivery ledger remains the authority for those commits.

`storage` defaults to the private `SLURP_HOME/credentials.json` map (`0600`,
parent directory `0700`). Keys retain the backend/source scopes used by the native
store. Writes are locked and atomically replaced. Reads never fall back to Keychain.
The machine setting `credential_store = "keychain"` explicitly selects native
storage. `storage::migrate_keychain` performs an explicit, copy-only import for one
backend and its cached source SDK keys, preserving existing file values.
