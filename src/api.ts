import type { Express, NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { Err, errorBody, statusOf, AppError } from "./errors.js";
import {
  authenticateBearer,
  createAgent,
  createAdminSession,
  destroySession,
  hasScope,
  listAgents,
  parseBearer,
  readSession,
  requireScope,
  rotateAgentCredential,
  updateAgent,
  verifyAdminSecret,
  type Principal,
} from "./auth.js";
import { rateLimit } from "./rate-limit.js";
import type { BrowserManager } from "./browsers.js";
import { listActivity, listAudit } from "./audit.js";
import { hub } from "./events.js";
import { issueViewerTicket } from "./viewer.js";
import { openApiSpec } from "./openapi.js";
import { startSseKeepalive } from "./mcp.js";
import { captureScreenshot } from "./cdp.js";
import { cookieSerialize } from "./http-util.js";

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
      sessionToken?: string;
    }
  }
}

function cookieToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(";").map((s) => s.trim());
  for (const p of parts) {
    if (p.startsWith("tallylamp_session=")) return decodeURIComponent(p.slice("tallylamp_session=".length));
  }
  return null;
}

export function authFromRequest(req: Request): Principal | null {
  const bearer = parseBearer(req.header("authorization"));
  if (bearer) {
    try {
      return authenticateBearer(bearer);
    } catch {
      return null;
    }
  }
  const tok = cookieToken(req);
  if (tok) return readSession(tok);
  return null;
}

function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const p = authFromRequest(req);
  if (!p) return next(Err.unauthenticated());
  req.principal = p;
  req.sessionToken = cookieToken(req) ?? undefined;
  next();
}

function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.principal || req.principal.type !== "admin") return next(Err.unauthorized("admin only"));
  next();
}

