import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable, type Writable } from "node:stream";

type PackOptions = { root: string; sources: Array<{ source: string; target: string }> };
type UnpackOptions = { file: string; cwd: string; roots: string[]; files?: string[]; maxBytes: number };

// node-tar's Pack does not cancel pending filesystem jobs when destroyed. Isolate packing
// so a cancelled download can close every file before its staging directory is removed.
// Non-retaining caches and one bounded child keep large profiles independent of heap size.
const PACK_SCRIPT = `
import * as tar from "tar";
import { pipeline } from "node:stream/promises";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8 * 1024 * 1024) throw new Error("archive selection is too large");
}
const { root, sources } = JSON.parse(input);
const noCache = () => {
  const cache = new Map();
  cache.get = () => undefined;
  cache.set = () => cache;
  return cache;
};
const archiveName = name => {
  const binding = sources.find(s => name === s.source || name.startsWith(s.source + "/"));
  if (!binding) throw new Error("archive entry is outside the selected data");
  return binding.target + name.slice(binding.source.length);
};
const locks = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]);
try {
  await pipeline(tar.c({ cwd: root, gzip: { level: 1 }, strict: true, portable: true,
    statCache: noCache(), linkCache: noCache(),
    onWriteEntry: entry => { entry.path = archiveName(entry.path); },
    filter: name => {
      const parts = archiveName(name).split("/");
      return !(parts.length === 3 && ["profiles", "seeds"].includes(parts[0]) && locks.has(parts[2]));
    }
  }, sources.map(s => s.source)), process.stdout);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
`;

const UNPACK_SCRIPT = `
import * as tar from "tar";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) throw new Error("archive selection is too large");
}
const { file, cwd, roots, files = [], maxBytes } = JSON.parse(input);
const inspect = () => {
  let bytes = 0, count = 0, pathBytes = 0;
  const seen = new Set();
  return {
    filter: (name, entry) => {
      const clean = name.endsWith("/") ? name.slice(0, -1) : name;
      const key = process.platform === "darwin" ? clean.normalize("NFC").toLowerCase() : clean;
      const allowed = files.includes(clean) || roots.some(root => clean === root || clean.startsWith(root + "/"));
      if (!allowed || name.includes("\\\\") || name.includes("\\0") || name.startsWith("/") ||
          clean.split("/").some(part => !part || part === "." || part === "..") ||
          !["File", "Directory"].includes(entry.type) || seen.has(key) ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || (bytes += entry.size) > maxBytes ||
          ++count > 2_000_000 || (pathBytes += Buffer.byteLength(clean)) > 32 * 1024 ** 2) {
        console.error("archive contains unsafe, duplicate or oversized entries");
        process.exit(1);
      }
      seen.add(key);
      return true;
    },
    clear: () => seen.clear()
  };
};
try {
  const scan = inspect();
  await tar.t({ file, strict: true, filter: scan.filter });
  scan.clear();
  const extraction = inspect();
  await tar.x({ file, cwd, strict: true, filter: extraction.filter, chmod: false, noMtime: true });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
`;

function startJob(script: string, options: unknown) {
  const child = spawn(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.stdin.on("error", () => undefined);
  const completion = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`archive processing failed: ${stderr.trim() || `exit ${code}`}`)));
  });
  // Attach immediately: a spawn failure can precede the pipeline's rejection.
  void completion.catch(() => undefined);
  child.stdin.end(JSON.stringify(options));
  return { child, completion };
}

export async function packArchive(options: PackOptions, output: Writable, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (output.destroyed) throw new Error("archive download disconnected");
  const { child, completion } = startJob(PACK_SCRIPT, options);
  const terminate = () => { child.kill("SIGKILL"); };
  const disconnected = () => { if (!output.writableFinished) terminate(); };
  signal?.addEventListener("abort", terminate, { once: true });
  output.once("close", disconnected);
  async function* checked() {
    for await (const chunk of child.stdout) yield chunk;
    // Do not finish the HTTP response until the compressor confirms success.
    await completion;
  }
  try {
    await pipeline(Readable.from(checked()), output, { signal });
    await completion;
  } catch (e) {
    child.kill("SIGKILL");
    await completion.catch(() => undefined);
    throw e;
  } finally { signal?.removeEventListener("abort", terminate); output.off("close", disconnected); }
}

/** Kill and await the unpacker on cancellation before callers remove its partial files. */
export async function unpackArchive(options: UnpackOptions, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const { child, completion } = startJob(UNPACK_SCRIPT, options);
  const terminate = () => { child.kill("SIGKILL"); };
  signal?.addEventListener("abort", terminate, { once: true });
  child.stdout.resume();
  try { await completion; signal?.throwIfAborted(); }
  finally { signal?.removeEventListener("abort", terminate); }
}
