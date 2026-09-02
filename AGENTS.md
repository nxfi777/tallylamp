# Tallylamp — agent notes

- Runtime is **process-based headed Chrome**, not Docker-in-Docker.
- MCP lives at `/mcp`. Lifecycle tools are `tallylamp_*`; everything else is
  chrome-devtools-mcp 1.8.0 forwarded against `--browser-url`.
- Metadata is descriptive. Provenance columns are the authenticated principal.
- Human takeover is a lease in `control_leases`. Mutating MCP tools must fail
  with a retryable tool error while the lease is live.
- CDP and the viewer backend bind loopback. Do not publish 9222.
- `TALLYLAMP_FAKE_CHROME=1` is for tests. Do not ship it.
- Refresh `docs/research.md` if you bump Chrome, chrome-devtools-mcp, or the
  MCP SDK; run `npm test` and the realism job.
