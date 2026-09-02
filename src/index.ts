import http from "node:http";
import { config } from "./config.js";
import { log } from "./log.js";
import { getDb } from "./db.js";
import { startEgressProxy } from "./egress-proxy.js";
import { BrowserManager } from "./browsers.js";
import { McpGateway } from "./mcp.js";
import { createApp } from "./server.js";
import { attachViewerUpgrade } from "./viewer.js";

async function main(): Promise<void> {
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", reason instanceof Error ? reason.stack : String(reason));
  });

  if (!config.adminSecret) {
    log.warn("ADMIN_SECRET is empty — dashboard login will fail until it is set");
  }

  getDb();
  const proxy = config.fakeChrome ? undefined : await startEgressProxy();
  const browsers = new BrowserManager(proxy);
  await browsers.recoverOnBoot();
  const mcp = new McpGateway(browsers);
  const app = createApp(browsers, mcp);
  const server = http.createServer(app);
  attachViewerUpgrade(server, browsers);

  const reap = setInterval(() => {
    void browsers.reapIdle();
  }, 15_000);
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
    clearInterval(pagePoll);
    server.close();
    await browsers.shutdown();
    await proxy?.close();
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
