import { Err } from "./errors.js";

/** Internal only. Credentials are write-only through the API, not through SQLite. */
export type BrowserProxy = { server: string; username?: string; password?: string };

export function parseBrowserProxy(input: unknown): BrowserProxy | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw Err.invalid("proxy must be an object or null");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["server", "username", "password"].includes(key))) {
    throw Err.invalid("proxy accepts only server, username and password");
  }
  if (typeof value.server !== "string" || value.server.length > 2048) throw Err.invalid("proxy.server is required");
  const server = value.server.trim();
  let url: URL;
  try { url = new URL(server); } catch { throw Err.invalid("proxy.server must be an HTTP or HTTPS proxy URL"); }
  // Never echo the input: an incorrectly pasted URL may itself contain a password.
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(server) || !["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || server.includes("@") || url.pathname !== "/" || url.search || url.hash || url.port === "0") {
    throw Err.invalid("proxy.server must be http://host:port or https://host:port, without credentials, path, query or fragment");
  }
  const proxy: BrowserProxy = { server: url.origin };
  for (const key of ["username", "password"] as const) {
    const credential = value[key];
    if (credential === undefined) continue;
    if (typeof credential !== "string" || credential.length > 1024 || /[\x00-\x1f\x7f]/.test(credential)) {
      throw Err.invalid(`proxy.${key} must be a string of at most 1024 characters without control characters`);
    }
    proxy[key] = credential;
  }
  if (proxy.username?.includes(":")) throw Err.invalid("proxy.username cannot contain a colon");
  if ((proxy.username === undefined) !== (proxy.password === undefined) || proxy.username === "") {
    throw Err.invalid("provide both proxy.username and proxy.password, or omit both for no authentication");
  }
  return proxy;
}

export function proxyView(proxy: BrowserProxy | null) {
  return proxy ? { server: proxy.server, hasAuthentication: proxy.username !== undefined } : null;
}
