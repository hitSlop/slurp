//! `slurp cloud`: deploy and operate your own Slurp Worker in your Cloudflare account using `wrangler`.
//!
//! The Worker is embedded in this binary (`assets/worker`, produced by `backend/scripts/bundle.mjs`), so deploying it needs
//! no checkout and no `npm install`; only `wrangler` (or Node, to fetch a pinned copy with `npx`) and a Cloudflare login.
use crate::terminal::Terminal;
use anyhow::{Context, Result, anyhow, bail, ensure};
use clap::{Args, Subcommand};
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command as Process, Stdio},
    time::{Duration, Instant},
};

static WORKER: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/assets/worker");
/// Version of wrangler fetched with `npx` when none is installed.
const PINNED_WRANGLER: &str = "4.158.0";
/// Oldest installed wrangler we trust (it must support `whoami --json`).
const MIN_WRANGLER: (u32, u32) = (4, 100);

#[derive(Subcommand)]
pub enum Command {
    /// Deploy a Worker and R2 bucket to your Cloudflare account and connect this computer to it.
    Init(InitArgs),
    /// Show your deployment: reachability, version and projects.
    Status(WorkerArg),
    /// Check wrangler, your Cloudflare login, the Worker and your saved connection, with a fix for each problem.
    Doctor(WorkerArg),
    /// Redeploy the Worker bundled with this CLI. Your data, secrets and settings are kept.
    Upgrade(UpgradeArgs),
    /// Delete the Worker, its data and its bucket. This cannot be undone.
    Destroy(DestroyArgs),
}

#[derive(Args, Clone)]
pub struct InitArgs {
    /// Worker name (also the first part of its workers.dev address).
    #[arg(long, default_value = "slurp")]
    pub worker: String,
    /// R2 bucket for event archives.
    #[arg(long, default_value = "slurp-archive")]
    pub bucket: String,
    /// Custom domain in a zone owned by this Cloudflare account.
    #[arg(long)]
    pub domain: Option<String>,
    /// Cloudflare account ID; needed only when you have several.
    #[arg(long, env = "CLOUDFLARE_ACCOUNT_ID")]
    pub account: Option<String>,
    /// Seconds between archive seals (default 600).
    #[arg(long)]
    pub seal_interval: Option<u64>,
    /// Delete archives older than this many days (default: keep everything).
    #[arg(long)]
    pub retention_days: Option<f64>,
    /// Print browser destinations instead of opening them.
    #[arg(long)]
    pub no_open: bool,
    /// Do not ask questions; use the defaults and flags.
    #[arg(long, short = 'y')]
    pub yes: bool,
}
impl Default for InitArgs {
    fn default() -> Self {
        Self {
            worker: "slurp".into(),
            bucket: "slurp-archive".into(),
            domain: None,
            account: None,
            seal_interval: None,
            retention_days: None,
            no_open: false,
            yes: false,
        }
    }
}

#[derive(Args, Clone)]
pub struct WorkerArg {
    /// Which deployment, when you have more than one (the Worker name).
    #[arg(long)]
    pub worker: Option<String>,
}
#[derive(Args, Clone)]
pub struct UpgradeArgs {
    #[command(flatten)]
    pub target: WorkerArg,
    /// Allow deployment when health is unavailable; known newer or incompatible deployments remain refused.
    #[arg(long)]
    pub force: bool,
}
#[derive(Args, Clone)]
pub struct DestroyArgs {
    #[command(flatten)]
    pub target: WorkerArg,
    /// Skip the confirmation prompt.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

/// What `cloud init` produces: a connected deployment.
pub struct Deployed {
    pub backend: String,
    pub token: String,
}

// ---------------------------------------------------------------------------------------------------------------------
// wrangler

/// How we run wrangler. Tests point `SLURP_WRANGLER` at a fake script.
#[derive(Clone, Debug)]
pub struct Wrangler {
    program: OsString,
    prefix: Vec<String>,
    pub label: String,
}

pub struct Output {
    pub ok: bool,
    pub text: String,
}

impl Wrangler {
    pub fn discover() -> Result<Self> {
        if let Some(path) = std::env::var_os("SLURP_WRANGLER").filter(|v| !v.is_empty()) {
            return Ok(Self {
                label: path.to_string_lossy().into_owned(),
                program: path,
                prefix: vec![],
            });
        }
        if let Ok(out) = Process::new("wrangler").arg("--version").output()
            && out.status.success()
            && version_at_least(&String::from_utf8_lossy(&out.stdout), MIN_WRANGLER)
        {
            return Ok(Self {
                program: "wrangler".into(),
                prefix: vec![],
                label: "wrangler".into(),
            });
        }
        if Process::new("npx")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            return Ok(Self {
                program: "npx".into(),
                prefix: vec!["--yes".into(), format!("wrangler@{PINNED_WRANGLER}")],
                label: format!("npx wrangler@{PINNED_WRANGLER}"),
            });
        }
        bail!(
            "wrangler (Cloudflare's CLI) is needed. Install Node.js 20+ from https://nodejs.org, then run this again; slurp fetches wrangler itself with npx."
        )
    }

    fn command(&self, args: &[&str], cwd: &Path, account: Option<&str>) -> Process {
        let mut cmd = Process::new(&self.program);
        cmd.args(&self.prefix).args(args).current_dir(cwd);
        cmd.env("WRANGLER_SEND_METRICS", "false")
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0");
        if let Some(account) = account {
            cmd.env("CLOUDFLARE_ACCOUNT_ID", account);
        }
        cmd
    }

    /// Run wrangler and capture everything it prints.
    pub fn run(
        &self,
        args: &[&str],
        cwd: &Path,
        account: Option<&str>,
        stdin: Option<&str>,
    ) -> Result<Output> {
        let mut cmd = self.command(args, cwd, account);
        cmd.stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .with_context(|| format!("could not start {}", self.label))?;
        if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
            use std::io::Write;
            pipe.write_all(input.as_bytes())?;
        }
        let out = child.wait_with_output()?;
        Ok(Output {
            ok: out.status.success(),
            text: format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
        })
    }

    /// Run wrangler attached to the terminal (for `wrangler login`).
    pub fn run_attached(&self, args: &[&str], cwd: &Path) -> Result<bool> {
        Ok(self
            .command(args, cwd, None)
            .status()
            .with_context(|| format!("could not start {}", self.label))?
            .success())
    }
}

