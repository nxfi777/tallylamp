import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { config } from "./config.js";
import { getDb, nowIso } from "./db.js";
import {
  AGENT_SCOPES,
  createConnectorAgent,
  getAgent,
  issueCredential,
  lookupCredential,
  readSession,
  revokeCredential,
  revokeGrant,
  sha256,
  type Principal,
} from "./auth.js";
import { rateLimit } from "./rate-limit.js";
import { audit } from "./audit.js";
import { log } from "./log.js";
import { readCookie } from "./http-util.js";
import { pinnedLookup, resolveVetted } from "./ssrf.js";
import { request as httpsRequest } from "node:https";

const CODE_TTL_MS = 5 * 60 * 1000;
const CIMD_TTL_MS = 24 * 60 * 60 * 1000;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 256 * 1024;
const CIMD_MAX_REDIRECTS = 2;
const CIMD_USER_AGENT = `Tallylamp/${config.version} (+https://github.com/nxfi777/tallylamp)`;
const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 512;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The one resource this authorization server issues tokens for. */
export function mcpResource(): string {
  return `${config.publicUrl}/mcp`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Every OAuth HTML response is a credential-adjacent page: it must not be framed, must not
 * be cached, and must not be able to load or exfiltrate anything.
 *
 * `formAction` widens `form-action` by exactly one origin. The consent form posts here and
 * this server answers with a 302 to the client's redirect_uri, and a browser re-checks
 * `form-action` against every hop of that redirect. Under a bare `'self'` the hop to the
 * client is blocked, so approving does nothing — and because the check happens on a
 * redirect, Chromium withholds the destination and blames the pre-redirect URL, which
 * reads as this server refusing a form posted to itself. Only ever pass a redirect_uri
 * that has already been matched against the client's registration: an unvalidated value
 * here would let a caller name its own origin as a form-action destination.
 */
function secureHeaders(res: Response, formAction?: string): void {
  const extra = formAction ? ` ${originOf(formAction)}` : "";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${extra}; base-uri 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function isLoopbackRedirect(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

export function redirectUriAllowed(raw: string): boolean {
  if (raw.length > MAX_URI_LENGTH) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && isLoopbackRedirect(u)) return true;
  return false;
}

/**
 * RFC 8252 §7.3: a native client's loopback redirect uses an ephemeral port, so the port
 * must not participate in the comparison — and `localhost` and `127.0.0.1` are
 * interchangeable in practice. Everything else is compared byte-for-byte.
 */
function redirectMatches(registered: readonly string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  let c: URL;
  try {
    c = new URL(candidate);
  } catch {
    return false;
  }
  if (c.protocol !== "http:" || !isLoopbackRedirect(c)) return false;
  return registered.some((r) => {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return false;
    }
    return u.protocol === "http:" && isLoopbackRedirect(u) && u.pathname === c.pathname && u.search === c.search;
  });
}

type ClientInfo = {
  clientId: string;
  name: string;
  host: string;
  redirectUris: string[];
  source: "dcr" | "cimd";
  agentId: string | null;
};

type ClientRow = {
  client_id: string;
  redirect_uris_json: string;
  client_name: string | null;
  client_host: string | null;
  source: string;
  agent_id: string | null;
  fetched_at: string | null;
};

function rowToClient(row: ClientRow): ClientInfo {
  let uris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirect_uris_json) as unknown;
    if (Array.isArray(parsed)) uris = parsed.filter((u): u is string => typeof u === "string");
  } catch {
    uris = [];
  }
  return {
    clientId: row.client_id,
    name: row.client_name || row.client_host || row.client_id,
    host: row.client_host || "unknown",
    redirectUris: uris,
    source: row.source === "cimd" ? "cimd" : "dcr",
    agentId: row.agent_id,
  };
}

function loadClientRow(clientId: string): ClientRow | undefined {
  return getDb()
    .prepare(
      `SELECT client_id, redirect_uris_json, client_name, client_host, source, agent_id, fetched_at
       FROM oauth_clients WHERE client_id = ?`,
    )
    .get(clientId) as ClientRow | undefined;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "unknown";
  }
}

/** The scheme/host/port of a redirect_uri, for the one CSP source that has to name it. */
function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

