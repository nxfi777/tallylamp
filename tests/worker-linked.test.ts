import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startWorker, makeJoinToken, type WorkerState } from "../src/worker.js";
import { createLinkedBridgeTransport } from "../src/linked-bridge.js";
import { bridgeFilesDir } from "../src/bridge-files.js";

it("authenticates linked worker bridges, admits by thread headroom, and confines artifacts", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "worker-linked-test-"));
  const secret = "b".repeat(64);
  const control = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ workerId: "a".repeat(16), secret })); });
  control.listen(0, "127.0.0.1");
  await once(control, "listening");
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  const worker = await startWorker({ dataDir: directory, host: "127.0.0.1", port: 0, selfUrl: "http://127.0.0.1:1", name: "linked-worker", join: makeJoinToken(controlUrl, "a".repeat(48)) });
  const url = `http://127.0.0.1:${worker.port}`;
  const bridgeId = "c".repeat(32);
  const endpoint = `${url.replace("http", "ws")}/worker/v1/linked-bridges/${bridgeId}/mcp`;
  const headers = { Authorization: `Bearer ${secret}` };
  const state = async () => (await (await fetch(`${url}/worker/v1/state`, { headers })).json()) as WorkerState;
  const refused = async (authorization: string, id = bridgeId) => {
    const ws = new WebSocket(`${url.replace("http", "ws")}/worker/v1/linked-bridges/${id}/mcp`, { headers: { Authorization: authorization } });
    ws.on("error", () => undefined);
    return new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
      ws.on("open", () => { ws.terminate(); reject(new Error("worker accepted a refused bridge")); });
    });
  };
  const priorCgroup = process.env.TALLYLAMP_CGROUP_DIR;
  const priorProc = process.env.TALLYLAMP_PROC_DIR;
  const priorHeadroom = process.env.TALLYLAMP_PROCESS_HEADROOM;
  const client = new Client({ name: "worker-linked-test", version: "1" });
  try {
    assert.equal(await refused("Bearer wrong"), 403);
    assert.equal(await refused(`Bearer ${secret}`, "not-an-id"), 403);
    assert.equal((await state()).linkedBridges?.length, 0);
    const cgroup = path.join(directory, "cgroup");
    const proc = path.join(directory, "proc");
    await mkdir(cgroup); await mkdir(proc);
    process.env.TALLYLAMP_CGROUP_DIR = cgroup;
    process.env.TALLYLAMP_PROC_DIR = proc;
    process.env.TALLYLAMP_PROCESS_HEADROOM = "50";
    await writeFile(path.join(cgroup, "pids.max"), "1000");
    await writeFile(path.join(cgroup, "pids.current"), "945");
    assert.equal(await refused(`Bearer ${secret}`), 429);
    assert.equal((await state()).linkedBridges?.length, 0, "capacity rejection must not spawn a child");
    await writeFile(path.join(cgroup, "pids.current"), "930");
    await client.connect(createLinkedBridgeTransport(endpoint, secret, 9));
    assert.equal((await state()).linkedBridges?.length, 1);
    assert.equal(await refused(`Bearer ${secret}`, "d".repeat(32)), 429, "an unmeasured bridge reserves its pending threads");
    const files = bridgeFilesDir(bridgeId);
    await writeFile(path.join(files, "snapshot.txt"), "worker output");
    const artifact = (file: string, authorized = true) => fetch(`${url}/worker/v1/linked-bridges/${bridgeId}/files?path=${encodeURIComponent(file)}`, { headers: authorized ? headers : {} });
    assert.equal((await artifact("snapshot.txt", false)).status, 401);
    const output = await artifact("snapshot.txt");
    assert.equal(output.status, 200);
    assert.equal(output.headers.get("x-tallylamp-extension"), ".txt");
    assert.equal(await output.text(), "worker output");
    const outside = path.join(directory, "outside.txt");
    await writeFile(outside, "must not leave this directory");
    assert.equal((await artifact(outside)).status, 403);
    await symlink(outside, path.join(files, "escape.txt"));
    assert.equal((await artifact("escape.txt")).status, 403);
    // A per-session filesystem failure must not crash the worker or its other bridges.
    await writeFile(path.join(cgroup, "pids.current"), "100");
    const blockedId = "e".repeat(32);
    await writeFile(bridgeFilesDir(blockedId), "directory collision");
    try {
      assert.equal(await refused(`Bearer ${secret}`, blockedId), 503);
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
      assert.equal((await state()).linkedBridges?.length, 1);
    } finally { await rm(bridgeFilesDir(blockedId), { force: true }); }
    await client.close();
    const deadline = Date.now() + 3000;
    while ((await state()).linkedBridges?.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await state()).linkedBridges?.length, 0);
    assert.equal((await artifact("snapshot.txt")).status, 404);
  } finally {
    await client.close().catch(() => undefined);
    for (const [key, value] of [["TALLYLAMP_CGROUP_DIR", priorCgroup], ["TALLYLAMP_PROC_DIR", priorProc], ["TALLYLAMP_PROCESS_HEADROOM", priorHeadroom]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await worker.close();
    await new Promise<void>((resolve) => control.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
