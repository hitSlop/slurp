var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/util.ts
var enc = new TextEncoder();
var bytesToHex = /* @__PURE__ */ __name((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""), "bytesToHex");
var sha256Hex = /* @__PURE__ */ __name(async (d) => bytesToHex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : d)), "sha256Hex");
var randomHex = /* @__PURE__ */ __name((bytes2) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes2)).buffer), "randomHex");
async function hmacBytesHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, data));
}
__name(hmacBytesHex, "hmacBytesHex");
var MIN_TIME_MS = 0;
var MAX_TIME_MS = 253402300799999;
function isoOrUndefined(value) {
  const ms = typeof value === "number" ? value : typeof value === "string" ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) && ms >= MIN_TIME_MS && ms <= MAX_TIME_MS ? new Date(ms).toISOString() : void 0;
}
__name(isoOrUndefined, "isoOrUndefined");
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
async function retry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}
__name(retry, "retry");

// src/auth.ts
var MIN_ADMIN_TOKEN = 20;
var PUBLISHABLE_KEY = /^slurp_pk_([0-9a-f]{16})_([a-z][a-z0-9_]{0,31})_([0-9a-f]{48})$/;
var SECRET_KEY = /^slurp_sk_([0-9a-f]{16})_([0-9a-f]{48})$/;
var adminConfigured = /* @__PURE__ */ __name((env) => !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN, "adminConfigured");
var isAdmin = /* @__PURE__ */ __name((token, env) => adminConfigured(env) && timingSafeEqual(token, env.ADMIN_TOKEN), "isAdmin");
var bearer = /* @__PURE__ */ __name((req) => /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null, "bearer");
function presentedToken(req, allowQueryKey = false) {
  let token = bearer(req);
  if (allowQueryKey) {
    const q = new URL(req.url).searchParams.getAll("key");
    if (q.length) {
      if (q.length !== 1 || !PUBLISHABLE_KEY.test(q[0])) return void 0;
      token = q[0];
    }
  }
  return token;
}
__name(presentedToken, "presentedToken");
var projectOfKey = /* @__PURE__ */ __name((token) => {
  const hex = PUBLISHABLE_KEY.exec(token)?.[1] ?? SECRET_KEY.exec(token)?.[1];
  return hex ? "prj_" + hex : null;
}, "projectOfKey");
async function authenticate(env, token) {
  if (!token) return null;
  if (isAdmin(token, env)) return { kind: "admin" };
  const project = projectOfKey(token);
  if (!project) return null;
  const principal = await env.PROJECT.get(env.PROJECT.idFromName(project)).authorize(token);
  return principal ? { kind: "key", project, ...principal } : null;
}
__name(authenticate, "authenticate");

// src/compat/providers.ts
var encoder = new TextEncoder();
var isObject = /* @__PURE__ */ __name((v) => typeof v === "object" && v !== null && !Array.isArray(v), "isObject");
var str = /* @__PURE__ */ __name((v) => typeof v === "string" && v !== "" ? v : void 0, "str");
var at = /* @__PURE__ */ __name((root, ...path) => path.reduce((node, key) => isObject(node) ? node[key] : void 0, root), "at");
var sameHex = /* @__PURE__ */ __name((a, b) => timingSafeEqual(a.toLowerCase(), b.toLowerCase()), "sameHex");
var STRIPE_TOLERANCE_S = 300;
async function githubSignatureOk(body, header, secret) {
  if (!header?.startsWith("sha256=")) return false;
  return sameHex(header.slice("sha256=".length), await hmacBytesHex(secret, body));
}
__name(githubSignatureOk, "githubSignatureOk");
function authorizationOk(header, secret) {
  if (!header) return false;
  const value = header.trim();
  return timingSafeEqual(value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : value, secret);
}
__name(authorizationOk, "authorizationOk");
async function stripeSignatureOk(body, header, secret, nowMs = Date.now()) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  if (!t || !/^\d+$/.test(t) || Math.abs(nowMs / 1e3 - Number(t)) > STRIPE_TOLERANCE_S) return false;
  const prefix = encoder.encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const expected = await hmacBytesHex(secret, signed);
  return parts.some(([k, v]) => k === "v1" && v !== void 0 && sameHex(v, expected));
}
__name(stripeSignatureOk, "stripeSignatureOk");
var GITHUB_TIME = {
  release: [["release", "published_at"], ["release", "created_at"]],
  workflow_run: [["workflow_run", "updated_at"]],
  workflow_job: [["workflow_job", "completed_at"], ["workflow_job", "started_at"]],
  deployment: [["deployment", "created_at"]],
  deployment_status: [["deployment_status", "updated_at"], ["deployment_status", "created_at"]],
  push: [["head_commit", "timestamp"]],
  pull_request: [["pull_request", "updated_at"]],
  issues: [["issue", "updated_at"]]
};
var PROVIDERS = {
  github: {
    secret: "generated",
    body: "json-object",
    notJson: /* @__PURE__ */ __name((contentType) => contentType.includes("urlencoded") ? "set the webhook content type to application/json in GitHub" : void 0, "notJson"),
    async verify(d, secret) {
      return await githubSignatureOk(d.bytes, d.header("x-hub-signature-256"), secret) ? null : "bad or missing X-Hub-Signature-256";
    },
    async describe(d) {
      const kind = d.header("x-github-event") ?? "";
      if (kind === "ping") return { ignored: "ping" };
      if (kind === "") return { error: "missing X-GitHub-Event" };
      const action = str(at(d.payload, "action"));
      const delivery = d.header("x-github-delivery") ?? `sha256-${await sha256Hex(d.bytes)}`;
      const when = (GITHUB_TIME[kind] ?? []).map((path) => isoOrUndefined(at(d.payload, ...path))).find(Boolean);
      return { event: `github.${kind}${action ? `.${action}` : ""}`, id: `github:${delivery}`, delivery, at: when };
    },
    steps: [
      "In the repository: Settings > Webhooks > Add webhook.",
      "Payload URL: the url above. Content type: application/json.",
      "Secret: the secret above.",
      "Choose the events to send (Releases, Workflow runs, Deployment statuses are the useful ones), then Add webhook.",
      "To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret."
    ]
  },
  stripe: {
    secret: { issued: /^whsec_\S{16,200}$/, hint: "Stripe chooses the signing secret: reveal it on the endpoint (whsec_...) and run slurp project webhook PROJECT stripe --secret whsec_..." },
    body: "json-object",
    async verify(d, secret, now) {
      return await stripeSignatureOk(d.bytes, d.header("stripe-signature"), secret, now) ? null : "bad, missing or stale Stripe-Signature";
    },
    async describe(d) {
      const id = str(at(d.payload, "id")), type = str(at(d.payload, "type"));
      if (!id || !type) return { error: "not a Stripe event (no id or type)" };
      const created = at(d.payload, "created");
      return { event: `stripe.${type}`, id, delivery: id, at: typeof created === "number" ? isoOrUndefined(created * 1e3) : void 0 };
    },
    steps: [
      "In the Stripe Dashboard: Developers > Webhooks > Add endpoint.",
      "Endpoint URL: the url above.",
      "Select the events to send (invoice.paid, customer.subscription.*, checkout.session.completed).",
      "Stripe chooses the signing secret. Reveal it on the endpoint (whsec_...) and give it to Slurp: slurp project webhook PROJECT stripe --secret whsec_...",
      "Until then the endpoint refuses deliveries.",
      "To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret."
    ]
  },
  revenuecat: {
    secret: "generated",
    body: "json-object",
    // RevenueCat has no signature unless its optional HMAC mode is on (not supported): it sends the value you typed as `Authorization`.
    async verify(d, secret) {
      return authorizationOk(d.header("authorization"), secret) ? null : "bad or missing Authorization header (paste the secret from slurp project webhook PROJECT revenuecat into RevenueCat)";
    },
    async describe(d) {
      const id = str(at(d.payload, "event", "id")), type = str(at(d.payload, "event", "type"));
      if (!id || !type) return { error: "not a RevenueCat event (no event.id or event.type)" };
      return { event: `revenuecat.${type.toLowerCase()}`, id: `revenuecat:${id}`, delivery: id, at: isoOrUndefined(at(d.payload, "event", "event_timestamp_ms")) };
    },
    steps: [
      "In RevenueCat: Project settings > Integrations > Webhooks > New.",
      "Webhook URL: the url above.",
      "Authorization header value: the secret above, pasted exactly. RevenueCat sends it on every delivery.",
      "Choose the environment (send both Sandbox and Production if you want test purchases too) and the apps, then use Send test event.",
      "Query the revenue view: SELECT * FROM revenue WHERE environment = 'PRODUCTION'.",
      "To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret."
    ]
  },
  generic: {
    secret: "generated",
    body: "any",
    // Unsigned by default; when the caller signs, the signature has to be right.
    async verify(d, secret) {
      const claimed = d.header("x-slurp-signature");
      return claimed === null || await githubSignatureOk(d.bytes, claimed, secret) ? null : "bad X-Slurp-Signature";
    },
    async describe(d) {
      const event = d.query.get("event") || str(at(d.payload, "type")) || str(at(d.payload, "event")) || "webhook";
      const supplied = d.header("idempotency-key") ?? d.header("x-request-id") ?? d.header("x-delivery-id");
      const given = supplied && encoder.encode(supplied).length <= 200 ? supplied : void 0;
      const at_ = isoOrUndefined(at(d.payload, "timestamp"));
      const delivery = given ?? (at_ ? `sha256-${await sha256Hex(d.bytes)}` : void 0);
      return { event, ...delivery ? { id: `generic:${delivery}`, delivery } : {}, at: at_ };
    },
    steps: [
      "POST any body to the url above. Name the event with ?event=NAME (or a `type` or `event` field in a JSON body).",
      "Send an Idempotency-Key (or X-Request-Id, X-Delivery-Id) header so a retry of the same POST is one event; without one, each POST is its own event unless the body has a `timestamp`.",
      "Optional: sign the body with HMAC-SHA256 using the secret and send X-Slurp-Signature: sha256=<hex>; a wrong signature is refused.",
      "To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret."
    ]
  }
};
var providerNames = /* @__PURE__ */ __name(() => Object.keys(PROVIDERS), "providerNames");
var providerList = /* @__PURE__ */ __name(() => {
  const n = providerNames();
  return `${n.slice(0, -1).join(", ")} or ${n[n.length - 1]}`;
}, "providerList");
var providerOf = /* @__PURE__ */ __name((name) => Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : void 0, "providerOf");

