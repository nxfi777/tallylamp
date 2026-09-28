// Redraws the Chrome Web Store images from store/stage.html, and extension/icons/128.png with
// them: the store asks for a 128px icon with 16px of clear space round 96px of mark, and the
// manifest's 128px icon is the one it shows. Run it after changing the panel's look or words:
//
//   node scripts/store-assets.mjs            (CHROME_BIN overrides the browser path)
//
// One static server on loopback and one headless Chrome on a CDP pipe, both closed in finally.
// Needs a branded Chrome or Chromium on this machine, like scripts/linked-e2e.mjs.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

// [file, page, width, height, colour scheme]. Screenshots are light, like most people's
// Chrome; the tiles are dark so they stand out on the store's white page.
const ASSETS = [
  ["store/screenshot-1-share.png", "?shot=share", 1280, 800, "light"],
  ["store/screenshot-2-shared.png", "?shot=shared", 1280, 800, "light"],
  ["store/screenshot-3-pair.png", "?shot=pair", 1280, 800, "light"],
  ["store/screenshot-4-sites.png", "?shot=sites", 1280, 800, "light"],
  ["store/screenshot-5-handback.png", "?shot=handback", 1280, 800, "light"],
  ["store/promo-small.png", "?tile=small", 440, 280, "dark"],
  ["store/promo-marquee.png", "?tile=marquee", 1400, 560, "dark"],
  ["extension/icons/128.png", "?icon=128", 128, 128, "light"],
];

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
  let body;
  try {
    body = readFileSync(file);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(os.tmpdir(), "tallylamp-store-"));
const chrome = spawn(process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome"),
  ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let id = 0, buf = "";
const waits = new Map();
chrome.stdio[4].on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id;
  waits.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + "\0");
});

try {
  for (const [out, query, width, height, scheme] of ASSETS) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, sessionId);
    // Only the icon needs the page behind it clear. Store images must be opaque.
    if (out.endsWith("128.png")) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
    await send("Page.navigate", { url: `${base}/store/stage.html${query}` }, sessionId);
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ready = (await send("Runtime.evaluate", { expression: "window.stageReady === true", returnByValue: true }, sessionId)).result.value;
    }
    if (!ready) throw new Error(`${query} never finished drawing`);
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
    writeFileSync(path.join(ROOT, out), Buffer.from(data, "base64"));
    console.log(`${out}  ${width}x${height}`);
    await send("Target.closeTarget", { targetId });
  }
} finally {
  chrome.kill("SIGKILL");
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((r) => chrome.once("exit", r));
  server.close();
  // Chrome's helpers can still be writing into the profile for a moment after it exits.
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
