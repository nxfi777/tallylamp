import express, { type Express, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.js";
import type { BrowserManager } from "./browsers.js";
import { config, trustedOrigins } from "./config.js";
import { AppError, Err, errorBody } from "./errors.js";
import {
  GUEST_COOKIE,
  GUEST_COOKIE_PATH,
  auditGuestDenied,
  beginGuestHold,
  exchangeGuestToken,
  guestActor,
  guestControllerId,
  guestCooldownRemainingMs,
  guestIdFromController,
  guestLeft,
  readGuestSession,
  spendGuestAudit,
  type Guest,
  type GuestSession,
} from "./guests.js";
import { cookieSerialize, readCookie } from "./http-util.js";
import { log } from "./log.js";
import { rateLimit } from "./rate-limit.js";
import { guestTicketRef, issueViewerTicket } from "./viewer.js";

/**
 * Everything a guest can reach, in one place: a page at /guest and a handful of routes under
 * /guest/api/v1. Default-deny is structural rather than a list somebody has to keep in step:
 *
 * - The guest cookie is scoped to Path=/guest, so /api/v1, /mcp and the OAuth pages never
 *   receive it, and nothing there knows how to read it if they did.
 * - None of these routes take a browser id. The browser is the one on the grant, so there is
 *   no parameter to point at another one.
 * - Anything else under /guest/api is refused with the same 403 whether or not it exists.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const guestDir = path.resolve(here, "../guest");

declare global {
  namespace Express {
    interface Request {
      guestSession?: GuestSession;
    }
  }
}

function guestHeaders(res: Response): void {
  const ws = config.publicUrl.replace(/^http/, "ws");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ${ws}; ` +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function secureCookie(): boolean {
  return config.publicUrl.startsWith("https://");
}

function clearGuestCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    cookieSerialize(GUEST_COOKIE, "", { httpOnly: true, sameSite: "strict", path: GUEST_COOKIE_PATH, maxAge: 0, secure: secureCookie() }),
  );
}

function guestCookie(req: Request): string | null {
  try {
    return readCookie(req.headers.cookie, GUEST_COOKIE);
  } catch {
    return null; // a malformed %-escape is not a session
  }
}

/**
 * A guest session is a cookie, so every request has to prove it came from this origin. The
 * API's check waves through a request with no Origin; this one does not for anything that
 * changes state, and there is no bearer path to exempt.
 */
function originGuard(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  const trusted = origin !== undefined && trustedOrigins().includes(origin.replace(/\/$/, ""));
  if (req.method === "GET" || req.method === "HEAD") {
    const site = req.header("sec-fetch-site");
    if ((origin !== undefined && !trusted) || (site && site !== "same-origin" && site !== "none")) {
      return next(Err.unauthorized("forbidden"));
    }
    return next();
  }
  if (!trusted) return next(Err.unauthorized("forbidden"));
  next();
}

function requireGuest(req: Request, res: Response, next: NextFunction): void {
  const s = readGuestSession(guestCookie(req));
  if (!s) {
    clearGuestCookie(res);
    return next(Err.unauthenticated("this guest link has ended; ask for a new one"));
  }
  try {
    rateLimit(`guest:${s.guest.id}`, 240, 60);
  } catch (e) {
    return next(e);
  }
  req.guestSession = s;
  next();
}

/** The reduced view: name, whether it is running, and who has control. Nothing else. */
function guestBrowserView(browsers: BrowserManager, s: GuestSession) {
  const g = s.guest;
  const row = browsers.row(g.browserId);
  const control = browsers.controlState(row.id);
  const mine = control.controllerId === guestControllerId(g.id);
  const holder = mine
    ? "you"
    : control.controllerType === "none"
      ? "nobody"
      : control.controllerType === "agent"
        ? "agent"
        : guestIdFromController(control.controllerId)
          ? "guest"
          : "operator";
  const hosts = g.allowedHosts;
  return {
    id: row.id,
    name: row.name,
    status: browsers.runtime(row.id) ? "running" : row.status === "running" ? "stopped" : row.status,
    control: {
      holder,
      // Only ever your own lease. Anyone else's token stays on the admin side.
      leaseToken: mine ? control.leaseToken : null,
      expiresAt: mine ? control.expiresAt : null,
    },
    access: {
      label: g.label,
      modes: g.modes,
      navigation: hosts.length === 0 ? "none" : hosts.includes("*") ? "any" : "listed",
      allowedHosts: hosts.includes("*") ? [] : hosts,
      expiresAt: g.expiresAt,
      sessionExpiresAt: s.expiresAt,
      controlCooldownSec: Math.ceil(guestCooldownRemainingMs(g.id) / 1000),
    },
  };
}

function guestErrors(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json(errorBody(err));
    return;
  }
  const status = (err as { status?: unknown })?.status;
  if (status === 400 || status === 413) {
    res.status(status).json({ error: { code: "invalid_request", message: "invalid request", retryable: false } });
    return;
  }
  log.warn("guest route failed", { error: (err as Error)?.message });
  res.status(500).json(errorBody(err));
}

