// Live MCP discovery / locator-continuity audit. Uses one disposable browser, sequentially.
// TALLYLAMP_URL=https://HOST TALLYLAMP_TOKEN=... node scripts/mcp-popup-audit.mjs OUT --fixture
// Omit --fixture for discovery only. --native captures ONLY the newly created test browser.
// Credentials stay in memory; this script never changes permissions or existing profiles.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] || "mcp-popup-audit");
const fixture = process.argv.includes("--fixture");
const native = process.argv.includes("--native");
const endpoint = new URL("/mcp", process.env.TALLYLAMP_URL || "http://127.0.0.1:8080");
const token = process.env.TALLYLAMP_TOKEN;
if (!token) throw new Error("TALLYLAMP_TOKEN is required (do not put it in command arguments).");
if (native && !fixture) throw new Error("--native requires --fixture; existing browsers are never captured.");
if (endpoint.username || endpoint.password) throw new Error("Credentials must not be included in TALLYLAMP_URL.");
mkdirSync(out, { recursive: true, mode: 0o700 });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const report = { startedAt: new Date().toISOString(), endpoint: endpoint.origin + endpoint.pathname, checks: [] };
const save = () => {
  const file = path.join(out, "direct-mcp-audit.json");
  writeFileSync(file + ".tmp", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
};
let client, transport, browserId;
const plain = (result) => (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const redact = (message) => String(message).split(token).join("[credential]").replace(/data:text\/html,\S+/g, "[fixture-url]");
const record = (name, pass, details = {}) => {
  report.checks.push({ name, pass, at: new Date().toISOString(), ...details });
  save();
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 25_000 });
const connect = async () => {
  client = new Client({ name: "tallylamp-popup-audit", version: "1" });
  transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport, { timeout: 15_000 });
};
const disconnect = async () => {
  try { await transport?.terminateSession(); } finally { await client?.close(); }
};
const manifest = async (stage) => {
  const listed = await client.listTools({}, { timeout: 15_000 });
  const tools = listed.tools.map(({ name, inputSchema }) => ({ name, inputSchema, schemaSha256: digest(JSON.stringify(inputSchema)) }));
  record(stage, ["tallylamp_desktop_screenshot", "tallylamp_desktop_action"].every((n) => tools.some((t) => t.name === n)), {
    server: client.getServerVersion(), sessionFingerprint: digest(transport.sessionId ?? "none").slice(0, 16), tools,
  });
};
const page = async () => {
  const result = await call("list_pages");
  if (result.isError) throw new Error(redact(plain(result)));
  const selected = result.structuredContent?.pages?.find((p) => p.title === "Tallylamp locator audit fixture");
  const id = selected?.id ?? Number(plain(result).match(/^(\d+):.*Tallylamp locator audit fixture/m)?.[1]);
  if (!Number.isInteger(id) || id < 1) throw new Error("Could not identify the disposable fixture page.");
  return id;
};
const snapshot = async (pageId) => {
  const result = await call("take_snapshot", { pageId });
  const uid = plain(result).match(/uid=(\S+)\s+button "Count \d+"/)?.[1];
  if (result.isError || !uid) throw new Error("Fixture snapshot did not return the expected button.");
  return uid;
};
const counter = async (pageId) => {
  const result = await call("evaluate_script", { pageId, function: "() => ({fixtureCount: window.fixtureCount})" });
  if (result.isError) throw new Error(redact(plain(result)));
  const value = plain(result).match(/"fixtureCount"\s*:\s*(\d+)/)?.[1];
  if (value === undefined) throw new Error("Fixture count was not returned.");
  return Number(value);
};
try {
  await connect();
  await manifest("unbound discovery");
  if (fixture) {
    const made = await call("tallylamp_create_browser", { name: "Popup audit disposable fixture", persistent: false,
      metadata: { source: "mcp-popup-audit.mjs", project: "tallylamp", purpose: "Deterministic locator continuity; no wallet" } });
    if (made.isError) throw new Error(redact(plain(made)));
    browserId = JSON.parse(plain(made)).browserId;
    if (typeof browserId !== "string" || !browserId) throw new Error("Create response omitted browserId; inspect server before retrying.");
    report.fixtureBrowserId = browserId;
    save();
    await manifest("bound discovery");
    const html = '<!doctype html><meta charset="utf-8"><title>Tallylamp locator audit fixture</title><h1>Locator continuity fixture</h1><button onclick="this.textContent=\'Count \'+(++window.fixtureCount)">Count 0</button><script>window.fixtureCount=0</script>';
    const opened = await call("new_page", { url: "data:text/html," + encodeURIComponent(html) });
    if (opened.isError) throw new Error(redact(plain(opened)));
    let pageId = await page();
    let uid = await snapshot(pageId);
    const stable = await call("click", { pageId, uid });
    record("snapshot then click in one MCP session", !stable.isError && await counter(pageId) === 1, { pageId, uid, error: stable.isError ? redact(plain(stable)) : null });
    uid = await snapshot(pageId);
    const rebound = await call("tallylamp_use_browser", { browserId });
    if (rebound.isError) throw new Error(redact(plain(rebound)));
    const afterBind = await call("click", { pageId, uid });
    pageId = await page();
    const count = await counter(pageId);
    record("same-browser rebind preserves fresh locator", !afterBind.isError && count === 2, { count, error: afterBind.isError ? redact(plain(afterBind)) : null });
    await manifest("rebound discovery");
    if (native) {
      const capture = await call("tallylamp_desktop_screenshot", { browserId });
      const image = capture.content?.find((c) => c.type === "image");
      if (image) writeFileSync(path.join(out, image.mimeType === "image/png" ? "fixture-desktop.png" : "fixture-desktop.jpg"), Buffer.from(image.data, "base64"), { mode: 0o600 });
      record("native capture of disposable fixture", !capture.isError && Boolean(image), { dimensionsOrError: redact(plain(capture)) });
    }
    await disconnect();
    await connect();
    await manifest("reconnected discovery");
    pageId = await page();
    uid = await snapshot(pageId);
    const fresh = await call("click", { pageId, uid });
    record("fresh locator after reconnect", !fresh.isError && await counter(pageId) === count + 1, { pageId, uid, error: fresh.isError ? redact(plain(fresh)) : null });
  }
} catch (error) {
  record("audit completed", false, { error: redact(error.message) });
} finally {
  if (browserId) {
    try {
      const removed = await call("tallylamp_delete_browser", { browserId });
      record("disposable browser cleanup", !removed.isError, { browserId, error: removed.isError ? redact(plain(removed)) : null });
    } catch (error) { record("disposable browser cleanup", false, { browserId, error: redact(error.message) }); }
  }
  try { await disconnect(); } catch (error) { record("MCP disconnect", false, { error: redact(error.message) }); }
  report.finishedAt = new Date().toISOString();
  save();
}
process.exitCode = report.checks.some((c) => !c.pass) ? 1 : 0;
