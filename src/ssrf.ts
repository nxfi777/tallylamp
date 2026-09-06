import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { config } from "./config.js";

export type SsrfVerdict = { ok: true } | { ok: false; reason: string };

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.internal.",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    if (p[0] === 127) return true;
    if (p[0] === 10) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT / some cloud
    if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true;
    void n;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice("::ffff:".length));
    return false;
  }
  return true;
}

export function hostLooksPrivate(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h.endsWith(".metadata.google.internal")) return true;
  if (isIP(h) && isPrivateIp(h)) return true;
  return false;
}

export async function checkDestination(host: string, port: number): Promise<SsrfVerdict> {
  if (config.allowPrivateNetwork) return { ok: true };
  if (!host) return { ok: false, reason: "empty host" };
  if (port === 0) return { ok: false, reason: "invalid port" };
  if (hostLooksPrivate(host)) return { ok: false, reason: `blocked host ${host}` };
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length) return { ok: false, reason: "dns empty" };
    for (const r of records) {
      if (isPrivateIp(r.address)) return { ok: false, reason: `resolves to private address ${r.address}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `dns failed: ${(e as Error).message}` };
  }
}

export function parseAuthority(raw: string): { host: string; port: number } | null {
  let s = raw.trim();
  if (s.startsWith("http://")) s = s.slice(7);
  if (s.startsWith("https://")) s = s.slice(8);
  s = s.split("/")[0] ?? s;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0) return null;
    const host = s.slice(1, end);
    const rest = s.slice(end + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : 443;
    if (!Number.isFinite(port)) return null;
    return { host, port };
  }
  const idx = s.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
    return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
  }
  return { host: s, port: 443 };
}

/**
 * Resolve a host and return only addresses that pass the private-network policy, so a
 * caller can connect to a vetted address directly. Resolving once and pinning the result
 * closes the DNS-rebinding window between the check and the connection.
 */
export async function resolveVetted(host: string): Promise<{ ok: true; addresses: Array<{ address: string; family: number }> } | { ok: false; reason: string }> {
  if (!host) return { ok: false, reason: "empty host" };
  if (isIP(host)) {
    if (!config.allowPrivateNetwork && isPrivateIp(host)) return { ok: false, reason: `private address ${host}` };
    return { ok: true, addresses: [{ address: host, family: isIP(host) }] };
  }
  if (!config.allowPrivateNetwork && hostLooksPrivate(host)) return { ok: false, reason: `blocked host ${host}` };
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length) return { ok: false, reason: "dns empty" };
    if (!config.allowPrivateNetwork) {
      for (const r of records) {
        if (isPrivateIp(r.address)) return { ok: false, reason: `resolves to private address ${r.address}` };
      }
    }
    return { ok: true, addresses: records.map((r) => ({ address: r.address, family: r.family })) };
  } catch (e) {
    return { ok: false, reason: `dns failed: ${(e as Error).message}` };
  }
}

/**
 * A `lookup` shim for http/https requests that answers with one already-vetted address,
 * so the socket cannot connect anywhere the SSRF check did not approve.
 *
 * Node asks for `all: true` whenever happy-eyeballs is enabled — the default since Node 20
 * — and then reads the second callback argument as an array of records. Answering that
 * call with the scalar `(err, address, family)` form makes the connect fail with
 * "Invalid IP address: undefined" before a packet leaves the process, which surfaces as a
 * mysterious fetch failure rather than a DNS or network error. Both shapes are answered.
 */
export function pinnedLookup(address: string, family: number): LookupFunction {
  return ((_host: string, opts: unknown, cb: unknown) => {
    const answer = cb as (e: Error | null, a: unknown, f?: number) => void;
    if ((opts as { all?: boolean } | undefined)?.all) answer(null, [{ address, family }]);
    else answer(null, address, family);
  }) as unknown as LookupFunction;
}