fn version_at_least(text: &str, min: (u32, u32)) -> bool {
    let Some(token) = text.split_whitespace().find(|t| {
        t.split('.').count() >= 2 && t.chars().next().is_some_and(|c| c.is_ascii_digit())
    }) else {
        return false;
    };
    let mut parts = token.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    (major, minor) >= min
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub name: String,
}
pub struct Whoami {
    pub logged_in: bool,
    pub accounts: Vec<Account>,
}

/// Parse `wrangler whoami --json` (wrangler may print banner lines before the JSON).
pub fn parse_whoami(text: &str) -> Result<Whoami> {
    let start = text
        .find('{')
        .ok_or_else(|| anyhow!("wrangler whoami printed no JSON: {}", text.trim()))?;
    let value: Value = serde_json::from_str(&text[start..]).or_else(|_| {
        let mut de = serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>();
        de.next().context("empty")?.map_err(anyhow::Error::from)
    })?;
    let accounts = value["accounts"]
        .as_array()
        .map(|accounts| {
            accounts
                .iter()
                .filter_map(|a| {
                    Some(Account {
                        id: a["id"].as_str()?.to_owned(),
                        name: a["name"].as_str().unwrap_or("account").to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Whoami {
        logged_in: value["loggedIn"].as_bool().unwrap_or(false),
        accounts,
    })
}

/// The Worker URL printed by `wrangler deploy`: a workers.dev address (or a loopback address, for local testing).
pub fn parse_worker_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| {
                !(c.is_ascii_alphanumeric() || matches!(c, '/' | ':' | '.' | '-'))
            })
        })
        .find(|w| {
            (w.starts_with("https://") && w.ends_with(".workers.dev"))
                || w.starts_with("http://127.0.0.1:")
                || w.starts_with("http://localhost:")
        })
        .map(str::to_owned)
}

/// Bucket names from `wrangler r2 bucket list` (`name:  foo` lines).
pub fn parse_buckets(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.trim().strip_prefix("name:"))
        .map(|n| n.trim().to_owned())
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// receipts

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Receipt {
    pub version: u32,
    #[serde(default)]
    pub domain: Option<String>,
    pub worker: String,
    pub bucket: String,
    pub account_id: Option<String>,
    pub url: String,
    pub build: String,
    pub deployed_at: String,
    pub vars: serde_json::Map<String, Value>,
}

impl Receipt {
    /// A Worker with a custom domain is served at that domain, which is the address `init` records. Deploying a route makes wrangler
    /// turn the workers.dev address off, so a receipt that still names workers.dev would fail every readiness check after an upgrade.
    fn settle_url(&mut self) {
        if let Some(host) = &self.domain {
            self.url = format!("https://{host}");
        }
    }
}

fn receipts_dir() -> Result<PathBuf> {
    Ok(slurp_client::config::home()?.join("cloud"))
}
fn save_receipt(receipt: &Receipt) -> Result<()> {
    let path = receipts_dir()?.join(format!("{}.json", receipt.worker));
    slurp_client::files::write_atomic(&path, &serde_json::to_vec_pretty(receipt)?)
}
fn load_receipts() -> Result<Vec<Receipt>> {
    let dir = receipts_dir()?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error).with_context(|| format!("reading {}", dir.display())),
    };
    // A receipt that cannot be read is an error that names the file, not a deployment that quietly does not exist.
    let mut receipts: Vec<Receipt> = vec![];
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let bytes = std::fs::read(&path).with_context(|| {
            format!(
                "{} is not a valid deployment receipt; fix it or start fresh",
                path.display()
            )
        })?;
        let header: Value = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "{} is not a valid deployment receipt; fix it or start fresh",
                path.display()
            )
        })?;
        slurp_client::config::check_version(
            &path,
            header["version"].as_u64(),
            1,
            "slurp cloud init --worker NEW (or restore a valid receipt for the existing Worker)",
        )?;
        let mut receipt: Receipt = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "{} is not a valid deployment receipt; fix or delete it",
                path.display()
            )
        })?;
        receipt.settle_url();
        receipts.push(receipt);
    }
    receipts.sort_by(|a, b| a.worker.cmp(&b.worker));
    Ok(receipts)
}
fn pick_receipt(worker: Option<&str>) -> Result<Receipt> {
    let receipts = load_receipts()?;
    match (worker, receipts.len()) {
        (Some(name), _) => receipts
            .into_iter()
            .find(|r| r.worker == name)
            .ok_or_else(|| {
                anyhow!(
                    "no deployment named {name} was made from this computer; run slurp cloud init"
                )
            }),
        (None, 0) => bail!("no deployment found on this computer; run slurp cloud init"),
        (None, 1) => Ok(receipts.into_iter().next().expect("one receipt")),
        (None, _) => bail!(
            "several deployments found ({}); choose one with --worker",
            receipts
                .iter()
                .map(|r| r.worker.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// bundle

pub struct Bundle {
    pub code: &'static [u8],
    pub build: String,
    pub compatibility_date: String,
    /// The Durable Object bindings and migrations, the R2 binding name and observability, all copied from backend/wrangler.jsonc.
    pub durable_objects: Value,
    pub migrations: Value,
    pub r2_binding: String,
    pub observability: Value,
    pub vars: serde_json::Map<String, Value>,
}
pub fn bundle() -> Result<Bundle> {
    let code = WORKER
        .get_file("index.js")
        .context("the Worker bundle is missing from this build")?
        .contents();
    let meta: Value = serde_json::from_slice(
        WORKER
            .get_file("build.json")
            .context("the Worker build info is missing from this build")?
            .contents(),
    )?;
    let text = |key: &str| {
        meta[key]
            .as_str()
            .map(str::to_owned)
            .with_context(|| format!("the Worker build info has no {key}; rebuild the CLI"))
    };
    let value = |key: &str| {
        meta.get(key)
            .cloned()
            .with_context(|| format!("the Worker build info has no {key}; rebuild the CLI"))
    };
    Ok(Bundle {
        code,
        build: text("build")?,
        compatibility_date: text("compatibility_date")?,
        durable_objects: value("durable_objects")?,
        migrations: value("migrations")?,
        r2_binding: text("r2_binding")?,
        observability: value("observability")?,
        vars: meta["vars"]
            .as_object()
            .cloned()
            .context("the Worker build info has no vars; rebuild the CLI")?,
    })
}

/// A random admin token: 256 bits from two version-4 UUIDs (CSPRNG-backed), hex encoded.
pub fn new_admin_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn wrangler_config(
    bundle: &Bundle,
    worker: &str,
    bucket: &str,
    vars: &serde_json::Map<String, Value>,
    domain: Option<&str>,
) -> Value {
    let mut config = json!({
        "name": worker,
        "main": "index.js",
        "compatibility_date": bundle.compatibility_date,
        "durable_objects": bundle.durable_objects,
        "migrations": bundle.migrations,
        "r2_buckets": [{"binding": bundle.r2_binding, "bucket_name": bucket}],
        "vars": vars,
        "observability": bundle.observability,
    });
    if let Some(host) = domain {
        config["routes"] = json!([{ "pattern": host, "custom_domain": true }]);
    }
    config
}

/// Write the bundle and its generated config to a private temporary directory.
fn stage(
    bundle: &Bundle,
    worker: &str,
    bucket: &str,
    vars: &serde_json::Map<String, Value>,
    domain: Option<&str>,
) -> Result<tempfile::TempDir> {
    let dir = tempfile::Builder::new().prefix("slurp-worker-").tempdir()?;
    std::fs::write(dir.path().join("index.js"), bundle.code)?;
    std::fs::write(
        dir.path().join("wrangler.jsonc"),
        serde_json::to_vec_pretty(&wrangler_config(bundle, worker, bucket, vars, domain))?,
    )?;
    Ok(dir)
}

fn deploy_vars(bundle: &Bundle, args: &InitArgs) -> serde_json::Map<String, Value> {
    let mut vars = bundle.vars.clone();
    if let Some(seconds) = args.seal_interval {
        vars.insert(
            "SEAL_INTERVAL_MS".into(),
            json!((seconds * 1000).to_string()),
        );
    }
    if let Some(days) = args.retention_days {
        vars.insert("RETENTION_DAYS".into(), json!(days.to_string()));
    }
    vars.insert("SLURP_BUILD".into(), json!(bundle.build));
    vars
}

// ---------------------------------------------------------------------------------------------------------------------
// output

struct Progress {
    machine: bool,
}
impl Progress {
    fn step(&self, message: &str) {
        if !self.machine {
            eprintln!("  • {message}");
        }
    }
}

fn dashboard(account: Option<&str>, path: &str) -> String {
    match account {
        Some(account) => format!("https://dash.cloudflare.com/{account}/{path}"),
        None => "https://dash.cloudflare.com".into(),
    }
}

/// Turn a failed wrangler step into an error that says what happened and what to do next.
fn explain(step: &str, output: &str, account: Option<&str>) -> anyhow::Error {
    let lower = output.to_ascii_lowercase();
    let hint = if lower.contains("workers.dev subdomain")
        || lower.contains("register a workers.dev")
    {
        format!(
            "Your account needs a workers.dev subdomain. Create one at {} and run this again.",
            dashboard(account, "workers/onboarding")
        )
    } else if step.contains("bucket")
        && (lower.contains("r2")
            && (lower.contains("enable")
                || lower.contains("subscribe")
                || lower.contains("10042")
                || lower.contains("purchase")
                || lower.contains("payment")))
    {
        format!(
            "R2 is not enabled on this Cloudflare account yet. Enable it at {} (it needs a payment method on file; the free allowance covers small apps), then run this again.",
            dashboard(account, "r2/overview")
        )
    } else if lower.contains("authentication")
        || lower.contains("not logged in")
        || lower.contains("10000")
    {
        "Wrangler is not logged in or the login expired. Run `wrangler login` and try again.".into()
    } else {
        String::new()
    };
    let detail = output.trim();
    anyhow!(
        "{step} failed.{}{}",
        if hint.is_empty() {
            String::new()
        } else {
            format!(" {hint}")
        },
        if detail.is_empty() {
            String::new()
        } else {
            format!("\n\nwrangler said:\n{detail}")
        }
    )
}

// ---------------------------------------------------------------------------------------------------------------------
// commands

pub async fn run(command: &Command, machine: bool) -> Result<u8> {
    let ui = Terminal::new(machine);
    match command {
        Command::Init(args) => {
            let deployed = init(args, &ui, machine).await?;
            crate::service::emit(
                &json!({"backend": deployed.backend, "connected": true, "next": ["slurp setup", "slurp init --name <your app>"]}),
            )?;
            Ok(0)
        }
        Command::Status(target) => status(target, machine).await,
        Command::Doctor(target) => doctor(target, machine).await,
        Command::Upgrade(args) => upgrade(args, machine).await,
        Command::Destroy(args) => destroy(args, &ui, machine).await,
    }
}

/// `cloud init` as part of `slurp setup`: ask the questions in the terminal.
pub async fn init_interactive(ui: &Terminal, no_open: bool) -> Result<Deployed> {
    init(
        &InitArgs {
            no_open,
            ..InitArgs::default()
        },
        ui,
        false,
    )
    .await
}

fn choose_account(accounts: &[Account], args: &InitArgs, ui: &Terminal) -> Result<Option<String>> {
    if let Some(wanted) = &args.account {
        ensure!(
            accounts.iter().any(|a| &a.id == wanted),
            "that Cloudflare account ID is not available to this login"
        );
        return Ok(Some(wanted.clone()));
    }
    match accounts {
        [] => bail!("this Cloudflare login has no accounts"),
        [one] => Ok(Some(one.id.clone())),
        many => {
            ensure!(
                ui.interactive && !args.yes,
                "several Cloudflare accounts are available ({}); choose one with --account",
                many.iter()
                    .map(|a| format!("{} ({})", a.name, a.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let items: Vec<(String, String, String)> = many
                .iter()
                .map(|a| (a.id.clone(), a.name.clone(), a.id.clone()))
                .collect();
            Ok(Some(ui.select(
                "Which Cloudflare account should hold your Slurp Worker?",
                &items,
                &many[0].id,
            )?))
        }
    }
}

pub async fn init(args: &InitArgs, ui: &Terminal, machine: bool) -> Result<Deployed> {
    if let Some(host) = &args.domain {
        let url = slurp_client::reqwest::Url::parse(&format!("https://{host}"))?;
        ensure!(
            host.contains('.')
                && host.len() <= 253
                && host.parse::<std::net::IpAddr>().is_err()
                && host.split('.').all(|label| !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-'))
                && url.host_str().is_some_and(|h| h.eq_ignore_ascii_case(host))
                && url.port().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty(),
            "--domain must be a hostname such as events.example.com"
        );
    }
    let progress = Progress { machine };
    let wrangler = Wrangler::discover()?;
    let bundle = bundle()?;
    let home = slurp_client::config::home()?;
    slurp_client::config::settings_at(&home)?;
    load_receipts()?;
    slurp_client::storage::validate()?;
    let temp = tempfile::tempdir()?;
    let cwd = temp.path();

    progress.step(&format!("Using {}", wrangler.label));
    let mut who = parse_whoami(&wrangler.run(&["whoami", "--json"], cwd, None, None)?.text)
        .unwrap_or(Whoami {
            logged_in: false,
            accounts: vec![],
        });
    if !who.logged_in {
        ensure!(
            ui.interactive,
            "wrangler is not logged in to Cloudflare; run `wrangler login`, then run this again"
        );
        ui.note(
            "Log in to Cloudflare",
            "Wrangler will open your browser so you can approve access to your Cloudflare account.",
        )?;
        let login: &[&str] = if args.no_open {
            &["login", "--browser=false"]
        } else {
            &["login"]
        };
        ensure!(
            wrangler.run_attached(login, cwd)?,
            "Cloudflare login did not complete"
        );
        who = parse_whoami(&wrangler.run(&["whoami", "--json"], cwd, None, None)?.text)?;
        ensure!(who.logged_in, "Cloudflare login did not complete");
    }
    let account = choose_account(&who.accounts, args, ui)?;
    let account = account.as_deref();
    if let Some(account) = account
        && let Some(name) = who.accounts.iter().find(|a| a.id == account)
    {
        progress.step(&format!("Cloudflare account: {}", name.name));
    }

    let worker_exists = wrangler
        .run(
            &["deployments", "list", "--name", &args.worker],
            cwd,
            account,
            None,
        )?
        .ok;
    ensure!(
        !worker_exists,
        "a Worker named {} already exists in this account. Choose another name with --worker, or use `slurp cloud upgrade` if it is yours.",
        args.worker
    );
    let buckets = parse_buckets(
        &wrangler
            .run(&["r2", "bucket", "list"], cwd, account, None)?
            .text,
    );
    let vars = deploy_vars(&bundle, args);
    let staged = stage(
        &bundle,
        &args.worker,
        &args.bucket,
        &vars,
        args.domain.as_deref(),
    )?;
    if buckets.contains(&args.bucket) {
        ensure!(
            args.yes
                || !ui.interactive
                || ui.confirm(
                    &format!("An R2 bucket named {} already exists. Use it?", args.bucket),
                    false
                )?,
            "choose another bucket name with --bucket"
        );
        ensure!(
            args.yes || ui.interactive,
            "an R2 bucket named {} already exists; choose another name with --bucket, or pass --yes to use it",
            args.bucket
        );
        progress.step(&format!("Reusing R2 bucket {}", args.bucket));
    } else {
        progress.step(&format!("Creating R2 bucket {}", args.bucket));
        let created = wrangler.run(
            &["r2", "bucket", "create", &args.bucket],
            cwd,
            account,
            None,
        )?;
        ensure!(
            created.ok,
            explain("creating the R2 bucket", &created.text, account)
        );
    }

    progress.step("Deploying the Worker");
    let deployed = wrangler.run(
        &["deploy", "--config", "wrangler.jsonc"],
        staged.path(),
        account,
        None,
    )?;
    ensure!(
        deployed.ok,
        explain("deploying the Worker", &deployed.text, account)
    );
    let workers_url = parse_worker_url(&deployed.text).ok_or_else(|| {
        anyhow!(
            "the Worker deployed, but wrangler did not print its URL:\n{}",
            deployed.text.trim()
        )
    })?;

    let url = args
        .domain
        .as_ref()
        .map(|host| format!("https://{host}"))
        .unwrap_or(workers_url);
    progress.step("Setting the admin token");
    let token = new_admin_token();
    let secret = wrangler.run(
        &["secret", "put", "ADMIN_TOKEN", "--config", "wrangler.jsonc"],
        staged.path(),
        account,
        Some(&token),
    )?;
    ensure!(
        secret.ok,
        explain("setting the ADMIN_TOKEN secret", &secret.text, account)
    );

    save_receipt(&Receipt {
        version: 1,
        domain: args.domain.clone(),
        worker: args.worker.clone(),
        bucket: args.bucket.clone(),
        account_id: account.map(str::to_owned),
        url: url.clone(),
        build: bundle.build.clone(),
        deployed_at: chrono::Utc::now().to_rfc3339(),
        vars,
    })?;
    slurp_client::connection::save(&url, &token)?;
    progress.step("Waiting for the Worker to come up");
    if let Err(error) = wait_until_configured(&url, &bundle.build, &token).await {
        bail!(
            "{error:#}. The Worker is deployed and its admin token is saved. Check slurp cloud status --worker {} and retry slurp cloud upgrade --worker {}",
            args.worker,
            args.worker
        );
    }
    let connected = crate::connect::verify_and_save(&url, token).await?;
    progress.step(&format!("Connected to {}", connected.backend));
    ui.success(&format!("Your Worker is live at {}", connected.backend))?;
    Ok(Deployed {
        backend: connected.backend,
        token: connected.token,
    })
}

async fn health(url: &str) -> Result<Value> {
    Ok(slurp_client::http_client()?
        .get(format!("{url}/v1/health"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?)
}

/// How long to wait for a deployed Worker to come up with the new build (`SLURP_CLOUD_WAIT_SECS` shortens it for tests).
fn wait_limit() -> Duration {
    Duration::from_secs(
        std::env::var("SLURP_CLOUD_WAIT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(90),
    )
}

/// Wait until the Worker answers as configured and runs `build`, then call `ListProjects` with the admin token. That call wakes
/// the registry, which applies any storage migration, so a Worker whose storage is newer than its code (or otherwise broken)
/// fails here, not at the first sync.
async fn wait_until_configured(url: &str, build: &str, token: &str) -> Result<()> {
    let deadline = Instant::now() + wait_limit();
    let mut last;
    loop {
        match health(url).await {
            Ok(h) if h["ok"] == true && h["configured"] == true => {
                if h["build"].as_str() == Some(build) {
                    use slurp_client::api;
                    let checked = slurp_app::project_setup::Api::new(url, token)?
                        .call::<api::ListProjects>(&api::ListProjectsRequest {})
                        .await;
                    match checked {
                        Ok(_) => return Ok(()),
                        Err(error) if slurp_app::project_setup::is_rejected(&error) => {
                            return Err(error.into());
                        }
                        Err(error) => last = format!("could not list its projects: {error}"),
                    }
                } else {
                    last = format!(
                        "the Worker still runs build {}, not {build}",
                        h["build"].as_str().unwrap_or("unknown")
                    );
                }
            }
            Ok(h) => last = format!("not configured yet: {h}"),
            Err(error) => last = error.to_string(),
        }
        if Instant::now() >= deadline {
            bail!(
                "the Worker did not become ready within {} seconds ({last}). Run `slurp cloud doctor` to see what is wrong.",
                wait_limit().as_secs()
            );
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Whether `slurp cloud upgrade` may deploy over what `health` says is running. `health` is the Worker's `/v1/health`, or the
/// reason it could not be read. The three refusals do not depend on the control API version, which two releases can share.
fn check_deployed(worker: &str, health: &Result<Value>) -> Result<()> {
    let health = match health {
        Ok(h) if h["ok"] == true => h,
        Ok(_) => bail!(
            "can't tell what is deployed: {worker} did not answer /v1/health like a Slurp Worker. Pass --force to deploy anyway."
        ),
        Err(error) => bail!(
            "can't tell what is deployed: {worker} did not answer /v1/health ({error}). Check the Worker's URL and your network, or pass --force to deploy anyway."
        ),
    };
    let release = health["release"].as_str();
    let (Some(release), Some(_)) = (release, health["apiVersion"].as_u64()) else {
        bail!(
            "{worker} has unsupported deployment metadata, which this version cannot upgrade; deploy a new Worker with `slurp cloud init --worker NEW` and remove the old one with `slurp cloud destroy` when you're done"
        )
    };
    let api = health["apiVersion"]
        .as_u64()
        .context("Worker API version")?;
    ensure!(
        (crate::connect::MIN_API..=crate::connect::MAX_API).contains(&api),
        "{worker} reports incompatible Worker API {api}; use a compatible CLI or start fresh"
    );
    let deployed = semver::Version::parse(release).with_context(|| {
        format!("{worker} reports release {release:?}, which is not a version; pass --force to deploy anyway")
    })?;
    let mine = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
    ensure!(
        deployed <= mine,
        "the deployed Worker ({deployed}) is newer than this CLI's ({mine}); upgrade the CLI"
    );
    Ok(())
}

async fn status(target: &WorkerArg, machine: bool) -> Result<u8> {
    let receipt = pick_receipt(target.worker.as_deref())?;
    let latest = bundle()?.build;
    let health = health(&receipt.url).await.ok();
    let report = match crate::login::token(&receipt.url) {
        Ok(token) => admin_status(&receipt.url, &token).await,
        Err(_) => IssueReport::NotConnected,
    };
    let (projects, issues, summary) = report.parts();
    let errors = summary["errors"].as_u64().unwrap_or(0);
    let deployed_build = health
        .as_ref()
        .and_then(|h| h["build"].as_str())
        .map(str::to_owned);
    let release = health
        .as_ref()
        .and_then(|h| h["release"].as_str())
        .map(str::to_owned);
    let api_version = health.as_ref().and_then(|h| h["apiVersion"].as_u64());
    let value = json!({
        "worker": receipt.worker, "domain": receipt.domain, "url": receipt.url, "bucket": receipt.bucket,
        "reachable": health.is_some(),
        "configured": health.as_ref().is_some_and(|h| h["configured"] == true),
        "release": release, "api_version": api_version, "latest_release": env!("CARGO_PKG_VERSION"),
        "build": deployed_build, "latest_build": latest,
        "up_to_date": deployed_build.as_deref() == Some(latest.as_str()),
        "deployed_at": receipt.deployed_at, "projects": projects,
        "issues": issues, "summary": summary, "issues_note": report.note(),
    });
    if machine {
        crate::service::emit(&value)?;
    } else {
        let line = |k: &str, v: String| println!("{k:<12}{v}");
        line("Worker", format!("{} ({})", receipt.worker, receipt.url));
        line(
            "Reachable",
            if health.is_some() {
                "yes".into()
            } else {
                "NO: check the URL and your network".into()
            },
        );
        line(
            "Version",
            match (&deployed_build, value["up_to_date"].as_bool()) {
                (Some(b), Some(true)) => format!("{b} (current)"),
                (Some(b), _) => format!("{b}, newer available: run slurp cloud upgrade"),
                _ => "unknown".into(),
            },
        );
        line(
            "Release",
            format!(
                "{} (this CLI: {})",
                release.as_deref().unwrap_or("unknown"),
                env!("CARGO_PKG_VERSION")
            ),
        );
        line(
            "API",
            api_version.map_or("unknown".into(), |v| v.to_string()),
        );
        line("Bucket", receipt.bucket.clone());
        if let Some(note) = report.note() {
            line("Issues", format!("not checked: {note}"));
        } else if issues.is_empty() {
            line("Issues", "none".into());
        }
        for issue in &issues {
            line(
                "Issue",
                format!(
                    "{} {}: {}",
                    if issue["level"] == "error" {
                        "ERROR"
                    } else {
                        "warning"
                    },
                    issue["project"].as_str().unwrap_or(""),
                    issue["message"].as_str().unwrap_or("")
                ),
            );
        }
        for p in &projects {
            line("Project", project_line(p));
        }
        if projects.is_empty() && report.note().is_none() {
            line("Projects", "none yet; run slurp init in an app".into());
        }
    }
    // Problems the Worker reports are a failing status, so a script or cron job can act on them. Warnings are not.
    Ok(u8::from(errors > 0))
}

/// What `GET /v1/admin/status` gave back.
enum IssueReport {
    Read(Value),
    /// No saved admin token for this Worker.
    NotConnected,
    /// A Worker deployed before the route existed.
    TooOld,
    Failed(String),
}

impl IssueReport {
    /// The projects, the issues (worst first) and the summary, with the CLI's own key names. All empty when nothing was read.
    fn parts(&self) -> (Vec<Value>, Vec<Value>, Value) {
        let IssueReport::Read(report) = self else {
            return (vec![], vec![], json!({}));
        };
        let list = |key: &str| report[key].as_array().cloned().unwrap_or_default();
        let projects = list("projects")
            .iter()
            .map(|p| {
                json!({
                    "id": p["id"], "name": p["name"], "status": p["status"], "issues": p["issues"],
                    "sources": p["sources"], "archives": p["archives"], "events": p["events"],
                    "buffered_bytes": p["bufferedBytes"], "pending": p["pending"], "last_archive_at": p["lastArchiveAt"],
                })
            })
            .collect();
        (projects, list("issues"), report["summary"].clone())
    }

    /// Why there is no report to show, or `None` when there is one.
    fn note(&self) -> Option<String> {
        match self {
            IssueReport::Read(_) => None,
            IssueReport::NotConnected => {
                Some("not connected to this Worker; run slurp connect".into())
            }
            IssueReport::TooOld => {
                Some("this Worker predates the issue report; run slurp cloud upgrade".into())
            }
            IssueReport::Failed(why) => Some(why.clone()),
        }
    }
}

/// Every project and what is wrong with it, in one request. Admin token only.
async fn admin_status(url: &str, token: &str) -> IssueReport {
    let sent = async {
        Ok::<_, anyhow::Error>(
            slurp_client::http_client()?
                .get(format!("{url}/v1/admin/status"))
                .bearer_auth(token)
                .timeout(Duration::from_secs(20))
                .send()
                .await?,
        )
    };
    match sent.await {
        Err(e) => IssueReport::Failed(format!("could not reach the Worker: {e}")),
        Ok(response) if response.status() == slurp_client::reqwest::StatusCode::NOT_FOUND => {
            IssueReport::TooOld
        }
        Ok(response) if !response.status().is_success() => {
            IssueReport::Failed(format!("the Worker answered {}", response.status()))
        }
        Ok(response) => match response.json().await {
            Ok(report) => IssueReport::Read(report),
            Err(e) => IssueReport::Failed(format!("the Worker's answer was not a report: {e}")),
        },
    }
}

/// One project on one line: its state, where it sends from, and how far archiving has got.
fn project_line(p: &Value) -> String {
    let last = p["last_archive_at"].as_str().unwrap_or("none yet");
    format!(
        "{} {} [{}] sources: {}; {} archives, {} events; last archive {}{}",
        p["id"].as_str().unwrap_or(""),
        p["name"].as_str().unwrap_or(""),
        p["status"].as_str().unwrap_or("unknown"),
        {
            let sources: Vec<&str> = p["sources"]
                .as_array()
                .map(|s| s.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if sources.is_empty() {
                "none".to_owned()
            } else {
                sources.join(", ")
            }
        },
        p["archives"].as_u64().unwrap_or(0),
        p["events"].as_u64().unwrap_or(0),
        last,
        if p["pending"] == true {
            " (events waiting)"
        } else {
            ""
        },
    )
}

async fn doctor(target: &WorkerArg, machine: bool) -> Result<u8> {
    let mut checks: Vec<Value> = vec![];
    let mut add = |name: &str, ok: bool, detail: String, fix: &str| {
        checks.push(
            json!({"check": name, "ok": ok, "detail": detail, "fix": if ok { "" } else { fix }}),
        );
    };
    let wrangler = Wrangler::discover();
    match &wrangler {
        Ok(w) => add("wrangler available", true, w.label.clone(), ""),
        Err(e) => add(
            "wrangler available",
            false,
            e.to_string(),
            "Install Node.js 20+ from https://nodejs.org",
        ),
    }
    if let Ok(w) = &wrangler {
        let tmp = tempfile::tempdir()?;
        let who = w
            .run(&["whoami", "--json"], tmp.path(), None, None)
            .ok()
            .and_then(|o| parse_whoami(&o.text).ok());
        add(
            "logged in to Cloudflare",
            who.as_ref().is_some_and(|w| w.logged_in),
            who.as_ref()
                .map_or("could not read login state".into(), |w| {
                    format!("{} account(s)", w.accounts.len())
                }),
            "Run `wrangler login`",
        );
    }
    match pick_receipt(target.worker.as_deref()) {
        Err(e) => add(
            "deployment found",
            false,
            e.to_string(),
            "Run `slurp cloud init`",
        ),
        Ok(receipt) => {
            add(
                "deployment found",
                true,
                format!("{} at {}", receipt.worker, receipt.url),
                "",
            );
            match health(&receipt.url).await {
                Err(e) => add(
                    "Worker reachable",
                    false,
                    e.to_string(),
                    "Check the Worker URL and your network; the Worker may have been deleted",
                ),
                Ok(h) => {
                    add(
                        "Worker reachable",
                        h["ok"] == true,
                        format!(
                            "release {}, apiVersion {}",
                            h["release"].as_str().unwrap_or("unknown"),
                            h["apiVersion"]
                        ),
                        "This URL is not a Slurp Worker",
                    );
                    add(
                        "admin token set on the Worker",
                        h["configured"] == true,
                        String::new(),
                        "Run `wrangler secret put ADMIN_TOKEN` for this Worker, then `slurp connect`",
                    );
                    let latest = bundle()?.build;
                    let current = h["build"].as_str() == Some(latest.as_str());
                    add(
                        "Worker is up to date",
                        current,
                        format!(
                            "deployed {} / bundled {latest}",
                            h["build"].as_str().unwrap_or("unknown")
                        ),
                        "Run `slurp cloud upgrade`",
                    );
                }
            }
            match crate::login::token(&receipt.url) {
                Err(e) => add(
                    "saved connection",
                    false,
                    e.to_string(),
                    "Run `slurp connect <url> --token-stdin`",
                ),
                Ok(token) => {
                    let ok = crate::login::whoami(&receipt.url, &token)
                        .await
                        .is_ok_and(|who| who.scope == slurp_client::api::TokenScope::Admin);
                    add(
                        "saved admin token works",
                        ok,
                        String::new(),
                        "The saved token no longer matches the Worker; run `slurp connect <url> --token-stdin`",
                    );
                }
            }
        }
    }
    let failed = checks.iter().filter(|c| c["ok"] != true).count();
    if machine {
        crate::service::emit(&json!({"checks": checks, "problems": failed}))?;
    } else {
        for c in &checks {
            let ok = c["ok"] == true;
            println!(
                "{} {}{}",
                if ok { "✓" } else { "✗" },
                c["check"].as_str().unwrap_or(""),
                match c["detail"].as_str() {
                    Some(d) if !d.is_empty() => format!(" ({d})"),
                    _ => String::new(),
                }
            );
            if !ok {
                println!("    fix: {}", c["fix"].as_str().unwrap_or(""));
            }
        }
        println!(
            "{}",
            if failed == 0 {
                "Everything looks good.".to_owned()
            } else {
                format!("{failed} problem(s) found.")
            }
        );
    }
    Ok(u8::from(failed > 0))
}

/// The variables for an upgraded Worker: the new bundle's settings, each keeping the value this Worker was deployed with. A
/// setting the new bundle no longer has (renamed or removed) is dropped, and one it added takes its default.
fn upgraded_vars(
    bundle: &serde_json::Map<String, Value>,
    deployed: &serde_json::Map<String, Value>,
    build: &str,
) -> serde_json::Map<String, Value> {
    let mut vars = bundle.clone();
    for (name, value) in deployed {
        if vars.contains_key(name) {
            vars.insert(name.clone(), value.clone());
        }
    }
    vars.insert("SLURP_BUILD".into(), json!(build));
    vars
}

async fn upgrade(args: &UpgradeArgs, machine: bool) -> Result<u8> {
    let progress = Progress { machine };
    let mut receipt = pick_receipt(args.target.worker.as_deref())?;
    let wrangler = Wrangler::discover()?;
    let bundle = bundle()?;
    let deployed = health(&receipt.url).await;
    if !args.force || deployed.as_ref().is_ok_and(|h| h["ok"] == true) {
        check_deployed(&receipt.worker, &deployed)?;
    }
    if deployed
        .as_ref()
        .is_ok_and(|h| h["build"].as_str() == Some(bundle.build.as_str()))
    {
        let token = crate::login::token(&receipt.url)?;
        wait_until_configured(&receipt.url, &bundle.build, &token).await?;
        receipt.build = bundle.build.clone();
        save_receipt(&receipt)?;
        crate::service::emit(
            &json!({"worker": receipt.worker, "build": bundle.build, "upgraded": false, "reason": "already up to date"}),
        )?;
        return Ok(0);
    }
    // The check after the deploy needs the admin token, so find out now rather than after the Worker has changed.
    let token = crate::login::token(&receipt.url).with_context(|| {
        format!(
            "no admin token is saved for {}; run `slurp connect` first",
            receipt.url
        )
    })?;
    if deployed.as_ref().is_ok_and(|h| h["ok"] == true) {
        let who = crate::login::whoami(&receipt.url, &token).await?;
        ensure!(
            who.scope == slurp_client::api::TokenScope::Admin,
            "cloud upgrade requires an admin token"
        );
    }
    let vars = upgraded_vars(&bundle.vars, &receipt.vars, &bundle.build);
    let staged = stage(
        &bundle,
        &receipt.worker,
        &receipt.bucket,
        &vars,
        receipt.domain.as_deref(),
    )?;
    progress.step("Deploying the new Worker (your data, secret and settings are kept)");
    let account = receipt.account_id.as_deref();
    let out = wrangler.run(
        &["deploy", "--config", "wrangler.jsonc"],
        staged.path(),
        account,
        None,
    )?;
    ensure!(out.ok, explain("deploying the Worker", &out.text, account));
    wait_until_configured(&receipt.url, &bundle.build, &token).await?;
    receipt.build = bundle.build.clone();
    receipt.vars = vars;
    receipt.deployed_at = chrono::Utc::now().to_rfc3339();
    save_receipt(&receipt)?;
    crate::service::emit(
        &json!({"worker": receipt.worker, "build": bundle.build, "upgraded": true}),
    )?;
    Ok(0)
}

async fn destroy(args: &DestroyArgs, ui: &Terminal, machine: bool) -> Result<u8> {
    let progress = Progress { machine };
    let receipt = pick_receipt(args.target.worker.as_deref())?;
    if !args.yes {
        ensure!(ui.interactive, "pass --yes to destroy without a prompt");
        ui.note(
            "This deletes everything",
            &format!(
                "Worker {}, every project and archive it holds, and the R2 bucket {}.\nData already synced to your DuckDB files is not touched. This cannot be undone.",
                receipt.worker, receipt.bucket
            ),
        )?;
        let typed = ui.input(
            &format!("Type the Worker name ({}) to confirm", receipt.worker),
            "",
            |_| Ok(()),
        )?;
        ensure!(
            typed == receipt.worker,
            "cancelled: the name did not match; nothing was deleted"
        );
    }
    let wrangler = Wrangler::discover()?;
    let tmp = tempfile::tempdir()?;
    let account = receipt.account_id.as_deref();
    let token = crate::login::token(&receipt.url).context("destroy needs the saved admin token")?;
    progress.step("Deleting all projects and archives");
    let purge = slurp_client::http_client()?
        .post(format!("{}/v1/admin/purge", receipt.url))
        .bearer_auth(&token)
        .json(&json!({"confirm": "delete-all-data"}))
        .send()
        .await?;
    ensure!(
        purge.status().is_success(),
        "the Worker refused to purge its data (HTTP {}); nothing was deleted",
        purge.status().as_u16()
    );
    progress.step("Deleting the Worker");
    let deleted = wrangler.run(
        &["delete", "--name", &receipt.worker, "--force"],
        tmp.path(),
        account,
        None,
    )?;
    ensure!(
        deleted.ok,
        explain("deleting the Worker", &deleted.text, account)
    );
    progress.step("Deleting the R2 bucket");
    let bucket = wrangler.run(
        &["r2", "bucket", "delete", &receipt.bucket],
        tmp.path(),
        account,
        None,
    )?;
    ensure!(
        bucket.ok,
        explain("deleting the R2 bucket", &bucket.text, account)
    );
    let _ = std::fs::remove_file(receipts_dir()?.join(format!("{}.json", receipt.worker)));
    let _ = slurp_client::connection::forget(&receipt.url);
    crate::service::emit(&json!({"destroyed": receipt.worker, "bucket": receipt.bucket}))?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(domain: Option<&str>, url: &str) -> Receipt {
        Receipt {
            version: 1,
            domain: domain.map(str::to_owned),
            worker: "w".into(),
            bucket: "b".into(),
            account_id: None,
            url: url.into(),
            build: "x".into(),
            deployed_at: "2026-11-08T00:00:00Z".into(),
            vars: Default::default(),
        }
    }

    #[test]
    fn a_receipt_with_a_domain_is_served_at_the_domain() {
        let mut r = receipt(Some("events.example.com"), "https://w.me.workers.dev");
        r.settle_url();
        assert_eq!(r.url, "https://events.example.com");
        let mut plain = receipt(None, "https://w.me.workers.dev");
        plain.settle_url();
        assert_eq!(plain.url, "https://w.me.workers.dev");
    }

    #[test]
    fn custom_domain_is_in_the_deployed_configuration() {
        let bundle = bundle().unwrap();
        let config = wrangler_config(&bundle, "w", "b", &bundle.vars, Some("events.example.com"));
        assert_eq!(
            config["routes"],
            json!([{"pattern":"events.example.com","custom_domain":true}])
        );
    }
    #[test]
    fn parses_whoami_with_banner_noise() {
        let text = " ⛅️ wrangler 4.158.0\n──────\n{\n \"loggedIn\": true,\n \"accounts\": [{\"id\": \"abc\", \"name\": \"Acme\", \"type\": \"standard\"}]\n}\n";
        let who = parse_whoami(text).unwrap();
        assert!(who.logged_in);
        assert_eq!(
            who.accounts,
            vec![Account {
                id: "abc".into(),
                name: "Acme".into()
            }]
        );
        assert!(!parse_whoami("{\"loggedIn\": false}").unwrap().logged_in);
        assert!(parse_whoami("not json").is_err());
    }

    #[test]
    fn finds_the_worker_url_in_deploy_output() {
        let text = "Uploaded slurp (1.7 sec)\nDeployed slurp triggers (0.6 sec)\n  https://slurp.some-name.workers.dev\nCurrent Version ID: abc";
        assert_eq!(
            parse_worker_url(text).unwrap(),
            "https://slurp.some-name.workers.dev"
        );
        assert!(parse_worker_url("no url here").is_none());
    }

    #[test]
    fn lists_buckets() {
        let text = "Listing buckets...\nname:           audio\ncreation_date:  2025-07-06\nname:           slurp-archive\n";
        assert_eq!(parse_buckets(text), ["audio", "slurp-archive"]);
    }

    /// `backend/src/version.ts` is what `/v1/health` reports as `release`; it moves with the Cargo version.
    #[test]
    fn the_workers_release_matches_the_clis_version() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend/src/version.ts");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let release = text
            .split("RELEASE = '")
            .nth(1)
            .and_then(|rest| rest.split('\'').next())
            .unwrap_or_else(|| panic!("no RELEASE = '<version>' in {}", path.display()));
        assert_eq!(
            release,
            env!("CARGO_PKG_VERSION"),
            "backend/src/version.ts must equal [workspace.package] version in Cargo.toml"
        );
    }

    #[test]
    fn versions_compare() {
        assert!(version_at_least(" ⛅️ wrangler 4.158.0", (4, 100)));
        assert!(version_at_least("4.100.0", (4, 100)));
        assert!(!version_at_least("4.46.0", (4, 100)));
        assert!(!version_at_least("3.99.0", (4, 100)));
        assert!(!version_at_least("", (4, 100)));
    }

    #[test]
    fn an_upgrade_keeps_chosen_settings_drops_renamed_ones_and_adds_new_ones() {
        let map = |value: Value| value.as_object().unwrap().clone();
        let bundle =
            map(json!({"SEAL_INTERVAL_MS": "600000", "ARCHIVE_MAX_BYTES": "8388608", "GEO": "on"}));
        let deployed =
            map(json!({"SEAL_INTERVAL_MS": "60000", "SEAL_MAX_BYTES": "1", "SLURP_BUILD": "old"}));
        let vars = upgraded_vars(&bundle, &deployed, "new");
        assert_eq!(vars["SEAL_INTERVAL_MS"], "60000");
        assert_eq!(vars["ARCHIVE_MAX_BYTES"], "8388608");
        assert_eq!(vars["GEO"], "on");
        assert_eq!(vars["SLURP_BUILD"], "new");
        assert!(!vars.contains_key("SEAL_MAX_BYTES"));
    }

    #[test]
    fn admin_tokens_are_long_and_unique() {
        let (a, b) = (new_admin_token(), new_admin_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_embedded_bundle_matches_its_build_id() {
        let bundle = bundle().unwrap();
        assert!(bundle.code.len() > 10_000);
        assert_eq!(bundle.build.len(), 12);
        let config = wrangler_config(&bundle, "w", "b", &bundle.vars, None);
        assert_eq!(config["name"], "w");
        assert_eq!(config["r2_buckets"][0]["bucket_name"], "b");
    }

    /// What the CLI deploys must be what `wrangler dev` and the Deploy button use: the same bindings, classes, migrations,
    /// variables and compatibility date as backend/wrangler.jsonc.
    #[test]
    fn the_shipped_deployment_config_matches_the_workers_wrangler_config() {
        let text = include_str!("../../../backend/wrangler.jsonc");
        let wrangler: Value = serde_json::from_str(
            &text
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .expect("wrangler.jsonc");
        let bundle = bundle().unwrap();
        let config = wrangler_config(&bundle, "w", "b", &bundle.vars, None);
        for key in [
            "compatibility_date",
            "durable_objects",
            "migrations",
            "vars",
            "observability",
        ] {
            assert_eq!(
                config[key], wrangler[key],
                "{key} differs from backend/wrangler.jsonc; run node backend/scripts/bundle.mjs"
            );
        }
        assert_eq!(
            config["r2_buckets"][0]["binding"],
            wrangler["r2_buckets"][0]["binding"]
        );
    }

    #[test]
    fn failures_explain_the_next_step() {
        let r2 = explain(
            "creating the R2 bucket",
            "Please enable R2 through the Cloudflare Dashboard. [code: 10042]",
            Some("acc"),
        );
        assert!(
            r2.to_string()
                .contains("https://dash.cloudflare.com/acc/r2/overview")
        );
        let sub = explain(
            "deploying the Worker",
            "You need to register a workers.dev subdomain",
            Some("acc"),
        );
        assert!(sub.to_string().contains("workers/onboarding"));
        let login = explain(
            "deploying the Worker",
            "Authentication error [code: 10000]",
            None,
        );
        assert!(login.to_string().contains("wrangler login"));
        assert!(
            explain("x", "something odd", None)
                .to_string()
                .contains("something odd")
        );
    }
}
