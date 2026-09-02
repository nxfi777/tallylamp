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
