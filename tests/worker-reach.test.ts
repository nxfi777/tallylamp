import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { startTestServer, type TestCtx } from "./helpers.js";
import { allocatePort, type ChromeRuntime } from "../src/chrome.js";
import { createAgent } from "../src/auth.js";
import { startWorker, uploadStaging } from "../src/worker.js";
import { allowedFfmpeg, allowedXdotool, remoteSpawner, xFrame, X_EXIT, X_STDOUT, type RemoteRun } from "../src/x11-remote.js";
import { agentDesktop, agentDesktopCommand } from "../src/agent-desktop.js";
import { desktopInput, runDesktopViewer } from "../src/desktop-viewer.js";
import { createTunnel } from "../src/tunnels.js";

const admin = { type: "admin", id: "admin", name: "Administrator", scopes: ["*"] } as const;
const size = { width: 2560, height: 1600 };
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

/**
 * A worker's display endpoint without a display: it checks each command exactly as the real
 * one does, then answers the way the real one frames a finished program. A capture it leaves
 * running until the caller hangs up.
 */
function fakeDisplay(display: string, seen: Array<{ tool: string; args: string[] }>, aborted: { count: number }): RemoteRun {
  return async ({ tool, args, stdout }, signal) => {
    const ok = tool === "xdotool" ? allowedXdotool(args) : tool === "ffmpeg" ? allowedFfmpeg(args, display) : false;
    if (!ok) return new Response(JSON.stringify({ error: { message: "this worker runs only the display commands Tallylamp sends" } }), { status: 400 });
    seen.push({ tool, args });
    const capture = tool === "ffmpeg" && !args.includes("-frames:v");
    signal.addEventListener("abort", () => { aborted.count++; });
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        if (stdout) c.enqueue(xFrame(X_STDOUT, jpeg));
        if (!capture) {
          c.enqueue(xFrame(X_EXIT, Buffer.from(JSON.stringify({ code: 0, signal: null }))));
          c.close();
        }
      },
    }));
  };
}

describe("what a worker runs on a browser's display", () => {
  it("accepts every xdotool command the viewer and the agent tools build", () => {
    const agent = [
      { action: "move", x: 10, y: 20 }, { action: "click", x: 1, y: 2 }, { action: "click", x: 1, y: 2, button: "right", doubleClick: true },
      { action: "scroll", x: 5, y: 5, deltaY: 250 }, { action: "type", text: "héllo --window 1; $(id)" }, { action: "key", keys: ["Control", "l"] },
      { action: "key", keys: ["Shift", "F5"] }, { action: "openExtensions" },
    ].flatMap((input) => {
      const c = agentDesktopCommand(input, size);
      return c.release.length ? [c.args, c.release] : [c.args];
    });
    const viewer = [
      { type: "mouse", event: "mouseMoved", x: 3, y: 4 }, { type: "mouse", event: "mousePressed", button: "left", x: 3, y: 4, modifiers: 0 },
      { type: "mouse", event: "mouseReleased", button: "middle", x: 3, y: 4 }, { type: "scroll", x: 1, y: 1, deltaX: 0, deltaY: -120 },
      { type: "key", event: "keyDown", key: "A", modifiers: 8 }, { type: "key", event: "keyUp", key: "Enter" },
      { type: "paste", text: "a\nb -- c" }, { type: "extensions" },
    ].map((msg) => desktopInput(msg, size)!);
    for (const args of [...agent, ...viewer]) assert.ok(allowedXdotool(args), JSON.stringify(args));
  });

  it("refuses xdotool that would run anything, read a file, or touch another window", () => {
    for (const args of [
      [], ["exec", "sh"], ["key", "exec"], ["key", "Return", "exec", "sh", "-c", "id"], ["search", "--name", "x"], ["windowkill"],
      ["type", "--file", "/etc/passwd"], ["type", "--window", "1", "x"], ["mousemove", "1"], ["click", "--window", "1", "1"],
      ["key"], ["keydown", "Return;id"], ["mousemove", "1", "2", "exec", "id"], ["type"],
    ]) {
      assert.equal(allowedXdotool(args), false, JSON.stringify(args));
    }
  });

  it("refuses ffmpeg that reads anything but this browser's display, or writes anywhere but stdout", () => {
    const shot = ["-nostdin", "-loglevel", "error", "-f", "x11grab", "-video_size", "2560x1600", "-i", ":7.0", "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"];
    assert.ok(allowedFfmpeg(shot, ":7"));
    for (const args of [
      shot.map((a) => (a === ":7.0" ? ":0.0" : a)), [...shot.slice(0, -1), "/tmp/out.jpg"], [...shot.slice(0, -1), "-y", "pipe:1"],
      ["-i", "/etc/passwd", "pipe:1"], [...shot.slice(0, -1), "-vf", "movie=/etc/passwd", "pipe:1"], shot.filter((a) => a !== "-i" && a !== ":7.0"),
    ]) {
      assert.equal(allowedFfmpeg(args, ":7"), false, JSON.stringify(args));
    }
  });
});