/**
 * Client ID Metadata Documents: the client_id *is* an https URL that serves its own
 * registration. Preferred over DCR because it needs no server-side state and the document
 * is fetched from the client's own origin, so the redirect URIs cannot be attacker-chosen
 * unless the attacker already controls that origin.
 *
 * Every rejection returns the specific gate that fired. A single opaque "could not be
 * fetched" is unusable when the client is a third party whose document you cannot see:
 * a WAF challenge, a stale URL and a self-reference mismatch all need different fixes.
 */
async function fetchClientIdMetadata(clientId: string): Promise<CimdResult> {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return { ok: false, reason: "client_id is not a valid URL." };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "A client_id URL must use https." };
  if (u.pathname === "" || u.pathname === "/") return { ok: false, reason: "A client_id URL must have a path, not just an origin." };
  if (u.hash || u.username || u.password) return { ok: false, reason: "A client_id URL must not carry a fragment or userinfo." };

  const allowlist = config.oauthClientHosts;
  if (allowlist.length && !allowlist.includes(u.hostname.toLowerCase())) {
    return { ok: false, reason: `${u.hostname} is not in TALLYLAMP_OAUTH_CLIENT_HOSTS.` };
  }

  const cached = loadClientRow(clientId);
  if (cached && cached.source === "cimd" && cached.fetched_at && Date.now() - Date.parse(cached.fetched_at) < CIMD_TTL_MS) {
    return { ok: true, client: rowToClient(cached) };
  }

  const fetched = await fetchPinned(u);
  if (!fetched.ok) return { ok: false, reason: `Could not fetch ${u.href}: ${fetched.reason}` };
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fetched.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `${u.href} did not return a JSON object.` };
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `${u.href} did not return valid JSON.` };
  }

  // The document must claim the exact URL it was fetched from, or any https page could
  // register itself as any other client.
  if (doc.client_id !== clientId) {
    const claimed = typeof doc.client_id === "string" ? doc.client_id : JSON.stringify(doc.client_id ?? null);
    return { ok: false, reason: `The document at ${u.href} claims client_id ${claimed}, so it does not describe this client.` };
  }
  const declared = Array.isArray(doc.redirect_uris)
    ? (doc.redirect_uris as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const uris = declared.filter((v) => redirectUriAllowed(v));
  if (!uris.length) {
    return {
      ok: false,
      reason: declared.length
        ? `None of the redirect_uris in ${u.href} are an https or http-loopback URL.`
        : `${u.href} declares no redirect_uris.`,
    };
  }

  const name = typeof doc.client_name === "string" ? doc.client_name.slice(0, 120) : u.hostname;
  getDb()
    .prepare(
      `INSERT INTO oauth_clients(client_id, redirect_uris_json, token_endpoint_auth_method, created_at, client_name, client_host, source, fetched_at)
       VALUES (?, ?, 'none', ?, ?, ?, 'cimd', ?)
       ON CONFLICT(client_id) DO UPDATE SET
         redirect_uris_json = excluded.redirect_uris_json,
         client_name = excluded.client_name,
         client_host = excluded.client_host,
         fetched_at = excluded.fetched_at`,
    )
    .run(clientId, JSON.stringify(uris.slice(0, MAX_REDIRECT_URIS)), nowIso(), name, u.hostname, nowIso());
  return { ok: true, client: rowToClient(loadClientRow(clientId)!) };
}

type FetchResult = { ok: true; body: string } | { ok: false; reason: string };

/**
 * Fetch a client-metadata document with the SSRF policy actually enforced at connect time.
 *
 * `checkDestination` followed by `fetch` resolves DNS twice, so a hostile nameserver can
 * flip the record between the check and the connection. Here the vetted address is pinned
 * into the socket via `lookup`, while SNI and certificate validation still use the real
 * hostname. The body is capped as it streams.
 *
 * A redirect is followed only when it stays on the same host, and the new address is
 * vetted and pinned again. Cross-host redirects would resolve a host the caller never
 * consented to, so they are refused.
 */
