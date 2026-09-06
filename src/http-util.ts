import type { Response } from "express";
import { config } from "./config.js";

export function cookieSerialize(
  name: string,
  value: string,
  opts: { httpOnly?: boolean; sameSite?: "lax" | "strict" | "none"; path?: string; maxAge?: number; secure?: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite[0]!.toUpperCase()}${opts.sameSite.slice(1)}`);
  return parts.join("; ");
}

/** Read one cookie value out of a raw Cookie header. Shared by the API and the OAuth consent flow. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return decodeURIComponent(trimmed.slice(name.length + 1));
  }
  return null;
}

/** RFC 9728 challenge: tells an MCP client where to find this resource's metadata. */
export function wwwAuthenticate(error?: string): string {
  const parts = [
    'Bearer realm="mcp"',
    `resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`,
    'scope="mcp:tools"',
  ];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

const SSE_KEEPALIVE_MS = 30_000;

/** Keeps an SSE response alive through proxies. No MCP dependency; lives here so the API
 * routes do not import the MCP SDK just for a timer. */
export function startSseKeepalive(res: Response, everyMs = SSE_KEEPALIVE_MS): () => void {
  const timer = setInterval(() => {
    if (!res.headersSent || res.writableEnded || !res.writable) return;
    const ct = res.getHeader("content-type");
    if (ct !== undefined && !String(ct).includes("text/event-stream")) return;
    try {
      res.write(": keepalive\n\n");
    } catch {
      /* ignore */
    }
  }, everyMs);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
  return () => clearInterval(timer);
}
