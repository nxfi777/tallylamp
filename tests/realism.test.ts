import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { diffSurfaces, formatReport, type SurfaceMap } from "../src/realism.js";
import { gpuArgs } from "../src/chrome.js";
import { config } from "../src/config.js";

const chromeAvailable = existsSync(config.chromeBin) && !process.env.CI_SKIP_REALISM;

describe("browser realism differential", { skip: !chromeAvailable }, () => {
  it("classifies identical surfaces as MATCH", () => {
    const sample: SurfaceMap = { userAgent: "Mozilla/5.0", webdriver: undefined, webgl: { renderer: "Apple" } };
    const rows = diffSurfaces(sample, sample);
    assert.ok(rows.every((r) => r.classification === "match"));
    assert.ok(formatReport(rows).includes("MATCH"));
  });

  it("does not treat HeadlessChrome as a match against a headed UA", () => {
    const rows = diffSurfaces(
      { userAgent: "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36" },
      { userAgent: "Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36" },
    );
    const ua = rows.find((r) => r.key === "userAgent");
    assert.ok(ua);
    assert.notEqual(ua!.classification, "match");
  });

  it("launches headed chrome without HeadlessChrome in the UA when a real binary is present", async (t) => {
    if (!chromeAvailable) {
      t.skip();
      return;
    }
    const { launchChrome, stopRuntime } = await import("../src/chrome.js");
    const { captureSurfaces } = await import("../src/realism.js");
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tallylamp-realism-"));
    process.env.TALLYLAMP_XVFB = process.platform === "linux" ? "1" : "0";
    const rt = await launchChrome({ profileDir: dir, downloadDir: path.join(dir, "dl") });
    try {
      const surfaces = await captureSurfaces(rt);
      const ua = String(surfaces.userAgent ?? "");
      assert.equal(ua.includes("HeadlessChrome"), false, ua);
      assert.notEqual(surfaces.webdriver, true);
    } finally {
      await stopRuntime(rt);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists newly written cookies and local storage through an immediate stop", async () => {
    const { launchChrome, stopRuntime } = await import("../src/chrome.js");
    const { CdpClient, browserWsUrl, evaluate } = await import("../src/cdp.js");
    const { createServer } = await import("node:http");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tallylamp-persistence-"));
    const server = createServer((_req, res) => res.end("Profile persistence test"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    let rt: Awaited<ReturnType<typeof launchChrome>> | undefined;
    let cdp: InstanceType<typeof CdpClient> | undefined;
    try {
      for (const writing of [true, false]) {
        rt = await launchChrome({ profileDir: dir, downloadDir: join(dir, "dl") });
        cdp = new CdpClient(await browserWsUrl(rt.cdpUrl));
        await cdp.connect();
        if (writing) await evaluate(cdp, `location.href = 'http://127.0.0.1:${port}/'`);
        for (let attempt = 0; ; attempt++) {
          if (await evaluate(cdp, `location.origin === 'http://127.0.0.1:${port}' && document.readyState === 'complete'`)) break;
          assert.ok(attempt < 100, "test page did not load");
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (writing) {
          await evaluate(cdp, `localStorage.setItem('saved', 'yes'); document.cookie = 'saved=yes; Max-Age=86400'; document.cookie = 'session=kept'; true`);
        } else {
          assert.deepEqual(await evaluate(cdp, `({saved: localStorage.getItem('saved'), cookies: document.cookie.split('; ').sort()})`),
            { saved: "yes", cookies: ["saved=yes", "session=kept"] });
        }
        await cdp.close(); cdp = undefined;
        await stopRuntime(rt); rt = undefined;
      }
    } finally {
      await cdp?.close();
      if (rt) await stopRuntime(rt);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes headed Chrome through an authenticated upstream and never falls back on rejection", async () => {
    const { launchChrome, stopRuntime } = await import("../src/chrome.js");
    const { CdpClient, browserWsUrl, evaluate } = await import("../src/cdp.js");
    const { startEgressProxy } = await import("../src/egress-proxy.js");
    const { createServer } = await import("node:http");
    const { createConnection } = await import("node:net");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const privateSetting = process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK;
    process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = "1"; // Local fixture endpoints only.
    const dir = mkdtempSync(join(tmpdir(), "tallylamp-real-proxy-"));
    let hits = 0;
    const origin = createServer((_req, res) => { hits++; res.end("proxied-chrome-ok"); });
    const upstream = createServer();
    const peers = new Set<import("node:stream").Duplex>();
    const authorities: string[] = [];
    let reject = false;
    let rejections = 0;
    let rt: Awaited<ReturnType<typeof launchChrome>> | undefined;
    let cdp: InstanceType<typeof CdpClient> | undefined;
    let egress: Awaited<ReturnType<typeof startEgressProxy>> | undefined;
    try {
      await new Promise<void>(r => origin.listen(0, "127.0.0.1", r));
      const port = (origin.address() as { port: number }).port;
      upstream.on("connect", (req, client, head) => {
        peers.add(client); client.on("error", () => client.destroy());
        client.on("close", () => peers.delete(client));
        if (reject || req.headers["proxy-authorization"] !== "Basic cHJveHktdXNlcjpwcm94eS1wYXNz") {
          rejections++; client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return;
        }
        authorities.push(req.url!);
        const peer = createConnection({ host: "127.0.0.1", port });
        peers.add(peer); peer.on("error", () => client.destroy());
        peer.on("close", () => { peers.delete(peer); client.destroy(); });
        client.on("close", () => peer.destroy());
        peer.on("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) peer.write(head);
          client.pipe(peer); peer.pipe(client);
        });
      });
      await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
      egress = await startEgressProxy({ upstream: {
        server: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        username: "proxy-user", password: "proxy-pass",
      } });
      rt = await launchChrome({ profileDir: dir, downloadDir: join(dir, "dl"), proxyPort: egress.port, upstreamProxy: true });
      cdp = new CdpClient(await browserWsUrl(rt.cdpUrl));
      await cdp.connect();
      await evaluate(cdp, `location.href = 'http://127.0.0.1:${port}/first'`);
      for (let attempt = 0; ; attempt++) {
        if (await evaluate(cdp, `document.body?.textContent === 'proxied-chrome-ok'`)) break;
        assert.ok(attempt < 100, "proxied page did not load");
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(authorities.includes(`127.0.0.1:${port}`), "Chrome bypassed the local proxy");
      assert.ok(hits > 0);
      // Let the favicon settle before measuring whether the refused navigation went direct.
      await new Promise(r => setTimeout(r, 250));
      reject = true;
      const before = hits;
      await evaluate(cdp, `location.href = 'http://127.0.0.1:${port}/rejected'`);
      for (let attempt = 0; ; attempt++) {
        if (rejections > 0 && await evaluate(cdp, `document.readyState === 'complete' && document.body?.textContent !== 'proxied-chrome-ok'`)) break;
        assert.ok(attempt < 100, "refused proxy request did not finish");
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(hits, before, "a rejected proxy request reached the origin directly");
    } finally {
      await cdp?.close();
      if (rt) await stopRuntime(rt);
      await egress?.close();
      for (const peer of peers) peer.destroy();
      await Promise.all([new Promise<void>(r => origin.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
      rmSync(dir, { recursive: true, force: true });
      if (privateSetting === undefined) delete process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK;
      else process.env.TALLYLAMP_ALLOW_PRIVATE_NETWORK = privateSetting;
    }
  });
});

describe("gpu flags", () => {
  it("gives a GPU-less container a working software WebGL backend", () => {
    const sw = gpuArgs("software");
    assert.equal(sw.status, "software");
    // Without this flag current Chrome refuses SwiftShader and WebGL is simply absent,
    // which breaks any shader-backed site with its own error boundary.
    assert.ok(sw.args.includes("--enable-unsafe-swiftshader"), "SwiftShader must be explicitly enabled");
    assert.ok(sw.args.includes("--use-angle=swiftshader"));
  });

  it("leaves hardware mode alone", () => {
    assert.deepEqual(gpuArgs("hardware"), { args: [], status: "hardware" });
  });
});

describe("viewer stream sizing", () => {
  it("streams at the real window size, not a downscale", () => {
    // Regression: watch mode was pinned to 640x400 and then stretched across the stage,
    // which made page text unreadable.
    const [w, h] = config.windowSize.split(",").map(Number);
    assert.equal(config.viewerSize.width, w);
    assert.equal(config.viewerSize.height, h);
    assert.ok(config.viewerWatchQuality >= 50, "watch quality must stay legible");
  });
});