// src/publisher.ts
var DAY_MS = 864e5;
var encoder2 = new TextEncoder();
var pad20 = /* @__PURE__ */ __name((n) => String(n).padStart(20, "0"), "pad20");
var archiveKey = /* @__PURE__ */ __name((project, seq) => `projects/${project}/archives/${pad20(seq)}.jsonl.gz`, "archiveKey");
function publicationWake(f, cfg, now) {
  if (f.retryAt !== null) return f.retryAt;
  if (f.hasIntent || f.bufferedBytes >= cfg.archiveMaxBytes) return now;
  return f.oldestChunkAt === null ? null : f.oldestChunkAt + cfg.sealIntervalMs;
}
__name(publicationWake, "publicationWake");
function retentionWake(f, cfg, now) {
  if (cfg.retentionDays <= 0 || f.oldestLiveAt === null) return null;
  const due = f.oldestLiveAt + cfg.retentionDays * DAY_MS;
  if (due <= now && f.retryAt !== null) return Math.max(f.retryAt, now + 1e3);
  return Math.max(due, now + 1e3);
}
__name(retentionWake, "retentionWake");
function nextWake(f, cfg, now) {
  const times = [publicationWake(f, cfg, now), retentionWake(f, cfg, now)].filter((t) => t !== null);
  return times.length ? Math.min(...times) : null;
}
__name(nextWake, "nextWake");
var Publisher = class {
  static {
    __name(this, "Publisher");
  }
  /** Unpublished bytes in `chunks`, kept in step with the table (the table is the truth; this saves summing it on every request). */
  bufferedBytes = 0;
  /** The time the alarm is set to, as far as this object knows. */
  armed = null;
  inflight = null;
  /** Test hooks (DEBUG only). */
  faults = { archive: false, afterPut: false, alarm: false };
  ctx;
  env;
  db;
  cfg;
  project;
  constructor(ctx, env, db, cfg, project) {
    this.ctx = ctx;
    this.env = env;
    this.db = db;
    this.cfg = cfg;
    this.project = project;
  }
  setting(k) {
    return this.db.one("SELECT v FROM settings WHERE k=?", k)?.v ?? null;
  }
  intent() {
    const row = this.db.one("SELECT seq, through_chunk FROM intent");
    return row ? { seq: row.seq, through: row.through_chunk } : null;
  }
  maxChunk() {
    return this.db.one("SELECT MAX(id) m FROM chunks")?.m ?? 0;
  }
  /** Load the buffered size from the table (when the object starts). */
  load() {
    this.bufferedBytes = this.db.one("SELECT COALESCE(SUM(bytes), 0) b FROM chunks")?.b ?? 0;
  }
  facts() {
    const retry2 = this.setting("retry_at");
    return {
      retryAt: retry2 === null ? null : Number(retry2),
      hasIntent: this.intent() !== null,
      bufferedBytes: this.bufferedBytes,
      oldestChunkAt: this.db.one("SELECT at_ms t FROM chunks ORDER BY id LIMIT 1")?.t ?? null,
      oldestLiveAt: this.db.one("SELECT created_at t FROM manifest WHERE deleted_at IS NULL ORDER BY seq LIMIT 1")?.t ?? null
    };
  }
  /**
   * Set (or clear) the alarm for `nextWake`. The only place that touches the alarm, and only when the time changes: each write bills a row.
   * The cache of what is armed changes only once the platform has accepted the write: a failed write throws and leaves it as it was, so
   * the next call tries again instead of believing an alarm exists.
   */
  async rearm() {
    const now = Date.now();
    const want = nextWake(this.facts(), this.cfg, now);
    const cur = this.armed;
    if (want === null) {
      if (cur === null) return;
      await this.alarmWrite(() => this.ctx.storage.deleteAlarm());
      this.armed = null;
    } else {
      if (cur === want || cur !== null && cur <= now && want <= now) return;
      await this.alarmWrite(() => this.ctx.storage.setAlarm(want));
      this.armed = want;
    }
  }
  async alarmWrite(write) {
    if (this.faults.alarm) {
      this.faults.alarm = false;
      throw new Error("injected alarm failure");
    }
    await write();
    this.db.alarmWrites++;
  }
  /** Learn what the platform has armed (when the object starts, and as an alarm begins). */
  async syncAlarm() {
    this.armed = await this.ctx.storage.getAlarm();
  }
  /** One publication at a time: callers during a run share it. */
  publish() {
    if (!this.inflight) this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
  /** Publish everything buffered now (up to the newest chunk at this moment), even if a run that started earlier was already going. */
  async publishAll() {
    const mark = this.maxChunk();
    while (this.db.one("SELECT 1 FROM chunks WHERE id<=?", mark) || this.intent()) await this.publish();
    this.clearFailures();
  }
  async run() {
    const watermark = this.maxChunk();
    for (; ; ) {
      const intent = this.intent() ?? this.plan(watermark);
      if (!intent) return;
      await this.publishIntent(intent);
    }
  }
  /** Choose the next archive: the oldest chunks up to ARCHIVE_MAX_BYTES (at least one), and store that choice before any work is done. */
  plan(watermark) {
    let total = 0, through = 0;
    for (const c of this.db.rows("SELECT id, bytes FROM chunks WHERE id<=? ORDER BY id", watermark)) {
      if (through && total + c.bytes > this.cfg.archiveMaxBytes) break;
      total += c.bytes;
      through = c.id;
    }
    if (!through) return null;
    const seq = (this.db.one("SELECT MAX(seq) m FROM manifest")?.m ?? 0) + 1;
    this.db.rows("INSERT INTO intent VALUES(?,?)", seq, through);
    return { seq, through };
  }
  /** Compress the intent's chunks into one gzip stream and put it in R2, then commit manifest, chunk deletion and intent together. */
  async publishIntent({ seq, through }) {
    const chunks = this.db.rows("SELECT id, events, bytes FROM chunks WHERE id<=? ORDER BY id", through);
    const gz = await this.compress(chunks.map((c) => c.id));
    const sha256 = await sha256Hex(gz);
    await retry(async () => {
      if (this.faults.archive) throw new Error("injected archive failure");
      return this.env.ARCHIVE.put(archiveKey(this.project, seq), gz, { httpMetadata: { contentType: "application/gzip" } });
    });
    if (this.faults.afterPut) {
      this.faults.afterPut = false;
      throw new Error("injected failure after the R2 put");
    }
    const events = chunks.reduce((n, c) => n + c.events, 0), bytes2 = chunks.reduce((n, c) => n + c.bytes, 0);
    this.ctx.storage.transactionSync(() => {
      this.db.rows("INSERT INTO manifest(seq, size, sha256, events, created_at) VALUES(?,?,?,?,?)", seq, gz.length, sha256, events, Date.now());
      this.db.rows("DELETE FROM chunks WHERE id<=?", through);
      this.db.rows("DELETE FROM intent");
    });
    this.bufferedBytes = Math.max(0, this.bufferedBytes - bytes2);
  }
  /** Stream the chunks, in order, through one gzip compressor while its output is read at the same time (so neither side stalls). */
  async compress(ids) {
    const gzip = new CompressionStream("gzip");
    const output = new Response(gzip.readable).arrayBuffer();
    const writer = gzip.writable.getWriter();
    try {
      for (const id of ids) await writer.write(encoder2.encode(this.db.one("SELECT data FROM chunks WHERE id=?", id).data));
      await writer.close();
    } catch (e) {
      output.catch(() => {
      });
      await writer.abort(e).catch(() => {
      });
      throw e;
    }
    return new Uint8Array(await output);
  }
  /** Delete archives older than RETENTION_DAYS from R2 (a page at a time) and mark them deleted. Their manifest rows stay, so seq never repeats. */
  async sweep() {
    if (this.cfg.retentionDays <= 0) return;
    const cutoff = Date.now() - this.cfg.retentionDays * DAY_MS;
    for (; ; ) {
      const old = this.db.rows("SELECT seq FROM manifest WHERE deleted_at IS NULL AND created_at<? ORDER BY seq LIMIT 1000", cutoff);
      if (!old.length) return;
      await retry(() => this.env.ARCHIVE.delete(old.map((o) => archiveKey(this.project, o.seq))));
      this.db.rows("UPDATE manifest SET deleted_at=? WHERE seq<=? AND deleted_at IS NULL", Date.now(), old[old.length - 1].seq);
    }
  }
  /**
   * An alarm that throws is retried by Cloudflare a few times and then not again until something sets one, and a quiet project has nothing
   * that would. So a failure is caught and the retry is scheduled here (`retry_at`): it backs off from ARCHIVE_RETRY_MS up to the seal
   * interval, for ever. Retention does not wait for publication.
   */
  async alarm(force) {
    await this.syncAlarm();
    const now = Date.now();
    let failure = null;
    let published = false;
    const due = publicationWake(this.facts(), this.cfg, now);
    if (force || due !== null && due <= now) {
      try {
        await this.publish();
        published = true;
      } catch (e) {
        failure = e;
      }
    }
    try {
      await this.sweep();
    } catch (e) {
      failure ??= e;
    }
    if (failure) this.fail(failure, now);
    else if (published) this.clearFailures();
    await this.rearm();
  }
  /** Record a failed publication: count it and schedule the retry (`retry_at`), backing off. */
  fail(error, now) {
    const failures = Number(this.setting("failures") ?? 0) + 1;
    const { archiveRetryMs, sealIntervalMs } = this.cfg;
    const delay = Math.min(archiveRetryMs * 2 ** Math.min(failures - 1, 30), Math.max(sealIntervalMs, archiveRetryMs));
    this.db.rows("INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", "failures", String(failures));
    this.db.rows("INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", "retry_at", String(now + delay));
    console.error(`archive publication failed (attempt ${failures}); trying again in ${Math.round(delay / 1e3)} s`, error);
  }
  clearFailures() {
    if (this.setting("retry_at") !== null || this.setting("failures") !== null) this.db.rows("DELETE FROM settings WHERE k IN ('failures','retry_at')");
  }
  /** The archives' state for a listing: the oldest kept, the newest, and whether accepted events are still waiting for an archive. */
  coverage(queued) {
    const first = this.db.one("SELECT seq FROM manifest WHERE deleted_at IS NULL ORDER BY seq LIMIT 1")?.seq;
    const last = this.db.one("SELECT seq, created_at FROM manifest ORDER BY seq DESC LIMIT 1");
    const pending = queued || this.bufferedBytes > 0 || this.intent() !== null;
    return {
      ...first !== void 0 ? { first } : {},
      ...last ? { last: last.seq, lastAt: new Date(last.created_at).toISOString() } : {},
      pending
    };
  }
  /** A page of archives after `after` (default: from the oldest kept), with the gap retention left if `after` is older than that. */
  list(after, limit, queued) {
    const coverage = this.coverage(queued);
    const from = coverage.first ?? (coverage.last ?? 0) + 1;
    const gap = after !== void 0 && after + 1 < from ? { from: after + 1, to: from - 1 } : void 0;
    const rows = this.db.rows(
      "SELECT seq, size, sha256, events, created_at FROM manifest WHERE seq>? AND deleted_at IS NULL ORDER BY seq LIMIT ?",
      Math.max(after ?? 0, from - 1),
      limit + 1
    );
    const page = rows.slice(0, limit);
    return {
      coverage,
      archives: page.map((r) => ({ seq: r.seq, size: r.size, sha256: r.sha256, events: r.events, createdAt: new Date(r.created_at).toISOString() })),
      ...rows.length > limit ? { next: page[page.length - 1].seq } : {},
      ...gap ? { gap } : {}
    };
  }
  /** Whether archive `seq` is published and not deleted. */
  has(seq) {
    return this.db.one("SELECT 1 FROM manifest WHERE seq=? AND deleted_at IS NULL", seq) !== void 0;
  }
  /** Delete every archive object of this project (for purge). */
  async deleteArchives() {
    const live = this.db.rows("SELECT seq FROM manifest WHERE deleted_at IS NULL ORDER BY seq");
    for (let i = 0; i < live.length; i += 1e3) await retry(() => this.env.ARCHIVE.delete(live.slice(i, i + 1e3).map((r) => archiveKey(this.project, r.seq))));
    return live.length;
  }
};

// src/api.ts
var ApiFailure = class extends Error {
  static {
    __name(this, "ApiFailure");
  }
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var STATUS = { invalid_argument: 400, unauthenticated: 401, forbidden: 403, not_found: 404, already_exists: 409, unavailable: 503 };
var bad = /* @__PURE__ */ __name((message) => new ApiFailure("invalid_argument", message), "bad");
var bytes = /* @__PURE__ */ __name((s) => new TextEncoder().encode(s).length, "bytes");
function text(r, k, max = 200) {
  const v = r[k];
  if (typeof v !== "string" || v === "") throw bad(`${k} must be a non-empty string`);
  if (bytes(v) > max) throw bad(`${k} is too long`);
  return v;
}
__name(text, "text");
var optText = /* @__PURE__ */ __name((r, k, max) => r[k] === void 0 ? void 0 : text(r, k, max), "optText");
function optInt(r, k, min, max) {
  const v = r[k];
  if (v === void 0) return void 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${k} must be an integer from ${min} to ${max}`);
  return v;
}
__name(optInt, "optInt");
function optOneOf(r, k, values) {
  const v = r[k];
  if (v === void 0) return void 0;
  if (!values.includes(v)) throw bad(`${k} must be ${values.join(" or ")}`);
  return v;
}
__name(optOneOf, "optOneOf");
function needAdmin(c) {
  if (!adminConfigured(c.env)) throw new ApiFailure("unavailable", `ADMIN_TOKEN is not configured (needs at least ${MIN_ADMIN_TOKEN} characters)`);
  if (!c.auth) throw new ApiFailure("unauthenticated", "a bearer token is required");
  if (c.auth.kind !== "admin") throw new ApiFailure("forbidden", "the admin token is required");
}
__name(needAdmin, "needAdmin");
function needRead(c, project) {
  if (!c.auth) throw new ApiFailure("unauthenticated", "a bearer token is required");
  if (c.auth.kind === "key" && (c.auth.scope !== "secret" || c.auth.project !== project)) throw new ApiFailure("forbidden", "this key cannot read that project's archives");
}
__name(needRead, "needRead");
var registry = /* @__PURE__ */ __name((env) => env.REGISTRY.get(env.REGISTRY.idFromName("registry")), "registry");
var projectStub = /* @__PURE__ */ __name((env, id) => env.PROJECT.get(env.PROJECT.idFromName(id)), "projectStub");
var unwrap = /* @__PURE__ */ __name((r) => {
  if (r.ok) return r.value;
  throw new ApiFailure(r.code === "notfound" ? "not_found" : r.code === "exists" ? "already_exists" : "invalid_argument", r.message);
}, "unwrap");
async function resolve(c, ref) {
  const row = await registry(c.env).get(ref);
  if (!row) throw new ApiFailure("not_found", `no project ${ref}`);
  return row;
}
__name(resolve, "resolve");
var info = /* @__PURE__ */ __name((p) => ({ id: p.id, name: p.name, ...p.title ? { title: p.title } : {}, createdAt: p.created_at }), "info");
var keyInfo = /* @__PURE__ */ __name((project, k, reveal = false) => ({
  keyId: k.key_id,
  project,
  scope: k.scope,
  ...k.source ? { source: k.source } : {},
  ...k.name ? { name: k.name } : {},
  createdAt: k.created_at,
  ...k.revoked_at ? { revokedAt: k.revoked_at } : {},
  ...k.plain && (k.scope === "publishable" || reveal) ? { key: k.plain } : {}
}), "keyInfo");
var ingestUrl = /* @__PURE__ */ __name((c) => `${c.origin}/v1/events`, "ingestUrl");
var handlers = {
  async Whoami(c) {
    if (!c.auth) throw new ApiFailure("unauthenticated", "a bearer token is required");
    if (c.auth.kind === "admin") return { scope: "admin" };
    return { scope: c.auth.scope, project: c.auth.project, ...c.auth.source ? { source: c.auth.source } : {}, ...c.auth.name ? { name: c.auth.name } : {} };
  },
  // Two steps that can each be repeated: claim the name in the registry, then set up the project's own object. A crash in between is
  // finished by calling this again.
  async CreateProject(c, r) {
    needAdmin(c);
    const claimed = unwrap(await registry(c.env).claim({ name: text(r, "name", 63), title: optText(r, "title") }));
    const key = await projectStub(c.env, claimed.project.id).init();
    return { project: info(claimed.project), created: claimed.created, publishableKey: key.plain, ingestUrl: ingestUrl(c) };
  },
  async GetProject(c, r) {
    needAdmin(c);
    return { project: info(await resolve(c, text(r, "project"))), ingestUrl: ingestUrl(c) };
  },
  async ListProjects(c) {
    needAdmin(c);
    return { projects: (await registry(c.env).list()).map(info) };
  },
  async SourceKey(c, r) {
    needAdmin(c);
    const p = await resolve(c, text(r, "project"));
    return { key: keyInfo(p.id, unwrap(await projectStub(c.env, p.id).sourceKey(text(r, "source")))) };
  },
  async CreateKey(c, r) {
    needAdmin(c);
    const p = await resolve(c, text(r, "project"));
    const scope = optOneOf(r, "scope", ["publishable", "secret"]);
    if (!scope) throw bad("scope must be publishable or secret");
    return { key: keyInfo(p.id, unwrap(await projectStub(c.env, p.id).createKey(scope, optText(r, "source"), optText(r, "name"))), true) };
  },
  async ListKeys(c, r) {
    needAdmin(c);
    const p = await resolve(c, text(r, "project"));
    return { keys: (await projectStub(c.env, p.id).listKeys(optOneOf(r, "scope", ["publishable", "secret"]))).map((k) => keyInfo(p.id, k)) };
  },
  async RevokeKey(c, r) {
    needAdmin(c);
    const p = await resolve(c, text(r, "project"));
    return { key: keyInfo(p.id, unwrap(await projectStub(c.env, p.id).revokeKey(text(r, "keyId")))) };
  },
  async ConnectWebhook(c, r) {
    needAdmin(c);
    const name = text(r, "provider");
    const provider = providerOf(name);
    if (!provider) throw bad(`provider must be ${providerList()}`);
    const p = await resolve(c, text(r, "project"));
    const given = optText(r, "secret", 500) ?? null;
    if (given !== null && (provider.secret === "generated" || !provider.secret.issued.test(given)))
      throw bad(provider.secret === "generated" ? `${name} does not take a secret: Slurp generates it` : provider.secret.hint);
    const fresh = provider.secret === "generated" ? randomHex(32) : "";
    const hook = unwrap(await projectStub(c.env, p.id).connectWebhook(name, fresh, given));
    return { provider: name, url: `${c.origin}/hooks/${name}?key=${hook.key}`, secret: hook.secret, sender: name, steps: provider.steps };
  },
  async ListArchives(c, r) {
    if (!c.auth) throw new ApiFailure("unauthenticated", "a bearer token is required");
    const p = await resolve(c, text(r, "project"));
    needRead(c, p.id);
    return await projectStub(c.env, p.id).archives(optInt(r, "after", 0, Number.MAX_SAFE_INTEGER), optInt(r, "limit", 1, 5e3) ?? 1e3);
  },
  async Publish(c, r) {
    needAdmin(c);
    const p = await resolve(c, text(r, "project"));
    try {
      return { coverage: await projectStub(c.env, p.id).publish() };
    } catch (e) {
      console.error("publish failed", e);
      throw new ApiFailure("unavailable", "archive storage is unavailable; the events are kept and will be published later");
    }
  }
};
async function rpc(req, c, method) {
  const fail2 = /* @__PURE__ */ __name((e) => Response.json({ error: { code: e.code, message: e.message } }, { status: STATUS[e.code] }), "fail");
  if (req.method !== "POST") return Response.json({ error: { code: "invalid_argument", message: "use POST" } }, { status: 405, headers: { Allow: "POST" } });
  if (!Object.hasOwn(handlers, method)) return fail2(new ApiFailure("not_found", `unknown method ${method}`));
  try {
    const raw = (await req.text()).trim();
    let body = {};
    if (raw !== "") try {
      body = JSON.parse(raw);
    } catch {
      throw bad("the body must be JSON");
    }
    if (!isObject(body)) throw bad("the body must be a JSON object");
    return Response.json(await handlers[method](c, body));
  } catch (e) {
    if (e instanceof ApiFailure) return fail2(e);
    console.error(`${method} failed`, e);
    return fail2(new ApiFailure("unavailable", "storage is unavailable"));
  }
}
__name(rpc, "rpc");
async function download(req, c, project, seq) {
  const plain = /* @__PURE__ */ __name((status, message) => new Response(message, { status }), "plain");
  try {
    needRead(c, project);
  } catch (e) {
    return plain(STATUS[e.code], e.message);
  }
  const n = /^\d{1,15}$/.test(seq) ? Number(seq) : 0;
  if (n < 1 || !await projectStub(c.env, project).hasArchive(n)) return plain(404, "no such archive");
  const key = archiveKey(project, n);
  const obj = req.method === "HEAD" ? await c.env.ARCHIVE.head(key) : await c.env.ARCHIVE.get(key);
  if (!obj) return plain(404, "no such archive");
  return new Response(req.method === "HEAD" ? null : obj.body, {
    headers: { "content-type": "application/gzip", "content-length": String(obj.size), etag: obj.httpEtag, "cache-control": "private, no-transform" }
  });
}
__name(download, "download");

// src/record.ts
var MAX_RECORD_BYTES = 1024 * 1024;
var MAX_DEPTH = 128;
var MAX_REJECTED = 100;
var encoder3 = new TextEncoder();
var utf8Length = /* @__PURE__ */ __name((s) => encoder3.encode(s).length, "utf8Length");
var isObject2 = /* @__PURE__ */ __name((v) => typeof v === "object" && v !== null && !Array.isArray(v), "isObject");
var LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
var wellFormed = /* @__PURE__ */ __name((s) => {
  const native2 = s.isWellFormed;
  return native2 ? native2.call(s) : !LONE_SURROGATE.test(s);
}, "wellFormed");
function walk(value, depth) {
  if (typeof value === "string") return wellFormed(value) ? null : "strings must be well-formed Unicode (lone surrogate)";
  if (value === null || typeof value !== "object") return null;
  if (depth > MAX_DEPTH) return `nesting deeper than ${MAX_DEPTH}`;
  if (Array.isArray(value)) {
    for (const item of value) {
      const bad2 = walk(item, depth + 1);
      if (bad2) return bad2;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!wellFormed(key)) return "keys must be well-formed Unicode (lone surrogate)";
    const bad2 = walk(value[key], depth + 1);
    if (bad2) return bad2;
  }
  return null;
}
__name(walk, "walk");
var TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function validTimestamp(value) {
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = [1, 2, 3, 4, 5, 6].map((k) => Number(m[k]));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false;
  if (m[7] !== void 0 && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
__name(validTimestamp, "validTimestamp");
function fieldError(r) {
  const has = /* @__PURE__ */ __name((k) => Object.hasOwn(r, k), "has");
  const text4 = /* @__PURE__ */ __name((k) => typeof r[k] === "string" ? r[k] : null, "text");
  if (has("type") && r.type !== "track" && r.type !== "identify") return 'type must be "track" or "identify"';
  if (has("id")) {
    const id = text4("id");
    if (id === null || id === "" || id.length > 256 || utf8Length(id) > 256) return "id must be a string of 1-256 bytes";
  }
  if (has("timestamp")) {
    const t = text4("timestamp");
    if (t === null || !validTimestamp(t)) return "timestamp must be RFC 3339";
  }
  for (const k of ["data", "context"]) if (has(k) && !isObject2(r[k])) return `${k} must be an object`;
  for (const k of ["user_id", "anonymous_id", "session_id"]) if (has(k) && !text4(k)) return `${k} must be a non-empty string`;
  if (has("event")) {
    const e = text4("event");
    if (e === null || e === "" || e.length > 400 || [...e].length > 200) return "event must be a string of 1-200 characters";
  }
  if ((r.type ?? "track") === "track" && !has("event")) return "a track record needs event";
  if (r.type === "identify" && !has("user_id")) return "an identify record needs user_id";
  return null;
}
__name(fieldError, "fieldError");
function recordError(text4) {
  if (text4.length * 3 > MAX_RECORD_BYTES && utf8Length(text4) > MAX_RECORD_BYTES) return "record exceeds 1 MiB";
  let value;
  try {
    value = JSON.parse(text4);
  } catch {
    return "not valid JSON";
  }
  if (!isObject2(value)) return "a record must be a JSON object";
  return walk(value, 1) ?? fieldError(value);
}
__name(recordError, "recordError");
var isBlank = /* @__PURE__ */ __name((b) => b === 32 || b === 9 || b === 13, "isBlank");
var decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function splitLines(body) {
  const lines = [];
  let start = 0;
  for (let n = 1; start <= body.length; n++) {
    let stop = body.indexOf(10, start);
    if (stop === -1) stop = body.length;
    let a = start, b = stop;
    while (a < b && isBlank(body[a])) a++;
    while (b > a && isBlank(body[b - 1])) b--;
    if (b > a) {
      try {
        lines.push({ n, text: decoder.decode(body.subarray(a, b)) });
      } catch {
        lines.push({ n, error: "not valid UTF-8" });
      }
    }
    start = stop + 1;
  }
  return lines;
}
__name(splitLines, "splitLines");
function normalizeGeo(cf) {
  if (!cf) return null;
  const geo = {};
  for (const f of ["city", "country", "region"]) {
    const v = typeof cf[f] === "string" ? cf[f].trim() : "";
    if (v !== "" && v.length <= 256) geo[f] = v;
  }
  if (geo.country !== void 0) {
    const c = geo.country.toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1") geo.country = c;
    else delete geo.country;
  }
  return Object.keys(geo).length === 0 ? null : geo;
}
__name(normalizeGeo, "normalizeGeo");
var envelope = /* @__PURE__ */ __name((receivedAtMs, sender, geoJson, record) => `{"received_at":"${new Date(receivedAtMs).toISOString()}","sender":${JSON.stringify(sender)}${geoJson ? `,"geo":${geoJson}` : ""},"record":${record.replace(/[\r\n]/g, " ")}}
`, "envelope");

// src/compat/common.ts
var CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "Retry-After" };
var json = /* @__PURE__ */ __name((status, body, extra = {}) => Response.json(body, { status, headers: { ...CORS, ...extra } }), "json");
var preflight = /* @__PURE__ */ __name((methods, allowHeaders) => new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": methods, "access-control-allow-headers": allowHeaders, "access-control-max-age": "86400" } }), "preflight");
async function publishable(host, token) {
  const auth = token?.startsWith("slurp_pk_") ? await host.authenticate(token) : null;
  return auth?.kind === "key" && auth.scope === "publishable" ? { project: auth.project, token, source: auth.source } : null;
}
__name(publishable, "publishable");
var requestGeo = /* @__PURE__ */ __name((req) => normalizeGeo(req.cf), "requestGeo");
var BodyTooLarge = class extends Error {
  static {
    __name(this, "BodyTooLarge");
  }
};
async function readBounded(req, max, options) {
  if (Number(req.headers.get("content-length") ?? 0) > max) throw new BodyTooLarge();
  const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase().trim();
  if (!req.body) return new Uint8Array();
  const source = options.gunzip && (encoding === "gzip" || encoding === "x-gzip") ? req.body.pipeThrough(new DecompressionStream("gzip")) : req.body;
  const reader = source.getReader();
  const chunks = [];
  let size = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at2 = 0;
  for (const c of chunks) {
    out.set(c, at2);
    at2 += c.byteLength;
  }
  return out;
}
__name(readBounded, "readBounded");
var readBody = /* @__PURE__ */ __name((req, max) => readBounded(req, max, { gunzip: true }), "readBody");
var ingestFailure = /* @__PURE__ */ __name((res) => json(res.status, { error: res.reason }, res.retryAfter ? { "Retry-After": String(res.retryAfter) } : {}), "ingestFailure");
async function submit(host, sender, lines, opts) {
  const valid = [];
  const rejected = [];
  for (const l of lines) {
    const reason = l.error ?? recordError(l.text);
    if (!reason) valid.push(l.text);
    else if (rejected.length < MAX_REJECTED) rejected.push({ line: l.n, reason });
    else if (opts.invalid === "fail") break;
  }
  if (rejected.length && opts.invalid === "fail") return json(400, { error: "invalid records", rejected });
  const result = await host.ingest(sender, valid, opts.geo);
  return result.ok ? { accepted: result.accepted, rejected } : ingestFailure(result);
}
__name(submit, "submit");

// src/compat/hooks.ts
var encoder4 = new TextEncoder();
var decoder2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var fail = /* @__PURE__ */ __name((status, error) => json(status, { error }), "fail");
var hooks = {
  name: "webhook",
  match(_method, url) {
    const m = /^\/hooks\/([^/]+)\/?$/.exec(url.pathname);
    return m ? { provider: m[1] } : null;
  },
  async handle(req, { provider: name }, host) {
    const provider = providerOf(name);
    if (!provider) return fail(404, `unknown webhook provider (${providerList()})`);
    if (req.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });
    const url = new URL(req.url);
    const keys = url.searchParams.getAll("key");
    const principal = keys.length === 1 ? await publishable(host, keys[0]) : null;
    if (!principal || principal.source !== name) return fail(401, "invalid key (the webhook URL carries one publishable key: slurp project webhook shows it)");
    let bytes2;
    try {
      bytes2 = await readBody(req, host.cfg.maxBodyBytes);
    } catch (e) {
      return e instanceof BodyTooLarge ? fail(413, "body too large") : fail(400, "unreadable body");
    }
    const secret = await host.webhookSecret(principal.project, name);
    if (secret === null) return fail(401, `${name} is not connected to this project; run slurp project webhook PROJECT ${name}`);
    if (secret === "") return fail(401, `no signing secret is set for ${name} yet${typeof provider.secret === "object" ? `: ${provider.secret.hint}` : ""}`);
    const bad2 = await provider.verify({ bytes: bytes2, header: /* @__PURE__ */ __name((h) => req.headers.get(h), "header"), payload: void 0, query: url.searchParams }, secret, Date.now());
    if (bad2) return fail(401, bad2);
    let text4;
    try {
      text4 = decoder2.decode(bytes2).trim();
    } catch {
      return fail(400, "the body is not UTF-8 text");
    }
    let payload;
    let isJson = true;
    try {
      payload = JSON.parse(text4);
    } catch {
      isJson = false;
    }
    if (provider.body === "json-object" && !(isJson && isObject(payload)))
      return fail(400, provider.notJson?.(req.headers.get("content-type") ?? "") ?? "the body must be a JSON object");
    const d = await provider.describe({ bytes: bytes2, header: /* @__PURE__ */ __name((h) => req.headers.get(h), "header"), payload, query: url.searchParams });
    if ("error" in d) return fail(400, d.error);
    if ("ignored" in d) return json(200, { ok: true, ignored: d.ignored });
    const data = !isJson ? JSON.stringify({ raw: text4 }) : isObject(payload) ? text4 : `{"items":${text4}}`;
    const event = [...d.event].slice(0, 200).join("");
    const webhook = `{"provider":${JSON.stringify(name)}${d.delivery ? `,"delivery":${JSON.stringify(d.delivery)}` : ""}}`;
    const line = `{${d.id ? `"id":${JSON.stringify(d.id)},` : ""}"type":"track","event":${JSON.stringify(event)}${d.at ? `,"timestamp":"${d.at}"` : ""},"data":${data},"context":{"webhook":${webhook}}}`;
    if (encoder4.encode(line).length > MAX_RECORD_BYTES) return fail(413, "the payload is larger than 1 MiB; Slurp stores payloads whole, so it is refused");
    const result = await submit(host, principal, [{ n: 1, text: line }], { invalid: "fail", geo: null });
    return result instanceof Response ? result : json(200, { ok: true });
  }
};

// src/compat/segment.ts
var SINGLE = { t: "track", i: "identify", p: "page", s: "screen", g: "group", a: "alias" };
var ALLOW_HEADERS = "Authorization, Content-Type, X-Retry-Count";
function segmentRoute(method, path) {
  let m = /^\/v1\/([tipsga])$/.exec(path);
  if (m) return { kind: "single", type: SINGLE[m[1]] };
  if (path === "/v1/b" || path === "/v1/batch") return { kind: "batch" };
  m = /^\/v1\/projects\/([^/]+)\/settings$/.exec(path);
  if (m && (method === "GET" || method === "HEAD" || method === "OPTIONS")) return { kind: "settings", key: decodeURIComponent(m[1]) };
  return null;
}
__name(segmentRoute, "segmentRoute");
var text2 = /* @__PURE__ */ __name((v) => {
  if (typeof v === "string") return v === "" ? void 0 : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return void 0;
}, "text");
function translateMessage(raw, type) {
  if (!isObject(raw)) return { reason: "message must be an object" };
  const kind = type ?? (typeof raw.type === "string" ? raw.type : void 0);
  if (!kind || !["track", "identify", "page", "screen", "group", "alias"].includes(kind)) return { reason: "unknown message type" };
  const userId = text2(raw.userId);
  const anonymousId = text2(raw.anonymousId);
  const properties = isObject(raw.properties) ? raw.properties : {};
  const traits = isObject(raw.traits) ? raw.traits : isObject(raw.context?.traits) && kind === "identify" ? raw.context.traits : {};
  let recordType = "track";
  let event;
  let data;
  switch (kind) {
    case "track":
      event = text2(raw.event);
      if (!event) return { reason: "track needs an event name" };
      data = properties;
      break;
    case "identify":
      if (userId) {
        recordType = "identify";
        data = traits;
      } else {
        event = "identify";
        data = traits;
      }
      break;
    case "page":
    case "screen":
      event = kind;
      data = { ...properties, ...text2(raw.name) ? { name: text2(raw.name) } : {}, ...text2(raw.category) ? { category: text2(raw.category) } : {} };
      break;
    case "group":
      event = "group";
      data = { ...traits, group_id: text2(raw.groupId) ?? null };
      break;
    default:
      event = "alias";
      data = { previous_id: text2(raw.previousId) ?? null };
  }
  const context = isObject(raw.context) ? { ...raw.context } : {};
  if (kind === "identify") delete context.traits;
  context.compat = "segment";
  const id = text2(raw.messageId);
  const timestamp = [raw.timestamp, raw.originalTimestamp].map(isoOrUndefined).find(Boolean);
  const record = {};
  if (id) record.id = id;
  record.type = recordType;
  if (event !== void 0) record.event = event;
  if (timestamp) record.timestamp = timestamp;
  if (userId) record.user_id = userId;
  if (anonymousId) record.anonymous_id = anonymousId;
  record.data = data;
  record.context = context;
  return { line: JSON.stringify(record) };
}
__name(translateMessage, "translateMessage");
function keyFrom(req, body) {
  const auth = /^Basic (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (auth) {
    try {
      const user = atob(auth).split(":")[0];
      if (user) return user;
    } catch {
    }
  }
  const bearer2 = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer2) return bearer2;
  if (isObject(body) && typeof body.writeKey === "string" && body.writeKey) return body.writeKey;
  return new URL(req.url).searchParams.get("key");
}
__name(keyFrom, "keyFrom");
async function ingest(req, route, host) {
  if (route.kind === "settings") return settings(req, route.key, host);
  if (req.method === "OPTIONS") return preflight("POST, GET, OPTIONS", ALLOW_HEADERS);
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST, OPTIONS" });
  let bytes2;
  try {
    bytes2 = await readBody(req, host.cfg.maxBodyBytes);
  } catch (e) {
    if (e instanceof BodyTooLarge) return json(413, { error: "body too large" });
    return json(400, { error: "unreadable body" });
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes2));
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const principal = await publishable(host, keyFrom(req, body));
  if (!principal) return json(401, { error: "invalid write key (use a Slurp publishable key)" });
  let messages;
  let type;
  if (route.kind === "batch") {
    if (!isObject(body) || !Array.isArray(body.batch)) return json(400, { error: "batch must be an array" });
    messages = body.batch;
  } else {
    messages = [body];
    type = route.type;
  }
  const lines = messages.map((m, i) => {
    const t = translateMessage(m, type);
    return "reason" in t ? { n: i + 1, error: t.reason } : { n: i + 1, text: t.line };
  });
  const result = await submit(host, principal, lines, { invalid: "skip", geo: requestGeo(req) });
  if (result instanceof Response) return result;
  if (result.accepted === 0 && messages.length > 0) return json(400, { error: "no valid events in the request", rejected: messages.length });
  return json(200, { success: true, accepted: result.accepted, rejected: messages.length - result.accepted });
}
__name(ingest, "ingest");
async function settings(req, key, host) {
  if (req.method === "OPTIONS") return preflight("POST, GET, OPTIONS", ALLOW_HEADERS);
  if (!await publishable(host, key)) return json(404, { error: "unknown project" });
  const origin = new URL(req.url);
  return json(200, {
    integrations: { "Segment.io": { apiKey: key, apiHost: `${origin.host}/v1`, protocol: origin.protocol === "http:" ? "http" : "https", addBundledMetadata: true, unbundledIntegrations: [] } },
    plan: { track: { __default: { enabled: true, integrations: {} } }, identify: { __default: { enabled: true } }, group: { __default: { enabled: true } } },
    edgeFunction: {},
    analyticsNextEnabled: true,
    middlewareSettings: {},
    enabledMiddleware: {},
    metrics: { sampleRate: 0 },
    legacyVideoPluginsEnabled: false,
    remotePlugins: []
  }, { "cache-control": "public, max-age=60" });
}
__name(settings, "settings");
var segment = { name: "segment", match: /* @__PURE__ */ __name((method, url) => segmentRoute(method, url.pathname), "match"), handle: ingest };

// src/compat/sentry.ts
var ALLOW_HEADERS2 = "X-Sentry-Auth, Content-Type, Sentry-Trace, Baggage, Authorization, Content-Encoding";
var EXPOSE = { "access-control-expose-headers": "X-Sentry-Rate-Limits, Retry-After" };
function sentryRoute(path) {
  const m = /^\/api\/[^/]+\/(envelope|store)\/?$/.exec(path);
  return m ? { kind: m[1] } : null;
}
__name(sentryRoute, "sentryRoute");
var publishableKey = /* @__PURE__ */ __name((value) => value?.startsWith("slurp_pk_") ? value : null, "publishableKey");
var keyFromDsn = /* @__PURE__ */ __name((dsn) => {
  if (typeof dsn !== "string") return null;
  const m = /^[a-z]+:\/\/([^:@/]+)(?::[^@]*)?@/i.exec(dsn);
  return m ? m[1] : null;
}, "keyFromDsn");
function credentials(req, headerDsn) {
  const found = /* @__PURE__ */ new Set();
  const auth = /sentry_key=([^,\s]+)/.exec(req.headers.get("x-sentry-auth") ?? "")?.[1];
  const query = new URL(req.url).searchParams.get("sentry_key");
  for (const v of [auth, query, keyFromDsn(headerDsn)]) if (v) found.add(publishableKey(v) ?? `invalid:${v}`);
  if (found.size > 1) return "conflict";
  return { key: found.size === 1 ? [...found][0] : null };
}
__name(credentials, "credentials");
var decoder3 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
function parseEnvelope(bytes2) {
  const NL = 10;
  let at2 = 0;
  const line = /* @__PURE__ */ __name(() => {
    if (at2 >= bytes2.length) return null;
    let end = bytes2.indexOf(NL, at2);
    if (end === -1) end = bytes2.length;
    const out = bytes2.subarray(at2, end);
    at2 = Math.min(end + 1, bytes2.length);
    return out;
  }, "line");
  const jsonLine = /* @__PURE__ */ __name((b) => {
    const v = JSON.parse(decoder3.decode(b));
    if (!isObject(v)) throw new Error("header must be an object");
    return v;
  }, "jsonLine");
  const first = line();
  if (!first) throw new Error("empty envelope");
  const header = jsonLine(first);
  const items = [];
  for (; ; ) {
    let h = line();
    while (h && h.length === 0) h = line();
    if (!h) break;
    const itemHeader = jsonLine(h);
    const length = itemHeader.length;
    let payload;
    if (typeof length === "number" && Number.isSafeInteger(length) && length >= 0) {
      if (at2 + length > bytes2.length) throw new Error("item length exceeds the body");
      payload = bytes2.subarray(at2, at2 + length);
      at2 += length;
      if (at2 < bytes2.length) {
        if (bytes2[at2] !== NL) throw new Error("item payload is not followed by a newline");
        at2++;
      }
    } else {
      payload = line() ?? new Uint8Array();
    }
    items.push({ type: typeof itemHeader.type === "string" ? itemHeader.type : "", header: itemHeader, payload });
  }
  return { header, items };
}
__name(parseEnvelope, "parseEnvelope");
var text3 = /* @__PURE__ */ __name((v) => typeof v === "string" && v !== "" ? v : void 0, "text");
var timestampOf = /* @__PURE__ */ __name((v) => typeof v === "number" ? isoOrUndefined(v * 1e3) : isoOrUndefined(v), "timestampOf");
var hasException = /* @__PURE__ */ __name((e) => {
  const x = e.exception;
  const values = isObject(x) && Array.isArray(x.values) ? x.values : Array.isArray(x) ? x : [];
  return values.some((v) => isObject(v) && !(isObject(v.mechanism) && v.mechanism.synthetic === true));
}, "hasException");
function translateItem(item, header, itemHash) {
  const kind = item.type;
  if (kind !== "event" && kind !== "user_report" && kind !== "feedback" && kind !== "check_in") return null;
  let payload;
  try {
    payload = JSON.parse(decoder3.decode(item.payload));
  } catch {
    return { reason: `${kind} payload is not JSON` };
  }
  if (!isObject(payload)) return { reason: `${kind} payload is not an object` };
  const user = isObject(payload.user) ? payload.user : {};
  const userId = text3(user.id) ?? (typeof user.id === "number" ? String(user.id) : void 0) ?? text3(user.email) ?? text3(user.username);
  const sdk = isObject(payload.sdk) ? payload.sdk : null;
  const context = { compat: "sentry" };
  if (sdk && text3(sdk.name)) context.library = { name: sdk.name, ...text3(sdk.version) ? { version: sdk.version } : {} };
  let event;
  let id;
  if (kind === "event") {
    event = hasException(payload) || ["error", "fatal"].includes(String(payload.level)) ? "error" : "message";
    id = text3(header.event_id) ?? text3(payload.event_id);
  } else {
    event = kind === "check_in" ? "check_in" : "user_feedback";
    id = itemHash ? `sentry-${itemHash}` : void 0;
  }
  const timestamp = timestampOf(payload.timestamp);
  const record = { ...id ? { id } : {}, type: "track", event, ...timestamp ? { timestamp } : {} };
  if (userId) record.user_id = userId;
  record.data = payload;
  record.context = context;
  return { line: JSON.stringify(record) };
}
__name(translateItem, "translateItem");
async function ingest2(req, route, host) {
  if (req.method === "OPTIONS") return preflight("POST, GET, OPTIONS", ALLOW_HEADERS2);
  const reply = /* @__PURE__ */ __name((status, body, extra = {}) => json(status, body, { ...EXPOSE, ...extra }), "reply");
  if (req.method !== "POST") return reply(405, { detail: "method not allowed" }, { Allow: "POST, OPTIONS" });
  let bytes2;
  try {
    bytes2 = await readBody(req, host.cfg.maxBodyBytes);
  } catch (e) {
    if (e instanceof BodyTooLarge) return reply(413, { detail: "body too large" });
    return reply(400, { detail: "unreadable body" });
  }
  let envelope2;
  try {
    if (route.kind === "envelope") envelope2 = parseEnvelope(bytes2);
    else {
      const event = JSON.parse(decoder3.decode(bytes2));
      if (!isObject(event)) throw new Error("event must be an object");
      envelope2 = { header: { event_id: event.event_id }, items: [{ type: "event", header: { type: "event" }, payload: bytes2 }] };
    }
  } catch (e) {
    return reply(400, { detail: `malformed envelope: ${e.message}` });
  }
  const creds = credentials(req, envelope2.header.dsn);
  if (creds === "conflict") return reply(403, { detail: "conflicting credentials" });
  const principal = await publishable(host, creds.key);
  if (!principal) return reply(403, { detail: "invalid or missing sentry_key (use the DSN Slurp prints for this project)" });
  const lines = [];
  for (const item of envelope2.items) {
    const t = translateItem(item, envelope2.header, item.type === "event" ? void 0 : await sha256Hex(item.payload));
    if (t && "line" in t) lines.push({ n: lines.length + 1, text: t.line });
  }
  const result = await submit(host, principal, lines, { invalid: "skip", geo: requestGeo(req) });
  return result instanceof Response ? new Response(result.body, { status: result.status, headers: { ...Object.fromEntries(result.headers), ...EXPOSE } }) : reply(200, { id: text3(envelope2.header.event_id) ?? "" });
}
__name(ingest2, "ingest");
var sentry = { name: "sentry", match: /* @__PURE__ */ __name((_method, url) => sentryRoute(url.pathname), "match"), handle: ingest2 };

// src/config.ts
var NUMBERS = [
  ["SEAL_INTERVAL_MS", "sealIntervalMs", 6e5, 1],
  ["ARCHIVE_MAX_BYTES", "archiveMaxBytes", 8 * 1024 * 1024, 1],
  ["GROUP_COMMIT_MS", "groupCommitMs", 500, 0],
  ["BUFFER_CAP_BYTES", "bufferCapBytes", 64 * 1024 * 1024, 1],
  ["MAX_BODY_BYTES", "maxBodyBytes", 10 * 1024 * 1024, 1],
  ["RETENTION_DAYS", "retentionDays", 0, 0],
  ["ARCHIVE_RETRY_MS", "archiveRetryMs", 5e3, 1]
];
var warned = /* @__PURE__ */ new Set();
var defaultWarn = /* @__PURE__ */ __name((name, value, why) => {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`${name}=${JSON.stringify(value)} ${why}; using the default`);
}, "defaultWarn");
function parseConfig(env, warn = defaultWarn) {
  const config = {};
  for (const [name, field, fallback, minimum] of NUMBERS) {
    const raw = env[name];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (raw !== void 0 && !(Number.isFinite(n) && n >= minimum)) warn(name, raw, `is not a number of at least ${minimum}`);
    config[field] = Number.isFinite(n) && n >= minimum ? n : fallback;
  }
  const geo = env.GEO;
  if (geo !== void 0 && geo !== "on" && geo !== "off") warn("GEO", geo, 'is not "on" or "off"');
  config.geo = geo !== "off";
  return config;
}
__name(parseConfig, "parseConfig");
var cache = /* @__PURE__ */ new WeakMap();
var configOf = /* @__PURE__ */ __name((env) => {
  let config = cache.get(env);
  if (!config) {
    config = parseConfig(env);
    cache.set(env, config);
  }
  return config;
}, "configOf");

// src/debug.ts
async function debugRoute(req, env, auth) {
  const url = new URL(req.url);
  if (env.DEBUG !== "1" || auth?.kind !== "admin" || !url.pathname.startsWith("/__debug/")) return null;
  const [, , op, id] = url.pathname.split("/");
  const stub = projectStub(env, id);
  const ok = /* @__PURE__ */ __name(() => Response.json({ ok: true }), "ok");
  const stats = /* @__PURE__ */ __name(async () => Response.json(await stub.stats()), "stats");
  const fault = /* @__PURE__ */ __name(async (which) => {
    await stub.fault(which, url.searchParams.get("off") === null);
    return ok();
  }, "fault");
  switch (op) {
    case "flush":
      await stub.flush();
      return stats();
    case "publish":
      await stub.publish();
      return stats();
    // `?force=1` publishes even when nothing is due yet; without it this is the alarm exactly as the platform runs it.
    case "alarm":
      await stub.runAlarm(url.searchParams.get("force") !== null);
      return stats();
    case "sweep":
      await stub.sweep();
      return stats();
    case "stats":
      return stats();
    case "fail-flush":
      return fault("flush");
    case "fail-archive":
      return fault("archive");
    case "fail-after-put":
      return fault("after-put");
    case "fail-alarm":
      return fault("alarm");
    case "heal-archive":
      await stub.fault("archive", false);
      return ok();
    default:
      return null;
  }
}
__name(debugRoute, "debugRoute");

// src/landing.ts
var esc = /* @__PURE__ */ __name((s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]), "esc");
function setupPage(origin, configured) {
  const o = esc(origin);
  const setup = configured ? "" : `<p class="warn"><strong>Not finished.</strong> The <code>ADMIN_TOKEN</code> secret is missing or too short (20 characters minimum). Set it in the Cloudflare dashboard under this Worker's Settings, Variables and Secrets, or run <code>npx wrangler secret put ADMIN_TOKEN</code>. Then reload this page.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Slurp is running</title>
<style>
:root{--bg:#fff;--fg:#17191c;--muted:#535c66;--rule:#e4e7eb;--code:#f6f9fc;--accent:#e8002a}
@media(prefers-color-scheme:dark){:root{--bg:#101215;--fg:#eceff2;--muted:#9aa4af;--rule:#262b31;--code:#171b20}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:56px 20px}
h1{font-size:28px;margin:0 0 8px}p{color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${configured ? "#1a9d5c" : "#e8a000"};margin-right:10px}
pre{background:var(--code);border:1px solid var(--rule);border-radius:7px;padding:14px 16px;overflow:auto;font-size:13px;color:var(--fg)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.warn{border:1px solid var(--rule);border-left:3px solid #e8a000;padding:12px 16px;border-radius:4px}
ol{padding-left:20px}li{margin:10px 0}a{color:var(--accent)}
</style></head><body><main>
<h1><span class="dot"></span>Slurp is running</h1>
<p>This is your own Slurp Worker. Events you send here are stored in your Cloudflare account and nowhere else.</p>
${setup}
<h2>Connect your computer</h2>
<ol>
<li>Install the Slurp CLI.</li>
<li>Connect it to this Worker with the <code>ADMIN_TOKEN</code> you chose when you deployed. The token is read from standard input, so it never shows up in your shell history:
<pre><code>slurp connect ${o} --token-stdin</code></pre></li>
<li>In your app's folder, create a project and get the SDK snippet:
<pre><code>slurp setup
slurp init --name "My app"</code></pre></li>
</ol>
<p>Your SDK sends events to <code>${o}/v1/events</code> with a publishable key. <code>slurp init</code> prints both for you.</p>
<p><a href="https://github.com/hitSlop/slurp/blob/main/docs/self-hosting.md">Self-hosting guide</a> \xB7 <a href="${o}/v1/health">Health</a></p>
</main></body></html>`;
}
__name(setupPage, "setupPage");

// src/native.ts
var native = {
  name: "ingest",
  match: /* @__PURE__ */ __name((_method, url) => url.pathname === "/v1/events" ? true : null, "match"),
  async handle(req, _route, host) {
    if (req.method === "OPTIONS") return preflight("POST, OPTIONS", "Authorization, Content-Type");
    if (req.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST, OPTIONS" });
    const token = presentedToken(req, true);
    if (!token) return json(401, { error: "invalid key" });
    const project = projectOfKey(token);
    if (!project) {
      return await host.authenticate(token) ? json(403, { error: "publishable key required" }) : json(401, { error: "invalid key" });
    }
    let body;
    try {
      body = await readBounded(req, host.cfg.maxBodyBytes, { gunzip: false });
    } catch (e) {
      return e instanceof BodyTooLarge ? json(413, { error: "body too large" }) : json(400, { error: "unreadable body" });
    }
    const result = await submit(host, { project, token }, splitLines(body), { invalid: "fail", geo: requestGeo(req) });
    return result instanceof Response ? result : json(200, { ok: true, accepted: result.accepted });
  }
};

// src/registry.ts
import { DurableObject } from "cloudflare:workers";
var RESERVED_PREFIXES = ["session_", "prj_", "mdl_"];
var RESERVED_WORDS = new Set("_slurp add all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create default deferrable desc describe distinct do else end except false fetch for foreign from group having in information_schema initially intersect into lake lambda lateral leading limit main memory not null offset on only or order pg_catalog pivot pivot_longer pivot_wider placing primary qualify raw references returning select show some summarize symmetric system table temp then to trailing true union unique unpivot using variadic when where window with".split(" "));
function validProjectName(name) {
  return name.length >= 1 && name.length <= 63 && /^[a-z][a-z0-9_]*$/.test(name) && !name.includes("__") && !RESERVED_PREFIXES.some((p) => name.startsWith(p)) && !RESERVED_WORDS.has(name);
}
__name(validProjectName, "validProjectName");
function validTitle(title) {
  return title === void 0 || new TextEncoder().encode(title).length <= 200;
}
__name(validTitle, "validTitle");
var RegistryDO = class extends DurableObject {
  static {
    __name(this, "RegistryDO");
  }
  sql = this.ctx.storage.sql;
  constructor(ctx, env) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, title TEXT, created_at TEXT NOT NULL)");
  }
  /** The project with this name, creating it first if there is none. Repeating a call returns the same project. */
  claim(a) {
    if (!validProjectName(a.name) || !validTitle(a.title)) return { ok: false, code: "invalid", message: "invalid project details" };
    const existing = this.sql.exec("SELECT * FROM projects WHERE name=?", a.name).toArray()[0];
    if (existing) return { ok: true, value: { project: existing, created: false } };
    const id = "prj_" + randomHex(8);
    this.sql.exec("INSERT INTO projects VALUES(?,?,?,?)", id, a.name, a.title ?? null, (/* @__PURE__ */ new Date()).toISOString());
    return { ok: true, value: { project: this.get(id), created: true } };
  }
  get(ref) {
    return this.sql.exec("SELECT * FROM projects WHERE id=? OR name=? LIMIT 1", ref, ref).toArray()[0] ?? null;
  }
  list() {
    return this.sql.exec("SELECT * FROM projects ORDER BY id").toArray();
  }
  /** Forget every project (used by `slurp cloud destroy`). */
  async purge() {
    await this.ctx.storage.deleteAll();
    this.sql.exec("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, title TEXT, created_at TEXT NOT NULL)");
  }
};

// src/project.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";

// src/db.ts
var Db = class {
  static {
    __name(this, "Db");
  }
  /** Rows written since this object was constructed, and `setAlarm`/`deleteAlarm` calls (each bills a row too). */
  rowsWritten = 0;
  alarmWrites = 0;
  sql;
  constructor(sql) {
    this.sql = sql;
  }
  /** Run a statement to the end and return its rows. */
  rows(query, ...bindings) {
    const cursor = this.sql.exec(query, ...bindings);
    const out = cursor.toArray();
    this.rowsWritten += cursor.rowsWritten;
    return out;
  }
  one(query, ...bindings) {
    return this.rows(query, ...bindings)[0];
  }
};
var SCHEMA = `
CREATE TABLE IF NOT EXISTS keys(key_id TEXT PRIMARY KEY, scope TEXT NOT NULL, source TEXT, name TEXT, plain TEXT UNIQUE, hash TEXT UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS webhooks(provider TEXT PRIMARY KEY, source TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, events INTEGER NOT NULL, bytes INTEGER NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intent(seq INTEGER PRIMARY KEY, through_chunk INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS manifest(seq INTEGER PRIMARY KEY, size INTEGER NOT NULL, sha256 TEXT NOT NULL, events INTEGER NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// src/project.ts
var SOURCE = /^[a-z][a-z0-9_]{0,31}$/;
var CHUNK_MAX_BYTES = 6 * 1024 * 1024;
var encoder5 = new TextEncoder();
var ProjectDO = class extends DurableObject2 {
  static {
    __name(this, "ProjectDO");
  }
  db = new Db(this.ctx.storage.sql);
  cfg = configOf(this.env);
  publisher = new Publisher(this.ctx, this.env, this.db, this.cfg, this.ctx.id.name ?? "");
  ready = false;
  queue = [];
  queuedBytes = 0;
  timer = null;
  /** Test hook (DEBUG only): make the next group commit fail once. */
  failFlush = false;
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = this.db.rows("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keys'").length > 0;
    if (!this.ready) return;
    this.db.rows(SCHEMA);
    this.publisher.load();
    ctx.blockConcurrencyWhile(async () => {
      await this.publisher.syncAlarm();
      await this.publisher.rearm();
    });
  }
  get project() {
    return this.ctx.id.name ?? "";
  }
  now = /* @__PURE__ */ __name(() => (/* @__PURE__ */ new Date()).toISOString(), "now");
  /** Create this project's storage and its `default` source key, or return the existing one. Safe to repeat. */
  init() {
    if (!this.ready) {
      this.db.rows(SCHEMA);
      this.ready = true;
    }
    return this.sourceKey("default").value;
  }
  // ---- keys ----
  mint(scope, source, name, hash, key) {
    const row = { key_id: randomHex(8), scope, source, name, plain: hash ? null : key, created_at: this.now(), revoked_at: null };
    this.db.rows("INSERT INTO keys(key_id, scope, source, name, plain, hash, created_at) VALUES(?,?,?,?,?,?,?)", row.key_id, scope, source, name, row.plain, hash, row.created_at);
    return row;
  }
  publishableKey(source) {
    return `slurp_pk_${this.project.slice(4)}_${source}_${randomHex(24)}`;
  }
  /** The key's scope and the source or label it carries; null when it is unknown or revoked (at once: nothing is cached). */
  async authorize(token) {
    if (!this.ready) return null;
    const secret = token.startsWith("slurp_sk_");
    const row = this.db.one(`SELECT * FROM keys WHERE ${secret ? "hash" : "plain"}=? AND revoked_at IS NULL`, secret ? await sha256Hex(token) : token);
    if (!row) return null;
    return row.scope === "secret" ? { scope: "secret", keyId: row.key_id, name: row.name ?? "default" } : { scope: "publishable", keyId: row.key_id, source: row.source };
  }
  /** The oldest live publishable key for `source`, made if there is none (so asking again never makes a second one). */
  sourceKey(source) {
    if (!this.ready) return { ok: false, code: "notfound", message: "project" };
    if (!SOURCE.test(source)) return { ok: false, code: "invalid", message: "source must be a lowercase name of up to 32 letters, digits and underscores, starting with a letter" };
    const live = this.db.one("SELECT * FROM keys WHERE scope='publishable' AND source=? AND revoked_at IS NULL ORDER BY rowid LIMIT 1", source);
    if (live) return { ok: true, value: live };
    const key = this.publishableKey(source);
    return { ok: true, value: this.mint("publishable", source, null, null, key) };
  }
  async createKey(scope, source, name) {
    if (!this.ready) return { ok: false, code: "notfound", message: "project" };
    if (scope === "publishable") {
      if (source === void 0 || !SOURCE.test(source)) return { ok: false, code: "invalid", message: "a publishable key needs a source: lowercase letters, digits and underscores, starting with a letter, up to 32" };
      return { ok: true, value: this.mint("publishable", source, null, null, this.publishableKey(source)) };
    }
    const label = name === void 0 || name.trim() === "" ? "default" : name;
    if (encoder5.encode(label).length > 200) return { ok: false, code: "invalid", message: "name is too long" };
    const key = `slurp_sk_${this.project.slice(4)}_${randomHex(24)}`;
    const row = this.mint("secret", null, label, await sha256Hex(key), key);
    return { ok: true, value: { ...row, plain: key } };
  }
  listKeys(scope) {
    if (!this.ready) return [];
    return this.db.rows("SELECT * FROM keys ORDER BY rowid").filter((k) => !scope || k.scope === scope);
  }
  revokeKey(keyId) {
    if (!this.ready) return { ok: false, code: "notfound", message: "project" };
    if (!this.db.one("SELECT 1 FROM keys WHERE key_id=?", keyId)) return { ok: false, code: "notfound", message: "key" };
    this.db.rows("UPDATE keys SET revoked_at=? WHERE key_id=? AND revoked_at IS NULL", this.now(), keyId);
    return { ok: true, value: this.db.one("SELECT * FROM keys WHERE key_id=?", keyId) };
  }
  // ---- webhook connections ----
  /**
   * Connect a provider. Idempotent: with a live key for the provider's source the connection is returned as it is. With none (never
   * connected, or the key was revoked) a new key is made and the secret is replaced too, so rotating is revoke, then connect again.
   * `fresh` is the secret to use then ('' for a provider that issues its own); `given` is one the user supplied (always stored).
   */
  connectWebhook(provider, fresh, given) {
    if (!this.ready) return { ok: false, code: "notfound", message: "project" };
    const existed = this.db.one("SELECT 1 FROM keys WHERE scope='publishable' AND source=? AND revoked_at IS NULL", provider) !== void 0;
    const key = this.sourceKey(provider);
    if (!key.ok) return key;
    const replace = !existed || given !== null;
    this.db.rows("INSERT INTO webhooks VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET secret=excluded.secret WHERE ?", provider, provider, given ?? fresh, this.now(), replace ? 1 : 0);
    return { ok: true, value: { secret: this.webhookSecret(provider), key: key.value.plain } };
  }
  /** The provider's signing secret ('' until Stripe's has been given), or null when it has not been connected. */
  webhookSecret(provider) {
    return this.ready ? this.db.one("SELECT secret FROM webhooks WHERE provider=?", provider)?.secret ?? null : null;
  }
  // ---- ingest ----
  /**
   * The only way events enter: check the presented key here, at enqueue (so a key revoked while its body was uploading gets nothing
   * stored), take the source from the stored key, wrap each line in an envelope, commit them, and answer once they are durable.
   */
  async ingest(token, lines, geo) {
    const principal = await this.authorize(token);
    if (!principal) return { ok: false, status: 401, reason: "invalid key", retryAfter: 0 };
    if (principal.scope !== "publishable") return { ok: false, status: 403, reason: "publishable key required", retryAfter: 0 };
    const source = principal.source;
    if (lines.length === 0) return { ok: true, accepted: 0 };
    const atMs = Date.now();
    const geoJson = this.cfg.geo && geo ? JSON.stringify(geo) : null;
    const wrapped = lines.map((l) => envelope(atMs, source, geoJson, l));
    const sizes = wrapped.map((l) => encoder5.encode(l).length);
    const bytes2 = sizes.reduce((a, b) => a + b, 0);
    if (this.publisher.bufferedBytes + this.queuedBytes + bytes2 > this.cfg.bufferCapBytes) return { ok: false, status: 429, reason: "buffer full", retryAfter: 10 };
    const done = new Promise((resolve2) => {
      this.queue.push({ lines: wrapped, sizes, bytes: bytes2, atMs, done: resolve2 });
      this.queuedBytes += bytes2;
    });
    if (this.cfg.groupCommitMs <= 0 || this.queuedBytes >= CHUNK_MAX_BYTES) await this.flush();
    else if (!this.timer) this.timer = setTimeout(() => {
      void this.flush();
    }, this.cfg.groupCommitMs);
    return done;
  }
  /** Commit everything queued as chunks (at most CHUNK_MAX_BYTES each) in one transaction, then acknowledge it. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const q = this.queue;
    if (q.length === 0) return;
    this.queue = [];
    this.queuedBytes = 0;
    try {
      if (this.failFlush) {
        this.failFlush = false;
        throw new Error("injected flush failure");
      }
      const chunks = [];
      let cur;
      for (const item of q) {
        item.lines.forEach((line, i) => {
          if (!cur || cur.bytes + item.sizes[i] > CHUNK_MAX_BYTES) chunks.push(cur = { data: [], events: 0, bytes: 0, atMs: item.atMs });
          cur.data.push(line);
          cur.events++;
          cur.bytes += item.sizes[i];
        });
      }
      this.ctx.storage.transactionSync(() => {
        for (const c of chunks) this.db.rows("INSERT INTO chunks(events, bytes, at_ms, data) VALUES(?,?,?,?)", c.events, c.bytes, c.atMs, c.data.join(""));
      });
      this.publisher.bufferedBytes += q.reduce((n, item) => n + item.bytes, 0);
    } catch (e) {
      console.error("flush failed", e);
      for (const item of q) item.done({ ok: false, status: 503, reason: "unavailable", retryAfter: 5 });
      return;
    }
    try {
      await this.publisher.rearm();
    } catch (e) {
      console.error("the alarm could not be set; the requests were answered 503 so their senders retry", e);
      for (const item of q) item.done({ ok: false, status: 503, reason: "unavailable", retryAfter: 5 });
      return;
    }
    for (const item of q) item.done({ ok: true, accepted: item.lines.length });
  }
  // ---- archives ----
  async alarm() {
    await this.runAlarm(false);
  }
  /** The alarm's work; `force` publishes even if nothing is due yet (tests). */
  async runAlarm(force) {
    await this.flush();
    await this.publisher.alarm(force);
  }
  /** Publish everything buffered now, then report where archives stand. Throws if R2 fails. */
  async publish() {
    await this.flush();
    try {
      await this.publisher.publishAll();
    } catch (e) {
      this.publisher.fail(e, Date.now());
      try {
        await this.publisher.rearm();
      } catch (a) {
        console.error("could not set the alarm after a failed publish", a);
      }
      throw e;
    }
    await this.publisher.rearm();
    return this.coverage();
  }
  coverage() {
    return this.ready ? this.publisher.coverage(this.queue.length > 0) : { pending: false };
  }
  archives(after, limit) {
    return this.ready ? this.publisher.list(after, limit, this.queue.length > 0) : { coverage: { pending: false }, archives: [] };
  }
  /** Whether archive `seq` exists (published, not deleted by retention). */
  hasArchive(seq) {
    return this.ready && this.publisher.has(seq);
  }
  /** Delete this project's archives from R2 and all of its storage (used by `slurp cloud destroy`). */
  async purge() {
    const archives = this.ready ? await this.publisher.deleteArchives() : 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.queuedBytes = 0;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
    this.publisher.armed = null;
    this.publisher.bufferedBytes = 0;
    return { archives };
  }
  // ---- test hooks (the DEBUG routes only) ----
  async fault(which, on) {
    if (which === "flush") this.failFlush = on;
    else if (which === "archive") this.publisher.faults.archive = on;
    else if (which === "alarm") this.publisher.faults.alarm = on;
    else this.publisher.faults.afterPut = on;
  }
  async sweep() {
    await this.publisher.sweep();
    await this.publisher.rearm();
  }
  async stats() {
    if (!this.ready) return { ready: false, pending: false, rowsWritten: this.db.rowsWritten, alarmWrites: this.db.alarmWrites };
    const n = /* @__PURE__ */ __name((table, where = "1") => this.db.one(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).n, "n");
    return {
      ready: true,
      pending: this.coverage().pending,
      queued: this.queue.length,
      bufferedBytes: this.publisher.bufferedBytes,
      chunks: n("chunks"),
      intent: this.db.one("SELECT seq, through_chunk FROM intent") ?? null,
      manifest: n("manifest"),
      live: n("manifest", "deleted_at IS NULL"),
      alarm: await this.ctx.storage.getAlarm(),
      armed: this.publisher.armed,
      rowsWritten: this.db.rowsWritten,
      alarmWrites: this.db.alarmWrites,
      failures: Number(this.db.one("SELECT v FROM settings WHERE k='failures'")?.v ?? 0),
      retryAt: this.db.one("SELECT v FROM settings WHERE k='retry_at'")?.v ?? null
    };
  }
};

// src/index.ts
var ADAPTERS = [native, segment, sentry, hooks];
var makeHost = /* @__PURE__ */ __name((env) => ({
  cfg: configOf(env),
  authenticate: /* @__PURE__ */ __name((token) => authenticate(env, token), "authenticate"),
  ingest: /* @__PURE__ */ __name((sender, lines, geo) => projectStub(env, sender.project).ingest(sender.token, lines, geo), "ingest"),
  webhookSecret: /* @__PURE__ */ __name((project, provider) => Promise.resolve(projectStub(env, project).webhookSecret(provider)), "webhookSecret")
}), "makeHost");
async function purge(req, env, ctx) {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  if (ctx.auth?.kind !== "admin") return Response.json({ error: ctx.auth ? "admin token required" : "invalid token" }, { status: ctx.auth ? 403 : 401 });
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== "delete-all-data") return Response.json({ error: 'send {"confirm":"delete-all-data"} to confirm' }, { status: 400 });
  const registry2 = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  const projects = await registry2.list();
  let archives = 0;
  for (const p of projects) archives += (await projectStub(env, p.id).purge()).archives;
  let strays = 0;
  for (; ; ) {
    const page = await env.ARCHIVE.list({ prefix: "projects/", limit: 1e3 });
    if (page.objects.length === 0) break;
    await env.ARCHIVE.delete(page.objects.map((o) => o.key));
    strays += page.objects.length;
  }
  await registry2.purge();
  return Response.json({ ok: true, projects: projects.length, archives, strays });
}
__name(purge, "purge");
var index_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = makeHost(env);
    for (const adapter of ADAPTERS) {
      const route = adapter.match(req.method, url);
      if (route === null) continue;
      try {
        return await adapter.handle(req, route, host);
      } catch (e) {
        console.error(`${adapter.name} ingest failed`, e);
        return json(503, { error: "unavailable" }, { "Retry-After": "5" });
      }
    }
    const path = url.pathname;
    if (path === "/healthz") return new Response("ok\n");
    if (path === "/" && (req.method === "GET" || req.method === "HEAD"))
      return new Response(req.method === "HEAD" ? null : setupPage(url.origin, adminConfigured(env)), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" }
      });
    if (path === "/v1/health") return Response.json({ ok: true, apiVersion: 2, configured: adminConfigured(env), build: env.SLURP_BUILD ?? null, geo: host.cfg.geo });
    const ctx = { env, cfg: host.cfg, auth: await authenticate(env, bearer(req)), origin: url.origin };
    const method = /^\/v1\/rpc\/([A-Za-z]+)$/.exec(path)?.[1];
    if (method) return rpc(req, ctx, method);
    const archive = /^\/v1\/projects\/(prj_[0-9a-f]{16})\/archives\/([^/]+)$/.exec(path);
    if (archive) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      return download(req, ctx, archive[1], archive[2]);
    }
    if (path === "/v1/admin/purge") return purge(req, env, ctx);
    return await debugRoute(req, env, ctx.auth) ?? new Response("not found", { status: 404 });
  }
};
export {
  ProjectDO,
  RegistryDO,
  index_default as default
};