async function fetchPinned(start: URL): Promise<FetchResult> {
  let u = start;
  for (let hop = 0; hop <= CIMD_MAX_REDIRECTS; hop++) {
    const res = await fetchPinnedOnce(u);
    if (!res.redirectTo) return res.result;
    let next: URL;
    try {
      next = new URL(res.redirectTo, u);
    } catch {
      return { ok: false, reason: `redirect to an unparseable location` };
    }
    if (next.protocol !== "https:" || next.hostname.toLowerCase() !== start.hostname.toLowerCase()) {
      return { ok: false, reason: `redirected off ${start.hostname} to ${next.origin}, which is not followed` };
    }
    u = next;
  }
  return { ok: false, reason: `more than ${CIMD_MAX_REDIRECTS} redirects` };
}

function fetchPinnedOnce(u: URL): Promise<{ result: FetchResult; redirectTo?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: FetchResult, redirectTo?: string) => {
      if (settled) return;
      settled = true;
      resolve(redirectTo === undefined ? { result } : { result, redirectTo });
    };
    void resolveVetted(u.hostname).then((vetted) => {
      if (!vetted.ok) {
        done({ ok: false, reason: vetted.reason });
        return;
      }
      const pinned = vetted.addresses[0]!;
      const req = httpsRequest(
        {
          protocol: "https:",
          hostname: u.hostname,
          servername: u.hostname,
          port: u.port ? Number(u.port) : 443,
          path: `${u.pathname}${u.search}`,
          method: "GET",
          // A WAF in front of the client's origin will challenge a request with no
          // User-Agent, and the challenge page is indistinguishable from a broken URL.
          headers: { accept: "application/json, */*;q=0.1", "user-agent": CIMD_USER_AGENT, host: u.host },
          timeout: CIMD_TIMEOUT_MS,
          lookup: pinnedLookup(pinned.address, pinned.family),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            const location = res.headers.location;
            res.destroy();
            done({ ok: false, reason: `HTTP ${status}` }, location);
            return;
          }
          if (status !== 200) {
            res.destroy();
            done({ ok: false, reason: `HTTP ${status}${status === 403 || status === 429 ? " (a WAF or bot filter in front of that host is blocking this server)" : ""}` });
            return;
          }
          if (Number(res.headers["content-length"] ?? "0") > CIMD_MAX_BYTES) {
            res.destroy();
            done({ ok: false, reason: `document larger than ${CIMD_MAX_BYTES} bytes` });
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total > CIMD_MAX_BYTES) {
              res.destroy();
              done({ ok: false, reason: `document larger than ${CIMD_MAX_BYTES} bytes` });
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => done({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", (e) => done({ ok: false, reason: `read failed: ${e.message}` }));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done({ ok: false, reason: `no response within ${CIMD_TIMEOUT_MS}ms` });
      });
      req.on("error", (e) => done({ ok: false, reason: (e as Error).message }));
      req.end();
    }, (e: unknown) => {
      // A rejected vet would otherwise leave this promise pending, and the authorize
      // handler awaiting it would never send a response.
      done({ ok: false, reason: `address check failed: ${(e as Error).message}` });
    });
  });
}

type ClientResolution = { ok: true; client: ClientInfo } | { ok: false; reason: string };
type CimdResult = ClientResolution;

/**
 * Resolve a client_id to a registration. A client_id that is neither a registration this
 * server issued nor a dereferenceable CIMD URL is refused outright — this is the check
 * whose absence turns the consent page into a credential-phishing endpoint.
 */
async function resolveClient(clientId: string): Promise<ClientResolution> {
  if (!clientId) return { ok: false, reason: "No client_id was supplied." };
  if (clientId.startsWith("tallylamp_")) {
    const row = loadClientRow(clientId);
    if (!row) return { ok: false, reason: "This client_id is not registered with this Tallylamp." };
    return { ok: true, client: rowToClient(row) };
  }
  if (/^https:\/\//i.test(clientId)) {
    const result = await fetchClientIdMetadata(clientId);
    if (!result.ok) log.warn("cimd rejected", { client_id: clientId, reason: result.reason });
    return result;
  }
  return { ok: false, reason: "client_id must be a registration issued by this server or an https client-metadata URL." };
}

