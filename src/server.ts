import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, trustedOrigins } from "./config.js";
import { AGENT_SCOPES, authenticateBearer, parseBearer } from "./auth.js";
import { Err } from "./errors.js";
import { errorHandler, mountApi, authFromRequest } from "./api.js";
/** Structural, so this module never imports the MCP SDK. */
export type McpHandler = {
  handle(req: Request, res: Response, principal: import("./auth.js").Principal): Promise<void>;
};
import type { BrowserManager } from "./browsers.js";
import { rateLimit } from "./rate-limit.js";
import { mountOauth, authorizationServerMetadata, mcpResource } from "./oauth.js";
import { wwwAuthenticate } from "./http-util.js";
import { audit } from "./audit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(here, "../dashboard");

export function originOk(req: Request): boolean {
  const origin = req.header("origin");
  if (!origin) return true;
  if (trustedOrigins().includes(origin.replace(/\/$/, ""))) return true;
  // Hosted HTTPS: MCP clients (Claude.ai, ChatGPT, …) send their own Origin.
  // The DNS-rebinding Origin check is for localhost servers, not a public resource.
  const pub = config.publicUrl;
  if (pub.startsWith("https://") && !pub.includes("localhost") && !pub.includes("127.0.0.1")) {
    return true;
  }
  return false;
}

export function createApp(browsers: BrowserManager, mcp: McpHandler): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ? 1 : false);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // MCP clients probe the discovery documents from a browser context and with an
  // Authorization header, both of which require a preflight. Without this, a browser-based
  // host can never reach /mcp regardless of whether its auth is correct.
  app.use(["/mcp", "/.well-known", "/oauth/token", "/oauth/register", "/oauth/revoke"], (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
    );
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const protectedResourceMetadata = () => {
    const body: Record<string, unknown> = {
      resource: mcpResource(),
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:tools", ...AGENT_SCOPES],
    };
    if (config.oauth) body.authorization_servers = [config.publicUrl];
    return body;
  };

  // Served directly at both paths. A 30x here is treated as a discovery failure by some
  // clients, and RFC 9728 path-insertion means both spellings get probed.
  for (const route of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(route, (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(protectedResourceMetadata());
    });
  }

  if (config.oauth) {
    for (const route of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
      app.get(route, (_req, res) => {
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json(authorizationServerMetadata());
      });
    }
    mountOauth(app);
  }

  app.all(
    "/mcp",
    async (req, res, next) => {
      try {
        if (!originOk(req)) {
          res.status(403).json({ error: "forbidden origin" });
          return;
        }
        const token = parseBearer(req.header("authorization"));
        if (!token) {
          res
            .status(401)
            .setHeader("WWW-Authenticate", wwwAuthenticate())
            .json({ error: "invalid_token", error_description: "missing bearer token" });
          return;
        }
        let principal;
        try {
          // Audience-checked: a token minted for a different resource is refused here.
          principal = authenticateBearer(token, mcpResource());
        } catch {
          // Unauthenticated bearer attempts are cheap to generate and were previously
          // neither throttled nor recorded.
          rateLimit(`mcp-authfail:${req.ip}`, 30, 15);
          audit({ actorType: "anonymous", actorId: req.ip ?? "unknown", action: "auth.bearer_failed", detail: { path: "/mcp" } });
          res
            .status(401)
            .setHeader("WWW-Authenticate", wwwAuthenticate("invalid_token"))
            .json({ error: "invalid_token" });
          return;
        }
        rateLimit(`mcp:${principal.id}`, 240, 60);
        await mcp.handle(req, res, principal);
      } catch (e) {
        next(e);
      }
    },
  );

  mountApi(app, browsers);

  app.use(express.static(dashboardDir));
  app.get(["/", "/login", "/browsers", "/browsers/:id", "/agents", "/seeds", "/security"], (_req, res) => {
    res.sendFile(path.join(dashboardDir, "index.html"));
  });

  app.use(errorHandler);
  void authFromRequest;
  void Err;
  return app;
}

export function dashboardAuthGate(req: Request, res: Response, next: express.NextFunction): void {
  if (req.path.startsWith("/api") || req.path === "/healthz" || req.path === "/mcp") return next();
  next();
}
