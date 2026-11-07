# How the connection works

Slurp has no accounts, logins or sessions. Your Worker knows three kinds of secret, and the CLI saves at most one token per Worker.

| Credential | Looks like | What it can do | Where it lives |
| --- | --- | --- | --- |
| **Admin token** | whatever you chose (or `slurp cloud init` generated) | Everything: create projects and keys, read every archive. | The Worker's `ADMIN_TOKEN` secret. On your computer: saved by `slurp connect` (or `slurp cloud init`). |
| **Secret key** | `slurp_sk_…` | Read **one project's** archives. Made for bots. | A bot's secret store, as `SLURP_TOKEN`. |
| **Publishable key** | `slurp_pk_…` | Only **send** events for one project. Safe in a web page or an app. | Your app's code. Make one per sender (`ios`, `web`, `github`): its name is stamped on every event it sends. The Worker keeps it, and `slurp project setup` shows it again. |

## The saved connection

`slurp connect https://your-worker.workers.dev --token-stdin < admin-token.txt` does three things: checks that the URL is a Slurp Worker (`/v1/health`) with an admin token configured, asks the Worker what your token is (`Auth.Whoami`), and refuses anything that is not the admin token. Then it saves the token and makes that Worker this computer's default. `slurp cloud init` does the same after it deploys.

What is saved is **just the token string**, under the Worker's URL. There is no expiry, refresh or session to maintain, so nothing can go stale: a token either works or the Worker refuses it. By default it is a plain file, `~/.slurp/credentials.json` (or `$SLURP_HOME/credentials.json`), readable only by you (`0600`, in a `0700` folder) and never inside a project or event folder. To use the operating system keychain instead, set `credential_store = "keychain"` in `~/.slurp/config.toml`; the two stores are independent and neither falls back to the other.

## Which token a command uses

For a given Worker, in this order:

1. `SLURP_TOKEN` in the environment
2. `SLURP_READ_KEY` in the environment
3. the token `slurp connect` saved

If there is none of these, a command stops with `not connected to a Worker; run slurp connect <worker-url> --token-stdin (or set SLURP_TOKEN)`. Which Worker is chosen comes from `--backend`, then `SLURP_BACKEND`, then the project, then the default `slurp connect` set. Because the environment wins, a bot never needs a saved connection: set `SLURP_TOKEN` to its secret key and it works.

## Checking what a token is

```sh
slurp whoami
# {"backend":"https://slurp.you.workers.dev","scope":"admin","project":null,"name":null}
SLURP_TOKEN=slurp_sk_… slurp whoami
# {"backend":"…","scope":"secret","project":"prj_…","name":"bot"}
```

`scope` is `admin`, `secret` or `publishable`, and `project` and `name` say which project a key belongs to and what it is called. Any valid key can ask, so a bot can verify its own key; an unknown, revoked or missing key is refused. `slurp connect` needs `admin` and says so if you give it a key (`that is a secret key; slurp connect needs the Worker's admin token`).

## Logging out, revoking and rotating

- `slurp logout` forgets the saved token for the current Worker. It does not change anything on the Worker, because a token is not a session: to stop a key working, revoke it.
- **Revoke a key:** `slurp project key revoke PROJECT KEY_ID`. A revoked key stops working on the very next request.
- **Rotate the admin token:** `wrangler secret put ADMIN_TOKEN`, then `slurp connect` again with the new value. Signed download links derived from it stop working (they last an hour anyway).
- **Publishable keys** saved for `slurp send` stay until you revoke or replace them; `slurp logout` does not remove them.
