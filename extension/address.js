// Pure, so it can be tested under plain Node.

/** People type "tallylamp.example.com", "https://…/", "localhost:8080". All of them are fine. */
export function normalizeServer(raw) {
  const typed = String(raw ?? "").trim();
  if (!typed) return { ok: false, error: "Enter the address of your Tallylamp server." };
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(typed.replace(/^https?:\/\//i, ""));
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(typed) ? typed : `${loopback ? "http" : "https"}://${typed}`);
  } catch {
    return { ok: false, error: "That doesn't look like a web address. It should look like tallylamp.example.com." };
  }
  if (url.protocol === "http:" && !loopback) {
    return { ok: false, error: "Use an https:// address. Plain http is only allowed for a server on this computer." };
  }
  return { ok: true, server: url.origin };
}
