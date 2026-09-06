const SECRET_KEYS = /secret|token|password|authorization|cookie|credential|api[_-]?key/i;

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 24 && /^[A-Za-z0-9_\-+/=.]+$/.test(value)) return "[redacted]";
    return value;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Array.isArray(value) ? [] as unknown as Record<string, unknown> : {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

function line(level: string, msg: string, extra?: unknown): void {
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (extra !== undefined) rec.extra = redact(extra);
  const text = JSON.stringify(rec);
  if (level === "error") process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

export const log = {
  info: (msg: string, extra?: unknown) => line("info", msg, extra),
  warn: (msg: string, extra?: unknown) => line("warn", msg, extra),
  error: (msg: string, extra?: unknown) => line("error", msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (process.env.DEBUG) line("debug", msg, extra);
  },
};
