# Tallylamp 0.5.0

Route each browser through an HTTP or HTTPS proxy, with optional Basic-auth
credentials. Set it in the dashboard, through the control API, or with the
browser create/update MCP tools. Existing browsers keep their direct route
unless you configure a proxy.

## What changes

- Proxy settings survive browser and service restarts. Changes require a stopped
  browser and its owner or an administrator; borrowers cannot change the route.
- The local safety proxy still checks destinations. Browser-specific tunnels
  take precedence, and a failed upstream connection never falls back to direct access.
- HTTP, HTTPS, and WebSocket traffic can use the upstream. DNS stays local.
  The provider must support HTTP/1.x CONNECT to IP addresses, including port 80
  for plain HTTP. SOCKS and PAC are not supported.
- Proxied browsers start with QUIC and WebRTC's non-proxied UDP disabled. This
  does not provide an OS-level network sandbox.
- Profile-template copies do not include proxy settings or proxy credentials.

## Before upgrading

Back up `/data` and finish active browser work. A redeploy stops Chrome, while
the data volume keeps persistent profiles. Schema 7 adds the nullable
`browsers.proxy_json` column; old browsers have no upstream proxy by default.

Proxy credentials are hidden from responses, audit details, and Chrome arguments,
but stored **unencrypted in SQLite**. Protect volume access and backups. Prefer an
HTTPS proxy, since Basic authentication to an HTTP proxy is unencrypted in transit.

Do not roll a proxied browser back to older code and expect the route to remain
enforced. Versions before 0.5.0 ignore proxy settings and can send traffic directly.
Restore a compatible backup and review routing before a rollback.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35035507641)
passed 228 application tests, 8 headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.5.0` for Linux amd64. Anonymous
registry access and version/source-revision labels were verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:2708748f0c4db245b78a4ed586e72ebf5acd87dab09981c13eeb0030a0a98a35
```

The same digest is recorded in the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading). The Railway
template pins that artifact for new installations; existing installations do
not upgrade automatically.

See [proxy setup](https://github.com/nxfi777/tallylamp/blob/main/docs/proxies.md)
for inputs, update semantics, and troubleshooting.
