# Releasing

How maintainers cut a release of Slurp: the CLI and its embedded Worker, the JavaScript and React Native SDKs, and the hosted pieces. Releases are made from `master`.

The rules for how stored data and versions may change are in [contracts.md, "Versions and upgrades"](contracts.md#versions-and-upgrades). A release must follow them, and the checklist below checks that it does.

## What ships, and from where

| What | Version lives in | Published by |
|---|---|---|
| The CLI: `@hitslop/slurp` on npm, the shell installer (`curl -LsSf https://slurp.run/install \| sh`), and the GitHub Release archives for four targets | `version` in `[workspace.package]`, `Cargo.toml` | Pushing a `vX.Y.Z` tag. `.github/workflows/release.yml` (cargo-dist 0.34.0, configured in `dist-workspace.toml`) builds, creates the Release and publishes to npm |
| The Worker | `RELEASE` in `backend/src/version.ts`, always equal to the CLI's version. `/v1/health` reports it as `release` | Embedded in the CLI (`crates/slurp-cli/assets/worker/`, regenerated with `node backend/scripts/bundle.mjs`). Users deploy it with `slurp cloud init` and `slurp cloud upgrade`. The Deploy to Cloudflare button builds `backend/` from `master` |
| `@hitslop/slurp-sdk` | `sdks/js/package.json` and `version` in `sdks/js/src/event.ts` | The manual workflow `.github/workflows/publish-sdk.yml` with `package=js` |
| `@hitslop/slurp-react-native` | `sdks/react-native/package.json` and `version` in `sdks/react-native/src/native.ts` | The same workflow with `package=react-native`, always after `js` |
| slurp.run (the website) | none | `.github/workflows/deploy-site.yml`, by itself, on every push to `master` that touches `apps/site`, `docs`, `examples` or `packages/web-shared` |
| The maintainers' Worker (`events.slurp.run`) | the CLI that deployed it | A maintainer runs `slurp cloud upgrade` after a CLI release (step 5) |

`https://slurp.run/install` redirects to the installer of the **latest** GitHub Release (`apps/site/public/_redirects`). A prerelease never becomes "latest".

## Choosing the version

- **The CLI and the Worker share one version.**
  - Before 1.0, a breaking change bumps the minor (0.2.0 to 0.3.0) and anything else bumps the patch.
  - "Breaking" means something a user must act on: a removed command or flag, a changed output field, or a contract change with no upgrade path.
  - A data migration that runs by itself is **not** breaking.
- **The SDKs version on their own** and are bumped only when their code changes. The React Native package depends on the JavaScript SDK as `workspace:^`, which pnpm publishes as `^<js version>`. Bump React Native whenever its required JavaScript SDK version changes.
- **The contract numbers are separate from all of these:** `apiVersion`, the Durable Object and DuckDB schema versions, the archive `format` and the SDK storage namespace. Schema versions advance with every migration; the other format versions change for incompatible changes (see [contracts.md](contracts.md#versions-and-upgrades)).

## 1. Prepare the release PR

On a branch named `release-X.Y.Z`:

1. **Check what changed in stored data.** For every store that this release changes (Durable Object tables, the local DuckDB tables, archive envelopes, config files, SDK saved state), confirm:
   - database changes append a migration step without editing shipped steps; other format changes have a compatible reader or explicit format refusal;
   - a test loads data at the previous version and checks it survives the step;
   - new Worker-to-object calls use staged adoption or a tested fallback, because objects can briefly run old code during deployment;
   - `docs/contracts.md` describes the new version.
2. **Changelog.** In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z`. cargo-dist uses this section as the GitHub Release notes. If users must do anything, open the section with an **Upgrade** paragraph saying what, such as "run `slurp cloud upgrade`".
3. **Bump the versions:**
   - `Cargo.toml` `[workspace.package] version`, then `cargo check` to update `Cargo.lock`;
   - `backend/src/version.ts` `RELEASE` (a test fails if it differs from `Cargo.toml`);
   - when the SDKs changed, `sdks/js/package.json` with `sdks/js/src/event.ts`, and `sdks/react-native/package.json` with `sdks/react-native/src/native.ts`;
   - version strings in examples, such as `sdks/js/README.md`: `git grep -n "<old version>"` finds them.
4. **Regenerate what is embedded.** The Worker's code changed (at least `RELEASE`), so run `node backend/scripts/bundle.mjs` and commit `crates/slurp-cli/assets/worker/`. CI fails if the bundle is stale.
5. **Run the checks locally.** CI runs them too:

   ```sh
   (cd backend && npm ci && npm run typecheck && npm test)
   node backend/scripts/bundle.mjs --check
   SLURP_TEST_DUCKDB=$HOME/.slurp/bin/duckdb SLURP_DUCKDB=$HOME/.slurp/bin/duckdb cargo test --workspace
   cargo clippy --workspace --all-targets --all-features -- -D warnings && cargo fmt --all --check
   (cd sdks/js && node --test --test-force-exit test/*.test.ts)
   pnpm --filter @hitslop/slurp-react-native typecheck && pnpm --filter @hitslop/slurp-react-native test
   (cd sdks/js && npm pack --dry-run) && (cd sdks/react-native && npm pack --dry-run)   # check the file lists
   ```

6. Open the PR titled "Release X.Y.Z". On a pull request, `release.yml` runs `dist plan`, which catches a broken cargo-dist configuration before the tag. Merge once CI is green.

## 2. Optional: a release candidate

Use this for a release with a migration, a new Worker feature, or anything you want to try on a real Cloudflare account before npm has it:

1. Prepare and merge an RC PR. Set Cargo.toml and the Worker RELEASE to `X.Y.Z-rc.1`, update Cargo.lock, regenerate the bundle, and run verification. SDKs keep their independent versions.
2. Tag that commit:

   ```sh
   git tag -a vX.Y.Z-rc.1 -m vX.Y.Z-rc.1
   git push origin vX.Y.Z-rc.1
   ```

3. cargo-dist creates a GitHub prerelease without publishing to npm or changing `slurp.run/install`. Install the candidate from its Release page.
4. Upgrade a scratch Worker and sync a copy of a real database.
5. Prepare the stable release PR with Cargo and Worker versions `X.Y.Z`, and regenerate the bundle again.

## 3. Tag the release

```sh
git checkout master && git pull --ff-only
git tag -a vX.Y.Z -m vX.Y.Z
git push origin vX.Y.Z
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

`release.yml` runs these jobs:
- **`plan`**;
- **`build-local-artifacts`:** `aarch64` and `x86_64`, for `apple-darwin` and `unknown-linux-gnu`;
- **`build-global-artifacts`:** the installer, checksums and the npm package;
- **`host`:** creates the GitHub Release;
- **`publish-npm`:** `@hitslop/slurp`, using the `NPM_TOKEN` secret;
- **`announce`**.

Never move or re-push a tag. If something fails after `publish-npm`, release a new patch (see "When a release is broken").

## 4. Publish the SDKs (only if they changed)

```sh
gh workflow run publish-sdk.yml --ref master -f package=js
# when that run is green:
gh workflow run publish-sdk.yml --ref master -f package=react-native
```

The workflow typechecks, builds and tests the SDK first. It refuses to publish a version that is already on npm, and it refuses React Native until the JavaScript SDK version it needs is on npm.

## 5. Verify, and upgrade our own Worker

1. **npm:**

   ```sh
   npm view @hitslop/slurp version
   npm view @hitslop/slurp-sdk version
   npm view @hitslop/slurp-react-native version
   ```

2. **A clean install from npm** (run in an empty folder): `npx @hitslop/slurp@X.Y.Z --version`.
3. **The shell installer**, into a scratch folder without touching your shell profile:

   ```sh
   dir=$(mktemp -d)
   curl -LsSf https://slurp.run/install | SLURP_CLI_INSTALL_DIR=$dir SLURP_CLI_NO_MODIFY_PATH=1 sh
   "$dir"/bin/slurp --version
   ```
4. **Upgrade the maintainers' Worker** with the released CLI:
   - `slurp cloud upgrade --worker <name>`. It refuses a downgrade, waits for the new build and checks storage.
   - Then check that `curl -s https://events.slurp.run/v1/health` shows the new `release`.
5. **Sync:** run `slurp sync --now` in `apps/site`. It succeeds, and any local database migration announces itself once.
6. **The site:** if the JavaScript SDK changed, bump `@hitslop/slurp-sdk` in `apps/site/package.json` and run `pnpm install`. Merging that deploys the site.

## When a release is broken

- **npm versions are permanent:** a version can't be republished. Fix forward with a patch release, and mark the bad one:

  ```sh
  npm deprecate @hitslop/slurp@X.Y.Z "broken; use X.Y.Z+1"
  ```

  Clear the mark later with `npm deprecate @hitslop/slurp@X.Y.Z ""`.
- **The GitHub Release** can be edited, or marked as a prerelease to take it off `slurp.run/install`. Leave the tag in place.
- **Migrations are forward-only.** If a step succeeded but the code after it is broken, ship a corrective release; there are no down migrations.
  - **Locally:** the CLI kept a backup next to the database (`<database>.schema<N>-<random>.bak/<database filename>`), which restores by stopping all DuckDB processes and copying the enclosed database file back. Failed attempts are removed only when the binding verifies and the schema is unchanged. Otherwise their files stay for inspection and may be incomplete.
  - **On the Worker:** `slurp cloud upgrade` won't install an older bundle. Use application rollback only if the release ran no schema migrations and wrote no incompatible persistent formats: `npx wrangler rollback` in a folder with the Worker's config, or Deployments in the dashboard. If it did migrate, older code refuses newer data with a 503, by design, so fix forward.
- **The Deploy to Cloudflare button** builds `master`. A bad commit there reaches new button deploys until it is fixed, so keep `master` releasable.

## First supported baseline

0.2.0 is the first supported release. Existing files require explicit format versions; unversioned files and flat credential maps require fresh setup. No legacy conversion or missing-version fallback is supported. At publication, capture these baseline fixtures from the published artifacts: DuckDB data (events, receipts, problems, and a user table), ProjectDO and RegistryDO SQL, two archives, and SDK saved state. Store them under `fixtures/releases/0.2.0/`. Every future migration must test these fixtures.
