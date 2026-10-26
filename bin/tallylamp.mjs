#!/usr/bin/env node
const base = process.env.TALLYLAMP_URL || "http://127.0.0.1:8080";
const token = process.env.TALLYLAMP_TOKEN || process.env.ADMIN_SECRET || "";
const [cmd, sub, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`tallylamp — control a Tallylamp deployment

Usage:
  tallylamp status
  tallylamp browser list
  tallylamp browser create [--name NAME] [--purpose TEXT]
  tallylamp agent create --name NAME
  tallylamp export FILE.tar.gz [--exclude SLUG] [--browser SLUG]
  tallylamp import FILE.tar.gz --data-dir NEW_DIRECTORY [--max-gb 64]
  tallylamp tunnel PORT [--host 127.0.0.1] [--browser SLUG] [--ttl 3600]
  tallylamp tunnel PORT --tunnel-id ID          (with TALLYLAMP_TUNNEL_TOKEN set)
  tallylamp gateway [--ports 80,443] [--allow-sleep]   (with TALLYLAMP_GATEWAY_TOKEN set)
  tallylamp gateway --check ADDRESS[:PORT]

Tunnel:
  Lets one Tallylamp browser reach one private address on THIS machine, over a socket this
  process dials outward. Nothing new listens here and no public hostname is created. The
  second form runs a binding somebody already created for you -- what tallylamp_open_tunnel
  prints -- and needs no API token of its own. Ctrl-C closes it.

Gateway:
  Lets the browsers assigned to this gateway reach the web from THIS computer's connection,
  so sites see this network instead of a datacenter. It dials out to Tallylamp; nothing
  listens here. Tallylamp vets every destination and sends only public IP addresses, and this
  end refuses this computer's own networks (LAN, loopback, VPN and Tailscale ranges) and every
  port outside --ports regardless. HTTPS stays encrypted end to end. It reconnects by itself,
  and on macOS keeps the computer from idling to sleep while it runs. --check says whether it
  would connect to an address, without connecting. Needs Node 22 or newer.

Env:
  TALLYLAMP_URL    default http://127.0.0.1:8080
  TALLYLAMP_TOKEN  admin secret or agent bearer
  TALLYLAMP_TUNNEL_TOKEN  a tunnel's connect token, for the second tunnel form
  TALLYLAMP_GATEWAY_TOKEN  a gateway's token, shown once when the gateway is added

Transfer:
  Export stops selected browsers and leaves them stopped; source data is retained.
  Repeat --exclude or --browser to select several. All saved profiles are included.
  Import restores offline into a new directory; it never overwrites existing data.
  Archives contain logins and credentials. Keep them private.
`);
}

async function req(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    console.error(body);
    process.exit(1);
  }
  return body;
}

function flag(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

const F_OPEN = 0x01, F_DATA = 0x02, F_CLOSE = 0x03, F_ACK = 0x04, F_ERROR = 0x05;
const MAX_CHUNK = 256 * 1024;

function encode(type, streamId, payload) {
  const body = payload ?? Buffer.alloc(0);
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId, 1);
  body.copy(out, 5);
  return out;
}

if (!cmd || cmd === "-h" || cmd === "--help") {
  usage();
  process.exit(0);
}

