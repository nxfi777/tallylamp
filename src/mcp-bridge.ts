import { createRequire } from "node:module";
import path from "node:path";
import { config } from "./config.js";
import { sanitizedChromeEnv } from "./chrome.js";

const require = createRequire(import.meta.url);

function chromeDevtoolsBin(): string {
  const pkg = require.resolve("chrome-devtools-mcp/package.json");
  const dir = path.dirname(pkg);
  return path.join(dir, "build", "src", "bin", "chrome-devtools-mcp.js");
}

/**
 * Spawn options for a chrome-devtools-mcp bridge child. bind() and the manifest harvest both
 * go through this so the tool list an unbound session advertises cannot drift from the tools
 * a bound session actually gets: same binary, same flags, so the same registrations.
 *
 * `extensions` lets the bridge see extension targets: service workers in list_pages, and
 * evaluate_script inside one. Without it chrome-devtools-mcp drops every chrome-extension://
 * target. Only Tallylamp's own browsers get it. A linked browser is a person's own Chrome,
 * and the extensions in it are theirs, not part of the tab they shared.
 */
export function bridgeSpawn(browserUrl: string, stderr: "pipe" | "ignore", opts: { websocket?: boolean; extensions?: boolean } = {}) {
  return {
    command: process.execPath,
    args: [
      chromeDevtoolsBin(),
      opts.websocket ? `--wsEndpoint=${browserUrl}` : `--browser-url=${browserUrl}`,
      "--no-usage-statistics",
      "--experimental-structured-content",
      ...(opts.extensions ? ["--categoryExtensions=true"] : []),
    ],
    env: {
      ...sanitizedChromeEnv(),
      CI: "1",
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      // The bridge is a full Node process carrying puppeteer-core: ~153-186 MB left to
      // its own devices. It needs nowhere near that.
      NODE_OPTIONS: config.mcpBridgeNodeOptions,
    },
    stderr,
  };
}

