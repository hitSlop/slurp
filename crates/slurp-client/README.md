# Slurp service client

This crate has no dependency on the library, daemon, DuckDB or DuckLake.
`rpc` is generated from `backend/api/slurp.ridl`. `http_client()` provides the
shared TLS roots, timeouts and redirect policy.

`connection` is the saved Worker connection: one bearer token per backend URL (`save`, `load`, `forget`, and
`resolve`, which prefers `SLURP_TOKEN` or `SLURP_READ_KEY` from the environment over the saved one, failing with
`NotConnected` if there is neither). A self-hosted Worker has no logins, sessions or refresh, so the token is saved as
itself through `storage`. `rpc::AuthClient::whoami` says what a token is (`admin`, `secret` or `publishable`, and its
project and key name). See `docs/connection.md`.

`remote::HttpRemote` lists and downloads a project's archives; `download_verified` checks size and SHA-256 against the listing and asks
for a fresh signed link when one expires mid-download. The CLI's DuckDB sync (`Workspace::sync`) and `reader::read_published`
(`slurp read`) both use it. The DuckDB sync's cursor is the receipts table in the database; nothing is kept on disk between runs.

`storage` defaults to the private `SLURP_HOME/credentials.json` map (`0600`,
parent directory `0700`). Account names are scoped by backend, as in the native
store. Writes are locked and atomically replaced. Reads never fall back to Keychain.
The machine setting `credential_store = "keychain"` explicitly selects native
storage.
