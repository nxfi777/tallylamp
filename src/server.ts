import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, trustedOrigins } from "./config.js";
import { authenticateBearer, parseBearer } from "./auth.js";
import { Err } from "./errors.js";
import { errorHandler, mountApi, authFromRequest } from "./api.js";
import { McpGateway, startSseKeepalive } from "./mcp.js";
import type { BrowserManager } from "./browsers.js";
import { rateLimit } from "./rate-limit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(here, "../dashboard");

export function originOk(req: Request): boolean {
  const origin = req.header("origin");
  if (!origin) return true;
  return trustedOrigins().includes(origin.replace(/\/$/, ""));
}

export function createApp(browsers: BrowserManager, mcp: McpGateway): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const resource = `${config.publicUrl}/mcp`;
    const body: Record<string, unknown> = {
      resource,
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:tools"],
    };
    if (config.oauth) {
      body.authorization_servers = [`${config.publicUrl}`];
    }
    res.json(body);
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.redirect(307, "/.well-known/oauth-protected-resource");
  });

  if (config.oauth) {
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.json({
        issuer: config.publicUrl,
        authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
        token_endpoint: `${config.publicUrl}/oauth/token`,
        registration_endpoint: `${config.publicUrl}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "client_credentials"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        response_types_supported: ["code"],
        scopes_supported: ["mcp:tools"],
        client_id_metadata_document_supported: false,
      });
    });

    app.post("/oauth/register", (req, res) => {
      res.status(201).json({
        client_id: "tallylamp-public",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        redirect_uris: req.body?.redirect_uris ?? ["http://127.0.0.1/callback", "http://localhost/callback"],
      });
    });

    app.get("/oauth/authorize", (req, res) => {
      res.status(400).type("html").send(`<!doctype html>
<meta charset="utf-8"><title>Tallylamp OAuth</title>
<body style="font-family:system-ui;background:#0c1014;color:#fdffff;padding:2rem">
<h1>Use a pre-issued agent token</h1>
<p>Tallylamp authenticates MCP clients with a bearer token created in the dashboard
(Agents → create). Configure your client with:</p>
<pre>Authorization: Bearer tl_ag_…</pre>
<p>Interactive OAuth login is not used for agent principals. The authorization_code
endpoint exists so discovery does not 404; it does not issue tokens.</p>
<p>redirect_uri=${String(req.query.redirect_uri ?? "")}</p>
</body>`);
    });

    app.post("/oauth/token", (_req, res) => {
      res.status(400).json({
        error: "invalid_grant",
        error_description:
          "Tallylamp issues agent tokens in the dashboard. Use Authorization: Bearer <token> on /mcp.",
      });
    });
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
            .setHeader(
              "WWW-Authenticate",
              `Bearer realm="mcp", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", scope="mcp:tools"`,
            )
            .json({ error: "invalid_token", error_description: "missing bearer token" });
          return;
        }
        let principal;
        try {
          principal = authenticateBearer(token);
        } catch {
          res
            .status(401)
            .setHeader(
              "WWW-Authenticate",
              `Bearer realm="mcp", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
            )
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
  void startSseKeepalive;
  void authFromRequest;
  void Err;
  return app;
}

export function dashboardAuthGate(req: Request, res: Response, next: express.NextFunction): void {
  if (req.path.startsWith("/api") || req.path === "/healthz" || req.path === "/mcp") return next();
  next();
}
