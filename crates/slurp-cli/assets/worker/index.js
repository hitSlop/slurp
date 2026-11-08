var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/util.ts
var enc = new TextEncoder();
var bytesToHex = /* @__PURE__ */ __name((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""), "bytesToHex");
var sha256Hex = /* @__PURE__ */ __name(async (d) => bytesToHex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : d)), "sha256Hex");
var randomHex = /* @__PURE__ */ __name((bytes) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer), "randomHex");
var b64url = /* @__PURE__ */ __name((b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64url");
var fromB64url = /* @__PURE__ */ __name((s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), "fromB64url");
async function hmacBytesHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, data));
}
__name(hmacBytesHex, "hmacBytesHex");
var hmacHex = /* @__PURE__ */ __name((secret, msg) => hmacBytesHex(secret, enc.encode(msg)), "hmacHex");
var MIN_TIME_MS = 0;
var MAX_TIME_MS = 253402300799999;
function isoOrUndefined(value) {
  const ms = typeof value === "number" ? value : typeof value === "string" ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) && ms >= MIN_TIME_MS && ms <= MAX_TIME_MS ? new Date(ms).toISOString() : void 0;
}
__name(isoOrUndefined, "isoOrUndefined");
var envNumber = /* @__PURE__ */ __name((value, fallback) => Number(value) > 0 ? Number(value) : fallback, "envNumber");
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
async function gzip(text3) {
  const stream = new Blob([text3]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
__name(gzip, "gzip");
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

// src/canonical.ts
var MAX_RECORD_BYTES = 1024 * 1024;
var MAX_DEPTH = 128;
var RECORD_TOO_LARGE = "record exceeds 1 MiB";
var RESERVED = ["received_at", "received_seq", "sender"];
var MAX_LINES = 1 << 20;
var Reject = class extends Error {
  static {
    __name(this, "Reject");
  }
};
var NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
function scan(s) {
  let i = 0;
  const n = s.length;
  const members = /* @__PURE__ */ new Map();
  let context;
  const fail2 = /* @__PURE__ */ __name((m) => {
    throw new Reject(m);
  }, "fail");
  const ws = /* @__PURE__ */ __name(() => {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  }, "ws");
  const hex4 = /* @__PURE__ */ __name((at2) => {
    if (at2 + 4 > n) return fail2("invalid escape");
    const h = s.slice(at2, at2 + 4);
    return /^[0-9a-fA-F]{4}$/.test(h) ? parseInt(h, 16) : fail2("invalid escape");
  }, "hex4");
  function str2() {
    i++;
    for (; ; ) {
      if (i >= n) fail2("unterminated string");
      const c = s.charCodeAt(i);
      if (c === 34) {
        i++;
        return;
      }
      if (c < 32) fail2("control character in string");
      if (c !== 92) {
        i++;
        continue;
      }
      const e = s[i + 1];
      if (e === "u") {
        const u = hex4(i + 2);
        i += 6;
        if (u >= 55296 && u <= 56319) {
          if (s[i] !== "\\" || s[i + 1] !== "u") fail2("invalid surrogate");
          const lo = hex4(i + 2);
          if (lo < 56320 || lo > 57343) fail2("invalid surrogate");
          i += 6;
        } else if (u >= 56320 && u <= 57343) fail2("invalid surrogate");
      } else if (e !== void 0 && '"\\/bfnrt'.includes(e)) i += 2;
      else fail2("invalid escape");
    }
  }
  __name(str2, "str");
  function value(depth) {
    ws();
    if (i >= n) return fail2("unexpected end");
    const c = s[i];
    if (c === "{") return obj(depth + 1);
    if (c === "[") {
      arr(depth + 1);
      return void 0;
    }
    if (c === '"') {
      str2();
      return void 0;
    }
    for (const lit of ["true", "false", "null"]) if (s.startsWith(lit, i)) {
      i += lit.length;
      return void 0;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (!m) return fail2("invalid value");
    i += m[0].length;
    return void 0;
  }
  __name(value, "value");
  function arr(depth) {
    if (depth > MAX_DEPTH) fail2("nesting too deep");
    i++;
    ws();
    if (s[i] === "]") {
      i++;
      return;
    }
    for (; ; ) {
      value(depth);
      ws();
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === "]") {
        i++;
        return;
      }
      fail2("expected , or ]");
    }
  }
  __name(arr, "arr");
  function obj(depth) {
    if (depth > MAX_DEPTH) fail2("nesting too deep");
    const open = i;
    i++;
    const keys = /* @__PURE__ */ new Set();
    ws();
    if (s[i] === "}") {
      i++;
      return { keys, open, close: i - 1 };
    }
    for (; ; ) {
      ws();
      if (s[i] !== '"') fail2("expected string key");
      const ks = i;
      str2();
      const raw = s.slice(ks, i);
      const key = raw.includes("\\") ? JSON.parse(raw) : raw.slice(1, -1);
      if (keys.has(key)) fail2("duplicate name");
      keys.add(key);
      ws();
      if (s[i] !== ":") fail2("expected :");
      i++;
      ws();
      const vs = i;
      const child = value(depth);
      if (depth === 1) {
        members.set(key, [vs, i]);
        if (key === "context") context = child;
      }
      ws();
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === "}") {
        i++;
        return { keys, open, close: i - 1 };
      }
      fail2("expected , or }");
    }
  }
  __name(obj, "obj");
  ws();
  if (s[i] !== "{") fail2("expected a JSON object");
  const top = obj(1);
  ws();
  if (i !== n) fail2("expected one JSON object");
  return { members, top, context };
}
__name(scan, "scan");
var TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function validTimestamp(v) {
  const m = TS.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = [1, 2, 3, 4, 5, 6].map((k) => Number(m[k]));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false;
  if (m[7] !== void 0 && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
__name(validTimestamp, "validTimestamp");
function validateRecord(line) {
  let sc;
  try {
    sc = scan(line);
  } catch (e) {
    if (e instanceof Reject) return { reason: e.message };
    throw e;
  }
  const text3 = /* @__PURE__ */ __name((k) => {
    const span = sc.members.get(k);
    if (!span || line[span[0]] !== '"') return null;
    const v = JSON.parse(line.slice(span[0], span[1]));
    return v === "" ? null : v;
  }, "text");
  for (const k of RESERVED) if (sc.members.has(k)) return { reason: `reserved ${k} field` };
  const id = text3("id");
  if (id === null || new TextEncoder().encode(id).length > 256) return { reason: "id must be a string of 1-256 bytes" };
  const type = text3("type");
  if (type !== "track" && type !== "identify") return { reason: "type must be track or identify" };
  const ts = text3("timestamp");
  if (ts === null) return { reason: "timestamp is required" };
  if (!validTimestamp(ts)) return { reason: "timestamp must be RFC 3339" };
  const data = sc.members.get("data");
  if (!data || line[data[0]] !== "{") return { reason: "data must be a JSON object" };
  if (type === "track") {
    const ev = text3("event");
    if (ev === null || [...ev].length > 200) return { reason: "track event must be 1-200 characters" };
  }
  if (type === "identify" && text3("user_id") === null) return { reason: "identify requires user_id" };
  for (const k of ["user_id", "anonymous_id", "session_id"])
    if (sc.members.has(k) && text3(k) === null) return { reason: `${k} must be a nonempty string` };
  const ctx = sc.members.get("context");
  if (ctx) {
    if (line[ctx[0]] !== "{" || !sc.context) return { reason: "context must be a JSON object" };
    if (sc.context.keys.has("geo")) return { reason: "context.geo is reserved for server enrichment" };
  }
  return { scanned: sc };
}
__name(validateRecord, "validateRecord");
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
  if (Object.keys(geo).length === 0) return null;
  geo.provider = "cloudflare";
  geo.basis = "request_ip";
  return Object.fromEntries(Object.entries(geo).sort(([a], [b]) => a < b ? -1 : 1));
}
__name(normalizeGeo, "normalizeGeo");
function spliceGeo(line, sc, geo) {
  const g = JSON.stringify(geo);
  if (sc.context) {
    const at3 = sc.context.close;
    return line.slice(0, at3) + (sc.context.keys.size ? "," : "") + `"geo":${g}` + line.slice(at3);
  }
  const at2 = sc.top.close;
  return line.slice(0, at2) + `,"context":{"geo":${g}}` + line.slice(at2);
}
__name(spliceGeo, "spliceGeo");
function checkBody(body, geo) {
  let end = body.length;
  while (end > 0 && (body[end - 1] === 10 || body[end - 1] === 13)) end--;
  if (end === 0) return { lines: [] };
  const lines = [];
  const decoder3 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let start = 0;
  for (let n = 1; ; n++) {
    if (n > MAX_LINES) return { line: n, reason: "too many lines" };
    let stop = body.indexOf(10, start);
    if (stop === -1 || stop > end) stop = end;
    const bytes = body.subarray(start, stop);
    if (bytes.length > MAX_RECORD_BYTES) return { line: n, reason: RECORD_TOO_LARGE };
    let text3;
    try {
      text3 = decoder3.decode(bytes);
    } catch {
      return { line: n, reason: "invalid UTF-8" };
    }
    const r = validateRecord(text3);
    if ("reason" in r) return { line: n, reason: r.reason };
    lines.push(geo ? spliceGeo(text3, r.scanned, geo) : text3);
    if (stop >= end) break;
    start = stop + 1;
  }
  return { lines };
}
__name(checkBody, "checkBody");
function stampOne(raw, batchId, atMs, n, sender) {
  const line = raw.replace(/^[ \t\r]+/, "");
  const rest = line.slice(1);
  const seq = (BigInt(batchId) << 20n | BigInt(n)).toString();
  const comma = /^[ \t\r]*\}/.test(rest) ? "" : ",";
  return `{"received_at":"${new Date(atMs).toISOString()}","received_seq":"${seq}","sender":${JSON.stringify(sender)}${comma}${rest}
`;
}
__name(stampOne, "stampOne");

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

// src/slurp.gen.ts
var WebrpcVersion = "v1";
var WebrpcSchemaVersion = "v0.6.0";
var serveArchiveRpc = /* @__PURE__ */ __name(async (service, ctx, request) => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/rpc/Archive/")) return null;
  const method = pathname.slice("/rpc/Archive/".length);
  if (method === "" || method.includes("/")) return null;
  if (request.method !== "POST") {
    return webrpcErrorResponse(new WebrpcBadMethodError({ cause: `unsupported HTTP method ${request.method} (only POST is allowed)` }), { Allow: "POST" });
  }
  try {
    return await dispatchArchiveRequest(service, ctx, method, request);
  } catch (err) {
    return webrpcErrorResponse(err);
  }
}, "serveArchiveRpc");
var dispatchArchiveRequest = /* @__PURE__ */ __name(async (service, ctx, method, request, status = 200) => {
  switch (method) {
    case "ListObjects": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "ListObjectsRequest");
      if (payload && !validateType(payload, "ListObjectsRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: listObjectsRequest" });
      }
      const result = await service.listObjects(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "GetCoverage": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "GetCoverageRequest");
      if (payload && !validateType(payload, "GetCoverageRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: getCoverageRequest" });
      }
      const result = await service.getCoverage(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    default:
      throw new WebrpcBadRouteError({ cause: "method not found" });
  }
}, "dispatchArchiveRequest");
var serveProjectRpc = /* @__PURE__ */ __name(async (service, ctx, request) => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/rpc/Project/")) return null;
  const method = pathname.slice("/rpc/Project/".length);
  if (method === "" || method.includes("/")) return null;
  if (request.method !== "POST") {
    return webrpcErrorResponse(new WebrpcBadMethodError({ cause: `unsupported HTTP method ${request.method} (only POST is allowed)` }), { Allow: "POST" });
  }
  try {
    return await dispatchProjectRequest(service, ctx, method, request);
  } catch (err) {
    return webrpcErrorResponse(err);
  }
}, "serveProjectRpc");
var dispatchProjectRequest = /* @__PURE__ */ __name(async (service, ctx, method, request, status = 200) => {
  switch (method) {
    case "GetProject": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "GetProjectRequest");
      if (payload && !validateType(payload, "GetProjectRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: getProjectRequest" });
      }
      const result = await service.getProject(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "UpdateProject": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "UpdateProjectRequest");
      if (payload && !validateType(payload, "UpdateProjectRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: updateProjectRequest" });
      }
      const result = await service.updateProject(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "ListProjects": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "ListProjectsRequest");
      if (payload && !validateType(payload, "ListProjectsRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: listProjectsRequest" });
      }
      const result = await service.listProjects(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "CreateProject": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "CreateProjectRequest");
      if (payload && !validateType(payload, "CreateProjectRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: createProjectRequest" });
      }
      const result = await service.createProject(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "CreateKey": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "CreateKeyRequest");
      if (payload && !validateType(payload, "CreateKeyRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: createKeyRequest" });
      }
      const result = await service.createKey(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "ListKeys": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "ListKeysRequest");
      if (payload && !validateType(payload, "ListKeysRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: listKeysRequest" });
      }
      const result = await service.listKeys(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "GetWebhook": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "GetWebhookRequest");
      if (payload && !validateType(payload, "GetWebhookRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: getWebhookRequest" });
      }
      const result = await service.getWebhook(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    case "RevokeKey": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "RevokeKeyRequest");
      if (payload && !validateType(payload, "RevokeKeyRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: revokeKeyRequest" });
      }
      const result = await service.revokeKey(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    default:
      throw new WebrpcBadRouteError({ cause: "method not found" });
  }
}, "dispatchProjectRequest");
var serveHealthRpc = /* @__PURE__ */ __name(async (service, ctx, request) => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/rpc/Health/")) return null;
  const method = pathname.slice("/rpc/Health/".length);
  if (method === "" || method.includes("/")) return null;
  if (request.method !== "POST") {
    return webrpcErrorResponse(new WebrpcBadMethodError({ cause: `unsupported HTTP method ${request.method} (only POST is allowed)` }), { Allow: "POST" });
  }
  try {
    return await dispatchHealthRequest(service, ctx, method, request);
  } catch (err) {
    return webrpcErrorResponse(err);
  }
}, "serveHealthRpc");
var dispatchHealthRequest = /* @__PURE__ */ __name(async (service, ctx, method, request, status = 200) => {
  switch (method) {
    case "Version": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "VersionRequest");
      if (payload && !validateType(payload, "VersionRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: versionRequest" });
      }
      const result = await service.version(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    default:
      throw new WebrpcBadRouteError({ cause: "method not found" });
  }
}, "dispatchHealthRequest");
var serveAuthRpc = /* @__PURE__ */ __name(async (service, ctx, request) => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/rpc/Auth/")) return null;
  const method = pathname.slice("/rpc/Auth/".length);
  if (method === "" || method.includes("/")) return null;
  if (request.method !== "POST") {
    return webrpcErrorResponse(new WebrpcBadMethodError({ cause: `unsupported HTTP method ${request.method} (only POST is allowed)` }), { Allow: "POST" });
  }
  try {
    return await dispatchAuthRequest(service, ctx, method, request);
  } catch (err) {
    return webrpcErrorResponse(err);
  }
}, "serveAuthRpc");
var dispatchAuthRequest = /* @__PURE__ */ __name(async (service, ctx, method, request, status = 200) => {
  switch (method) {
    case "Whoami": {
      const payload = webrpcParseRequestBody(await webrpcRequestBodyText(request), "WhoamiRequest");
      if (payload && !validateType(payload, "WhoamiRequest")) {
        throw new WebrpcBadRequestError({ cause: "invalid argument: whoamiRequest" });
      }
      const result = await service.whoami(ctx, payload || {});
      const tagged = webrpcTaggedStatus(result);
      return webrpcSuccessResponse((tagged ? tagged.result : result) ?? {}, tagged ? tagged.status : status);
    }
    default:
      throw new WebrpcBadRouteError({ cause: "method not found" });
  }
}, "dispatchAuthRequest");
var webrpcRequestBodyText = /* @__PURE__ */ __name(async (request, skipContentTypeCheck = false) => {
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const checkContentType = /* @__PURE__ */ __name(() => {
    if (contentType !== "application/json" && !skipContentTypeCheck) {
      throw new WebrpcBadRequestError({ cause: `unsupported Content-Type '${request.headers.get("Content-Type") || ""}' (only application/json is allowed)` });
    }
  }, "checkContentType");
  let checked = false;
  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (!skipContentTypeCheck && contentLength > 0) {
    checkContentType();
    checked = true;
  }
  const text3 = await request.text();
  if (text3 === "") {
    return "";
  }
  if (!checked) {
    checkContentType();
  }
  return text3;
}, "webrpcRequestBodyText");
var webrpcParseRequestBody = /* @__PURE__ */ __name((body, typ) => {
  if (typeof body !== "string" || body.trim() === "") {
    return {};
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new WebrpcBadRequestError({ cause: `failed to unmarshal request data: ${err instanceof Error ? err.message : String(err)}` });
  }
  try {
    return JsonDecode(data, typ) ?? {};
  } catch (err) {
    throw new WebrpcBadRequestError({ cause: `failed to unmarshal request data: ${err instanceof WebrpcError ? String(err.cause ?? err.message) : err instanceof Error ? err.message : String(err)}` });
  }
}, "webrpcParseRequestBody");
var webrpcJsonResponse = /* @__PURE__ */ __name((data, status = 200) => {
  return new Response(JsonEncode(data), {
    status,
    headers: { [WebrpcHeader]: WebrpcHeaderValue, "Content-Type": "application/json" }
  });
}, "webrpcJsonResponse");
var webrpcSuccessResponse = /* @__PURE__ */ __name((data, status = 200) => {
  if (status === 204 || status === 205) {
    return new Response(null, { status, headers: { [WebrpcHeader]: WebrpcHeaderValue } });
  }
  return webrpcJsonResponse(data, status);
}, "webrpcSuccessResponse");
var webrpcStatusKey = /* @__PURE__ */ Symbol("webrpcStatus");
var webrpcTaggedStatus = /* @__PURE__ */ __name((result) => result !== null && typeof result === "object" && webrpcStatusKey in result ? { status: result[webrpcStatusKey], result: result.result } : null, "webrpcTaggedStatus");
var webrpcErrorResponse = /* @__PURE__ */ __name((err, headers) => {
  const rpcErr = err instanceof WebrpcError ? err : new WebrpcEndpointError({ cause: err instanceof Error ? err.message : String(err) });
  const body = { error: rpcErr.name, code: rpcErr.code, msg: rpcErr.message, status: rpcErr.status };
  if (rpcErr.cause !== void 0) {
    body["cause"] = String(rpcErr.cause);
  }
  return new Response(JSON.stringify(body), {
    status: rpcErr.status || 400,
    headers: { ...headers, [WebrpcHeader]: WebrpcHeaderValue, "Content-Type": "application/json" }
  });
}, "webrpcErrorResponse");
var JS_TYPES = [
  "bigint",
  "boolean",
  "function",
  "number",
  "object",
  "string",
  "symbol",
  "undefined"
];
var validateSeq = /* @__PURE__ */ __name((_value) => {
  return true;
}, "validateSeq");
var validateCoverage = /* @__PURE__ */ __name((value) => {
  if (!("archiveId" in value) || !validateType(value["archiveId"], "string")) {
    return false;
  }
  if (!("firstRetained" in value) || !validateType(value["firstRetained"], "Seq")) {
    return false;
  }
  if ("latestPublished" in value && !validateType(value["latestPublished"], "Seq")) {
    return false;
  }
  if ("latestPublishedAt" in value && !validateType(value["latestPublishedAt"], "string")) {
    return false;
  }
  if (!("retentionSeconds" in value) || !validateType(value["retentionSeconds"], "number")) {
    return false;
  }
  return true;
}, "validateCoverage");
var validateArchiveObject = /* @__PURE__ */ __name((value) => {
  if (!("seq" in value) || !validateType(value["seq"], "Seq")) {
    return false;
  }
  if (!("name" in value) || !validateType(value["name"], "string")) {
    return false;
  }
  if (!("size" in value) || !validateType(value["size"], "number")) {
    return false;
  }
  if (!("sha256" in value) || !validateType(value["sha256"], "string")) {
    return false;
  }
  if (!("url" in value) || !validateType(value["url"], "string")) {
    return false;
  }
  return true;
}, "validateArchiveObject");
var validateListObjectsRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  if ("after" in value && !validateType(value["after"], "Seq")) {
    return false;
  }
  if ("limit" in value && !validateType(value["limit"], "number")) {
    return false;
  }
  return true;
}, "validateListObjectsRequest");
var validateListObjectsResponse = /* @__PURE__ */ __name((value) => {
  if ("coverage" in value && !validateType(value["coverage"], "Coverage")) {
    return false;
  }
  if (!("objects" in value) || !validateType(value["objects"], "ArchiveObject[]")) {
    return false;
  }
  if ("nextAfter" in value && !validateType(value["nextAfter"], "Seq")) {
    return false;
  }
  if ("expiresAt" in value && !validateType(value["expiresAt"], "string")) {
    return false;
  }
  return true;
}, "validateListObjectsResponse");
var validateGetCoverageRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  return true;
}, "validateGetCoverageRequest");
var validatePublicationStatus = /* @__PURE__ */ __name((value) => {
  if (!("state" in value) || !validateType(value["state"], "string")) {
    return false;
  }
  if (!("observedAt" in value) || !validateType(value["observedAt"], "string")) {
    return false;
  }
  if (!("intervalSeconds" in value) || !validateType(value["intervalSeconds"], "number")) {
    return false;
  }
  if ("estimatedAt" in value && !validateType(value["estimatedAt"], "string")) {
    return false;
  }
  return true;
}, "validatePublicationStatus");
var validateGetCoverageResponse = /* @__PURE__ */ __name((value) => {
  if ("coverage" in value && !validateType(value["coverage"], "Coverage")) {
    return false;
  }
  if ("publication" in value && !validateType(value["publication"], "PublicationStatus")) {
    return false;
  }
  return true;
}, "validateGetCoverageResponse");
var validateProjectInfo = /* @__PURE__ */ __name((value) => {
  if (!("id" in value) || !validateType(value["id"], "string")) {
    return false;
  }
  if (!("name" in value) || !validateType(value["name"], "string")) {
    return false;
  }
  if ("title" in value && !validateType(value["title"], "string")) {
    return false;
  }
  if (!("createdAt" in value) || !validateType(value["createdAt"], "string")) {
    return false;
  }
  return true;
}, "validateProjectInfo");
var validateApiKey = /* @__PURE__ */ __name((value) => {
  if (!("keyId" in value) || !validateType(value["keyId"], "string")) {
    return false;
  }
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  if (!("scope" in value) || !validateType(value["scope"], "string")) {
    return false;
  }
  if (!("name" in value) || !validateType(value["name"], "string")) {
    return false;
  }
  if (!("createdAt" in value) || !validateType(value["createdAt"], "string")) {
    return false;
  }
  if ("revokedAt" in value && !validateType(value["revokedAt"], "string")) {
    return false;
  }
  if ("key" in value && !validateType(value["key"], "string")) {
    return false;
  }
  return true;
}, "validateApiKey");
var validateListProjectsRequest = /* @__PURE__ */ __name((_value) => {
  return true;
}, "validateListProjectsRequest");
var validateListProjectsResponse = /* @__PURE__ */ __name((value) => {
  if (!("projects" in value) || !validateType(value["projects"], "ProjectInfo[]")) {
    return false;
  }
  return true;
}, "validateListProjectsResponse");
var validateCreateProjectRequest = /* @__PURE__ */ __name((value) => {
  if ("title" in value && !validateType(value["title"], "string")) {
    return false;
  }
  if ("geoEnabled" in value && !validateType(value["geoEnabled"], "boolean")) {
    return false;
  }
  if (!("name" in value) || !validateType(value["name"], "string")) {
    return false;
  }
  return true;
}, "validateCreateProjectRequest");
var validateCreateProjectResponse = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "ProjectInfo")) {
    return false;
  }
  if (!("created" in value) || !validateType(value["created"], "boolean")) {
    return false;
  }
  if (!("publishableKey" in value) || !validateType(value["publishableKey"], "string")) {
    return false;
  }
  if (!("ingestUrl" in value) || !validateType(value["ingestUrl"], "string")) {
    return false;
  }
  return true;
}, "validateCreateProjectResponse");
var validateGetProjectRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  return true;
}, "validateGetProjectRequest");
var validateGetProjectResponse = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "ProjectInfo")) {
    return false;
  }
  if (!("ingestUrl" in value) || !validateType(value["ingestUrl"], "string")) {
    return false;
  }
  if (!("geoEnabled" in value) || !validateType(value["geoEnabled"], "boolean")) {
    return false;
  }
  return true;
}, "validateGetProjectResponse");
var validateUpdateProjectRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  if ("name" in value && !validateType(value["name"], "string")) {
    return false;
  }
  if ("title" in value && !validateType(value["title"], "string")) {
    return false;
  }
  if ("geoEnabled" in value && !validateType(value["geoEnabled"], "boolean")) {
    return false;
  }
  return true;
}, "validateUpdateProjectRequest");
var validateUpdateProjectResponse = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "ProjectInfo")) {
    return false;
  }
  if (!("geoEnabled" in value) || !validateType(value["geoEnabled"], "boolean")) {
    return false;
  }
  return true;
}, "validateUpdateProjectResponse");
var validateCreateKeyRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  if (!("scope" in value) || !validateType(value["scope"], "string")) {
    return false;
  }
  if ("name" in value && !validateType(value["name"], "string")) {
    return false;
  }
  return true;
}, "validateCreateKeyRequest");
var validateCreateKeyResponse = /* @__PURE__ */ __name((value) => {
  if (!("keyId" in value) || !validateType(value["keyId"], "string")) {
    return false;
  }
  if (!("key" in value) || !validateType(value["key"], "string")) {
    return false;
  }
  return true;
}, "validateCreateKeyResponse");
var validateListKeysRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  if ("scope" in value && !validateType(value["scope"], "string")) {
    return false;
  }
  return true;
}, "validateListKeysRequest");
var validateListKeysResponse = /* @__PURE__ */ __name((value) => {
  if (!("keys" in value) || !validateType(value["keys"], "ApiKey[]")) {
    return false;
  }
  return true;
}, "validateListKeysResponse");
var validateRevokeKeyRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  if (!("keyId" in value) || !validateType(value["keyId"], "string")) {
    return false;
  }
  return true;
}, "validateRevokeKeyRequest");
var validateGetWebhookRequest = /* @__PURE__ */ __name((value) => {
  if (!("project" in value) || !validateType(value["project"], "string")) {
    return false;
  }
  if (!("provider" in value) || !validateType(value["provider"], "string")) {
    return false;
  }
  if ("rotate" in value && !validateType(value["rotate"], "boolean")) {
    return false;
  }
  if ("secret" in value && !validateType(value["secret"], "string")) {
    return false;
  }
  return true;
}, "validateGetWebhookRequest");
var validateGetWebhookResponse = /* @__PURE__ */ __name((value) => {
  if (!("provider" in value) || !validateType(value["provider"], "string")) {
    return false;
  }
  if (!("url" in value) || !validateType(value["url"], "string")) {
    return false;
  }
  if (!("secret" in value) || !validateType(value["secret"], "string")) {
    return false;
  }
  if (!("keyName" in value) || !validateType(value["keyName"], "string")) {
    return false;
  }
  return true;
}, "validateGetWebhookResponse");
var validateRevokeKeyResponse = /* @__PURE__ */ __name((value) => {
  if (!("key" in value) || !validateType(value["key"], "ApiKey")) {
    return false;
  }
  return true;
}, "validateRevokeKeyResponse");
var validateVersionRequest = /* @__PURE__ */ __name((_value) => {
  return true;
}, "validateVersionRequest");
var validateVersionResponse = /* @__PURE__ */ __name((value) => {
  if (!("server" in value) || !validateType(value["server"], "string")) {
    return false;
  }
  if (!("schema" in value) || !validateType(value["schema"], "string")) {
    return false;
  }
  if (!("webrpc" in value) || !validateType(value["webrpc"], "string")) {
    return false;
  }
  return true;
}, "validateVersionResponse");
var validateWhoamiRequest = /* @__PURE__ */ __name((_value) => {
  return true;
}, "validateWhoamiRequest");
var validateWhoamiResponse = /* @__PURE__ */ __name((value) => {
  if (!("scope" in value) || !validateType(value["scope"], "string")) {
    return false;
  }
  if ("project" in value && !validateType(value["project"], "string")) {
    return false;
  }
  if ("name" in value && !validateType(value["name"], "string")) {
    return false;
  }
  return true;
}, "validateWhoamiResponse");
var TYPE_VALIDATORS = {
  Seq: validateSeq,
  Coverage: validateCoverage,
  ArchiveObject: validateArchiveObject,
  ListObjectsRequest: validateListObjectsRequest,
  ListObjectsResponse: validateListObjectsResponse,
  GetCoverageRequest: validateGetCoverageRequest,
  PublicationStatus: validatePublicationStatus,
  GetCoverageResponse: validateGetCoverageResponse,
  ProjectInfo: validateProjectInfo,
  ApiKey: validateApiKey,
  ListProjectsRequest: validateListProjectsRequest,
  ListProjectsResponse: validateListProjectsResponse,
  CreateProjectRequest: validateCreateProjectRequest,
  CreateProjectResponse: validateCreateProjectResponse,
  GetProjectRequest: validateGetProjectRequest,
  GetProjectResponse: validateGetProjectResponse,
  UpdateProjectRequest: validateUpdateProjectRequest,
  UpdateProjectResponse: validateUpdateProjectResponse,
  CreateKeyRequest: validateCreateKeyRequest,
  CreateKeyResponse: validateCreateKeyResponse,
  ListKeysRequest: validateListKeysRequest,
  ListKeysResponse: validateListKeysResponse,
  RevokeKeyRequest: validateRevokeKeyRequest,
  GetWebhookRequest: validateGetWebhookRequest,
  GetWebhookResponse: validateGetWebhookResponse,
  RevokeKeyResponse: validateRevokeKeyResponse,
  VersionRequest: validateVersionRequest,
  VersionResponse: validateVersionResponse,
  WhoamiRequest: validateWhoamiRequest,
  WhoamiResponse: validateWhoamiResponse
};
var validateType = /* @__PURE__ */ __name((value, type) => {
  if (type === "any") {
    return true;
  }
  if (type.endsWith("[]")) {
    const elemType = type.slice(0, -2);
    return Array.isArray(value) && value.every((elem) => validateType(elem, elemType));
  }
  if (JS_TYPES.indexOf(type) > -1) {
    return typeof value === type;
  }
  const validator = TYPE_VALIDATORS[type];
  if (!validator) {
    return false;
  }
  return validator(value);
}, "validateType");
var JsonEncode = /* @__PURE__ */ __name((obj) => {
  return JSON.stringify(obj);
}, "JsonEncode");
var JsonDecode = /* @__PURE__ */ __name((data, _typ = "") => {
  let parsed = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      throw WebrpcBadResponseError.new({ cause: `JsonDecode: JSON.parse failed: ${err.message}` });
    }
  }
  return parsed;
}, "JsonDecode");
var WebrpcError = class _WebrpcError extends Error {
  static {
    __name(this, "WebrpcError");
  }
  code;
  status;
  constructor(error = {}) {
    super(error.message);
    this.name = error.name || "WebrpcEndpointError";
    this.code = typeof error.code === "number" ? error.code : 0;
    this.message = error.message || `endpoint error`;
    this.status = typeof error.status === "number" ? error.status : 400;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _WebrpcError.prototype);
  }
  static new(payload) {
    return new this({ message: payload.message, code: payload.code, status: payload.status, cause: payload.cause });
  }
};
var WebrpcEndpointError = class _WebrpcEndpointError extends WebrpcError {
  static {
    __name(this, "WebrpcEndpointError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "WebrpcEndpoint";
    this.code = typeof error.code === "number" ? error.code : 0;
    this.message = error.message || `endpoint error`;
    this.status = typeof error.status === "number" ? error.status : 400;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _WebrpcEndpointError.prototype);
  }
};
var WebrpcBadRouteError = class _WebrpcBadRouteError extends WebrpcError {
  static {
    __name(this, "WebrpcBadRouteError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "WebrpcBadRoute";
    this.code = typeof error.code === "number" ? error.code : -2;
    this.message = error.message || `bad route`;
    this.status = typeof error.status === "number" ? error.status : 404;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _WebrpcBadRouteError.prototype);
  }
};
var WebrpcBadMethodError = class _WebrpcBadMethodError extends WebrpcError {
  static {
    __name(this, "WebrpcBadMethodError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "WebrpcBadMethod";
    this.code = typeof error.code === "number" ? error.code : -3;
    this.message = error.message || `bad method`;
    this.status = typeof error.status === "number" ? error.status : 405;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _WebrpcBadMethodError.prototype);
  }
};
var WebrpcBadRequestError = class _WebrpcBadRequestError extends WebrpcError {
  static {
    __name(this, "WebrpcBadRequestError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "WebrpcBadRequest";
    this.code = typeof error.code === "number" ? error.code : -4;
    this.message = error.message || `bad request`;
    this.status = typeof error.status === "number" ? error.status : 400;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _WebrpcBadRequestError.prototype);
  }
};
var WebrpcBadResponseError = class _WebrpcBadResponseError extends WebrpcError {
  static {
    __name(this, "WebrpcBadResponseError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "WebrpcBadResponse";
    this.code = typeof error.code === "number" ? error.code : -5;
    this.message = error.message || `bad response`;
    this.status = typeof error.status === "number" ? error.status : 500;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _WebrpcBadResponseError.prototype);
  }
};
var UnauthenticatedError = class _UnauthenticatedError extends WebrpcError {
  static {
    __name(this, "UnauthenticatedError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "Unauthenticated";
    this.code = typeof error.code === "number" ? error.code : 1e3;
    this.message = error.message || `authentication required`;
    this.status = typeof error.status === "number" ? error.status : 401;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _UnauthenticatedError.prototype);
  }
};
var ForbiddenError = class _ForbiddenError extends WebrpcError {
  static {
    __name(this, "ForbiddenError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "Forbidden";
    this.code = typeof error.code === "number" ? error.code : 1001;
    this.message = error.message || `not allowed`;
    this.status = typeof error.status === "number" ? error.status : 403;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _ForbiddenError.prototype);
  }
};
var InvalidArgumentError = class _InvalidArgumentError extends WebrpcError {
  static {
    __name(this, "InvalidArgumentError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "InvalidArgument";
    this.code = typeof error.code === "number" ? error.code : 2e3;
    this.message = error.message || `invalid argument`;
    this.status = typeof error.status === "number" ? error.status : 400;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _InvalidArgumentError.prototype);
  }
};
var AlreadyExistsError = class _AlreadyExistsError extends WebrpcError {
  static {
    __name(this, "AlreadyExistsError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "AlreadyExists";
    this.code = typeof error.code === "number" ? error.code : 2001;
    this.message = error.message || `project name already exists`;
    this.status = typeof error.status === "number" ? error.status : 409;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _AlreadyExistsError.prototype);
  }
};
var NotFoundError = class _NotFoundError extends WebrpcError {
  static {
    __name(this, "NotFoundError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "NotFound";
    this.code = typeof error.code === "number" ? error.code : 3e3;
    this.message = error.message || `not found`;
    this.status = typeof error.status === "number" ? error.status : 404;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _NotFoundError.prototype);
  }
};
var RetentionGapError = class _RetentionGapError extends WebrpcError {
  static {
    __name(this, "RetentionGapError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "RetentionGap";
    this.code = typeof error.code === "number" ? error.code : 4e3;
    this.message = error.message || `sequences after the checkpoint are past the retention floor`;
    this.status = typeof error.status === "number" ? error.status : 410;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _RetentionGapError.prototype);
  }
};
var UnavailableError = class _UnavailableError extends WebrpcError {
  static {
    __name(this, "UnavailableError");
  }
  constructor(error = {}) {
    super(error);
    this.name = error.name || "Unavailable";
    this.code = typeof error.code === "number" ? error.code : 5e3;
    this.message = error.message || `temporarily unavailable`;
    this.status = typeof error.status === "number" ? error.status : 503;
    if (error.cause !== void 0) this.cause = error.cause;
    Object.setPrototypeOf(this, _UnavailableError.prototype);
  }
};
var WebrpcHeader = "Webrpc";
var WebrpcHeaderValue = "webrpc@v0.49.0;typescript@v0.49.0;slurp@v0.6.0";