describe("Full browser and the agent desktop tools, run on another host", () => {
  let ctx: TestCtx;
  let id: string;
  let rt: ChromeRuntime;
  let owner: ReturnType<typeof createAgent>;
  const seen: Array<{ tool: string; args: string[] }> = [];
  const aborted = { count: 0 };
  const env = { xvfb: process.env.TALLYLAMP_XVFB, fake: process.env.TALLYLAMP_FAKE_CHROME };
  before(async () => {
    ctx = await startTestServer();
    owner = createAgent({ name: "Desktop on a worker" });
    id = ctx.browsers.create({ principal: owner.agent, via: "mcp", name: "remote display" }).id;
    rt = await ctx.browsers.ensureRunning(id);
    // Shaped as workers.ts shapes a worker's browser: the worker's display, and its spawner.
    // No Xvfb here at all.
    rt.display = ":7";
    rt.desktopSpawn = remoteSpawner(fakeDisplay(":7", seen, aborted));
    process.env.TALLYLAMP_XVFB = "1";
    process.env.TALLYLAMP_FAKE_CHROME = "0";
    ctx.browsers.updateAgentDesktop(id, true, admin);
  });
  after(async () => {
    rt.display = null;
    rt.desktopSpawn = undefined;
    for (const [key, value] of [["TALLYLAMP_XVFB", env.xvfb], ["TALLYLAMP_FAKE_CHROME", env.fake]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await ctx.close();
  });

  it("takes a screenshot and clicks through the worker, with commands the worker accepts", async () => {
    seen.length = 0;
    const shot = await agentDesktop(ctx.browsers, owner.agent, id, {}, true);
    assert.deepEqual(shot.image, jpeg);
    assert.equal(shot.screenWidth, rt.screen.width);
    await agentDesktop(ctx.browsers, owner.agent, id, { action: "click", x: 10, y: 10 }, false);
    assert.deepEqual(seen.map((s) => s.tool), ["ffmpeg", "xdotool", "xdotool"], "the capture, the click, then its release");
    assert.deepEqual(seen[2]!.args, ["mouseup", "1"]);
  });

  it("reports a command the worker refuses as a failed operation, not a hang", async () => {
    const refusing = remoteSpawner(async () => new Response(JSON.stringify({ error: { message: "no" } }), { status: 400 }));
    rt.desktopSpawn = refusing;
    try {
      await assert.rejects(agentDesktop(ctx.browsers, owner.agent, id, { action: "move", x: 1, y: 1 }, false), /native operation could not start/);
    } finally {
      rt.desktopSpawn = remoteSpawner(fakeDisplay(":7", seen, aborted));
    }
  });

  it("streams Full browser from the worker's display, and stops the capture there when the view closes", async () => {
    seen.length = 0;
    const before = aborted.count;
    const sent: unknown[] = [];
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0, send(d: unknown) { sent.push(d); }, ping() {},
      close(code: number) { this.emit("close", code); }, terminate() { this.emit("close", 1006); },
    });
    runDesktopViewer(ws as unknown as WebSocket, ctx.browsers, id, "watch");
    for (let i = 0; i < 50 && !sent.some((d) => Buffer.isBuffer(d)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent.find((d) => Buffer.isBuffer(d)), jpeg, "the worker's frame reaches the viewer");
    assert.equal(seen[0]?.tool, "ffmpeg");
    ws.close(1000);
    assert.equal(aborted.count, before + 1, "closing the view hangs up on the worker, which kills its ffmpeg");
  });
});

/** The agent's end of a tunnel, as in tunnel.test.ts: forwards to one address on its own machine. */
function tunnelClient(wsUrl: string, host: string, port: number): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);
  const streams = new Map<number, net.Socket>();
  const send = (type: number, sid: number, payload = Buffer.alloc(0)) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const out = Buffer.allocUnsafe(5 + payload.length);
    out.writeUInt8(type, 0);
    out.writeUInt32BE(sid, 1);
    payload.copy(out, 5);
    ws.send(out);
  };
  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const type = buf.readUInt8(0);
    const sid = buf.readUInt32BE(1);
    const payload = buf.subarray(5);
    if (type === 0x01) {
      const sock = net.createConnection({ host, port });
      streams.set(sid, sock);
      sock.once("connect", () => send(0x04, sid));
      sock.on("data", (c) => send(0x02, sid, c));
      sock.on("close", () => {
        if (streams.delete(sid)) send(0x03, sid);
      });
      return;
    }
    const sock = streams.get(sid);
    if (type === 0x02) sock?.write(payload);
    else if (type === 0x03) sock?.end();
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("tunnels and uploads for a browser on a worker", () => {
  let ctx: TestCtx;
  let worker: Awaited<ReturnType<typeof startWorker>> & { url: string };
  let dataDir: string;
  let site: Server;
  let sitePort: number;
  before(async () => {
    ctx = await startTestServer();
    ctx.browsers.workers.stopPolling();
    dataDir = mkdtempSync(path.join(os.tmpdir(), "tallylamp-worker-"));
    const port = await allocatePort();
    const url = `http://127.0.0.1:${port}`;
    worker = { ...(await startWorker({ dataDir, host: "127.0.0.1", port, join: ctx.browsers.workers.createJoinToken(admin).token, selfUrl: url, name: "worker-t" })), url };
    await ctx.browsers.workers.poll();
    // The agent's dev server, on the agent's machine.
    site = createServer((_req, res) => res.end("hello from the laptop"));
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    sitePort = (site.address() as net.AddressInfo).port;
  });
  after(async () => {
    site.close();
    await worker.close().catch(() => undefined);
    await ctx.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("carries a tunnel from Chrome on the worker to the agent's machine, and nothing it was not bound to", async () => {
    const row = ctx.browsers.create({ principal: admin, via: "control_api", name: "tunnelled", workerId: worker.identity.workerId });
    await ctx.browsers.ensureRunning(row.id);
    const { row: tunnel, token } = createTunnel(ctx.browsers, admin, { browserId: row.id, host: "127.0.0.1", port: sitePort });

    // Bound, with nothing on the agent's end yet: refused as unavailable, not as the policy's
    // 403. That answer can only have come from this instance, so the worker's socket is up.
    let answer = "";
    for (let i = 0; i < 100 && answer !== "refused"; i++) {
      answer = await worker.dialTunnel(row.id, "127.0.0.1", sitePort).then((s) => (s ? (s.destroy(), "stream") : "none"), () => "refused");
      if (answer !== "refused") await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(answer, "refused");

    const client = await tunnelClient(`${ctx.url.replace(/^http/, "ws")}/api/v1/tunnels/${tunnel.id}/connect?token=${encodeURIComponent(token)}`, "127.0.0.1", sitePort);
    try {
      const stream = (await worker.dialTunnel(row.id, "127.0.0.1", sitePort)) as Duplex;
      assert.ok(stream, "a bound authority opens a stream");
      const reply = await new Promise<string>((resolve) => {
        let out = "";
        stream.on("data", (d: Buffer) => { out += d.toString(); });
        stream.on("end", () => resolve(out));
        stream.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${sitePort}\r\nConnection: close\r\n\r\n`);
      });
      assert.match(reply, /hello from the laptop/);
      // Anything else is no binding, which the worker's egress policy then refuses.
      assert.equal(await worker.dialTunnel(row.id, "127.0.0.1", sitePort + 1), null);
      assert.equal(await worker.dialTunnel(row.id, "example.com", 443), null, "a public address never asks");
    } finally {
      client.close();
    }
    await ctx.browsers.stop(row.id);
    assert.equal(await worker.dialTunnel(row.id, "127.0.0.1", sitePort), null, "a stopped browser's socket is gone");
  });

  it("puts a file for upload_file at the same path on the worker, and only one the bridge would take", async () => {
    const row = ctx.browsers.create({ principal: admin, via: "control_api", name: "uploader", workerId: worker.identity.workerId });
    await ctx.browsers.ensureRunning(row.id);
    const folder = mkdtempSync(path.join(realpathSync(os.tmpdir()), "tl-upload-"));
    const file = path.join(folder, "report.pdf");
    writeFileSync(file, "pdf bytes");
    try {
      const out = (await ctx.browsers.workers.stageUploads(ctx.browsers.row(row.id), [file, "/etc/hosts", "/no/such/file"])) as string[];
      const staged = out[0]!;
      assert.ok(staged.startsWith(uploadStaging(row.id) + path.sep), staged);
      assert.equal(path.basename(staged), "report.pdf", "the page sees the file's own name");
      assert.equal(readFileSync(staged, "utf8"), "pdf bytes");
      assert.deepEqual(out.slice(1), ["/etc/hosts", "/no/such/file"], "outside the temp directory, the bridge refuses it itself");
      assert.deepEqual(await ctx.browsers.workers.stageUploads(ctx.browsers.row(row.id), [staged]), [staged], "already there");

      const put = (dir: string, name: string) =>
        fetch(`${worker.url}/worker/v1/browsers/${row.id}/uploads/${dir}/${name}`, {
          method: "PUT", headers: { authorization: `Bearer ${worker.identity.secret}` }, body: "x",
        }).then((r) => r.status);
      assert.equal(await put("0123456789ab", "a%2Fb"), 400);
      assert.equal(await put("zz", "ok.txt"), 400);
      assert.equal(await put("0123456789ab", "ok.txt"), 200);

      await ctx.browsers.stop(row.id);
      assert.equal(existsSync(uploadStaging(row.id)), false, "a stopped browser's uploads are gone");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