function params(req: Request): Record<string, string> {
  const src = (req.method === "GET" ? req.query : req.body) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src ?? {})) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function multi(req: Request, key: string): string[] {
  const v = (req.body as Record<string, unknown>)?.[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

function adminSession(req: Request): { principal: Principal; token: string } | null {
  const token = readCookie(req.headers.cookie, "tallylamp_session");
  if (!token) return null;
  const principal = readSession(token);
  if (!principal || principal.type !== "admin") return null;
  return { principal, token };
}

/** Binds the consent form to one dashboard session and one exact (client, redirect) pair. */
function consentToken(sessionToken: string, clientId: string, redirectUri: string): string {
  return createHmac("sha256", config.adminSecret || "tallylamp-no-secret")
    .update([sessionToken, clientId, redirectUri].join("\n"))
    .digest("base64url");
}

function consentTokenValid(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

const PAGE_CSS = `
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0c1014; color:#fdffff;
    font-family:"IBM Plex Sans", system-ui, sans-serif; }
  .box { width:min(480px,92vw); background:#161d24; border:1px solid #2a3540; border-radius:12px; padding:1.6rem; }
  h1 { font-size:1.2rem; margin:0 0 .6rem; }
  p { color:#93a0ab; font-size:.9rem; line-height:1.5; }
  dl { margin:1rem 0; font-size:.9rem; }
  dt { color:#93a0ab; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; margin-top:.7rem; }
  dd { margin:.15rem 0 0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-all; }
  ul.scopes { list-style:none; padding:0; margin:.4rem 0 0; font-size:.86rem; }
  ul.scopes li { display:flex; align-items:center; gap:.5rem; padding:.15rem 0; }
  input[type=number] { width:5rem; background:#1c252e; border:1px solid #2a3540; color:#fdffff; border-radius:6px; padding:.35rem .5rem; font:inherit; }
  .row { display:flex; gap:.6rem; margin-top:1.3rem; }
  button { font:inherit; flex:1; padding:.65rem .7rem; border-radius:6px; border:0; cursor:pointer; }
  button.approve { background:#177abf; color:#fff; }
  button.deny { background:#1c252e; color:#fdffff; border:1px solid #2a3540; }
  .err { color:#ea1c25; }
  .lamp { display:inline-block; width:10px; height:10px; border-radius:50%; background:#ea1c25; margin-right:.4rem; }
  code { background:#1c252e; padding:.1rem .3rem; border-radius:4px; }
`;

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
<div class="box">
  <div><span class="lamp"></span><strong>Tallylamp</strong></div>
  ${inner}
</div>`;
}

/**
 * Terminal failure page. It deliberately has no form and never redirects: a request that
 * failed client validation must not be able to bounce the operator anywhere.
 */
function errorPage(res: Response, status: number, title: string, detail: string): void {
  secureHeaders(res);
  res
    .status(status)
    .type("html")
    .send(shell(title, `<h1>${escapeHtml(title)}</h1><p class="err">${escapeHtml(detail)}</p>
      <p>Nothing was authorized. If a link sent you here, do not trust it.</p>`));
}

function consentPage(opts: {
  client: ClientInfo;
  redirectUri: string;
  hidden: Record<string, string>;
  consent: string;
  defaultScopes: readonly string[];
  maxBrowsers: number;
}): string {
  const hidden = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n    ");
  const scopes = AGENT_SCOPES.map(
    (s) => `<li><input type="checkbox" id="scope-${escapeHtml(s)}" name="grant_scope" value="${escapeHtml(s)}"${
      opts.defaultScopes.includes(s) ? " checked" : ""
    }> <label for="scope-${escapeHtml(s)}"><code>${escapeHtml(s)}</code></label></li>`,
  ).join("\n      ");
  return shell(
    "Authorize connector",
    `<h1>${escapeHtml(hostOf(opts.redirectUri))} wants to drive browsers</h1>
  <p>Approving creates a <strong>connector agent</strong> on this Tallylamp. It can create and
  drive browsers of its own. It cannot touch another agent's browsers, take control away from
  you, or reach anything else on this server. Revoke it any time from the Agents page.</p>
  <form method="post" action="/oauth/authorize">
    ${hidden}
    <input type="hidden" name="consent" value="${escapeHtml(opts.consent)}">
    <dl>
      <dt>Claimed name</dt><dd>${escapeHtml(opts.client.name)}</dd>
      <dt>Client</dt><dd>${escapeHtml(opts.client.clientId)}</dd>
      <dt>Authorization code will be sent to</dt><dd>${escapeHtml(hostOf(opts.redirectUri))}</dd>
      <dt>Full redirect</dt><dd>${escapeHtml(opts.redirectUri)}</dd>
      <dt>Name checked?</dt><dd>${
        opts.client.source === "cimd"
          ? "Yes — fetched from the client's own domain"
          : "No — the client registered itself and chose this name"
      }</dd>
      <dt>Scopes</dt>
      <dd><ul class="scopes">
      ${scopes}
      </ul></dd>
      <dt><label for="max-browsers">Browser cap</label></dt>
      <dd><input id="max-browsers" type="number" name="max_browsers" min="1" max="${config.maxBrowsers}" value="${opts.maxBrowsers}"></dd>
    </dl>
    <p>Access tokens last ${Math.round(config.oauthAccessTtlSec / 60)} minutes and renew
    silently until you revoke the connector.</p>
    <div class="row">
      <button class="deny" type="submit" name="action" value="deny">Deny</button>
      <button class="approve" type="submit" name="action" value="approve">Approve</button>
    </div>
  </form>`,
  );
}

function authorizeRedirect(res: Response, redirectUri: string, extra: Record<string, string>): void {
  const dest = new URL(redirectUri);
  for (const [k, v] of Object.entries(extra)) {
    if (v) dest.searchParams.set(k, v);
  }
  // RFC 9207: the issuer identifier lets the client detect mix-up attacks. ChatGPT's
  // stable redirect URI is gated on it.
  dest.searchParams.set("iss", config.publicUrl);
  secureHeaders(res, redirectUri);
  res.redirect(302, dest.toString());
}

function requestedScopes(raw: string | undefined): string[] {
  if (!raw) return [...AGENT_SCOPES];
  const asked = raw.split(/\s+/).filter(Boolean);
  if (asked.includes("mcp:tools")) return [...AGENT_SCOPES];
  const matched = asked.filter((s) => (AGENT_SCOPES as readonly string[]).includes(s));
  return matched.length ? matched : [...AGENT_SCOPES];
}

function resourceAcceptable(resource: string | undefined): boolean {
  if (!resource) return true;
  const want = mcpResource();
  return resource.replace(/\/$/, "") === want || resource.replace(/\/$/, "") === config.publicUrl;
}

/** Reuse the connector agent across reconnects so revoking it stays meaningful. */
function connectorAgentFor(client: ClientInfo, scopes: string[], maxBrowsers: number): Principal {
  if (client.agentId) {
    const existing = getAgent(client.agentId);
    if (existing && existing.type === "agent") {
      if (!existing.enabled) throw new Error("connector-revoked");
      return existing;
    }
  }
  const agent = createConnectorAgent({
    name: `${client.name} (connector)`,
    scopes,
    maxBrowsers,
    labels: { kind: "connector", client_id: client.clientId, client_host: client.host },
  });
  getDb().prepare(`UPDATE oauth_clients SET agent_id = ? WHERE client_id = ?`).run(agent.id, client.clientId);
  return agent;
}

export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    registration_endpoint: `${config.publicUrl}/oauth/register`,
    revocation_endpoint: `${config.publicUrl}/oauth/revoke`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    scopes_supported: ["mcp:tools", ...AGENT_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
  };
}

/**
 * Express 4 does not catch a rejected promise from an async handler: the request would
 * hang with no response instead of returning an error. Every async OAuth route goes
 * through this.
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

export function mountOauth(app: Express): void {
  app.get("/oauth/authorize", asyncHandler(async (req, res) => {
    secureHeaders(res);
    rateLimit(`oauth-authorize-get:${req.ip}`, 60, 20);
    const p = params(req);

    if (p.response_type && p.response_type !== "code") {
      errorPage(res, 400, "Unsupported response type", "This server only supports response_type=code.");
      return;
    }
    if (!p.code_challenge || p.code_challenge_method !== "S256") {
      errorPage(res, 400, "PKCE required", "Send code_challenge with code_challenge_method=S256.");
      return;
    }
    if (!resourceAcceptable(p.resource)) {
      errorPage(res, 400, "Wrong resource", `This server only issues tokens for ${mcpResource()}.`);
      return;
    }
    if (!p.redirect_uri || !redirectUriAllowed(p.redirect_uri)) {
      errorPage(res, 400, "Bad redirect_uri", "redirect_uri must be an https URL or an http loopback URL.");
      return;
    }

    // Resolving a CIMD client_id makes an outbound HTTPS request. Gate that behind the
    // dashboard session so an anonymous request cannot use this endpoint as a fetch proxy.
    const session = adminSession(req);
    if (!session) {
      const next = `/oauth/authorize?${new URLSearchParams(p).toString()}`;
      res.redirect(302, `/login?next=${encodeURIComponent(next)}`);
      return;
    }

    const resolved = await resolveClient(p.client_id ?? "");
    if (!resolved.ok) {
      errorPage(res, 400, "Unknown client", resolved.reason);
      return;
    }
    if (!redirectMatches(resolved.client.redirectUris, p.redirect_uri)) {
      errorPage(res, 400, "Unregistered redirect_uri", "That redirect_uri is not registered for this client.");
      return;
    }

    // Now that this redirect_uri is known to belong to this client, let the consent form
    // reach it. Every earlier exit from this handler keeps the bare `form-action 'self'`.
    secureHeaders(res, p.redirect_uri);
    res.type("html").send(
      consentPage({
        client: resolved.client,
        redirectUri: p.redirect_uri,
        hidden: {
          client_id: p.client_id ?? "",
          redirect_uri: p.redirect_uri,
          state: p.state ?? "",
          code_challenge: p.code_challenge,
          code_challenge_method: "S256",
          resource: p.resource ?? mcpResource(),
          scope: p.scope ?? "",
          response_type: "code",
        },
        consent: consentToken(session.token, p.client_id ?? "", p.redirect_uri),
        defaultScopes: requestedScopes(p.scope),
        maxBrowsers: config.oauthMaxBrowsers,
      }),
    );
  }));

  app.post("/oauth/authorize", asyncHandler(async (req, res) => {
    secureHeaders(res);
    rateLimit(`oauth-auth:${req.ip}`, 20, 8);
    const p = params(req);

    const session = adminSession(req);
    if (!session) {
      errorPage(
        res,
        401,
        "Not signed in",
        "Sign in to the Tallylamp dashboard, then start the connection again from your MCP client.",
      );
      return;
    }
    if (!p.code_challenge || p.code_challenge_method !== "S256") {
      errorPage(res, 400, "PKCE required", "Send code_challenge with code_challenge_method=S256.");
      return;
    }
    if (!resourceAcceptable(p.resource)) {
      errorPage(res, 400, "Wrong resource", `This server only issues tokens for ${mcpResource()}.`);
      return;
    }
    if (!p.redirect_uri || !redirectUriAllowed(p.redirect_uri)) {
      errorPage(res, 400, "Bad redirect_uri", "redirect_uri must be an https URL or an http loopback URL.");
      return;
    }

    // Re-resolve from the submitted fields rather than trusting the hidden inputs.
    const resolved = await resolveClient(p.client_id ?? "");
    if (!resolved.ok) {
      errorPage(res, 400, "Unknown client", resolved.reason);
      return;
    }
    if (!redirectMatches(resolved.client.redirectUris, p.redirect_uri)) {
      errorPage(res, 400, "Unregistered redirect_uri", "That redirect_uri is not registered for this client.");
      return;
    }
    if (!consentTokenValid(consentToken(session.token, p.client_id ?? "", p.redirect_uri), p.consent ?? "")) {
      errorPage(res, 400, "Stale consent form", "Reload the authorization page and try again.");
      return;
    }

    if (p.action === "deny") {
      audit({ actorType: "admin", actorId: "admin", action: "oauth.denied", detail: { clientId: resolved.client.clientId } });
      authorizeRedirect(res, p.redirect_uri, { error: "access_denied", state: p.state ?? "" });
      return;
    }

    const chosen = multi(req, "grant_scope").filter((s) => (AGENT_SCOPES as readonly string[]).includes(s));
    if (!chosen.length) {
      // An empty selection is a refusal, not a request for the defaults. Falling back to
      // the full scope set here meant unticking every box granted everything.
      errorPage(
        res,
        400,
        "Nothing selected",
        "A connector with no scopes cannot do anything. Go back and tick at least one, or press Deny to refuse it.",
      );
      return;
    }
    const scopes = chosen;
    const capRaw = Number(p.max_browsers);
    const cap = Number.isFinite(capRaw) ? Math.min(Math.max(Math.trunc(capRaw), 1), config.maxBrowsers) : config.oauthMaxBrowsers;

    let agent: Principal;
    try {
      agent = connectorAgentFor(resolved.client, scopes, cap);
    } catch {
      errorPage(res, 409, "Connector revoked", "You revoked this connector earlier. Re-enable it on the Agents page to let it back in.");
      return;
    }

    const code = randomBytes(32).toString("base64url");
    const grantId = `grn_${randomBytes(12).toString("hex")}`;
    getDb()
      .prepare(
        `INSERT INTO oauth_codes(code_hash, client_id, redirect_uri, code_challenge, resource, principal_type, principal_id, expires_at, scope, audience, grant_id)
         VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(code),
        resolved.client.clientId,
        p.redirect_uri,
        p.code_challenge,
        p.resource || mcpResource(),
        agent.id,
        new Date(Date.now() + CODE_TTL_MS).toISOString(),
        scopes.join(" "),
        mcpResource(),
        grantId,
      );
    audit({
      actorType: "admin",
      actorId: "admin",
      action: "oauth.authorized",
      targetType: "agent",
      targetId: agent.id,
      detail: { clientId: resolved.client.clientId, redirectHost: hostOf(p.redirect_uri), scopes, maxBrowsers: cap },
    });
    authorizeRedirect(res, p.redirect_uri, { code, state: p.state ?? "" });
  }));

  app.post("/oauth/token", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    rateLimit(`oauth-token:${req.ip}`, 60, 20);
    const p = params(req);
    if (p.grant_type === "authorization_code") return void exchangeCode(p, res);
    if (p.grant_type === "refresh_token") return void refresh(p, res);
    res.status(400).json({ error: "unsupported_grant_type", error_description: "authorization_code and refresh_token only" });
  });

  app.post("/oauth/revoke", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    rateLimit(`oauth-revoke:${req.ip}`, 60, 20);
    const p = params(req);
    // RFC 7009: an unknown token is a success, so revocation cannot be used as an oracle.
    if (p.token) {
      const row = lookupCredential(p.token);
      if (row) {
        if (row.grant_id) {
          revokeGrant(row.grant_id);
          audit({ actorType: "agent", actorId: row.principal_id, action: "oauth.revoked", detail: { grantId: row.grant_id } });
        } else {
          revokeCredential(p.token);
        }
      }
    }
    res.status(200).json({});
  });

  app.post("/oauth/register", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    rateLimit(`oauth-register:${req.ip}`, 12, 6);
    const raw = Array.isArray(req.body?.redirect_uris) ? (req.body.redirect_uris as unknown[]) : [];
    const allowed = raw
      .filter((u): u is string => typeof u === "string")
      .filter((u) => redirectUriAllowed(u))
      .slice(0, MAX_REDIRECT_URIS);
    if (!allowed.length) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must contain at least one https or http-loopback URL",
      });
      return;
    }
    const name = typeof req.body?.client_name === "string" ? req.body.client_name.slice(0, 120) : hostOf(allowed[0]!);
    const clientId = `tallylamp_${randomBytes(12).toString("hex")}`;
    getDb()
      .prepare(
        `INSERT INTO oauth_clients(client_id, redirect_uris_json, token_endpoint_auth_method, created_at, client_name, client_host, source)
         VALUES (?, ?, 'none', ?, ?, ?, 'dcr')`,
      )
      .run(clientId, JSON.stringify(allowed), nowIso(), name, hostOf(allowed[0]!));
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      redirect_uris: allowed,
      client_name: name,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });
}

type CodeRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  principal_type: string;
  principal_id: string;
  expires_at: string;
  used: number;
  scope: string | null;
  audience: string | null;
  grant_id: string | null;
};

function issuePair(principalId: string, clientId: string, grantId: string, audience: string, scope: string) {
  const accessTtl = config.oauthAccessTtlSec;
  const access = issueCredential("agent", principalId, {
    prefix: "tl_oa",
    expiresAt: new Date(Date.now() + accessTtl * 1000).toISOString(),
    audience,
    kind: "access",
    clientId,
    grantId,
  });
  const refreshToken = issueCredential("agent", principalId, {
    prefix: "tl_rt",
    expiresAt: new Date(Date.now() + config.oauthRefreshTtlSec * 1000).toISOString(),
    audience,
    kind: "refresh",
    clientId,
    grantId,
  });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: accessTtl,
    refresh_token: refreshToken,
    scope,
  };
}

function exchangeCode(p: Record<string, string>, res: Response): void {
  if (!p.code || !p.code_verifier || !p.redirect_uri || !p.client_id) {
    res.status(400).json({ error: "invalid_request", error_description: "code, code_verifier, redirect_uri and client_id are required" });
    return;
  }
  const row = getDb()
    .prepare(
      `SELECT client_id, redirect_uri, code_challenge, principal_type, principal_id, expires_at, used, scope, audience, grant_id
       FROM oauth_codes WHERE code_hash = ?`,
    )
    .get(sha256(p.code)) as CodeRow | undefined;
  if (!row) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (row.used) {
    // A replayed code means the code leaked. RFC 6749 §4.1.2: revoke what it produced.
    if (row.grant_id) revokeGrant(row.grant_id);
    res.status(400).json({ error: "invalid_grant", error_description: "code already used" });
    return;
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    res.status(400).json({ error: "invalid_grant", error_description: "code expired" });
    return;
  }
  if (row.client_id !== p.client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "code was issued to a different client" });
    return;
  }
  if (row.redirect_uri !== p.redirect_uri) {
    res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    return;
  }
  const challenge = createHash("sha256").update(p.code_verifier).digest("base64url");
  if (challenge !== row.code_challenge) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    return;
  }
  getDb().prepare(`UPDATE oauth_codes SET used = 1 WHERE code_hash = ?`).run(sha256(p.code));

  const agent = getAgent(row.principal_id);
  if (!agent || agent.type !== "agent" || !agent.enabled) {
    res.status(400).json({ error: "invalid_grant", error_description: "connector revoked" });
    return;
  }
  res.json(
    issuePair(
      row.principal_id,
      row.client_id,
      row.grant_id ?? `grn_${randomBytes(12).toString("hex")}`,
      row.audience ?? mcpResource(),
      row.scope ?? "mcp:tools",
    ),
  );
}