// src/compat/common.ts
var COMPAT_CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Retry-After"
};
var json = /* @__PURE__ */ __name((status, body, extra = {}) => Response.json(body, { status, headers: { ...COMPAT_CORS, ...extra } }), "json");
var preflight = /* @__PURE__ */ __name((allowHeaders) => new Response(null, { status: 204, headers: { ...COMPAT_CORS, "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": allowHeaders, "access-control-max-age": "86400" } }), "preflight");
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
var isObject = /* @__PURE__ */ __name((v) => typeof v === "object" && v !== null && !Array.isArray(v), "isObject");
var text = /* @__PURE__ */ __name((v) => {
  if (typeof v === "string") return v === "" ? void 0 : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return void 0;
}, "text");
function timestampOf(msg, sentAt, now) {
  for (const v of [msg.timestamp, msg.originalTimestamp]) {
    const iso2 = isoOrUndefined(v);
    if (iso2) return iso2;
  }
  return isoOrUndefined(sentAt) ?? new Date(now).toISOString();
}
__name(timestampOf, "timestampOf");
async function translateMessage(raw, type, sentAt, now) {
  if (!isObject(raw)) return { reason: "message must be an object" };
  const kind = type ?? (typeof raw.type === "string" ? raw.type : void 0);
  if (!kind || !["track", "identify", "page", "screen", "group", "alias"].includes(kind)) return { reason: "unknown message type" };
  const userId = text(raw.userId);
  const anonymousId = text(raw.anonymousId);
  const properties = isObject(raw.properties) ? raw.properties : {};
  const traits = isObject(raw.traits) ? raw.traits : isObject(raw.context?.traits) && kind === "identify" ? raw.context.traits : {};
  let canonicalType = "track";
  let event;
  let data;
  switch (kind) {
    case "track":
      event = text(raw.event);
      if (!event) return { reason: "track needs an event name" };
      data = properties;
      break;
    case "identify":
      if (userId) {
        canonicalType = "identify";
        data = traits;
      } else {
        event = "identify";
        data = traits;
      }
      break;
    case "page":
    case "screen":
      event = kind;
      data = { ...properties, ...text(raw.name) ? { name: text(raw.name) } : {}, ...text(raw.category) ? { category: text(raw.category) } : {} };
      break;
    case "group":
      event = "group";
      data = { ...traits, group_id: text(raw.groupId) ?? null };
      break;
    default:
      event = "alias";
      data = { previous_id: text(raw.previousId) ?? null };
  }
  const context = isObject(raw.context) ? { ...raw.context } : {};
  delete context.geo;
  if (kind === "identify") delete context.traits;
  context.compat = "segment";
  const timestamp = timestampOf(raw, sentAt, now);
  const id = text(raw.messageId) ?? `segment-${await sha256Hex(JSON.stringify([kind, userId, anonymousId, event, timestamp, data]))}`;
  const record = { id, type: canonicalType, ...event !== void 0 ? { event } : {}, timestamp };
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
async function segmentIngest(req, route, host) {
  const origin = new URL(req.url).origin;
  if (route.kind === "settings") return settings(req, route.key, origin, host);
  if (req.method === "OPTIONS") return preflight(ALLOW_HEADERS);
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST, OPTIONS" });
  let bytes;
  try {
    bytes = await readBody(req, host.maxBody);
  } catch (e) {
    if (e instanceof BodyTooLarge) return json(413, { error: "body too large" });
    return json(400, { error: "unreadable body" });
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const principal = await host.publishable(keyFrom(req, body));
  if (!principal) return json(401, { error: "invalid write key (use a Slurp publishable key)" });
  const sentAt = isObject(body) && typeof body.sentAt === "string" ? body.sentAt : void 0;
  let messages;
  let type;
  if (route.kind === "batch") {
    if (!isObject(body) || !Array.isArray(body.batch)) return json(400, { error: "batch must be an array" });
    messages = body.batch;
  } else {
    messages = [body];
    type = route.type;
  }
  const now = Date.now();
  const lines = [];
  let rejected = 0;
  const encoder3 = new TextEncoder();
  for (const m of messages) {
    const t = await translateMessage(m, type, sentAt, now);
    if ("reason" in t || "reason" in validateRecord(t.line) || encoder3.encode(t.line).length > MAX_RECORD_BYTES) {
      rejected++;
      continue;
    }
    lines.push(t.line);
  }
  if (lines.length === 0) {
    if (messages.length === 0) return json(200, { success: true, accepted: 0, rejected: 0 });
    return json(400, { error: "no valid events in the request", rejected });
  }
  const res = await host.ingest(principal, encoder3.encode(lines.join("\n") + "\n"), host.geoFor(req, principal.geo));
  if (!res.ok) return ingestFailure(res);
  return json(200, { success: true, accepted: lines.length, rejected });
}
__name(segmentIngest, "segmentIngest");
async function settings(req, key, origin, host) {
  if (req.method === "OPTIONS") return preflight(ALLOW_HEADERS);
  if (!await host.publishable(key)) return json(404, { error: "unknown project" });
  return json(200, {
    integrations: { "Segment.io": { apiKey: key, apiHost: `${new URL(origin).host}/v1`, protocol: new URL(origin).protocol === "http:" ? "http" : "https", addBundledMetadata: true, unbundledIntegrations: [] } },
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
var isObject2 = /* @__PURE__ */ __name((v) => typeof v === "object" && v !== null && !Array.isArray(v), "isObject");
var decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
function parseEnvelope(bytes) {
  const NL = 10;
  let at2 = 0;
  const line = /* @__PURE__ */ __name(() => {
    if (at2 >= bytes.length) return null;
    let end = bytes.indexOf(NL, at2);
    if (end === -1) end = bytes.length;
    const out = bytes.subarray(at2, end);
    at2 = Math.min(end + 1, bytes.length);
    return out;
  }, "line");
  const jsonLine = /* @__PURE__ */ __name((b) => {
    const v = JSON.parse(decoder.decode(b));
    if (!isObject2(v)) throw new Error("header must be an object");
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
      if (at2 + length > bytes.length) throw new Error("item length exceeds the body");
      payload = bytes.subarray(at2, at2 + length);
      at2 += length;
      if (at2 < bytes.length) {
        if (bytes[at2] !== NL) throw new Error("item payload is not followed by a newline");
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
var text2 = /* @__PURE__ */ __name((v) => typeof v === "string" && v !== "" ? v : void 0, "text");
function timestampOf2(v, fallback, now) {
  for (const c of [v, fallback]) {
    const iso2 = typeof c === "number" ? isoOrUndefined(c * 1e3) : isoOrUndefined(c);
    if (iso2) return iso2;
  }
  return new Date(now).toISOString();
}
__name(timestampOf2, "timestampOf");
var hasException = /* @__PURE__ */ __name((e) => {
  const x = e.exception;
  const values = isObject2(x) && Array.isArray(x.values) ? x.values : Array.isArray(x) ? x : [];
  return values.some((v) => isObject2(v) && !(isObject2(v.mechanism) && v.mechanism.synthetic === true));
}, "hasException");
async function translateItem(item, header, now) {
  const kind = item.type;
  if (kind !== "event" && kind !== "user_report" && kind !== "feedback" && kind !== "check_in") return null;
  let payload;
  try {
    payload = JSON.parse(decoder.decode(item.payload));
  } catch {
    return { reason: `${kind} payload is not JSON` };
  }
  if (!isObject2(payload)) return { reason: `${kind} payload is not an object` };
  const sentAt = header.sent_at;
  const user = isObject2(payload.user) ? payload.user : {};
  const userId = text2(user.id) ?? (typeof user.id === "number" ? String(user.id) : void 0) ?? text2(user.email) ?? text2(user.username);
  const sdk = isObject2(payload.sdk) ? payload.sdk : null;
  const context = { compat: "sentry" };
  if (sdk && text2(sdk.name)) context.library = { name: sdk.name, ...text2(sdk.version) ? { version: sdk.version } : {} };
  let event;
  let id;
  if (kind === "event") {
    event = hasException(payload) || ["error", "fatal"].includes(String(payload.level)) ? "error" : "message";
    id = text2(header.event_id) ?? text2(payload.event_id) ?? `sentry-${await sha256Hex(item.payload)}`;
  } else {
    event = kind === "check_in" ? "check_in" : "user_feedback";
    id = `sentry-${await sha256Hex(item.payload)}`;
  }
  const record = { id, type: "track", event, timestamp: timestampOf2(payload.timestamp, sentAt, now) };
  if (userId) record.user_id = userId;
  record.data = payload;
  record.context = context;
  return { line: JSON.stringify(record) };
}
__name(translateItem, "translateItem");
async function sentryIngest(req, route, host) {
  if (req.method === "OPTIONS") return preflight(ALLOW_HEADERS2);
  const reply = /* @__PURE__ */ __name((status, body, extra = {}) => json(status, body, { ...EXPOSE, ...extra }), "reply");
  if (req.method !== "POST") return reply(405, { detail: "method not allowed" }, { Allow: "POST, OPTIONS" });
  let bytes;
  try {
    bytes = await readBody(req, host.maxBody);
  } catch (e) {
    if (e instanceof BodyTooLarge) return reply(413, { detail: "body too large" });
    return reply(400, { detail: "unreadable body" });
  }
  let envelope;
  try {
    if (route.kind === "envelope") envelope = parseEnvelope(bytes);
    else {
      const event = JSON.parse(decoder.decode(bytes));
      if (!isObject2(event)) throw new Error("event must be an object");
      envelope = { header: { event_id: event.event_id }, items: [{ type: "event", header: { type: "event" }, payload: bytes }] };
    }
  } catch (e) {
    return reply(400, { detail: `malformed envelope: ${e.message}` });
  }
  const creds = credentials(req, envelope.header.dsn);
  if (creds === "conflict") return reply(403, { detail: "conflicting credentials" });
  const principal = await host.publishable(creds.key);
  if (!principal) return reply(403, { detail: "invalid or missing sentry_key (use the DSN Slurp prints for this project)" });
  const eventId = text2(envelope.header.event_id) ?? "";
  const now = Date.now();
  const lines = [];
  const encoder3 = new TextEncoder();
  for (const item of envelope.items) {
    const t = await translateItem(item, envelope.header, now);
    if (!t || "reason" in t) continue;
    if ("reason" in validateRecord(t.line) || encoder3.encode(t.line).length > MAX_RECORD_BYTES) continue;
    lines.push(t.line);
  }
  if (lines.length > 0) {
    const res = await host.ingest(principal, encoder3.encode(lines.join("\n") + "\n"), host.geoFor(req, principal.geo));
    if (!res.ok) return ingestFailure(res);
  }
  return reply(200, { id: eventId });
}
__name(sentryIngest, "sentryIngest");

// src/compat/hooks.ts
var PROVIDERS = ["github", "stripe", "revenuecat", "generic"];
var isProvider = /* @__PURE__ */ __name((value) => PROVIDERS.includes(value), "isProvider");
var STRIPE_TOLERANCE_S = 300;
var encoder = new TextEncoder();
var decoder2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var hookRoute = /* @__PURE__ */ __name((path) => {
  const m = /^\/hooks\/([^/]+)\/?$/.exec(path);
  return m ? { provider: m[1] } : null;
}, "hookRoute");
var sameHex = /* @__PURE__ */ __name((a, b) => timingSafeEqual(a.toLowerCase(), b.toLowerCase()), "sameHex");
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
var isObject3 = /* @__PURE__ */ __name((v) => typeof v === "object" && v !== null && !Array.isArray(v), "isObject");
var str = /* @__PURE__ */ __name((v) => typeof v === "string" && v !== "" ? v : void 0, "str");
var at = /* @__PURE__ */ __name((root, ...path) => path.reduce((node, key) => isObject3(node) ? node[key] : void 0, root), "at");
var fail = /* @__PURE__ */ __name((status, error) => json(status, { error }), "fail");
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
async function hookIngest(req, route, host) {
  const provider = route.provider;
  if (!isProvider(provider)) return fail(404, "unknown webhook provider (github, stripe, revenuecat or generic)");
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });
  const keys = new URL(req.url).searchParams.getAll("key");
  const principal = keys.length === 1 ? await host.publishable(keys[0]) : null;
  if (!principal) return fail(401, "invalid key (the webhook URL carries one publishable key: slurp project webhook shows it)");
  let bytes;
  try {
    bytes = await readBody(req, host.maxBody);
  } catch (e) {
    return e instanceof BodyTooLarge ? fail(413, "body too large") : fail(400, "unreadable body");
  }
  const secret = await host.webhookSecret(provider, principal.project);
  if (secret === null) return fail(401, "no signing secret is set for this provider yet; run slurp project webhook PROJECT stripe --secret whsec_...");
  const header = /* @__PURE__ */ __name((name) => req.headers.get(name), "header");
  if (provider === "github" && !await githubSignatureOk(bytes, header("x-hub-signature-256"), secret)) return fail(401, "bad or missing X-Hub-Signature-256");
  if (provider === "stripe" && !await stripeSignatureOk(bytes, header("stripe-signature"), secret)) return fail(401, "bad, missing or stale Stripe-Signature");
  if (provider === "revenuecat" && !authorizationOk(header("authorization"), secret)) return fail(401, "bad or missing Authorization header (paste the secret from slurp project webhook PROJECT revenuecat into RevenueCat)");
  const claimed = header("x-slurp-signature");
  if (provider === "generic" && claimed !== null && !await githubSignatureOk(bytes, claimed, secret)) return fail(401, "bad X-Slurp-Signature");
  let text3;
  try {
    text3 = decoder2.decode(bytes).trim();
  } catch {
    return fail(400, "the body is not UTF-8 text");
  }
  let payload;
  let isJson = true;
  try {
    payload = JSON.parse(text3);
  } catch {
    isJson = false;
  }
  if (provider !== "generic" && !(isJson && isObject3(payload))) {
    return fail(400, provider === "github" && (header("content-type") ?? "").includes("urlencoded") ? "set the webhook content type to application/json in GitHub" : "the body must be a JSON object");
  }
  const now = Date.now();
  let described;
  if (provider === "github") {
    const kind = header("x-github-event") ?? "";
    if (kind === "ping") return json(200, { ok: true, ignored: "ping" });
    if (kind === "") return fail(400, "missing X-GitHub-Event");
    const action = str(at(payload, "action"));
    const delivery = header("x-github-delivery") ?? `sha256-${await sha256Hex(bytes)}`;
    const when = (GITHUB_TIME[kind] ?? []).map((path) => isoOrUndefined(at(payload, ...path))).find(Boolean);
    described = { event: `github.${kind}${action ? `.${action}` : ""}`, id: `github:${delivery}`, delivery, at: when };
  } else if (provider === "stripe") {
    const id = str(at(payload, "id")), type = str(at(payload, "type"));
    if (!id || !type) return fail(400, "not a Stripe event (no id or type)");
    const created = at(payload, "created");
    described = { event: `stripe.${type}`, id, delivery: id, at: typeof created === "number" ? isoOrUndefined(created * 1e3) : void 0 };
  } else if (provider === "revenuecat") {
    const id = str(at(payload, "event", "id")), type = str(at(payload, "event", "type"));
    if (!id || !type) return fail(400, "not a RevenueCat event (no event.id or event.type)");
    const ms = at(payload, "event", "event_timestamp_ms");
    described = { event: `revenuecat.${type.toLowerCase()}`, id: `revenuecat:${id}`, delivery: id, at: isoOrUndefined(ms) };
  } else {
    const query = new URL(req.url).searchParams.get("event");
    const named = query || str(at(payload, "type")) || str(at(payload, "event")) || "webhook";
    const supplied = header("idempotency-key") ?? header("x-request-id") ?? header("x-delivery-id");
    const given = supplied && encoder.encode(supplied).length <= 200 ? supplied : null;
    const bodyTime = isoOrUndefined(at(payload, "timestamp"));
    const delivery = given ?? (bodyTime ? `sha256-${await sha256Hex(bytes)}` : `post-${crypto.randomUUID()}`);
    described = { event: named, id: `generic:${delivery}`, delivery, at: bodyTime ?? (given ? void 0 : new Date(now).toISOString()) };
  }
  const happened = described.at ?? new Date(await host.firstSeen(principal.project, described.id, now)).toISOString();
  const data = !isJson ? JSON.stringify({ raw: text3 }) : isObject3(payload) ? text3 : `{"items":${text3}}`;
  const event = [...described.event].slice(0, 200).join("");
  const line = `{"id":${JSON.stringify(described.id)},"type":"track","event":${JSON.stringify(event)},"timestamp":"${happened}","data":${data},"context":{"webhook":{"provider":"${provider}","delivery":${JSON.stringify(described.delivery)}}}}`;
  const record = encoder.encode(line);
  if (record.length > MAX_RECORD_BYTES) return fail(413, "the payload is larger than 1 MiB; Slurp stores payloads whole, so it is refused");
  const invalid = validateRecord(line);
  if ("reason" in invalid) return fail(400, `the payload cannot be stored: ${invalid.reason}`);
  const result = await host.ingest(principal, encoder.encode(line + "\n"), null);
  if (!result.ok) return ingestFailure(result);
  return json(200, { ok: true });
}
__name(hookIngest, "hookIngest");

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
  update(ref, p) {
    const s = this.get(ref);
    if (!s) return { ok: false, code: "notfound", message: "project" };
    if (!validTitle(p.title)) return { ok: false, code: "invalid", message: "bad title" };
    if (p.name !== void 0 && !validProjectName(p.name)) return { ok: false, code: "invalid", message: "bad name" };
    if (p.name !== void 0 && p.name !== s.name && this.sql.exec("SELECT 1 FROM projects WHERE name=?", p.name).toArray().length) return { ok: false, code: "exists", message: "name exists" };
    this.ctx.storage.transactionSync(() => {
      if (p.name !== void 0) this.sql.exec("UPDATE projects SET name=? WHERE id=?", p.name, s.id);
      if (p.title !== void 0) this.sql.exec("UPDATE projects SET title=? WHERE id=?", p.title === "" ? null : p.title, s.id);
    });
    return { ok: true, value: this.get(s.id) };
  }
  /** Forget every project (used by `slurp cloud destroy`). */
  async purge() {
    await this.ctx.storage.deleteAll();
    this.sql.exec("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, title TEXT, created_at TEXT NOT NULL)");
  }
};

// src/project.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";
var pad20 = /* @__PURE__ */ __name((n) => String(n).padStart(20, "0"), "pad20");
var MAX_SEQ_PER_ROW = (1 << 20) - 1;
var ROW_MAX_BYTES = 15e5;
var encoder2 = new TextEncoder();
var RECENT_HASHES = 1e4;
var ProjectDO = class extends DurableObject2 {
  static {
    __name(this, "ProjectDO");
  }
  sql = this.ctx.storage.sql;
  pendingBytes = 0;
  nextBatch = 1;
  queue = [];
  queuedBytes = 0;
  timer = null;
  /** Identical request bodies seen lately, keyed by hash. The promise settles when that request's batch is committed (or fails). */
  recent = /* @__PURE__ */ new Map();
  /** Test hook (DEBUG only): make the next group commit fail once. */
  failNext = false;
  /** Test hook (DEBUG only): make archive writes to R2 fail until cleared. */
  failArchive = false;
  /** Rows written by this object since it was last constructed (what Durable Object SQLite bills). */
  rows = 0;
  constructor(ctx, env) {
    super(ctx, env);
    if (this.initialized()) this.restore();
  }
  initialized() {
    return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").toArray().length > 0;
  }
  restore() {
    this.table(this.gen());
    let max = Number(this.meta("batch_hwm") ?? 0);
    let bytes = 0;
    for (const g of this.liveGens()) {
      const r = this.sql.exec(`SELECT COALESCE(MAX(id),0) m, COALESCE(SUM(bytes),0) b FROM b_${g}`).one();
      max = Math.max(max, r.m);
      bytes += r.b;
    }
    this.nextBatch = max + 1;
    this.pendingBytes = bytes;
  }
  projectId() {
    return this.ctx.id.name ?? "";
  }
  /**
   * Create this project's storage and its first publishable key, or return the existing one. Safe to repeat: it never
   * changes a key that exists, and `geo` only applies the first time.
   */
  init(geo) {
    if (!this.initialized()) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS manifest(seq INTEGER PRIMARY KEY, name TEXT NOT NULL, r2key TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, events INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS keys(key_id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, hash TEXT UNIQUE, plain TEXT UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);`);
      this.setMeta("geo", geo ? "1" : "0");
      this.restore();
    }
    const live = this.sql.exec("SELECT plain FROM keys WHERE scope='publishable' AND revoked_at IS NULL ORDER BY created_at, key_id LIMIT 1").toArray()[0];
    return { key: live ? live.plain : this.mintPublishable("default").key };
  }
  mintPublishable(name) {
    const key = `slurp_pk_${this.projectId().slice(4)}_${randomHex(24)}`;
    const keyId = randomHex(8);
    this.w("INSERT INTO keys VALUES(?,?,?,NULL,?,?,NULL)", keyId, "publishable", name, key, (/* @__PURE__ */ new Date()).toISOString());
    return { key, keyId };
  }
  /** The key's scope, id and name; null when it is unknown or revoked (immediately, with no cache). A publishable key is looked up as is. */
  async authorize(token) {
    if (!this.initialized()) return null;
    const secret = token.startsWith("slurp_sk_");
    const row = (secret ? this.sql.exec("SELECT key_id, scope, name FROM keys WHERE hash=? AND revoked_at IS NULL", await sha256Hex(token)) : this.sql.exec("SELECT key_id, scope, name FROM keys WHERE plain=? AND revoked_at IS NULL", token)).toArray()[0];
    return row ? { scope: row.scope, keyId: row.key_id, name: row.name, geo: this.meta("geo") === "1" } : null;
  }
  async createKey(scope, name) {
    if (!this.initialized()) return { ok: false, code: "notfound", message: "project" };
    if (scope !== "publishable" && scope !== "secret") return { ok: false, code: "invalid", message: "scope must be publishable or secret" };
    const label = name.trim() === "" ? "default" : name;
    if (encoder2.encode(label).length > 200) return { ok: false, code: "invalid", message: "name too long" };
    if (scope === "publishable") return { ok: true, value: this.mintPublishable(label) };
    const key = `slurp_sk_${this.projectId().slice(4)}_${randomHex(24)}`;
    const hash = await sha256Hex(key);
    const keyId = randomHex(8);
    this.w("INSERT INTO keys VALUES(?,?,?,?,NULL,?,NULL)", keyId, "secret", label, hash, (/* @__PURE__ */ new Date()).toISOString());
    return { ok: true, value: { key, keyId } };
  }
  listKeys(scope) {
    if (!this.initialized()) return [];
    return this.sql.exec("SELECT * FROM keys ORDER BY created_at, key_id").toArray().filter((k) => !scope || k.scope === scope);
  }
  revokeKey(keyId) {
    if (!this.initialized()) return { ok: false, code: "notfound", message: "project" };
    const k = this.sql.exec("SELECT * FROM keys WHERE key_id=?", keyId).toArray()[0];
    if (!k) return { ok: false, code: "notfound", message: "key" };
    if (!k.revoked_at) this.w("UPDATE keys SET revoked_at=? WHERE key_id=?", (/* @__PURE__ */ new Date()).toISOString(), keyId);
    return { ok: true, value: this.sql.exec("SELECT * FROM keys WHERE key_id=?", keyId).one() };
  }
  /**
   * When a webhook delivery that carries no time of its own first arrived. A provider redelivers the same delivery with the same id,
   * and its record must not change (the importer treats the same id with different content as a conflict), so the first arrival time
   * is kept and returned again. Rows older than a week are dropped (GitHub redelivers within about three days). The table is made on
   * first use, so deployments that existed before it did not need a migration.
   */
  firstSeen(id, now) {
    this.sql.exec("CREATE TABLE IF NOT EXISTS hook_seen(id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL)");
    this.w("INSERT INTO hook_seen VALUES(?,?) ON CONFLICT(id) DO NOTHING", id, now);
    return this.sql.exec("SELECT first_seen FROM hook_seen WHERE id=?", id).one().first_seen;
  }
  pruneHookSeen() {
    if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hook_seen'").toArray().length === 0) return;
    this.w("DELETE FROM hook_seen WHERE first_seen<?", Date.now() - 7 * 864e5);
  }
  /** Webhook secrets are derived from this counter, so changing it changes this project's secrets (every provider) and no one else's. */
  webhookEpoch() {
    return this.initialized() ? Number(this.meta("webhook_epoch") ?? 0) : 0;
  }
  rotateWebhook() {
    const next = this.webhookEpoch() + 1;
    if (this.initialized()) this.setMeta("webhook_epoch", String(next));
    return next;
  }
  /** The signing secret a provider issued for this project (Stripe), or null until it has been set. */
  providerSecret(provider) {
    return this.initialized() ? this.meta(`webhook_secret_${provider}`) : null;
  }
  setProviderSecret(provider, secret) {
    if (this.initialized()) this.setMeta(`webhook_secret_${provider}`, secret);
  }
  /** The first active publishable key with this name, made if there is none (so asking again never makes a second one). */
  ensurePublishable(name) {
    if (!this.initialized()) return { ok: false, code: "notfound", message: "project" };
    const live = this.sql.exec("SELECT plain FROM keys WHERE scope='publishable' AND name=? AND revoked_at IS NULL ORDER BY created_at, key_id LIMIT 1", name).toArray()[0];
    return { ok: true, value: live ? live.plain : this.mintPublishable(name).key };
  }
  geoEnabled() {
    return this.initialized() && this.meta("geo") === "1";
  }
  setGeo(on) {
    if (this.initialized()) this.setMeta("geo", on ? "1" : "0");
  }
  num(k, d) {
    const v = Number(this.env[k]);
    return Number.isFinite(v) ? v : d;
  }
  w(query, ...bindings) {
    const c = this.sql.exec(query, ...bindings);
    c.toArray();
    this.rows += c.rowsWritten;
    return c;
  }
  meta(k) {
    const r = this.sql.exec("SELECT v FROM meta WHERE k=?", k).toArray()[0];
    return r ? r.v : null;
  }
  setMeta(k, v) {
    this.w("INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
  }
  gen() {
    return Number(this.meta("gen") ?? 1);
  }
  table(g) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS b_${g}(id INTEGER PRIMARY KEY, data TEXT NOT NULL, events INTEGER NOT NULL, bytes INTEGER NOT NULL)`);
  }
  intent() {
    const v = this.meta("sealing");
    return v ? JSON.parse(v) : null;
  }
  liveGens() {
    const i = this.intent();
    return i ? [i.gen, this.gen()] : [this.gen()];
  }
  archiveId() {
    let id = this.meta("archive_id");
    if (!id) {
      id = randomHex(8);
      this.setMeta("archive_id", id);
    }
    return id;
  }
  /** True while accepted events are waiting for their archive (a retention alarm alone is not a pending publication). */
  hasBuffered() {
    return this.pendingBytes > 0 || this.queue.length > 0 || this.intent() !== null;
  }
  publication(alarm) {
    const pending = this.hasBuffered();
    return { state: pending ? "pending" : "idle", observedAt: (/* @__PURE__ */ new Date()).toISOString(), intervalSeconds: Math.round(this.num("SEAL_INTERVAL_MS", 6e5) / 1e3), ...pending && alarm !== null ? { estimatedAt: new Date(alarm).toISOString() } : {} };
  }
  /** When the oldest archive reaches RETENTION_DAYS, or null when retention is off or nothing is archived. */
  nextExpiry() {
    const days = this.num("RETENTION_DAYS", 0);
    if (days <= 0) return null;
    const oldest = this.sql.exec("SELECT MIN(created_at) m FROM manifest").one().m;
    return oldest === null ? null : oldest + days * 864e5;
  }
  /** With nothing buffered, keep an alarm only for the next retention expiry; otherwise none. */
  async settleIdleAlarm() {
    const expiry = this.nextExpiry();
    if (expiry === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(expiry, Date.now() + 1e3));
  }
  /** Ingest for a presented publishable key: one call that authorizes, applies geo only if this project opted in, and stamps the sender. */
  async ingestKey(token, body, requestGeo) {
    const a = await this.authorize(token);
    if (!a) return { ok: false, status: 401, reason: "invalid token" };
    if (a.scope !== "publishable") return { ok: false, status: 403, reason: "publishable key required" };
    return this.ingest(a.name, body, a.geo ? requestGeo : null);
  }
  /** Ingest records already authorized as `sender` (the sending key's name). */
  async ingest(sender, body, geo) {
    if (!this.initialized()) return { ok: false, status: 503, reason: "unavailable", retryAfter: 5 };
    const checked = checkBody(body, geo);
    if ("reason" in checked) return { ok: false, status: checked.reason === RECORD_TOO_LARGE ? 413 : 400, reason: `line ${checked.line}: ${checked.reason}` };
    if (checked.lines.length === 0) return { ok: true, accepted: 0, duplicate: false, publication: this.publication(await this.ctx.storage.getAlarm()) };
    const hash = `${sender}:${await sha256Hex(body)}`;
    const earlier = this.recent.get(hash);
    if (earlier) {
      const outcome = await earlier;
      return outcome.ok ? { ...outcome, duplicate: true } : outcome;
    }
    const cap = this.num("BUFFER_CAP_BYTES", 64 * 1024 * 1024);
    if (this.pendingBytes + this.queuedBytes + body.length > cap) return { ok: false, status: 429, reason: "buffer full", retryAfter: 10 };
    const window = this.num("GROUP_COMMIT_MS", 500);
    const done = new Promise((resolve) => {
      this.queue.push({ lines: checked.lines, atMs: Date.now(), hash, sender, done: resolve });
      this.queuedBytes += body.length;
    });
    this.recent.set(hash, done);
    if (this.recent.size > RECENT_HASHES) this.recent.delete(this.recent.keys().next().value);
    if (window <= 0) await this.flush();
    else if (!this.timer) this.timer = setTimeout(() => {
      void this.flush();
    }, window);
    return done;
  }
  /** Commit queued requests as one row per <=1M records. Acks only after the commit. */
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
      const rows = [];
      let cur = { id: this.nextBatch++, data: "", events: 0, bytes: 0 };
      for (const item of q) {
        for (const line of item.lines) {
          let text3 = stampOne(line, cur.id, item.atMs, cur.events, item.sender);
          let size = encoder2.encode(text3).length;
          if (cur.events > 0 && (cur.bytes + size > ROW_MAX_BYTES || cur.events > MAX_SEQ_PER_ROW)) {
            rows.push(cur);
            cur = { id: this.nextBatch++, data: "", events: 0, bytes: 0 };
            text3 = stampOne(line, cur.id, item.atMs, 0, item.sender);
            size = encoder2.encode(text3).length;
          }
          cur.data += text3;
          cur.bytes += size;
          cur.events++;
        }
      }
      rows.push(cur);
      let bytes = 0;
      const g = this.gen();
      if (this.failNext) {
        this.failNext = false;
        throw new Error("injected flush failure");
      }
      this.ctx.storage.transactionSync(() => {
        for (const r of rows) {
          bytes += r.bytes;
          this.w(`INSERT INTO b_${g} VALUES(?,?,?,?)`, r.id, r.data, r.events, r.bytes);
        }
      });
      this.pendingBytes += bytes;
      const alarm = await this.ctx.storage.getAlarm();
      let next = alarm;
      if (this.pendingBytes >= this.num("SEAL_MAX_BYTES", 8 * 1024 * 1024)) next = Date.now();
      else if (alarm === null || alarm > Date.now() + this.num("SEAL_INTERVAL_MS", 6e5)) next = Date.now() + this.num("SEAL_INTERVAL_MS", 6e5);
      if (next !== alarm) await this.ctx.storage.setAlarm(next);
      const pub = this.publication(next);
      for (const item of q) item.done({ ok: true, accepted: item.lines.length, duplicate: false, publication: pub });
    } catch (e) {
      for (const item of q) {
        this.recent.delete(item.hash);
        item.done({ ok: false, status: 503, reason: "unavailable", retryAfter: 5 });
      }
      console.error("flush failed", e);
    }
  }
  /**
   * A Durable Object alarm that throws is retried by Cloudflare six times in about two minutes and then not again until something calls
   * `setAlarm`. A quiet project has nothing that would, so an R2 outage longer than that would leave its events unpublished for good. So
   * a failure here is caught and a later attempt is scheduled by us: it backs off from `ARCHIVE_RETRY_MS` (5 s) up to the seal interval,
   * forever, and is logged each time.
   */
  async alarm() {
    await this.flush();
    try {
      await this.seal();
      await this.sweep();
      if (this.meta("archive_failures") !== null) this.w("DELETE FROM meta WHERE k=?", "archive_failures");
    } catch (e) {
      const failures = Number(this.meta("archive_failures") ?? 0) + 1;
      this.setMeta("archive_failures", String(failures));
      const delay = Math.min(this.num("ARCHIVE_RETRY_MS", 5e3) * 2 ** Math.min(failures - 1, 20), Math.max(this.num("SEAL_INTERVAL_MS", 6e5), this.num("ARCHIVE_RETRY_MS", 5e3)));
      console.error(`archive publication failed (attempt ${failures}); trying again in ${Math.round(delay / 1e3)} s`, e);
      await this.ctx.storage.setAlarm(Date.now() + delay);
      return;
    }
    this.pruneHookSeen();
    const g = this.gen();
    const left = this.sql.exec(`SELECT COUNT(*) c FROM b_${g}`).one().c;
    if (left > 0 && await this.ctx.storage.getAlarm() === null) {
      const due = this.pendingBytes >= this.num("SEAL_MAX_BYTES", 8 * 1024 * 1024);
      await this.ctx.storage.setAlarm(Date.now() + (due ? 0 : this.num("SEAL_INTERVAL_MS", 6e5)));
    } else if (left === 0 && this.queue.length === 0 && this.intent() === null) await this.settleIdleAlarm();
  }
  /**
   * Seal the buffered batches into one gzip NDJSON archive. Safe to replay: rotation and the intent commit together,
   * the frozen table is immutable, the R2 key is content-addressed, and finalization is one transaction.
   */
  async seal() {
    const intent = this.intent() ?? this.rotate();
    if (!intent) return null;
    const frozen = intent.gen;
    const exists = this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='b_${frozen}'`).toArray().length > 0;
    if (!exists) {
      this.w("DELETE FROM meta WHERE k=?", "sealing");
      return null;
    }
    const rows = this.sql.exec(`SELECT data, events, bytes FROM b_${frozen} ORDER BY id`).toArray();
    const text3 = rows.map((r) => r.data).join("");
    const events = rows.reduce((n, r) => n + r.events, 0);
    const rawBytes = rows.reduce((n, r) => n + r.bytes, 0);
    const gz = await gzip(text3);
    const sha = await sha256Hex(gz);
    const name = `${pad20(intent.seq)}-${sha}.jsonl.gz`;
    const r2key = `v1/projects/${this.ctx.id.name}/archives/${this.archiveId()}/events/${name}`;
    await retry(async () => {
      if (this.failArchive) throw new Error("injected archive failure");
      return this.env.ARCHIVE.put(r2key, gz, { httpMetadata: { contentType: "application/gzip" } });
    });
    const row = { seq: intent.seq, name, r2key, size: gz.length, sha256: sha, events, created_at: Date.now() };
    this.ctx.storage.transactionSync(() => {
      this.w("INSERT INTO manifest VALUES(?,?,?,?,?,?,?)", row.seq, row.name, row.r2key, row.size, row.sha256, row.events, row.created_at);
      this.setMeta("next_seq", String(intent.seq + 1));
      this.w("DELETE FROM meta WHERE k=?", "sealing");
      this.w(`DROP TABLE b_${frozen}`);
    });
    this.pendingBytes = Math.max(0, this.pendingBytes - rawBytes);
    const left = this.sql.exec(`SELECT COUNT(*) c FROM b_${this.gen()}`).one().c;
    if (left === 0 && this.queue.length === 0) await this.settleIdleAlarm();
    return row;
  }
  /** Optional retention: drop archives older than RETENTION_DAYS (0 keeps everything). */
  async sweep() {
    const days = this.num("RETENTION_DAYS", 0);
    if (days <= 0) return;
    const old = this.sql.exec("SELECT seq, r2key FROM manifest WHERE created_at<? ORDER BY seq LIMIT 100", Date.now() - days * 864e5).toArray();
    if (!old.length) return;
    await retry(() => this.env.ARCHIVE.delete(old.map((o) => o.r2key)));
    this.w("DELETE FROM manifest WHERE seq<=?", old[old.length - 1].seq);
    if (old.length === 100 && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 1e3);
  }
  coverage() {
    if (!this.initialized()) return null;
    const next = Number(this.meta("next_seq") ?? 1);
    if (next === 1) return null;
    const lo = this.sql.exec("SELECT MIN(seq) m FROM manifest").one().m;
    const at2 = this.sql.exec("SELECT created_at c FROM manifest ORDER BY seq DESC LIMIT 1").toArray()[0];
    return { archiveId: this.archiveId(), firstRetained: String(lo ?? next), latestPublished: String(next - 1), latestPublishedAt: at2?.c ?? Date.now() };
  }
  listObjects(after, limit) {
    if (!this.initialized()) return [];
    return this.sql.exec("SELECT * FROM manifest WHERE seq>? ORDER BY seq LIMIT ?", after, limit).toArray();
  }
  /** Where publication stands, for a coverage read: pending until the buffered events are archived. */
  async publicationStatus() {
    return this.publication(await this.ctx.storage.getAlarm());
  }
  /** Test hook (DEBUG only). */
  async failNextFlush() {
    this.failNext = true;
  }
  /** Test hooks (DEBUG only): break or heal archive writes, and run the alarm handler now. */
  async setFailArchive(on) {
    this.failArchive = on;
  }
  async runAlarm() {
    await this.alarm();
  }
  /** Debug statistics (the DEBUG routes only). */
  async stats() {
    if (!this.initialized()) return { pending: false, rows: 0, pendingBytes: 0, queued: 0, gen: 0, sealing: null, manifest: 0, alarm: null };
    return { pending: this.hasBuffered(), rows: this.rows, pendingBytes: this.pendingBytes, queued: this.queue.length, gen: this.gen(), sealing: this.intent(), manifest: this.sql.exec("SELECT COUNT(*) n FROM manifest").one().n, alarm: await this.ctx.storage.getAlarm() };
  }
  /** Delete every archive object this project wrote and all of its Durable Object storage (used by `slurp cloud destroy`). */
  async purge() {
    const rows = this.initialized() ? this.sql.exec("SELECT r2key FROM manifest").toArray() : [];
    for (let i = 0; i < rows.length; i += 1e3) await retry(() => this.env.ARCHIVE.delete(rows.slice(i, i + 1e3).map((r) => r.r2key)));
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { archives: rows.length };
  }
  /** Freeze the current generation and persist the seal intent in one transaction. Null when nothing is buffered. */
  rotate() {
    const g = this.gen();
    const top = this.sql.exec(`SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM b_${g}`).one();
    if (top.c === 0) return null;
    const seq = Number(this.meta("next_seq") ?? 1);
    this.ctx.storage.transactionSync(() => {
      this.table(g + 1);
      this.setMeta("gen", String(g + 1));
      this.setMeta("batch_hwm", String(Math.max(top.m, this.nextBatch - 1)));
      this.setMeta("sealing", JSON.stringify({ gen: g, seq }));
    });
    return { gen: g, seq };
  }
};

// src/index.ts
var MIN_ADMIN_TOKEN = 20;
var DEFAULT_MAX_BODY = 10 * 1024 * 1024;
var SIGNED_URL_TTL_S = 3600;
var bearer = /* @__PURE__ */ __name((req) => /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null, "bearer");
var registry = /* @__PURE__ */ __name((env) => env.REGISTRY.get(env.REGISTRY.idFromName("registry")), "registry");
var projectDO = /* @__PURE__ */ __name((env, id) => env.PROJECT.get(env.PROJECT.idFromName(id)), "projectDO");
var KEY = /^slurp_(?:pk|sk)_([0-9a-f]{16})_[0-9a-f]{48}$/;
function presentedToken(req, allowQueryKey) {
  let token = bearer(req);
  if (allowQueryKey) {
    const q = new URL(req.url).searchParams.getAll("key");
    if (q.length) {
      if (q.length !== 1 || !q[0].startsWith("slurp_pk_")) return void 0;
      token = q[0];
    }
  }
  return token;
}
__name(presentedToken, "presentedToken");
async function authenticate(req, env, allowQueryKey = false) {
  const token = presentedToken(req, allowQueryKey);
  return token ? principalFor(token, env) : null;
}
__name(authenticate, "authenticate");
async function principalFor(token, env) {
  if (!token) return null;
  if (isAdmin(token, env)) return { kind: "admin" };
  const m = KEY.exec(token);
  if (!m) return null;
  const project = "prj_" + m[1];
  const a = await projectDO(env, project).authorize(token);
  return a ? { kind: "key", project, ...a } : null;
}
__name(principalFor, "principalFor");
var webhookSecret = /* @__PURE__ */ __name((env, provider, project, epoch) => hmacHex(env.ADMIN_TOKEN, `slurp-webhook-v1:${provider}:${project}:${epoch}`), "webhookSecret");
var isAdmin = /* @__PURE__ */ __name((token, env) => !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN), "isAdmin");
var signingSecret = /* @__PURE__ */ __name((env) => hmacHex(env.ADMIN_TOKEN, "slurp-object-url-v1"), "signingSecret");
var unwrap = /* @__PURE__ */ __name((r) => {
  if (r.ok) return r.value;
  if (r.code === "notfound") throw new NotFoundError();
  if (r.code === "exists") throw new AlreadyExistsError();
  throw new InvalidArgumentError({ cause: r.message });
}, "unwrap");
var needAdmin = /* @__PURE__ */ __name((c) => {
  if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < MIN_ADMIN_TOKEN)
    throw new UnavailableError({ cause: `ADMIN_TOKEN is not configured (needs at least ${MIN_ADMIN_TOKEN} characters)` });
  if (!c.principal) throw new UnauthenticatedError();
  if (c.principal.kind !== "admin") throw new ForbiddenError();
}, "needAdmin");
var info = /* @__PURE__ */ __name((s) => ({ id: s.id, name: s.name, title: s.title ?? void 0, createdAt: s.created_at }), "info");
var keyInfo = /* @__PURE__ */ __name((project, k) => ({ keyId: k.key_id, project, scope: k.scope, name: k.name, createdAt: k.created_at, revokedAt: k.revoked_at ?? void 0, key: k.plain ?? void 0 }), "keyInfo");
var ingestUrl = /* @__PURE__ */ __name((c) => `${c.origin}/v1/events`, "ingestUrl");
async function resolveOrThrow(c, ref) {
  const s = await registry(c.env).get(ref);
  if (!s) throw new NotFoundError();
  return s;
}
__name(resolveOrThrow, "resolveOrThrow");
var projectService = {
  async getProject(c, r) {
    needAdmin(c);
    const s = await resolveOrThrow(c, r.project);
    return { project: info(s), ingestUrl: ingestUrl(c), geoEnabled: await projectDO(c.env, s.id).geoEnabled() };
  },
  async updateProject(c, r) {
    needAdmin(c);
    const s = unwrap(await registry(c.env).update(r.project, r));
    const stub = projectDO(c.env, s.id);
    if (r.geoEnabled !== void 0) await stub.setGeo(r.geoEnabled);
    return { project: info(s), geoEnabled: await stub.geoEnabled() };
  },
  async listProjects(c) {
    needAdmin(c);
    return { projects: (await registry(c.env).list()).map(info) };
  },
  // Two steps that can each be repeated: claim the name in the registry, then set up the project's own object. A crash in
  // between is finished by calling this again.
  async createProject(c, r) {
    needAdmin(c);
    const claimed = unwrap(await registry(c.env).claim(r));
    const { key } = await projectDO(c.env, claimed.project.id).init(!!r.geoEnabled);
    return { project: info(claimed.project), created: claimed.created, publishableKey: key, ingestUrl: ingestUrl(c) };
  },
  async createKey(c, r) {
    needAdmin(c);
    const s = await resolveOrThrow(c, r.project);
    return unwrap(await projectDO(c.env, s.id).createKey(r.scope, r.name ?? ""));
  },
  async listKeys(c, r) {
    needAdmin(c);
    const s = await resolveOrThrow(c, r.project);
    if (r.scope !== void 0 && r.scope !== "publishable" && r.scope !== "secret") throw new InvalidArgumentError({ cause: "scope must be publishable or secret" });
    return { keys: (await projectDO(c.env, s.id).listKeys(r.scope)).map((k) => keyInfo(s.id, k)) };
  },
  async getWebhook(c, r) {
    needAdmin(c);
    if (!isProvider(r.provider)) throw new InvalidArgumentError({ cause: "provider must be github, stripe, revenuecat or generic" });
    const s = await resolveOrThrow(c, r.project);
    const stub = projectDO(c.env, s.id);
    const issued = r.provider === "stripe";
    if (r.secret !== void 0 && !(issued && /^whsec_\S{16,200}$/.test(r.secret))) throw new InvalidArgumentError({ cause: "only Stripe issues its own secret, and it looks like whsec_..." });
    if (r.rotate && issued) throw new InvalidArgumentError({ cause: "rotate the secret in Stripe, then pass the new one as secret" });
    if (r.rotate) await stub.rotateWebhook();
    if (r.secret !== void 0) await stub.setProviderSecret(r.provider, r.secret);
    const key = unwrap(await stub.ensurePublishable(r.provider));
    const secret = issued ? await stub.providerSecret(r.provider) ?? "" : await webhookSecret(c.env, r.provider, s.id, await stub.webhookEpoch());
    return { provider: r.provider, url: `${c.origin}/hooks/${r.provider}?key=${key}`, secret, keyName: r.provider };
  },
  async revokeKey(c, r) {
    needAdmin(c);
    const s = await resolveOrThrow(c, r.project);
    return { key: keyInfo(s.id, unwrap(await projectDO(c.env, s.id).revokeKey(r.keyId))) };
  }
};
var healthService = {
  async version() {
    return { server: "slurp-worker", schema: WebrpcSchemaVersion, webrpc: WebrpcVersion };
  }
};
async function urlSigner(c) {
  const secret = await signingSecret(c.env);
  const exp = Math.floor(Date.now() / 1e3) + SIGNED_URL_TTL_S;
  return { exp, sign: /* @__PURE__ */ __name(async (r2key) => `${c.origin}/v1/objects/${b64url(new TextEncoder().encode(r2key))}?exp=${exp}&sig=${await hmacHex(secret, `${r2key}
${exp}`)}`, "sign") };
}
__name(urlSigner, "urlSigner");
var iso = /* @__PURE__ */ __name((ms) => new Date(ms).toISOString(), "iso");
async function archiveAuth(c, ref) {
  if (!c.principal) throw new UnauthenticatedError();
  const s = await resolveOrThrow(c, ref);
  if (c.principal.kind === "key" && (c.principal.scope !== "secret" || c.principal.project !== s.id)) throw new ForbiddenError();
  return s;
}
__name(archiveAuth, "archiveAuth");
var retentionSeconds = /* @__PURE__ */ __name((env) => Number(env.RETENTION_DAYS) > 0 ? Number(env.RETENTION_DAYS) * 86400 : 0, "retentionSeconds");
var covOut = /* @__PURE__ */ __name((c, cov) => ({ archiveId: cov.archiveId, firstRetained: cov.firstRetained, latestPublished: cov.latestPublished, latestPublishedAt: iso(cov.latestPublishedAt), retentionSeconds: retentionSeconds(c.env) }), "covOut");
var archiveService = {
  async listObjects(c, r) {
    const s = await archiveAuth(c, r.project);
    const limit = Math.min(Math.max(r.limit ?? 1e3, 1), 5e3);
    if (r.after != null && !/^\d+$/.test(r.after)) throw new InvalidArgumentError({ cause: "after must be a decimal sequence" });
    const sd = projectDO(c.env, s.id);
    const cov = await sd.coverage();
    if (!cov) return { objects: [] };
    if (r.after != null && Number(r.after) + 1 < Number(cov.firstRetained)) throw new RetentionGapError();
    const after = r.after != null ? Number(r.after) : Number(cov.firstRetained) - 1;
    const rows = await sd.listObjects(after, limit + 1);
    const page = rows.slice(0, limit);
    const signer = await urlSigner(c);
    const objects = [];
    for (const m of page) objects.push({ seq: String(m.seq), name: m.name, size: m.size, sha256: m.sha256, url: await signer.sign(m.r2key) });
    return { coverage: covOut(c, cov), objects, nextAfter: rows.length > limit ? String(page[page.length - 1].seq) : void 0, expiresAt: objects.length ? iso(signer.exp * 1e3) : void 0 };
  },
  async getCoverage(c, r) {
    const s = await archiveAuth(c, r.project);
    const stub = projectDO(c.env, s.id);
    const cov = await stub.coverage();
    return { coverage: cov ? covOut(c, cov) : void 0, publication: await stub.publicationStatus() };
  }
};
var authService = {
  async whoami(c) {
    const p = c.principal;
    if (!p) throw new UnauthenticatedError();
    return p.kind === "admin" ? { scope: "admin" } : { scope: p.scope, project: p.project, name: p.name };
  }
};
var CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "Retry-After, Slurp-Duplicate" };
var jsonError = /* @__PURE__ */ __name((status, error, extra = {}) => Response.json({ error }, { status, headers: { ...CORS, ...extra } }), "jsonError");
async function ingest(req, env) {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "86400" } });
  if (req.method !== "POST") return jsonError(405, "method not allowed", { Allow: "POST, OPTIONS" });
  const token = presentedToken(req, true);
  if (!token) return jsonError(401, "invalid token");
  if (isAdmin(token, env)) return jsonError(403, "publishable key required");
  const m = KEY.exec(token);
  if (!m) return jsonError(401, "invalid token");
  const max = envNumber(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY);
  let body;
  try {
    body = await readBounded(req, max, { gunzip: false });
  } catch (e) {
    return e instanceof BodyTooLarge ? jsonError(413, "body too large") : jsonError(400, "unreadable body");
  }
  const geo = normalizeGeo(req.cf);
  let res;
  try {
    res = await projectDO(env, "prj_" + m[1]).ingestKey(token, body, geo);
  } catch (e) {
    console.error("ingest failed", e);
    return jsonError(503, "unavailable", { "Retry-After": "5" });
  }
  if (!res.ok) return jsonError(res.status, res.reason, res.retryAfter ? { "Retry-After": String(res.retryAfter) } : {});
  return Response.json({ ok: true, publication: res.publication }, { headers: { ...CORS, ...res.duplicate ? { "Slurp-Duplicate": "1" } : {} } });
}
__name(ingest, "ingest");
async function download(req, env, token) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const u = new URL(req.url);
  const exp = Number(u.searchParams.get("exp"));
  const sig = u.searchParams.get("sig") ?? "";
  let r2key;
  try {
    r2key = new TextDecoder().decode(fromB64url(token));
  } catch {
    return new Response("bad token", { status: 400 });
  }
  if (!exp || exp < Date.now() / 1e3) return new Response("expired", { status: 403 });
  if (!timingSafeEqual(sig, await hmacHex(await signingSecret(env), `${r2key}
${exp}`))) return new Response("bad signature", { status: 403 });
  const obj = await env.ARCHIVE.get(r2key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(req.method === "HEAD" ? null : obj.body, { headers: { "content-type": "application/gzip", "content-length": String(obj.size), etag: obj.httpEtag, "cache-control": "private, no-transform" } });
}
__name(download, "download");
async function purge(req, env, ctx) {
  if (req.method !== "POST") return jsonError(405, "method not allowed", { Allow: "POST" });
  if (ctx.principal?.kind !== "admin") return jsonError(ctx.principal ? 403 : 401, ctx.principal ? "admin token required" : "invalid token");
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== "delete-all-data") return jsonError(400, 'send {"confirm":"delete-all-data"} to confirm');
  const reg = registry(env);
  const projects = await reg.list();
  let archives = 0;
  for (const s of projects) archives += (await projectDO(env, s.id).purge()).archives;
  let strays = 0;
  for (; ; ) {
    const page = await env.ARCHIVE.list({ limit: 1e3 });
    if (page.objects.length === 0) break;
    await env.ARCHIVE.delete(page.objects.map((o) => o.key));
    strays += page.objects.length;
  }
  await reg.purge();
  return Response.json({ ok: true, projects: projects.length, archives, strays });
}
__name(purge, "purge");
function compatHost(env) {
  return {
    async publishable(token) {
      if (!token?.startsWith("slurp_pk_")) return null;
      const p = await principalFor(token, env);
      return p?.kind === "key" && p.scope === "publishable" ? { project: p.project, sender: p.name, geo: p.geo } : null;
    },
    ingest: /* @__PURE__ */ __name((p, body, geo) => projectDO(env, p.project).ingest(p.sender, body, geo), "ingest"),
    async webhookSecret(provider, project) {
      const stub = projectDO(env, project);
      return provider === "stripe" ? stub.providerSecret(provider) : webhookSecret(env, provider, project, await stub.webhookEpoch());
    },
    geoFor: /* @__PURE__ */ __name((req, geo) => geo ? normalizeGeo(req.cf) : null, "geoFor"),
    firstSeen: /* @__PURE__ */ __name((project, id, now) => projectDO(env, project).firstSeen(id, now), "firstSeen"),
    maxBody: envNumber(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY)
  };
}
__name(compatHost, "compatHost");
var index_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/events") return ingest(req, env);
    const sentry = sentryRoute(url.pathname);
    if (sentry) {
      try {
        return await sentryIngest(req, sentry, compatHost(env));
      } catch (e) {
        console.error("sentry ingest failed", e);
        return jsonError(503, "unavailable", { "Retry-After": "5" });
      }
    }
    const hook = hookRoute(url.pathname);
    if (hook) {
      try {
        return await hookIngest(req, hook, compatHost(env));
      } catch (e) {
        console.error("webhook ingest failed", e);
        return jsonError(503, "unavailable", { "Retry-After": "5" });
      }
    }
    const segment = segmentRoute(req.method, url.pathname);
    if (segment) {
      try {
        return await segmentIngest(req, segment, compatHost(env));
      } catch (e) {
        console.error("segment ingest failed", e);
        return jsonError(503, "unavailable", { "Retry-After": "5" });
      }
    }
    if (url.pathname.startsWith("/v1/objects/")) return download(req, env, url.pathname.slice("/v1/objects/".length));
    if (url.pathname === "/healthz") return new Response("ok\n");
    if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD"))
      return new Response(req.method === "HEAD" ? null : setupPage(url.origin, !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" }
      });
    if (url.pathname === "/v1/health")
      return Response.json({ ok: true, apiVersion: WebrpcSchemaVersion, capabilities: { sink: "durable-object", archive: "jsonl.gz", geo: true }, configured: !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN, build: env.SLURP_BUILD ?? null });
    const ctx = { env, principal: await authenticate(req, env), origin: url.origin };
    if (url.pathname === "/v1/admin/purge") return purge(req, env, ctx);
    if (env.DEBUG === "1" && ctx.principal?.kind === "admin" && url.pathname.startsWith("/__debug/")) {
      const [, , op, id] = url.pathname.split("/");
      const stub = projectDO(env, id);
      if (op === "flush") {
        await stub.flush();
        return Response.json(await stub.stats());
      }
      if (op === "seal") {
        await stub.flush();
        return Response.json(await stub.seal());
      }
      if (op === "rotate") {
        await stub.flush();
        return Response.json(await stub.rotate());
      }
      if (op === "sweep") {
        await stub.sweep();
        return Response.json(await stub.stats());
      }
      if (op === "fail-flush") {
        await stub.failNextFlush();
        return Response.json({ ok: true });
      }
      if (op === "fail-archive" || op === "heal-archive") {
        await stub.setFailArchive(op === "fail-archive");
        return Response.json({ ok: true });
      }
      if (op === "alarm") {
        await stub.runAlarm();
        return Response.json(await stub.stats());
      }
      if (op === "stats") return Response.json(await stub.stats());
    }
    return await serveHealthRpc(healthService, ctx, req) ?? await serveProjectRpc(projectService, ctx, req) ?? await serveArchiveRpc(archiveService, ctx, req) ?? await serveAuthRpc(authService, ctx, req) ?? new Response("not found", { status: 404 });
  }
};
export {
  ProjectDO,
  RegistryDO,
  index_default as default
};
