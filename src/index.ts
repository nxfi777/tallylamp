import http from "node:http";
import { config } from "./config.js";
import { log } from "./log.js";
import { getDb } from "./db.js";
import { enforceAdminSecretRotation, pruneExpiredCredentials } from "./auth.js";
import { pruneRateLimits } from "./rate-limit.js";
import { pruneAuditEvents } from "./audit.js";
import { BrowserManager } from "./browsers.js";
import { sweepLending } from "./lending.js";
import { createApp } from "./server.js";
import { attachViewerUpgrade } from "./viewer.js";
import { attachTunnelUpgrade, closeAllTunnels, sweepTunnels } from "./tunnels.js";

async function main(): Promise<void> {
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", reason instanceof Error ? reason.stack : String(reason));
  });

  if (!config.adminSecret) {
    log.warn("ADMIN_SECRET is empty — dashboard login will fail until it is set");
  }

  getDb();
  // Rotating ADMIN_SECRET must invalidate every OAuth grant it approved, and dead rows
  // should not accumulate on the volume.
  enforceAdminSecretRotation();
  pruneExpiredCredentials();
  // Egress proxies are per browser now, started and closed with the Chrome they serve.
  const browsers = new BrowserManager();
  await browsers.recoverOnBoot();
  // The MCP SDK module graph is ~20 MB resident and is only needed once a client opens an
  // /mcp session, so it is imported on first use rather than at boot. The promise is
  // memoised, so concurrent first requests share one gateway.
  let gatewayPromise: Promise<import("./mcp.js").McpGateway> | undefined;
  let gateway: import("./mcp.js").McpGateway | undefined;
  const loadGateway = () => {
    gatewayPromise ??= import("./mcp.js").then((m) => {
      gateway = new m.McpGateway(browsers);
      return gateway;
    });
    return gatewayPromise;
  };
  const mcp = {
    handle: async (req: Parameters<import("./mcp.js").McpGateway["handle"]>[0], res: Parameters<import("./mcp.js").McpGateway["handle"]>[1], principal: Parameters<import("./mcp.js").McpGateway["handle"]>[2]) =>
      (await loadGateway()).handle(req, res, principal),
    // These no-op until a session has actually been opened, which is the point.
    reapIdleSessions: async () => gateway?.reapIdleSessions(),
    releaseBrowser: async (id: string) => gateway?.releaseBrowser(id),
    closeAll: async () => gateway?.closeAll(),
  };
  const app = createApp(browsers, mcp);
  const server = http.createServer(app);
  attachViewerUpgrade(server, browsers);
  attachTunnelUpgrade(server);

  const reap = setInterval(() => {
    pruneRateLimits();
    // sweepLending before the reaper: it is what settles a request whose owner has crashed and
    // will never answer anything again, and it reads the same idle clock the reaper does.
    try {
      sweepLending(browsers);
    } catch (e) {
      log.warn("lending sweep failed", { error: (e as Error).message });
    }
    try {
      sweepTunnels();
    } catch (e) {
      log.warn("tunnel sweep failed", { error: (e as Error).message });
    }
    void mcp.reapIdleSessions().then(() => browsers.reapIdle());
  }, 15_000);

  // Cheap, and both tables are otherwise unbounded on a long-lived volume.
  const prune = setInterval(() => {
    try {
      pruneAuditEvents();
      pruneExpiredCredentials();
    } catch (e) {
      log.warn("prune failed", { error: (e as Error).message });
    }
  }, 3_600_000);
  prune.unref();
  reap.unref();

  const pagePoll = setInterval(() => {
    for (const b of browsers.list()) {
      if (browsers.runtime(b.id)) void browsers.refreshPageInfo(b.id);
    }
  }, 4000);
  pagePoll.unref();

  const shutdown = async (signal: string) => {
    log.info("shutdown", { signal });
    clearInterval(reap);
    clearInterval(prune);
    clearInterval(pagePoll);
    server.close();
    // Kill the bridge children before the browsers, or they outlive the process.
    await mcp.closeAll();
    closeAllTunnels();
    await browsers.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => resolve());
  });
  log.info("tallylamp listening", {
    host: config.host,
    port: config.port,
    publicUrl: config.publicUrl,
    dataDir: config.dataDir,
    maxBrowsers: config.maxBrowsers,
    sandbox: config.sandbox,
  });
}

main().catch((e) => {
  log.error("fatal", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