function refresh(p: Record<string, string>, res: Response): void {
  if (!p.refresh_token || !p.client_id) {
    res.status(400).json({ error: "invalid_request", error_description: "refresh_token and client_id are required" });
    return;
  }
  const row = lookupCredential(p.refresh_token);
  if (!row || row.kind !== "refresh") {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (row.revoked_at) {
    // Rotation means a live refresh token is never presented twice. A revoked one coming
    // back means it was captured, so the whole family dies.
    if (row.grant_id) revokeGrant(row.grant_id);
    audit({ actorType: "agent", actorId: row.principal_id, action: "oauth.refresh_reuse", detail: { grantId: row.grant_id } });
    res.status(400).json({ error: "invalid_grant", error_description: "refresh token reuse detected" });
    return;
  }
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    res.status(400).json({ error: "invalid_grant", error_description: "refresh token expired" });
    return;
  }
  if (row.client_id && row.client_id !== p.client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "refresh token belongs to another client" });
    return;
  }
  const agent = getAgent(row.principal_id);
  if (!agent || agent.type !== "agent" || !agent.enabled) {
    res.status(400).json({ error: "invalid_grant", error_description: "connector revoked" });
    return;
  }
  revokeCredential(p.refresh_token);
  res.json(
    issuePair(
      row.principal_id,
      row.client_id ?? p.client_id,
      row.grant_id ?? `grn_${randomBytes(12).toString("hex")}`,
      row.audience ?? mcpResource(),
      agent.scopes.join(" "),
    ),
  );
}
