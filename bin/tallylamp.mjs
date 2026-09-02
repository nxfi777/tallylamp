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

Env:
  TALLYLAMP_URL    default http://127.0.0.1:8080
  TALLYLAMP_TOKEN  admin secret or agent bearer
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
} else {
  usage();
  process.exit(1);
}