function csrf(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (parseBearer(req.header("authorization"))) return next();
  const origin = req.header("origin");
  if (!origin) return next();
  const allowed = new Set([config.publicUrl, `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...config.extraOrigins]);
  if (![...allowed].some((o) => origin === o || origin === o.replace(/\/$/, ""))) {
    return next(Err.unauthorized("csrf origin mismatch"));
  }
  next();
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function mountApi(app: Express, browsers: BrowserManager): void {
  app.get("/api/v1/openapi.json", (_req, res) => res.json(openApiSpec));

  app.post(
    "/api/v1/login",
    asyncRoute(async (req, res) => {
      rateLimit(`login:${req.ip}`, 10, 5);
      const secret = typeof req.body?.secret === "string" ? req.body.secret : "";
      if (!verifyAdminSecret(secret)) throw Err.unauthenticated("invalid admin secret");
      const sess = createAdminSession();
      res.setHeader("Set-Cookie", cookieSerialize("tallylamp_session", sess.token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: Math.floor(config.sessionTtlMs / 1000),
        secure: config.publicUrl.startsWith("https://"),
      }));
      res.json({ ok: true, expiresAt: sess.expiresAt });
    }),
  );

  app.post(
    "/api/v1/logout",
    asyncRoute(async (req, res) => {
      const tok = cookieToken(req);
      if (tok) destroySession(tok);
      res.setHeader("Set-Cookie", cookieSerialize("tallylamp_session", "", { path: "/", maxAge: 0, httpOnly: true }));
      res.json({ ok: true });
    }),
  );

  app.get("/api/v1/me", requireAuth, (req, res) => {
    res.json({ principal: req.principal });
  });

  const api = app;

  api.use("/api/v1", requireAuth, csrf);

  api.get("/api/v1/status", (req, res) => {
    res.json({
      version: config.version,
      maxBrowsers: config.maxBrowsers,
      running: browsers.runningCount(),
      sandbox: config.sandbox,
      gpu: config.gpu,
      allowPrivateNetwork: config.allowPrivateNetwork,
      xvfb: config.xvfb,
      oauth: config.oauth,
      principal: req.principal,
    });
  });

  api.get("/api/v1/browsers", (req, res) => {
    const p = req.principal!;
    const rows = p.type === "admin" ? browsers.list() : browsers.list({ ownerType: "agent", ownerId: p.id });
    res.json({ browsers: rows.map((r) => browsers.publicView(r)) });
  });

  api.post(
    "/api/v1/browsers",
    asyncRoute(async (req, res) => {
      const p = req.principal!;
      if (p.type === "agent") requireScope(p, "browser:create");
      rateLimit(`create:${p.id}`, 20, 8);
      const row = browsers.create({
        principal: p,
        via: p.type === "admin" ? "dashboard" : "control_api",
        name: req.body?.name,
        persistent: req.body?.persistent !== false,
        metadata: req.body?.metadata,
        seedId: req.body?.seedId,
      });
      if (req.body?.start !== false) await browsers.ensureRunning(row.id);
      res.status(201).json({ browser: browsers.publicView(browsers.row(row.id)) });
    }),
  );

  api.get("/api/v1/browsers/:id", (req, res) => {
    const row = browsers.row(req.params.id);
    browsers.assertAccess(req.principal!, row, "read");
    res.json({
      browser: browsers.publicView(row),
      activity: listActivity(row.id),
    });
  });

  api.patch("/api/v1/browsers/:id", (req, res) => {
    const updated = browsers.updateMetadata(req.params.id, req.body?.metadata ?? req.body, req.principal!);
    res.json({ browser: browsers.publicView(updated) });
  });

  api.delete(
    "/api/v1/browsers/:id",
    asyncRoute(async (req, res) => {
      await browsers.destroy(req.params.id, req.principal!);
      res.status(204).end();
    }),
  );

  api.post(
    "/api/v1/browsers/:id/start",
    asyncRoute(async (req, res) => {
      const row = browsers.row(req.params.id);
      browsers.assertAccess(req.principal!, row, "control");
      await browsers.ensureRunning(row.id);
      res.json({ browser: browsers.publicView(browsers.row(row.id)) });
    }),
  );

  api.post(
    "/api/v1/browsers/:id/stop",
    asyncRoute(async (req, res) => {
      const row = browsers.row(req.params.id);
      browsers.assertAccess(req.principal!, row, "control");
      await browsers.stop(row.id);
      res.json({ browser: browsers.publicView(browsers.row(row.id)) });
    }),
  );

  api.post(
    "/api/v1/browsers/:id/restart",
    asyncRoute(async (req, res) => {
      const row = browsers.row(req.params.id);
      browsers.assertAccess(req.principal!, row, "control");
      await browsers.restart(row.id);
      res.json({ browser: browsers.publicView(browsers.row(row.id)) });
    }),
  );

  api.post("/api/v1/browsers/:id/control", (req, res) => {
    if (req.principal!.type !== "admin") throw Err.unauthorized("only the administrator can take human control");
    const force = Boolean(req.body?.force);
    const state = browsers.acquireControl(req.params.id, "human", "admin", { force });
    res.json({ control: state });
  });

  api.delete("/api/v1/browsers/:id/control", (req, res) => {
    if (req.principal!.type !== "admin") throw Err.unauthorized();
    const state = browsers.releaseControl(req.params.id, req.principal);
    res.json({ control: state });
  });

  api.post("/api/v1/browsers/:id/control/heartbeat", (req, res) => {
    if (req.principal!.type !== "admin") throw Err.unauthorized();
    const state = browsers.heartbeatControl(req.params.id, String(req.body?.leaseToken ?? ""));
    res.json({ control: state });
  });

  api.post("/api/v1/browsers/:id/viewer-ticket", (req, res) => {
    if (req.principal!.type !== "admin") throw Err.unauthorized();
    const row = browsers.row(req.params.id);
    const mode = req.body?.mode === "control" ? "control" : "watch";
    if (mode === "control" && browsers.controlState(row.id).controllerType !== "human") {
      throw Err.unauthorized("take control before requesting an interactive viewer");
    }
    const ticket = issueViewerTicket(row.id, req.sessionToken ?? "admin", mode);
    res.json({ ticket, expiresInSec: Math.floor(config.viewerTicketTtlMs / 1000), mode });
  });

  api.get(
    "/api/v1/browsers/:id/thumbnail",
    asyncRoute(async (req, res) => {
      if (req.principal!.type !== "admin") throw Err.unauthorized();
      const rt = browsers.runtime(req.params.id);
      if (!rt) {
        res.status(204).end();
        return;
      }
      const buf = await captureScreenshot(rt.cdpUrl, 35);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(buf);
    }),
  );

  api.get("/api/v1/agents", requireAdmin, (req, res) => {
    void req;
    res.json({
      agents: listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        scopes: JSON.parse(a.scopes_json),
        maxBrowsers: a.max_browsers,
        enabled: a.enabled === 1,
        createdAt: a.created_at,
        lastSeenAt: a.last_seen_at,
        browserCount: browsers.list({ ownerType: "agent", ownerId: a.id }).length,
      })),
    });
  });

  api.post("/api/v1/agents", requireAdmin, (req, res) => {
    rateLimit("agent-create", 10, 5);
    const created = createAgent({
      name: String(req.body?.name ?? "Agent"),
      scopes: req.body?.scopes,
      maxBrowsers: req.body?.maxBrowsers,
    });
    res.status(201).json({ agent: created.agent, token: created.token });
  });

  api.patch("/api/v1/agents/:id", requireAdmin, (req, res) => {
    const agent = updateAgent(req.params.id, req.body ?? {});
    res.json({ agent });
  });

  api.post("/api/v1/agents/:id/rotate", requireAdmin, (req, res) => {
    const token = rotateAgentCredential(req.params.id);
    res.json({ token });
  });

  api.get("/api/v1/seeds", requireAdmin, (_req, res) => {
    res.json({ seeds: browsers.listSeeds() });
  });

  api.post(
    "/api/v1/seeds",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const seed = await browsers.snapshotSeed(
        String(req.body?.browserId),
        String(req.body?.name ?? "seed"),
        req.principal!,
      );
      res.status(201).json({ seed });
    }),
  );

  api.get("/api/v1/audit", requireAdmin, (_req, res) => {
    res.json({ events: listAudit() });
  });

  api.get("/api/v1/events", requireAdmin, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const stop = startSseKeepalive(res);
    const onEvent = (ev: unknown) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    hub.on("event", onEvent);
    req.on("close", () => {
      hub.off("event", onEvent);
      stop();
    });
  });

  void hasScope;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = statusOf(err);
  if (!(err instanceof AppError)) {
    console.error(err);
  }
  res.status(status).json(errorBody(err));
}
