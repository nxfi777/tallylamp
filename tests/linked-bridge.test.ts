import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocket, WebSocketServer } from "ws";
import { acceptLinkedBridge, createLinkedBridgeTransport } from "../src/linked-bridge.js";
import { prepareBridgeFiles } from "../src/bridge-files.js";
import { TunnelMux } from "../src/tunnels.js";

async function endpoint(accept: (ws: WebSocket) => void) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== "Bearer test-worker-secret") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, accept);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/bridge`,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("carries MCP text beside a CDP tunnel restricted to the supplied endpoint", { timeout: 10_000 }, async () => {
  let connections = 0;
  const echo = net.createServer((socket) => { connections++; socket.pipe(socket); });
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  let mux!: TunnelMux;
  const remote = await endpoint((ws) => {
    mux = new TunnelMux(ws, { role: "test" });
    ws.on("message", (data, binary) => {
      if (binary) return;
      const message = JSON.parse(String(data));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
    });
    ws.send(JSON.stringify({ type: "linked-bridge-ready" }));
  });
  const transport = createLinkedBridgeTransport(remote.url, "test-worker-secret", (echo.address() as net.AddressInfo).port);
  try {
    await transport.start();
    assert.equal(await mux.open("127.0.0.1", 1), null);
    assert.equal(await mux.open("cdp", 2), null);
    assert.equal(connections, 0, "a worker-selected destination must never be dialled");
    const stream = await mux.open("cdp", 1);
    assert.ok(stream);
    const reply = once(stream, "data");
    stream.write("shared-tab CDP bytes");
    assert.equal(String((await reply)[0]), "shared-tab CDP bytes");
    assert.equal(connections, 1);
    const result = new Promise<unknown>((resolve) => { transport.onmessage = resolve; });
    await transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    assert.deepEqual(await result, { jsonrpc: "2.0", id: 7, result: { tools: [] } });
    stream.destroy();
  } finally {
    await transport.close();
    await remote.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

it("rejects unauthenticated startup and reports one close", { timeout: 10_000 }, async () => {
  const remote = await endpoint(() => assert.fail("an unauthenticated bridge was admitted"));
  const transport = createLinkedBridgeTransport(remote.url, "wrong", 1);
  let closed = 0;
  transport.onclose = () => { closed++; };
  try {
    await assert.rejects(transport.start(), /401/);
    await transport.close();
    assert.equal(transport.closed, true);
    assert.equal(closed, 1);
  } finally { await remote.close(); }
});

it("rejects malformed JSON-RPC and does not reconnect or replay", { timeout: 10_000 }, async () => {
  let calls = 0;
  const remote = await endpoint((ws) => {
    ws.send(JSON.stringify({ type: "linked-bridge-ready" }));
    ws.on("message", () => { calls++; ws.send(JSON.stringify({ id: 1, result: {} })); });
  });
  const transport = createLinkedBridgeTransport(remote.url, "test-worker-secret", 1);
  try {
    await transport.start();
    const closed = new Promise<void>((resolve) => { transport.onclose = resolve; });
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await closed;
    await assert.rejects(transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), /not connected/);
    await assert.rejects(transport.start(), /cannot be started again/);
    assert.equal(calls, 1);
  } finally { await transport.close(); await remote.close(); }
});

it("runs a real bridge on the worker and reaps it when its session closes", { timeout: 20_000 }, async () => {
  let bridge!: ReturnType<typeof acceptLinkedBridge>;
  const remote = await endpoint((ws) => { bridge = acceptLinkedBridge(ws); });
  const transport = createLinkedBridgeTransport(remote.url, "test-worker-secret", 1);
  const client = new Client({ name: "linked-worker-test", version: "1" });
  try {
    await client.connect(transport);
    assert.ok(bridge.pid, "the bridge process belongs to the worker connection");
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "list_pages"));
    // Use the installed bridge's advertised capabilities, so adding an output argument
    // upstream cannot silently leave a successful tool's file on a worker.
    const workerDirectory = "/worker/session";
    let outputFields = 0;
    for (const tool of tools.tools) {
      for (const field of ["filePath", "requestFilePath", "responseFilePath", "outputDirPath"]) {
        if (!Object.hasOwn(tool.inputSchema.properties ?? {}, field)) continue;
        outputFields++;
        const local = path.join(os.tmpdir(), "tallylamp-output-manifest-test", tool.name, field === "outputDirPath" ? "reports" : "artifact.txt");
        const prepared = await prepareBridgeFiles(workerDirectory, tool.name, { [field]: local });
        const rewritten = prepared.args[field];
        const label = `${tool.name}.${field}`;
        assert.ok(typeof rewritten === "string" && rewritten.startsWith(workerDirectory + "/"), `${label} must be routed into the worker session`);
        assert.notEqual(rewritten, local, `${label} must not name the main filesystem on a worker`);
        assert.ok(prepared.files.length > 0, `${label} needs a return-file mapping`);
        for (const file of prepared.files) {
          assert.ok(field === "outputDirPath" ? file.remote.startsWith(rewritten + "/") : file.remote === rewritten, `${label} mapping must cover its rewritten output`);
        }
      }
    }
    assert.ok(outputFields > 0, "the bridge manifest must expose file outputs to verify");
    await client.close();
    await bridge.closed;
    assert.equal(bridge.pid, null);
  } finally {
    await client.close();
    await bridge?.close();
    await remote.close();
  }
});
