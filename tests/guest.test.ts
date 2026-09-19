import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type WebSocketType from "ws";
import { startTestServer, json, type TestCtx } from "./helpers.js";
import { resetRateLimits } from "../src/rate-limit.js";
import { emitFakeEvent, fakeCdpCalls, resetFakeCdp, setFakeHistory, setFakeTargets } from "../src/fake-chrome.js";
import { listAudit } from "../src/audit.js";
import { cleanHosts, hostAllowed } from "../src/guests.js";

let ctx: TestCtx;
let A: string;
let B: string;

type Created = { token: string; url: string; guest: { id: string; label: string } };
type Seen = Array<Record<string, unknown>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function admin(path: string, method = "GET", body?: unknown) {
  return json(`${ctx.url}${path}`, {
    method,
    headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newBrowser(name: string): Promise<string> {
  const r = await admin("/api/v1/browsers", "POST", { name, start: true });
  assert.equal(r.status, 201);
  return (r.body as { browser: { id: string } }).browser.id;
}

async function makeGuest(browserId: string, body: Record<string, unknown>): Promise<Created> {
  const r = await admin(`/api/v1/browsers/${browserId}/guests`, "POST", body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as Created;
}

async function signIn(token: string): Promise<string> {
  const r = await fetch(`${ctx.url}/guest/api/v1/session`, {
    method: "POST",
    headers: { Origin: ctx.url, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(r.status, 200, await r.text());
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function guest(cookie: string, path: string, method = "GET", body?: unknown) {
  return json(`${ctx.url}/guest/api/v1${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ctx.url, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function guestTicket(cookie: string, mode: "watch" | "control"): Promise<{ ticket: string; browserId: string }> {
  const r = await guest(cookie, "/viewer-ticket", "POST", { mode });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { ticket: string; browserId: string };
}

async function adminTicket(browserId: string, mode: "watch" | "control"): Promise<string> {
  const r = await admin(`/api/v1/browsers/${browserId}/viewer-ticket`, "POST", { mode });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body as { ticket: string }).ticket;
}

const viewUrl = (browserId: string, ticket: string, extra = "") =>
  `${ctx.url.replace("http", "ws")}/api/v1/browsers/${browserId}/view?ticket=${encodeURIComponent(ticket)}${extra}`;

/** Open a socket; resolve with it on 101, or with the refusal status. */
async function tryOpen(
  url: string,
  origin: string | null,
): Promise<{ status: number; ws?: WebSocketType; seen: Seen; closed: Promise<number> }> {
  const WebSocket = (await import("ws")).default;
  const seen: Seen = [];
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === null ? {} : { origin });
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (raw, binary) => {
      if (binary) return;
      try {
        seen.push(JSON.parse(String(raw)));
      } catch {
        /* ignore */
      }
    });
    ws.on("open", () => resolve({ status: 101, ws, seen, closed }));
    ws.on("unexpected-response", (req, res) => {
      req.destroy();
      resolve({ status: res.statusCode ?? 0, seen, closed });
    });
    ws.on("error", () => resolve({ status: -1, seen, closed }));
  });
}

const within = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, sleep(ms).then(() => fallback)]);

function audits(action: string) {
  return (listAudit(500) as Array<{ action: string; actor_type: string; actor_id: string; detail_json: string }>).filter(
    (e) => e.action === action,
  );
}

describe("guest links", () => {
  before(async () => {
    // The suite hands out more links on one browser than an operator should.
    process.env.TALLYLAMP_GUESTS_PER_BROWSER = "100";
    ctx = await startTestServer();
    A = await newBrowser("guest-a");
    B = await newBrowser("guest-b");
  });
  after(async () => {
    delete process.env.TALLYLAMP_GUESTS_PER_BROWSER;
    await ctx.close();
  });
  beforeEach(() => {
    resetRateLimits();
    for (const id of [A, B]) ctx.browsers.releaseControl(id);
  });

  describe("creating a link", () => {
    it("is admin only, returns the token once, and never lists it", async () => {
      const asAgent = await json(`${ctx.url}/api/v1/browsers/${A}/guests`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.agentToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ label: "x" }),
      });
      assert.equal(asAgent.status, 403);

      const made = await makeGuest(A, { label: "Sam", modes: ["watch", "control"] });
      assert.match(made.token, /^tl_guest_/);
      assert.equal(made.url, `${ctx.url}/guest#${made.token}`, "the token rides in the fragment, never the path or query");
      assert.deepEqual((made.guest as unknown as { modes: string[] }).modes, ["watch", "control"]);

      const list = await admin(`/api/v1/browsers/${A}/guests`);
      assert.equal(list.status, 200);
      const text = JSON.stringify(list.body);
      assert.ok(!text.includes(made.token), "the token must not be listed");
      assert.ok(!text.includes("token_hash") && !text.includes("tokenHash"));
    });

    it("defaults to watch only and rejects malformed input", async () => {
      const made = await makeGuest(A, { label: "Watcher" });
      assert.deepEqual((made.guest as unknown as { modes: string[] }).modes, ["watch"]);
      for (const body of [
        {},
        { label: "" },
        { label: "x", modes: [] },
        { label: "x", modes: ["admin"] },
        { label: "x", expiresInSec: 10 },
        { label: "x", expiresInSec: 10 * 86400 },
        { label: "x", allowedHosts: ["com"] },
        { label: "x", allowedHosts: ["example.com/path"] },
        { label: "x", allowedHosts: ["user@example.com"] },
        { label: "x", allowedHosts: ["example.com:8443"] },
        { label: "x", allowedHosts: ["*", "example.com"] },
      ]) {
        resetRateLimits(); // creation is rate limited, and this loop is not what that limit is about
        const r = await admin(`/api/v1/browsers/${A}/guests`, "POST", body);
        assert.equal(r.status, 400, `must refuse ${JSON.stringify(body)}`);
      }
      const missing = await admin(`/api/v1/browsers/nope/guests`, "POST", { label: "x" });
      assert.equal(missing.status, 404);
    });

    it("matches hosts exactly or as a parent domain, never as a suffix", () => {
      assert.deepEqual(cleanHosts(["Example.COM", "*.accounts.test"]), ["example.com", "accounts.test"]);
      assert.equal(hostAllowed(["example.com"], "https://example.com/x"), true);
      assert.equal(hostAllowed(["example.com"], "https://login.example.com/"), true);
      assert.equal(hostAllowed(["example.com"], "https://evilexample.com/"), false);
      assert.equal(hostAllowed(["example.com"], "https://example.com.evil.test/"), false);
      assert.equal(hostAllowed(["example.com"], "file:///etc/passwd"), false);
      assert.equal(hostAllowed(["*"], "javascript:alert(1)"), false);
      assert.equal(hostAllowed([], "https://example.com/"), false);
    });
  });

  describe("exchanging the link", () => {
    it("sets an HttpOnly, SameSite=Strict cookie scoped to /guest", async () => {
      const made = await makeGuest(A, { label: "Cookie check" });
      const r = await fetch(`${ctx.url}/guest/api/v1/session`, {
        method: "POST",
        headers: { Origin: ctx.url, "Content-Type": "application/json" },
        body: JSON.stringify({ token: made.token }),
      });
      assert.equal(r.status, 200);
      const sc = r.headers.get("set-cookie") ?? "";
      assert.match(sc, /^tallylamp_guest=/);
      assert.match(sc, /HttpOnly/);
      assert.match(sc, /SameSite=Strict/);
      assert.match(sc, /Path=\/guest(;|$)/);
      assert.ok(!sc.includes(made.token), "the cookie is a session, not the link token");
    });

    it("refuses a missing or foreign Origin, and answers every bad token the same way", async () => {
      const made = await makeGuest(A, { label: "Origin check" });
      for (const headers of [{}, { Origin: "https://evil.test" }, { Origin: "null" }]) {
        const r = await json(`${ctx.url}/guest/api/v1/session`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ token: made.token }),
        });
        assert.equal(r.status, 403, `Origin ${JSON.stringify(headers)} must be refused`);
      }
      const bodies = new Set<string>();
      for (const token of ["tl_guest_nope", "garbage", "", made.token.slice(0, -2)]) {
        const r = await json(`${ctx.url}/guest/api/v1/session`, {
          method: "POST",
          headers: { Origin: ctx.url, "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        assert.equal(r.status, 401);
        bodies.add(JSON.stringify(r.body));
      }
      assert.equal(bodies.size, 1, "a probe must not tell invalid from expired from revoked");
      assert.ok(audits("guest.session.denied").length > 0);
    });

    it("works once, and records a second use of the same link", async () => {
      const made = await makeGuest(A, { label: "Once" });
      await signIn(made.token);
      const again = await json(`${ctx.url}/guest/api/v1/session`, {
        method: "POST",
        headers: { Origin: ctx.url, "Content-Type": "application/json" },
        body: JSON.stringify({ token: made.token }),
      });
      assert.equal(again.status, 401, "a forwarded or leaked link opens nothing once it has been used");
      // Hammering the spent link must not spend the real guest's audit budget.
      for (let i = 0; i < 30; i++) {
        resetRateLimits();
        await json(`${ctx.url}/guest/api/v1/session`, {
          method: "POST",
          headers: { Origin: ctx.url, "Content-Type": "application/json" },
          body: JSON.stringify({ token: made.token }),
        });
      }
      const { getDb } = await import("../src/db.js");
      const spent = getDb().prepare(`SELECT audit_count FROM browser_guests WHERE id = ?`).get(made.guest.id) as { audit_count: number };
      assert.ok(spent.audit_count <= 1, `reuse attempts must not draw on the link's budget (spent ${spent.audit_count})`);
      assert.ok(audits("guest.link.reused").some((e) => e.actor_id === made.guest.id));
      const listed = (await admin(`/api/v1/browsers/${A}/guests`)).body as { guests: Array<{ id: string; openedAt: string | null }> };
      assert.ok(listed.guests.find((g) => g.id === made.guest.id)!.openedAt, "the operator can see it was opened");
    });

    it("serves a page that loads no dashboard code and cannot run inline script", async () => {
      const r = await fetch(`${ctx.url}/guest`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(!html.includes("/app.js") && !html.includes("/app.css"), "the dashboard bundle must not load");
      const csp = r.headers.get("content-security-policy") ?? "";
      assert.match(csp, /script-src 'self'/);
      assert.ok(!csp.includes("unsafe-inline"));
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.match(r.headers.get("cache-control") ?? "", /no-store/);
      const js = await fetch(`${ctx.url}/guest/assets/guest.js`);
      assert.equal(js.status, 200);
      assert.ok(!(await js.text()).includes("/api/v1/browsers/${id}/viewer-ticket"), "the page must not call admin routes");
    });
  });

  describe("what a guest can reach", () => {
    let made: Created;
    let cookie: string;
    before(async () => {
      made = await makeGuest(A, { label: "Reach", modes: ["watch", "control"] });
      cookie = await signIn(made.token);
    });

    it("gets a reduced view of its own browser and nothing else", async () => {
      const r = await guest(cookie, "/browser");
      assert.equal(r.status, 200);
      const b = (r.body as { browser: Record<string, unknown> }).browser;
      assert.deepEqual(Object.keys(b).sort(), ["access", "control", "id", "name", "status"]);
      assert.equal(b.id, A);
      const text = JSON.stringify(r.body);
      for (const leak of ["proxy", "metadata", "signedInSites", "owner", "lentTo", "provenance", "profile"]) {
        assert.ok(!text.includes(`"${leak}"`), `${leak} must not reach a guest`);
      }
    });

    it("opens nothing on /api/v1 or /mcp, for its own browser or any other", async () => {
      const sessionValue = cookie.split("=")[1]!;
      const credentials: Array<[string, Record<string, string>]> = [
        ["guest cookie", { Cookie: cookie }],
        ["guest session as admin cookie", { Cookie: `tallylamp_session=${sessionValue}` }],
        ["link token as bearer", { Authorization: `Bearer ${made.token}` }],
        ["link token as admin cookie", { Cookie: `tallylamp_session=${made.token}` }],
      ];
      const routes: Array<[string, string]> = [];
      for (const id of [A, B]) {
        for (const [m, p] of [
          ["GET", `/api/v1/browsers/${id}`],
          ["PATCH", `/api/v1/browsers/${id}`],
          ["DELETE", `/api/v1/browsers/${id}`],
          ["POST", `/api/v1/browsers/${id}/start`],
          ["POST", `/api/v1/browsers/${id}/stop`],
          ["POST", `/api/v1/browsers/${id}/control`],
          ["DELETE", `/api/v1/browsers/${id}/control`],
          ["POST", `/api/v1/browsers/${id}/control/heartbeat`],
          ["POST", `/api/v1/browsers/${id}/viewer-ticket`],
          ["GET", `/api/v1/browsers/${id}/thumbnail`],
          ["GET", `/api/v1/browsers/${id}/guests`],
          ["POST", `/api/v1/browsers/${id}/guests`],
          ["POST", `/api/v1/browsers/${id}/tunnels`],
          ["PUT", `/api/v1/browsers/${id}/extensions`],
        ] as Array<[string, string]>) routes.push([m, p]);
      }
      routes.push(
        ["GET", "/api/v1/browsers"],
        ["POST", "/api/v1/browsers"],
        ["GET", "/api/v1/status"],
        ["GET", "/api/v1/me"],
        ["GET", "/api/v1/audit"],
        ["GET", "/api/v1/agents"],
        ["POST", "/api/v1/agents"],
        ["GET", "/api/v1/seeds"],
        ["GET", "/api/v1/requests"],
      );
      for (const [label, headers] of credentials) {
        for (const [method, path] of routes) {
          const r = await json(`${ctx.url}${path}`, {
            method,
            headers: { ...headers, Origin: ctx.url, "Content-Type": "application/json" },
            body: method === "GET" ? undefined : "{}",
          });
          assert.equal(r.status, 401, `${label}: ${method} ${path} must not open (got ${r.status})`);
        }
      }
      const mcp = await json(`${ctx.url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${made.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(mcp.status, 401);
    });

    it("gets the same 403 for every other path under /guest/api, and each one is audited", async () => {
      const before = audits("guest.request.denied").length;
      for (const [method, path] of [
        ["GET", `/guest/api/v1/browsers/${B}`],
        ["GET", `/guest/api/v1/browsers/${A}`],
        ["POST", "/guest/api/v1/stop"],
        ["DELETE", "/guest/api/v1/browser"],
        ["GET", "/guest/api/v1/audit"],
        ["GET", "/guest/api/v1/Browser"],
        ["GET", "/guest/api/v1/browser/"],
        ["GET", "/guest/api/v2/browser"],
        ["GET", "/guest/api/v1/../../api/v1/browsers"],
      ]) {
        const r = await json(`${ctx.url}${path}`, { method, headers: { Cookie: cookie, Origin: ctx.url } });
        assert.ok(r.status === 403 || r.status === 401, `${method} ${path} must be refused (got ${r.status})`);
      }
      assert.ok(audits("guest.request.denied").length > before);
      const withoutCookie = await json(`${ctx.url}/guest/api/v1/audit`, { headers: { Origin: ctx.url } });
      assert.equal(withoutCookie.status, 401, "an unknown path without a session looks like a known one");
    });

    it("refuses a state change with no Origin even when the cookie is valid", async () => {
      const r = await json(`${ctx.url}/guest/api/v1/control`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(r.status, 403);
      const cross = await json(`${ctx.url}/guest/api/v1/browser`, {
        headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(cross.status, 403);
    });

    it("keeps a route added later without any guard closed to guests", async () => {
      // Registered after startup with no auth of its own: exactly the mistake default-deny exists for.
      ctx.app.get("/api/v1/browsers/:id/dummy-unguarded", (req, res) => res.json({ ok: true, id: req.params.id }));
      ctx.app.post("/api/v1/dummy-unguarded", (_req, res) => res.json({ ok: true }));
      const asAdmin = await admin(`/api/v1/browsers/${A}/dummy-unguarded`);
      assert.equal(asAdmin.status, 200, "the route itself works");
      for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${made.token}` }]) {
        const r1 = await json(`${ctx.url}/api/v1/browsers/${A}/dummy-unguarded`, { headers });
        const r2 = await json(`${ctx.url}/api/v1/dummy-unguarded`, { method: "POST", headers: { ...headers, Origin: ctx.url } });
        assert.equal(r1.status, 401);
        assert.equal(r2.status, 401);
      }
    });
  });

  describe("control", () => {
    let full: Created;
    let fullCookie: string;
    let watcher: Created;
    let watcherCookie: string;
    before(async () => {
      full = await makeGuest(A, { label: "Driver", modes: ["watch", "control"] });
      fullCookie = await signIn(full.token);
      watcher = await makeGuest(A, { label: "Onlooker" });
      watcherCookie = await signIn(watcher.token);
    });

    it("lets a watch-only link watch and nothing more", async () => {
      assert.equal((await guest(watcherCookie, "/control", "POST", {})).status, 403);
      assert.equal((await guest(watcherCookie, "/viewer-ticket", "POST", { mode: "control" })).status, 403);
      assert.equal((await guest(watcherCookie, "/viewer-ticket", "POST", { mode: "watch" })).status, 200);
    });

    it("never lets a guest force, and never takes control off a person", async () => {
      const forced = await guest(fullCookie, "/control", "POST", { force: true });
      assert.equal(forced.status, 403);
      assert.ok(audits("guest.control.denied").some((e) => e.actor_id === full.guest.id && e.detail_json.includes("force")));

      ctx.browsers.acquireControl(A, "human", "admin", { force: true });
      const r = await guest(fullCookie, "/control", "POST", {});
      assert.equal(r.status, 409, "the operator's lease must survive a guest asking for it");
      assert.equal(ctx.browsers.controlState(A).controllerId, "admin");
      // Returning control is only ever your own.
      await guest(fullCookie, "/control", "DELETE");
      assert.equal(ctx.browsers.controlState(A).controllerId, "admin", "a guest's DELETE must not drop the operator's lease");
    });

    it("takes control off an agent, and records who did it", async () => {
      ctx.browsers.acquireControl(A, "agent", "some-agent");
      const r = await guest(fullCookie, "/control", "POST", {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const b = (r.body as { browser: { control: { holder: string; leaseToken: string } } }).browser;
      assert.equal(b.control.holder, "you");
      assert.ok(b.control.leaseToken);
      assert.equal(ctx.browsers.controlState(A).controllerId, `guest:${full.guest.id}`);

      const takeover = audits("human.takeover")[0]!;
      assert.equal(takeover.actor_type, "guest");
      assert.equal(takeover.actor_id, full.guest.id);
      assert.match(takeover.detail_json, /Driver/);
      assert.ok(audits("control.preempted").some((e) => e.actor_id === full.guest.id));

      // Another guest on the same browser cannot take it off this one.
      const rival = await makeGuest(A, { label: "Rival", modes: ["watch", "control"] });
      const other = await guest(await signIn(rival.token), "/control", "POST", {});
      assert.equal(other.status, 409);
      assert.equal(ctx.browsers.controlState(A).controllerId, `guest:${full.guest.id}`);

      const back = await guest(fullCookie, "/control", "DELETE");
      assert.equal(back.status, 200);
      assert.equal(ctx.browsers.controlState(A).controllerType, "none");
      const released = audits("control.released")[0]!;
      assert.equal(released.actor_type, "guest");
      assert.equal(released.actor_id, full.guest.id);
      assert.match(released.detail_json, /Driver/);
    });

    it("binds the lease heartbeat to the guest that holds it", async () => {
      const r = await guest(fullCookie, "/control", "POST", {});
      const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
      assert.equal((await guest(fullCookie, "/control/heartbeat", "POST", { leaseToken: lease })).status, 200);
      assert.equal(
        (await guest(watcherCookie, "/control/heartbeat", "POST", { leaseToken: lease })).status,
        409,
        "another guest holding the token must not renew it",
      );
      const asAdmin = await admin(`/api/v1/browsers/${A}/control/heartbeat`, "POST", { leaseToken: lease });
      assert.equal(asAdmin.status, 403, "the operator renews its own leases, not a guest's");
    });

    it("does not restart the hold clock when control is given back and taken again", async () => {
      const g = await makeGuest(A, { label: "Cycler", modes: ["watch", "control"] });
      const c = await signIn(g.token);
      process.env.TALLYLAMP_GUEST_MAX_LEASE_SEC = "1";
      try {
        assert.equal((await guest(c, "/control", "POST", {})).status, 200);
        for (let i = 0; i < 3; i++) {
          await sleep(300);
          assert.equal((await guest(c, "/control", "DELETE")).status, 200);
          const again = await guest(c, "/control", "POST", {});
          if (again.status !== 200) break;
        }
        await sleep(200);
        assert.equal(ctx.browsers.controlState(A).controllerType, "none", "a release and retake must not reset the maximum");
        assert.ok(audits("guest.control.max_age").some((e) => e.actor_id === g.guest.id));
        assert.equal((await guest(c, "/control", "POST", {})).status, 409, "and then the guest waits");
      } finally {
        delete process.env.TALLYLAMP_GUEST_MAX_LEASE_SEC;
      }
    });

    it("refuses a guest's actions once its link has used up its audit budget", async () => {
      process.env.TALLYLAMP_GUEST_AUDIT_BUDGET = "8";
      try {
        const g = await makeGuest(A, { label: "Noisy", modes: ["watch", "control"] });
        const c = await signIn(g.token); // 1
        let refused = 0;
        for (let i = 0; i < 6; i++) {
          resetRateLimits();
          const r = await guest(c, "/control", "POST", {}); // 3 each
          if (r.status === 429) refused += 1;
          await guest(c, "/control", "DELETE");
        }
        assert.ok(refused >= 4, "past the budget, the action is refused rather than done unrecorded");
        const rows = (listAudit(5000) as Array<{ actor_id: string }>).filter((e) => e.actor_id === g.guest.id);
        assert.ok(rows.length <= 9, `a guest's audit rows stay inside the budget (got ${rows.length})`);
        assert.ok(audits("guest.audit_budget.exhausted").some((e) => e.actor_id === g.guest.id));
        await guest(c, "/viewer-ticket", "POST", { mode: "watch" }); // may just fit
        assert.equal((await guest(c, "/viewer-ticket", "POST", { mode: "watch" })).status, 429);
      } finally {
        delete process.env.TALLYLAMP_GUEST_AUDIT_BUDGET;
      }
    });

    it("ends a guest lease at the maximum age and makes the guest wait before retaking it", async () => {
      const timer = await makeGuest(A, { label: "Timer", modes: ["watch", "control"] });
      const fullCookie = await signIn(timer.token);
      const full = timer;
      process.env.TALLYLAMP_GUEST_MAX_LEASE_SEC = "1";
      try {
        const r = await guest(fullCookie, "/control", "POST", {});
        assert.equal(r.status, 200);
        const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
        await sleep(600);
        // Re-taking your own lease must not restart the clock.
        assert.equal((await guest(fullCookie, "/control", "POST", {})).status, 200);
        await sleep(600);
        assert.equal(ctx.browsers.controlState(A).controllerType, "none", "the lease must end at the maximum age");
        assert.equal((await guest(fullCookie, "/control/heartbeat", "POST", { leaseToken: lease })).status, 409);
        const again = await guest(fullCookie, "/control", "POST", {});
        assert.equal(again.status, 409);
        assert.ok(Number(again.headers.get("retry-after")) > 0);
        assert.ok(audits("guest.control.max_age").some((e) => e.actor_id === full.guest.id));
      } finally {
        delete process.env.TALLYLAMP_GUEST_MAX_LEASE_SEC;
      }
    });
  });

  describe("the viewer socket", () => {
    let made: Created;
    let cookie: string;
    before(async () => {
      made = await makeGuest(A, { label: "Viewer", modes: ["watch", "control"] });
      cookie = await signIn(made.token);
    });

    it("opens a watch socket from the trusted origin, once per ticket, for its own browser only", async () => {
      const { ticket } = await guestTicket(cookie, "watch");
      const wrongBrowser = await tryOpen(viewUrl(B, ticket), ctx.url);
      assert.equal(wrongBrowser.status, 401, "a ticket for A must not open B");
      const ok = await tryOpen(viewUrl(A, ticket), ctx.url);
      assert.equal(ok.status, 101);
      ok.ws!.close();
      const reused = await tryOpen(viewUrl(A, ticket), ctx.url);
      assert.equal(reused.status, 401, "a used ticket must fail");
    });

    it("refuses a guest socket with no Origin, a foreign Origin, or the desktop surface", async () => {
      const t1 = await guestTicket(cookie, "watch");
      assert.equal((await tryOpen(viewUrl(A, t1.ticket), null)).status, 403);
      const t2 = await guestTicket(cookie, "watch");
      assert.equal((await tryOpen(viewUrl(A, t2.ticket), "https://evil.test")).status, 403);
      const t3 = await guestTicket(cookie, "watch");
      assert.equal((await tryOpen(viewUrl(A, t3.ticket, "&surface=desktop"), ctx.url)).status, 403);
    });

    it("refuses a foreign Origin for the operator too, but still serves a non-browser client", async () => {
      const foreign = await tryOpen(viewUrl(A, await adminTicket(A, "watch")), "https://evil.test");
      assert.equal(foreign.status, 403);
      const plain = await tryOpen(viewUrl(A, await adminTicket(A, "watch")), null);
      assert.equal(plain.status, 101, "tests and scripts connect without an Origin, and a hijacked page cannot");
      plain.ws!.close();
      const trusted = await tryOpen(viewUrl(A, await adminTicket(A, "watch")), ctx.url);
      assert.equal(trusted.status, 101);
      trusted.ws!.close();
    });

    it("refuses an operator ticket once the session that minted it has logged out", async () => {
      const login = await fetch(`${ctx.url}/api/v1/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: ctx.adminSecret }),
      });
      const second = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      const t = await json(`${ctx.url}/api/v1/browsers/${A}/viewer-ticket`, {
        method: "POST",
        headers: { Cookie: second, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "watch" }),
      });
      const ticket = (t.body as { ticket: string }).ticket;
      await fetch(`${ctx.url}/api/v1/logout`, { method: "POST", headers: { Cookie: second } });
      assert.equal((await tryOpen(viewUrl(A, ticket), ctx.url)).status, 401);
    });

    it("issues a control ticket only while the guest holds control", async () => {
      assert.equal((await guest(cookie, "/viewer-ticket", "POST", { mode: "control" })).status, 403);
      await guest(cookie, "/control", "POST", {});
      const t = await guestTicket(cookie, "control");
      // Lost between minting and connecting: the ticket is no longer enough.
      ctx.browsers.acquireControl(A, "human", "admin", { force: true });
      assert.equal((await tryOpen(viewUrl(A, t.ticket), ctx.url)).status, 403);
    });

    it("closes the guest's control socket when the operator forces a takeover", async () => {
      const r = await guest(cookie, "/control", "POST", {});
      const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
      const t = await guestTicket(cookie, "control");
      const sock = await tryOpen(viewUrl(A, t.ticket), ctx.url);
      assert.equal(sock.status, 101);
      sock.ws!.send(JSON.stringify({ type: "heartbeat", leaseToken: lease }));
      await sleep(200);
      const forced = await admin(`/api/v1/browsers/${A}/control`, "POST", { force: true });
      assert.equal(forced.status, 200);
      assert.equal(await within(sock.closed, 3000, -1), 4003);
      assert.ok(audits("control.forced").length > 0);
    });

    it("keeps navigation and tabs inside the link's allowance", async () => {
      const t = await guestTicket(cookie, "watch");
      const watch = await tryOpen(viewUrl(A, t.ticket), ctx.url);
      await sleep(400);
      const tabs = watch.seen.filter((m) => m.type === "tabs").pop() as { tabs: Array<{ url: string }> } | undefined;
      assert.ok(tabs, "a tab list is sent");
      assert.deepEqual(
        tabs!.tabs.map((t) => t.url).filter((u) => u !== "about:blank"),
        ["https://example.test/"],
        "a link with no navigation sees the tab it is shown, and nothing with content besides",
      );
      watch.ws!.close();

      const r = await guest(cookie, "/control", "POST", {});
      const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
      const ct = await guestTicket(cookie, "control");
      const sock = await tryOpen(viewUrl(A, ct.ticket), ctx.url);
      try {
        sock.ws!.send(JSON.stringify({ type: "heartbeat", leaseToken: lease }));
        await sleep(200);
        resetFakeCdp();
        sock.ws!.send(JSON.stringify({ type: "navigate", url: "https://example.test/" }));
        sock.ws!.send(JSON.stringify({ type: "newTab" }));
        sock.ws!.send(JSON.stringify({ type: "selectTab", targetId: "t1" }));
        sock.ws!.send(JSON.stringify({ type: "closeTab", targetId: "t1" }));
        sock.ws!.send(JSON.stringify({ type: "reload" }));
        await sleep(600);
        for (const m of ["Page.navigate", "Target.createTarget", "Target.closeTarget", "Target.activateTarget"]) {
          assert.equal(fakeCdpCalls.filter((c) => c.method === m).length, 0, `a link with no navigation must not reach ${m}`);
        }
        assert.equal(fakeCdpCalls.filter((c) => c.method === "Page.reload").length, 1, "page input still works");
      } finally {
        sock.ws!.close();
      }
    });

    it("caps how many viewers one guest can hold open", async () => {
      const g = await makeGuest(A, { label: "Many" });
      const c = await signIn(g.token);
      const open: WebSocketType[] = [];
      try {
        for (let i = 0; i < 3; i++) {
          const t = await guestTicket(c, "watch");
          const sock = await tryOpen(viewUrl(A, t.ticket), ctx.url);
          assert.equal(sock.status, 101);
          open.push(sock.ws!);
        }
        await sleep(200);
        const t = await guestTicket(c, "watch");
        assert.equal((await tryOpen(viewUrl(A, t.ticket), ctx.url)).status, 429);
        open.pop()!.close();
        await sleep(200);
        const t2 = await guestTicket(c, "watch");
        const after = await tryOpen(viewUrl(A, t2.ticket), ctx.url);
        assert.equal(after.status, 101, "closing one frees its place");
        open.push(after.ws!);
      } finally {
        for (const w of open) w.close();
      }
    });

    it("never moves a guest onto a tab its link does not allow, on its own or on reconnect", async () => {
      setFakeTargets([
        { targetId: "t1", type: "page", title: "Secret inbox", url: "https://secret.test/inbox" },
        { targetId: "t2", type: "page", title: "Allowed", url: "https://allowed.test/" },
      ]);
      try {
        const g = await makeGuest(A, { label: "Wanderer", modes: ["watch", "control"], allowedHosts: ["allowed.test"] });
        const c = await signIn(g.token);
        const t = await guestTicket(c, "watch");
        const sock = await tryOpen(viewUrl(A, t.ticket), ctx.url);
        assert.equal(sock.status, 101);
        await sleep(400);
        const tabs = sock.seen.filter((m) => m.type === "tabs").pop() as { tabs: Array<{ url: string; title: string }> };
        assert.ok(!JSON.stringify(tabs).includes("secret.test"), "the other tab's title and URL are not shown");
        resetFakeCdp();
        emitFakeEvent("Target.targetDestroyed", { targetId: "t2" });
        assert.equal(await within(sock.closed, 3000, -1), 4004, "with nothing it may see, the guest's view ends");
        assert.equal(
          fakeCdpCalls.filter((m) => m.method === "Target.attachToTarget" && m.params.targetId === "t1").length,
          0,
          "the viewer must not re-follow the guest onto the secret tab",
        );

        // Reconnecting must not pin a new home on whatever tab is left.
        setFakeTargets([{ targetId: "t1", type: "page", title: "Secret inbox", url: "https://secret.test/inbox" }]);
        const t2 = await guestTicket(c, "watch");
        const again = await tryOpen(viewUrl(A, t2.ticket), ctx.url);
        if (again.status === 101) assert.equal(await within(again.closed, 3000, -1), 4004);
        assert.ok(!again.seen.some((m) => m.type === "tabs" && JSON.stringify(m).includes("secret.test")));
      } finally {
        setFakeTargets(null);
      }
    });

    it("holds the tab cap however a guest opens tabs", async () => {
      const g = await makeGuest(A, { label: "Tabber", modes: ["watch", "control"] });
      const c = await signIn(g.token);
      const r = await guest(c, "/control", "POST", {});
      const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
      const t = await guestTicket(c, "control");
      const sock = await tryOpen(viewUrl(A, t.ticket), ctx.url);
      try {
        sock.ws!.send(JSON.stringify({ type: "heartbeat", leaseToken: lease }));
        await sleep(300);
        resetFakeCdp();
        // Two tabs exist; a middle-click storm opens ten more without a single newTab message.
        for (let i = 3; i <= 12; i++) {
          emitFakeEvent("Target.targetCreated", {
            targetInfo: { targetId: `t${i}`, type: "page", title: "Popup", url: "about:blank" },
          });
        }
        await sleep(300);
        const closed = fakeCdpCalls.filter((m) => m.method === "Target.closeTarget").map((m) => m.params.targetId);
        assert.deepEqual(closed, ["t11", "t12"], "every tab past the cap is closed as it appears");
      } finally {
        sock.ws!.close();
      }
    });

    it("keeps back and forward inside what happened after the handoff", async () => {
      setFakeHistory({ currentIndex: 1, entries: [{ id: 1, url: "https://secret.test/inbox" }, { id: 2, url: "https://example.test/" }] });
      try {
        const g = await makeGuest(A, { label: "Historian", modes: ["watch", "control"] });
        const c = await signIn(g.token);
        const r = await guest(c, "/control", "POST", {});
        const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
        const t = await guestTicket(c, "control");
        const sock = await tryOpen(viewUrl(A, t.ticket), ctx.url);
        try {
          sock.ws!.send(JSON.stringify({ type: "heartbeat", leaseToken: lease }));
          await sleep(300);
          resetFakeCdp();
          sock.ws!.send(JSON.stringify({ type: "historyGo", delta: -1 }));
          sock.ws!.send(JSON.stringify({ type: "mouse", event: "mousePressed", x: 5, y: 5, button: "back" }));
          await sleep(400);
          assert.equal(fakeCdpCalls.filter((m) => m.method === "Page.navigateToHistoryEntry").length, 0, "the inbox before the handoff stays out of reach");
          assert.equal(fakeCdpCalls.filter((m) => m.method === "Input.dispatchMouseEvent").length, 0, "so does the mouse's back button");
          assert.ok(sock.seen.some((m) => m.type === "notice"));

          // A page the guest reached after the handoff, then back to where it started: fine.
          setFakeHistory({
            currentIndex: 2,
            entries: [{ id: 1, url: "https://secret.test/inbox" }, { id: 2, url: "https://example.test/" }, { id: 3, url: "https://example.test/next" }],
          });
          resetFakeCdp();
          sock.ws!.send(JSON.stringify({ type: "historyGo", delta: -1 }));
          await sleep(400);
          const went = fakeCdpCalls.filter((m) => m.method === "Page.navigateToHistoryEntry");
          assert.equal(went.length, 1);
          assert.equal(went[0]!.params.entryId, 2);
        } finally {
          sock.ws!.close();
        }
      } finally {
        setFakeHistory(null);
      }
    });

    it("lets a link with an allow-list open those hosts and no others", async () => {
      const listed = await makeGuest(A, { label: "Listed", modes: ["watch", "control"], allowedHosts: ["example.test"] });
      const c = await signIn(listed.token);
      const r = await guest(c, "/control", "POST", {});
      const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
      const t = await guestTicket(c, "control");
      const sock = await tryOpen(viewUrl(A, t.ticket), ctx.url);
      try {
        sock.ws!.send(JSON.stringify({ type: "heartbeat", leaseToken: lease }));
        await sleep(200);
        resetFakeCdp();
        sock.ws!.send(JSON.stringify({ type: "navigate", url: "https://evil.test/" }));
        await sleep(300);
        assert.equal(fakeCdpCalls.filter((m) => m.method === "Page.navigate").length, 0);
        assert.ok(sock.seen.some((m) => m.type === "notice"), "a refused address is reported, not dropped");
        sock.ws!.send(JSON.stringify({ type: "navigate", url: "https://accounts.example.test/login" }));
        await sleep(300);
        assert.equal(fakeCdpCalls.filter((m) => m.method === "Page.navigate").length, 1);
      } finally {
        sock.ws!.close();
        await guest(c, "/control", "DELETE");
      }
    });
  });

  describe("revocation", () => {
    it("ends the session, the lease and every open socket at once, and old tickets with them", async () => {
      const made = await makeGuest(A, { label: "Revoked", modes: ["watch", "control"] });
      const cookie = await signIn(made.token);
      const r = await guest(cookie, "/control", "POST", {});
      const lease = (r.body as { browser: { control: { leaseToken: string } } }).browser.control.leaseToken;
      const watchTicket = await guestTicket(cookie, "watch");
      const spare = await guestTicket(cookie, "watch");
      const controlTicket = await guestTicket(cookie, "control");
      const watch = await tryOpen(viewUrl(A, watchTicket.ticket), ctx.url);
      const control = await tryOpen(viewUrl(A, controlTicket.ticket), ctx.url);
      assert.equal(watch.status, 101);
      assert.equal(control.status, 101);
      control.ws!.send(JSON.stringify({ type: "heartbeat", leaseToken: lease }));
      await sleep(200);

      const revoked = await admin(`/api/v1/browsers/${A}/guests/${made.guest.id}`, "DELETE");
      assert.equal(revoked.status, 200);
      assert.equal(await within(watch.closed, 3000, -1), 4001);
      assert.equal(await within(control.closed, 3000, -1), 4001);
      assert.equal(ctx.browsers.controlState(A).controllerType, "none", "the lease goes with the grant");
      assert.equal((await guest(cookie, "/browser")).status, 401);
      assert.equal((await tryOpen(viewUrl(A, spare.ticket), ctx.url)).status, 401, "a ticket minted before revocation fails after it");
      const again = await json(`${ctx.url}/guest/api/v1/session`, {
        method: "POST",
        headers: { Origin: ctx.url, "Content-Type": "application/json" },
        body: JSON.stringify({ token: made.token }),
      });
      assert.equal(again.status, 401, "the link cannot be exchanged again");
      const entry = audits("guest.revoked").find((e) => e.detail_json.includes(made.guest.id));
      assert.ok(entry);
      assert.match(entry!.detail_json, /Revoked/);
    });

    it("ends the link when the guest leaves, with its lease and its viewers", async () => {
      const made = await makeGuest(A, { label: "Leaver", modes: ["watch", "control"] });
      const c = await signIn(made.token);
      await guest(c, "/control", "POST", {});
      const t = await guestTicket(c, "watch");
      const sock = await tryOpen(viewUrl(A, t.ticket), ctx.url);
      assert.equal(sock.status, 101);
      const left = await guest(c, "/session", "DELETE");
      assert.equal(left.status, 200);
      assert.match(left.headers.get("set-cookie") ?? "", /Max-Age=0/);
      assert.equal(await within(sock.closed, 3000, -1), 4001);
      assert.equal(ctx.browsers.controlState(A).controllerType, "none");
      assert.equal((await guest(c, "/browser")).status, 401);
      assert.ok(audits("guest.left").some((e) => e.actor_id === made.guest.id));
    });

    it("ends with the grant's expiry even with nobody watching", async () => {
      const made = await makeGuest(A, { label: "Short", modes: ["watch", "control"], expiresInSec: 60 });
      const cookie = await signIn(made.token);
      await guest(cookie, "/control", "POST", {});
      // Wind the grant's clock forward rather than sleeping a minute.
      const { getDb } = await import("../src/db.js");
      getDb().prepare(`UPDATE browser_guests SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), made.guest.id);
      assert.equal(ctx.browsers.controlState(A).controllerType, "none");
      assert.equal((await guest(cookie, "/browser")).status, 401);
    });

    it("goes with the browser when the browser is deleted", async () => {
      const C = await newBrowser("guest-c");
      const made = await makeGuest(C, { label: "Doomed" });
      const cookie = await signIn(made.token);
      const t = await guestTicket(cookie, "watch");
      const sock = await tryOpen(viewUrl(C, t.ticket), ctx.url);
      assert.equal(sock.status, 101);
      assert.equal((await admin(`/api/v1/browsers/${C}`, "DELETE")).status, 204);
      assert.equal(await within(sock.closed, 3000, -1), 4001);
      assert.equal((await guest(cookie, "/browser")).status, 401);
      const { getDb } = await import("../src/db.js");
      const left = getDb().prepare(`SELECT COUNT(*) AS n FROM browser_guests WHERE browser_id = ?`).get(C) as { n: number };
      assert.equal(left.n, 0);
    });
  });
});
