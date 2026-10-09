import { randomBytes } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const bridgeFilesDir = (id: string) => path.join(realpathSync(os.tmpdir()), "tallylamp-linked-bridges", id);

async function canonical(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(file) === file) throw e;
    return path.join(await canonical(path.dirname(file)), path.basename(file));
  }
}

/** The bridge negotiates no filesystem roots, so its only allowed root is the temp directory. */
async function outputPath(asked: string): Promise<string> {
  const resolved = await canonical(path.resolve(asked.startsWith("file:") ? fileURLToPath(asked) : asked));
  if (!resolved.startsWith(realpathSync(os.tmpdir()) + path.sep)) throw new Error(`Access denied: output path ${asked} is outside the temporary directory.`);
  return resolved;
}

export type BridgeFile = { token: string; remote: string; local: string };

/** Rewrite explicit output paths; screenshots without a path still travel inline over MCP. */
export async function prepareBridgeFiles(directory: string, name: string, args: Record<string, unknown>): Promise<{ args: Record<string, unknown>; files: BridgeFile[] }> {
  const fields = name === "get_network_request" ? ["requestFilePath", "responseFilePath"]
    : ["take_snapshot", "take_screenshot", "take_heapsnapshot", "evaluate_script", "performance_start_trace", "performance_stop_trace"].includes(name) ? ["filePath"] : [];
  const out = { ...args };
  const files: BridgeFile[] = [];
  for (const field of fields) {
    if (typeof args[field] !== "string") continue;
    const local = await outputPath(args[field] as string);
    const token = randomBytes(16).toString("hex");
    const remote = path.posix.join(directory, token + path.extname(local));
    out[field] = remote;
    files.push({ token, remote, local });
  }
  if (name === "lighthouse_audit" && typeof args.outputDirPath === "string") {
    const local = await outputPath(args.outputDirPath);
    const token = randomBytes(16).toString("hex");
    const remote = path.posix.join(directory, token);
    out.outputDirPath = remote;
    for (const extension of [".html", ".json"]) {
      files.push({ token, remote: path.posix.join(remote, "report" + extension), local: path.join(local, "report" + extension) });
    }
  }
  return { args: out, files };
}

/** Includes automatic artifacts, such as screenshots too large to return inline. */
export function bridgeResultFiles(directory: string, result: unknown, files: BridgeFile[]): BridgeFile[] {
  const found = new Map<string, BridgeFile>();
  const prefix = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${prefix}/[a-zA-Z0-9_./-]+`, "g");
  const stem = (file: string) => file.slice(0, file.length - path.posix.extname(file).length);
  const inspect = (value: unknown) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(pattern)) {
        const remote = match[0].replace(/[.]+$/, "");
        if (!path.posix.extname(remote) || found.has(remote)) continue;
        // An explicit output may have its extension corrected by the bridge. Automatic
        // artifacts are keyed by their full path: report.html and report.json are distinct.
        const explicit = files.find((file) => file.remote === remote) ?? files.find((file) => stem(file.remote) === stem(remote));
        found.set(remote, explicit ? { ...explicit, remote } : {
          token: randomBytes(16).toString("hex"), remote,
          local: path.join(realpathSync(os.tmpdir()), `tallylamp-${randomBytes(12).toString("hex")}${path.posix.extname(remote)}`),
        });
      }
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === "object") Object.values(value).forEach(inspect);
  };
  inspect(result);
  return [...found.values()];
}

/** Stream a worker artifact to main before returning its path. Never buffer a trace in RAM. */
export async function receiveBridgeFile(response: Response, file: BridgeFile): Promise<[string, string]> {
  const extension = response.headers.get("x-tallylamp-extension") ?? "";
  if (!/^\.[a-z0-9-]+$/i.test(extension) || !response.body) throw new Error("Worker returned an invalid artifact");
  const remote = file.remote.slice(0, file.remote.length - path.extname(file.remote).length) + extension;
  const local = await outputPath(file.local.slice(0, file.local.length - path.extname(file.local).length) + extension);
  await mkdir(path.dirname(local), { recursive: true });
  await outputPath(local);
  const temporary = `${local}.${randomBytes(8).toString("hex")}.partial`;
  let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body as never), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 512 * 1024 * 1024 ? new Error("Worker artifact exceeds 512 MiB") : null, chunk);
      },
    }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await rename(temporary, local);
  } finally {
    await rm(temporary, { force: true });
  }
  return [remote, local];
}

export function replaceBridgePaths<T>(result: T, replacements: Array<[string, string]>): T {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return replacements.reduce((s, [remote, local]) => s.split(remote).join(local), value);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    return value;
  };
  return replace(result) as T;
}