if (cmd === "export") {
  if (!sub || sub.startsWith("--")) throw new Error("usage: tallylamp export FILE.tar.gz [--exclude SLUG] [--browser SLUG]");
  const { createWriteStream } = await import("node:fs");
  const { link, lstat, rm } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  try { await lstat(sub); throw new Error("export file already exists; choose a new filename"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = { "--exclude": "exclude", "--browser": "browsers" }[rest[i]];
    if (!key || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`invalid export option: ${rest[i]}`);
    (options[key] ??= []).push(rest[i + 1]);
  }
  if (!token) throw new Error("set ADMIN_SECRET or TALLYLAMP_TOKEN to the instance admin secret");
  const login = await fetch(`${base}/api/v1/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: token }), signal: AbortSignal.timeout(30_000),
  });
  if (!login.ok) throw new Error(`admin login failed (${login.status}); export requires the instance admin secret`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("admin login did not return a session");
  const temporary = `${sub}.partial-${randomBytes(6).toString("hex")}`;
  try {
    console.error("Exporting selected browsers, saved profiles and downloads. Selected browsers will remain stopped.");
    const response = await fetch(`${base}/api/v1/export`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(options), signal: AbortSignal.timeout(60 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`export failed (${response.status}): ${await response.text()}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    // Atomic publish without overwriting an existing archive.
    await link(temporary, sub);
    console.log(`Export saved to ${sub}`);
  } finally {
    await rm(temporary, { force: true });
    await fetch(`${base}/api/v1/logout`, { method: "POST", headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
} else if (cmd === "import") {
  if (!sub || sub.startsWith("--")) throw new Error("usage: tallylamp import FILE.tar.gz --data-dir NEW_DIRECTORY");
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--data-dir", "--max-gb"].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`invalid import option: ${rest[i]}`);
  }
  const destination = flag(rest, "--data-dir");
  if (!destination) throw new Error("import requires --data-dir pointing to a new directory");
  const { importInstance } = await import("../dist/transfer.js").catch(() => { throw new Error("run npm run build before importing"); });
  const manifest = await importInstance(sub, destination, Number(flag(rest, "--max-gb", "64")) * 1024 ** 3);
  console.log(`Restored ${manifest.browsers.length} browsers and ${manifest.profiles.length} saved profiles to ${destination}.`);
  console.log("Set TALLYLAMP_DATA_DIR to this directory before starting Tallylamp. Reconnect OAuth clients and linked browsers; some sites may need sign-in again.");
} else if (cmd === "status") {
  console.log(JSON.stringify(await req("/api/v1/status"), null, 2));
} else if (cmd === "browser" && sub === "list") {
  console.log(JSON.stringify(await req("/api/v1/browsers"), null, 2));
} else if (cmd === "browser" && sub === "create") {
  const nameIdx = rest.indexOf("--name");
  const purposeIdx = rest.indexOf("--purpose");
  const name = nameIdx >= 0 ? rest[nameIdx + 1] : undefined;
  const purpose = purposeIdx >= 0 ? rest[purposeIdx + 1] : undefined;
  const body = await req("/api/v1/browsers", {
    method: "POST",
    body: JSON.stringify({ name, persistent: true, metadata: purpose ? { purpose } : {} }),
  });
  console.log(JSON.stringify(body, null, 2));
} else if (cmd === "agent" && sub === "create") {
  const nameIdx = rest.indexOf("--name");
  const name = nameIdx >= 0 ? rest[nameIdx + 1] : "Agent";
  const body = await req("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  console.log(JSON.stringify(body, null, 2));
} else if (cmd === "tunnel") {
  await runTunnel([sub, ...rest]);
} else if (cmd === "gateway") {
  await runGateway([sub, ...rest].filter((a) => a !== undefined));
} else {
  usage();
  process.exit(1);
}

async function runTunnel(argv) {
  const net = await import("node:net");
  const port = Number(argv[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("usage: tallylamp tunnel PORT [--host HOST] [--browser SLUG] [--ttl SECONDS]");
    process.exit(1);
  }
  const host = flag(argv, "--host", "127.0.0.1");
  let tunnelId = flag(argv, "--tunnel-id", null);
  // argv is world-readable via ps, so the env form is the documented one; the flag stays for
  // interactive use.
  let tunnelToken = process.env.TALLYLAMP_TUNNEL_TOKEN || flag(argv, "--tunnel-token", null);
  let created = false;

  if (!tunnelId || !tunnelToken) {
    const browserRef = flag(argv, "--browser", null);
    const ttl = Number(flag(argv, "--ttl", "3600"));
    const { browsers } = await req("/api/v1/browsers");
    const list = browsers ?? [];
    const target = browserRef
      ? list.find((b) => b.slug === browserRef || b.id === browserRef || b.name === browserRef)
      : list.length === 1
        ? list[0]
        : null;
    if (!target) {
      console.error(
        browserRef
          ? `no browser matching ${browserRef}`
          : `pass --browser SLUG (${list.length} browsers are visible to this token)`,
      );
      process.exit(1);
    }
    const made = await req(`/api/v1/browsers/${target.id}/tunnels`, {
      method: "POST",
      body: JSON.stringify({ host, port, ttlSec: ttl }),
    });
    tunnelId = made.tunnel.id;
    tunnelToken = made.token;
    created = true;
    console.error(`tunnel ${tunnelId}: ${host}:${port} -> browser ${target.slug ?? target.id}, expires ${made.tunnel.expiresAt}`);
  }

  const wsUrl = `${base.replace(/^http/, "ws")}/api/v1/tunnels/${tunnelId}/connect?token=${encodeURIComponent(tunnelToken)}`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  const streams = new Map();

  const send = (type, id, payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(type, id, payload));
  };

  ws.onopen = () => console.error(`connected. ${host}:${port} is now reachable from that browser. Ctrl-C to close.`);
  let closingCleanly = false;
  ws.onerror = (e) => console.error("tunnel socket error", e?.message ?? e);
  ws.onclose = (e) => {
    for (const s of streams.values()) s.destroy();
    console.error(`tunnel closed${e?.reason ? `: ${e.reason}` : ""}`);
    // A tunnel that was revoked, expired or refused did not do its job, and a caller that
    // scripted this needs to be able to tell that from a clean Ctrl-C.
    process.exit(closingCleanly ? 0 : 1);
  };

  ws.onmessage = (ev) => {
    const buf = Buffer.from(ev.data);
    if (buf.length < 5) return;
    const type = buf.readUInt8(0);
    const streamId = buf.readUInt32BE(1);
    const payload = buf.subarray(5);

    if (type === F_OPEN) {
      const asked = payload.toString("utf8");
      const mine = `${String(host).toLowerCase().replace(/^\[|\]$/g, "")}:${port}`;
      // This process forwards to exactly the address it was started for and nothing else.
      // The server should never ask for another, and if it ever does -- misconfigured,
      // compromised, whatever -- this must not become a general proxy onto this machine.
      if (asked !== mine) {
        send(F_ERROR, streamId, Buffer.from(`this client only forwards ${mine}`, "utf8"));
        return;
      }
      const sock = net.createConnection({ host, port });
      streams.set(streamId, sock);
      sock.once("connect", () => send(F_ACK, streamId));
      sock.on("data", (chunk) => {
        for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
          send(F_DATA, streamId, chunk.subarray(i, i + MAX_CHUNK));
        }
      });
      sock.on("error", (err) => {
        send(F_ERROR, streamId, Buffer.from(err.message, "utf8"));
        streams.delete(streamId);
      });
      sock.on("close", () => {
        if (streams.delete(streamId)) send(F_CLOSE, streamId);
      });
      return;
    }
    const sock = streams.get(streamId);
    if (!sock) return;
    if (type === F_DATA) sock.write(payload);
    else if (type === F_CLOSE) {
      streams.delete(streamId);
      sock.end();
    }
  };

  const shutdown = async () => {
    closingCleanly = true;
    // Revoke first, then close: closing first lets onclose call process.exit out from under
    // the DELETE, which leaves the binding alive on the server after the client has gone.
    if (created) {
      await fetch(`${base}/api/v1/tunnels/${tunnelId}`, {
        method: "DELETE",
        headers: { Authorization: token ? `Bearer ${token}` : "" },
      }).catch(() => {});
    }
    try {
      ws.close(1000, "client exit");
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Addresses a gateway never connects to, whatever Tallylamp asks: this computer, its networks,
 * and every range that is not the public internet. Tallylamp already refuses private
 * destinations before asking; this is the same rule held on the side whose network it protects.
 */
function gatewayBlockList(net, os) {
  const list = new net.BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ]) list.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of [
    // NAT64 and 6to4 addresses can carry a private IPv4 address inside them. IPv4-mapped ones
    // (::ffff:a.b.c.d) need no rule: BlockList checks them against the IPv4 rules above, and a
    // ::ffff:0:0/96 rule would match every IPv4 address, public ones included.
    ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
    ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ]) list.addSubnet(address, prefix, "ipv6");
  // This computer's own networks by their actual numbers, so a LAN or VPN on public address
  // space is refused too.
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const i of entries ?? []) {
      if (!i.cidr) continue;
      const [address, prefix] = i.cidr.split("/");
      try {
        list.addSubnet(address, Number(prefix), i.family === "IPv6" || i.family === 6 ? "ipv6" : "ipv4");
      } catch {
        /* an interface Node reports oddly; the fixed ranges above still apply */
      }
    }
  }
  return list;
}

async function runGateway(argv) {
  const net = await import("node:net");
  const os = await import("node:os");
  const GATEWAY_PROTOCOL = "tallylamp-gateway.v1";
  const MAX_STREAMS = 512;
  const HIGH_WATER = 8 * 1024 * 1024;
  const LOW_WATER = 1024 * 1024;
  const SILENCE_MS = 65_000;

  const portsArg = flag(argv, "--ports", "80,443");
  const ports = new Set(String(portsArg).split(",").map((p) => Number(p.trim())));
  if (![...ports].every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
    console.error(`--ports takes a comma-separated list of port numbers, not ${portsArg}`);
    process.exit(1);
  }

  let blocked = gatewayBlockList(net, os);
  let blockedAt = Date.now();
  /** Null when allowed, otherwise why not. Interfaces change when a laptop moves networks. */
  const refusal = (address, port) => {
    if (!net.isIP(address)) return `${address} is not an IP address; Tallylamp sends only addresses it has vetted`;
    if (!ports.has(port)) return `port ${port} is not allowed here (allowed: ${[...ports].join(", ")})`;
    if (Date.now() - blockedAt > 30_000) {
      blocked = gatewayBlockList(net, os);
      blockedAt = Date.now();
    }
    if (blocked.check(address, net.isIPv6(address) ? "ipv6" : "ipv4")) {
      return `${address} is on this computer or a private network, which a gateway never connects to`;
    }
    return null;
  };

  const check = flag(argv, "--check", null);
  if (argv.includes("--check")) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(check ?? "") ?? /^([^:]+)(?::(\d+))?$/.exec(check ?? "") ?? [null, check, null];
    const address = m[1] ?? "";
    const port = m[2] ? Number(m[2]) : 443;
    const why = refusal(address, port);
    console.log(why ? `refused: ${why}` : `allowed: this gateway would connect to ${address}:${port}`);
    process.exit(why ? 2 : 0);
  }

  const gatewayToken = process.env.TALLYLAMP_GATEWAY_TOKEN || "";
  if (!gatewayToken) {
    console.error("set TALLYLAMP_GATEWAY_TOKEN to the token shown when the gateway was added in the dashboard");
    process.exit(1);
  }
  if (typeof WebSocket !== "function") {
    console.error(`this needs Node 22 or newer for its built-in WebSocket; this is ${process.version}`);
    process.exit(1);
  }

  // Idle sleep would take every browser on this gateway offline. Lid-close sleep still happens.
  if (process.platform === "darwin" && !argv.includes("--allow-sleep")) {
    try {
      const { spawn } = await import("node:child_process");
      spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
      console.error("keeping this Mac from idling to sleep while the gateway runs (--allow-sleep turns that off)");
    } catch {
      /* no caffeinate: the gateway still works while the Mac is awake */
    }
  }

  const final = {
    4401: "Tallylamp rejected this gateway's token. Remove the gateway in the dashboard, add it again and run the new command.",
    4403: "This gateway was removed in the Tallylamp dashboard.",
    4409: "Another computer connected with this gateway's token, so this one stopped. Run one copy per gateway.",
  };
  const url = `${base.replace(/^http/, "ws")}/api/v1/gateways/connect`;
  let attempt = 0;
  let stopping = false;
  let current = null;

  const connect = () => {
    const ws = new WebSocket(url, [GATEWAY_PROTOCOL, `tallylamp.token.${gatewayToken}`]);
    current = ws;
    ws.binaryType = "arraybuffer";
    const streams = new Map();
    const paused = new Set();
    let openedAt = 0;
    let lastHeard = Date.now();
    let drain = null;

    const send = (type, id, payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode(type, id, payload));
    };
    // One socket carries every stream, and a home upload is slower than a download into it.
    // Reading less from the sites is the only brake there is, so stop reading while it backs up.
    const relieve = () => {
      if (ws.bufferedAmount > LOW_WATER) return;
      for (const sock of paused) sock.resume();
      paused.clear();
      clearInterval(drain);
      drain = null;
    };
    const watchdog = setInterval(() => {
      // The server's heartbeat stopped arriving: the socket is dead even if it looks open.
      if (Date.now() - lastHeard > SILENCE_MS) ws.close(4000, "heartbeat lost");
    }, 10_000);

    ws.onopen = () => {
      openedAt = Date.now();
      console.error(`connected to ${base}. Browsers assigned to this gateway now reach the web from this computer. Ctrl-C to stop.`);
      ws.send(JSON.stringify({ type: "hello", hostname: os.hostname(), platform: process.platform, version: `node ${process.version}`, ports: [...ports] }));
    };
    ws.onerror = () => {
      /* onclose follows with the code */
    };
    ws.onclose = (e) => {
      clearInterval(watchdog);
      clearInterval(drain);
      for (const sock of streams.values()) sock.destroy();
      streams.clear();
      if (stopping) process.exit(0);
      if (final[e.code]) {
        console.error(final[e.code]);
        process.exit(1);
      }
      // A connection that held for a minute was a real one; start the backoff over.
      if (openedAt && Date.now() - openedAt > 60_000) attempt = 0;
      const delay = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      attempt = Math.min(attempt + 1, 6);
      console.error(`${openedAt ? "disconnected" : "could not connect"}${e.reason ? ` (${e.reason})` : ""}. Trying again in ${Math.ceil(delay / 1000)}s.`);
      setTimeout(connect, delay);
    };

    ws.onmessage = (ev) => {
      lastHeard = Date.now();
      if (typeof ev.data === "string") return; // heartbeat
      const buf = Buffer.from(ev.data);
      if (buf.length < 5) return;
      const type = buf.readUInt8(0);
      const streamId = buf.readUInt32BE(1);
      const payload = buf.subarray(5);

      if (type === F_OPEN) {
        const m = /^(.+):(\d{1,5})$/.exec(payload.toString("utf8"));
        const address = m ? m[1].replace(/^\[|\]$/g, "") : "";
        const port = m ? Number(m[2]) : 0;
        const why = m ? refusal(address, port) : "not an address:port";
        if (why) {
          send(F_ERROR, streamId, Buffer.from(why, "utf8"));
          return;
        }
        if (streams.size >= MAX_STREAMS) {
          send(F_ERROR, streamId, Buffer.from(`this gateway is at its limit of ${MAX_STREAMS} connections`, "utf8"));
          return;
        }
        const sock = net.createConnection({ host: address, port, noDelay: true, keepAlive: true });
        streams.set(streamId, sock);
        sock.once("connect", () => send(F_ACK, streamId));
        sock.on("data", (chunk) => {
          for (let i = 0; i < chunk.length; i += MAX_CHUNK) send(F_DATA, streamId, chunk.subarray(i, i + MAX_CHUNK));
          if (ws.bufferedAmount > HIGH_WATER) {
            sock.pause();
            paused.add(sock);
            drain ??= setInterval(relieve, 25);
          }
        });
        sock.on("error", (err) => {
          if (streams.delete(streamId)) send(F_ERROR, streamId, Buffer.from(err.message.slice(0, 200), "utf8"));
          paused.delete(sock);
        });
        sock.on("close", () => {
          paused.delete(sock);
          if (streams.delete(streamId)) send(F_CLOSE, streamId);
        });
        return;
      }
      const sock = streams.get(streamId);
      if (!sock) return;
      if (type === F_DATA) sock.write(payload);
      else if (type === F_CLOSE) {
        streams.delete(streamId);
        sock.end();
      }
    };
  };

  const shutdown = () => {
    stopping = true;
    try {
      current?.close(1000, "client exit");
    } catch {}
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  connect();
}