/** Refuse the action outright when its audit record would not fit in the link's budget. */
function spend(g: Guest, n: number): void {
  if (!spendGuestAudit(g.id, n)) {
    throw new AppError("rate_limited", "this link has reached its activity limit; ask for a new one", 429);
  }
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function mountGuest(app: Express, browsers: BrowserManager): void {
  // The page. Its own small script and stylesheet; the dashboard bundle is never loaded.
  app.get("/guest", (_req, res) => {
    guestHeaders(res);
    res.sendFile(path.join(guestDir, "index.html"));
  });
  app.use(
    "/guest/assets",
    (_req, res, next) => {
      guestHeaders(res);
      next();
    },
    express.static(path.join(guestDir, "assets"), { index: false, dotfiles: "deny", redirect: false }),
  );

  const r = express.Router({ caseSensitive: true, strict: true });
  r.use((_req, res, next) => {
    guestHeaders(res);
    next();
  });
  r.use(originGuard);

  // Trade the single-use link token for a session cookie. Every failure looks the same, so a
  // probe learns nothing about whether a token was spent, revoked, expired or never existed.
  r.post("/session", (req, res) => {
    rateLimit(`guest-exchange:${req.ip}`, 10, 5);
    const out = exchangeGuestToken(req.body?.token);
    if (!out) {
      // Bounded by the rate limit above, like the /mcp failed-bearer record.
      audit({ actorType: "anonymous", actorId: req.ip ?? "unknown", action: "guest.session.denied" });
      clearGuestCookie(res);
      throw Err.unauthenticated("this guest link is not valid any more; ask for a new one");
    }
    const maxAge = Math.max(1, Math.floor((Date.parse(out.expiresAt) - Date.now()) / 1000));
    res.setHeader(
      "Set-Cookie",
      cookieSerialize(GUEST_COOKIE, out.sessionToken, {
        httpOnly: true,
        sameSite: "strict",
        path: GUEST_COOKIE_PATH,
        maxAge,
        secure: secureCookie(),
      }),
    );
    if (spendGuestAudit(out.guest.id)) audit({
      actorType: "guest",
      actorId: out.guest.id,
      action: "guest.session.started",
      targetType: "browser",
      targetId: out.guest.browserId,
      detail: { label: out.guest.label, ip: req.ip },
    });
    const s = readGuestSession(out.sessionToken)!;
    res.json({ browser: guestBrowserView(browsers, s) });
  });

  r.use(requireGuest);

  r.get("/browser", (req, res) => {
    res.json({ browser: guestBrowserView(browsers, req.guestSession!) });
  });

  // Leave. The link was single use, so this ends it: its session, its lease, its viewers.
  r.delete("/session", (req, res) => {
    guestLeft(browsers, req.guestSession!.guest);
    clearGuestCookie(res);
    res.json({ ok: true });
  });

  // A browser left idle gets stopped; a guest who arrives later has to be able to wake it.
  r.post(
    "/start",
    asyncRoute(async (req, res) => {
      const s = req.guestSession!;
      rateLimit(`guest-start:${s.guest.id}`, 1, 3);
      if (!browsers.runtime(s.guest.browserId)) {
        spend(s.guest, 1);
        await browsers.ensureRunning(s.guest.browserId);
        audit({
          actorType: "guest",
          actorId: s.guest.id,
          action: "guest.browser.started",
          targetType: "browser",
          targetId: s.guest.browserId,
          detail: { label: s.guest.label },
        });
      }
      res.json({ browser: guestBrowserView(browsers, s) });
    }),
  );

  // Take control. Off an agent, yes -- that is the ordinary human-takeover rule. Off a person,
  // never, and `force` is not something a guest can ask for.
  r.post("/control", (req, res) => {
    const s = req.guestSession!;
    const g = s.guest;
    rateLimit(`guest-control:${g.id}`, 10, 5);
    if (!g.modes.includes("control")) {
      auditGuestDenied(g, "guest.control.denied", { reason: "watch-only link" });
      throw Err.unauthorized("this link lets you watch, not take control");
    }
    if (req.body?.force !== undefined && req.body.force !== false) {
      auditGuestDenied(g, "guest.control.denied", { reason: "force" });
      throw Err.unauthorized("a guest cannot force a takeover");
    }
    const waitMs = guestCooldownRemainingMs(g.id);
    if (waitMs > 0) {
      const sec = Math.ceil(waitMs / 1000);
      res.setHeader("Retry-After", String(sec));
      auditGuestDenied(g, "guest.control.denied", { reason: "cooldown" });
      throw Err.alreadyControlled(`the agent has the browser for a moment; you can take control again in ${sec}s`);
    }
    // Room for what a takeover writes: the takeover, a preemption, and how it ends.
    spend(g, 3);
    const holdingNow = browsers.controlState(g.browserId).controllerId === guestControllerId(g.id);
    const undo = beginGuestHold(g.id, holdingNow);
    try {
      browsers.acquireControl(g.browserId, "human", guestControllerId(g.id), { preemptAgent: true, actor: guestActor(g) });
    } catch (e) {
      undo();
      if (e instanceof AppError && e.code === "already_controlled") {
        auditGuestDenied(g, "guest.control.denied", { reason: "held by a person" });
        throw Err.alreadyControlled("someone else is controlling this browser right now");
      }
      throw e;
    }
    res.json({ browser: guestBrowserView(browsers, s) });
  });

  // Return control. Only ever your own: this used to be a DELETE that dropped whoever held it.
  // Never throttled beyond the general limit: handing control back is the safe direction, and
  // its audit row was paid for by the takeover.
  r.delete("/control", (req, res) => {
    const s = req.guestSession!;
    if (browsers.controlState(s.guest.browserId).controllerId === guestControllerId(s.guest.id)) {
      browsers.releaseControl(s.guest.browserId, guestActor(s.guest));
    }
    res.json({ browser: guestBrowserView(browsers, s) });
  });

  r.post("/control/heartbeat", (req, res) => {
    const s = req.guestSession!;
    const token = typeof req.body?.leaseToken === "string" ? req.body.leaseToken : "";
    try {
      browsers.heartbeatControl(s.guest.browserId, token, { guestId: s.guest.id });
    } catch {
      throw Err.alreadyControlled("your control has ended");
    }
    res.json({ browser: guestBrowserView(browsers, s) });
  });

  r.post("/viewer-ticket", (req, res) => {
    const s = req.guestSession!;
    const g = s.guest;
    rateLimit(`guest-ticket:${g.id}`, 20, 10);
    const mode = req.body?.mode === "control" ? "control" : "watch";
    if (mode === "control" && (!g.modes.includes("control") || browsers.controlState(g.browserId).controllerId !== guestControllerId(g.id))) {
      auditGuestDenied(g, "guest.viewer_ticket.denied", { mode });
      throw Err.unauthorized("take control before opening an interactive viewer");
    }
    spend(g, 1);
    const ticket = issueViewerTicket(g.browserId, guestTicketRef(s.sessionId), mode);
    audit({
      actorType: "guest",
      actorId: g.id,
      action: "guest.viewer_ticket",
      targetType: "browser",
      targetId: g.browserId,
      detail: { label: g.label, mode },
    });
    res.json({ ticket, browserId: g.browserId, mode, expiresInSec: Math.floor(config.viewerTicketTtlMs / 1000) });
  });

  // Signed in, but asking for something that is not on the list above.
  r.use((req, _res, next) => {
    const s = req.guestSession!;
    auditGuestDenied(s.guest, "guest.request.denied", { method: req.method, path: req.originalUrl.slice(0, 200) });
    next(Err.unauthorized("forbidden"));
  });
  r.use(guestErrors);

  app.use("/guest/api/v1", r);
  // Not v1, not anything: the same 403 for every path, so nothing here maps the surface.
  app.use("/guest/api", (_req, res) => {
    guestHeaders(res);
    res.status(403).json(errorBody(Err.unauthorized("forbidden")));
  });
}
