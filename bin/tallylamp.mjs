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
  tallylamp tunnel PORT [--host 127.0.0.1] [--browser SLUG] [--ttl 3600]
  tallylamp tunnel PORT --tunnel-id ID          (with TALLYLAMP_TUNNEL_TOKEN set)

Tunnel:
  Lets one Tallylamp browser reach one private address on THIS machine, over a socket this
  process dials outward. Nothing new listens here and no public hostname is created. The
  second form runs a binding somebody already created for you -- what tallylamp_open_tunnel
  prints -- and needs no API token of its own. Ctrl-C closes it.

Env:
  TALLYLAMP_URL    default http://127.0.0.1:8080
  TALLYLAMP_TOKEN  admin secret or agent bearer
  TALLYLAMP_TUNNEL_TOKEN  a tunnel's connect token, for the second tunnel form
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

if (cmd === "status") {
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
