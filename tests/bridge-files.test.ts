import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bridgeResultFiles, prepareBridgeFiles, receiveBridgeFile, replaceBridgePaths } from "../src/bridge-files.js";

it("copies a worker output back to the requested main path, including changed extensions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-files-test-"));
  try {
    const prepared = await prepareBridgeFiles("/worker/session", "take_snapshot", { filePath: path.join(dir, "snapshot.other") });
    const remote = String(prepared.args.filePath).replace(/\.other$/, ".txt");
    const result = { content: [{ type: "text", text: `Saved snapshot to ${remote}.` }], structuredContent: { file: remote } };
    const files = bridgeResultFiles("/worker/session", result, prepared.files);
    assert.equal(files.length, 1);
    const mapping = await receiveBridgeFile(new Response("snapshot contents", { headers: { "X-Tallylamp-Extension": ".txt" } }), files[0]!);
    const copied = replaceBridgePaths(result, [mapping]);
    assert.equal(await readFile(mapping[1], "utf8"), "snapshot contents");
    assert.equal(mapping[1], path.join(await realpath(dir), "snapshot.txt"));
    assert.equal(copied.structuredContent.file, mapping[1]);
    assert.ok(!JSON.stringify(copied).includes("/worker/session"));
    assert.deepEqual(await readdir(dir), ["snapshot.txt"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("discovers automatic large screenshots and ignores paths outside the session", () => {
  const result = { content: [{ type: "text", text: "Saved screenshot to /worker/session/chrome-devtools-mcp-ABC/screenshot.png. Other: /worker/another/file.png" }] };
  const files = bridgeResultFiles("/worker/session", result, []);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.remote, "/worker/session/chrome-devtools-mcp-ABC/screenshot.png");
  assert.ok(files[0]!.local.endsWith(".png"));
});

it("keeps both Lighthouse reports and maps an explicitly requested report directory", async () => {
  const local = path.join(os.tmpdir(), "linked-lighthouse-test");
  const prepared = await prepareBridgeFiles("/worker/session", "lighthouse_audit", { outputDirPath: local });
  const directory = String(prepared.args.outputDirPath);
  const result = { content: [{ type: "text", text: `${directory}/report.html\n${directory}/report.json` }] };
  const files = bridgeResultFiles("/worker/session", result, prepared.files);
  assert.equal(files.length, 2);
  assert.equal(path.basename(files[0]!.local), "report.html");
  assert.equal(path.basename(files[1]!.local), "report.json");
  assert.equal(bridgeResultFiles("/worker/session", result, []).length, 2, "automatic same-stem reports must both be copied");
});

it("stages evaluate_script JSON output", async () => {
  const local = path.join(os.tmpdir(), "linked-script-test.json");
  const prepared = await prepareBridgeFiles("/worker/session", "evaluate_script", { function: "() => 42", filePath: local });
  assert.equal(prepared.files.length, 1);
  assert.match(String(prepared.args.filePath), /^\/worker\/session\//);
  assert.equal(prepared.args.function, "() => 42");
});

it("keeps the bridge's temp-only policy and rejects symlink escapes before executing a tool", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-files-test-"));
  try {
    await assert.rejects(prepareBridgeFiles("/worker/session", "take_screenshot", { filePath: "/etc/not-allowed.png" }), /Access denied/);
    await symlink(process.cwd(), path.join(dir, "escape"));
    await assert.rejects(prepareBridgeFiles("/worker/session", "take_snapshot", { filePath: path.join(dir, "escape", "not-allowed.txt") }), /Access denied/);
    assert.deepEqual(await prepareBridgeFiles("/worker/session", "take_screenshot", {}), { args: {}, files: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("removes partial artifacts on a broken download", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-files-test-"));
  try {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); controller.error(new Error("download interrupted")); } });
    await assert.rejects(receiveBridgeFile(new Response(stream, { headers: { "X-Tallylamp-Extension": ".txt" } }), { token: "x", remote: "/worker/session/x.txt", local: path.join(dir, "output.txt") }), /download interrupted/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
