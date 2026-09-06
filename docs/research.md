# Research log

This log records the source checks used to design Tallylamp on 2 September 2026.
Version numbers and measurements belong to that date unless an entry says otherwise.
Implementation corrections from the 6 September documentation audit are marked below.
See the [architecture](architecture.md) and [client setup guide](mcp-compatibility.md)
for the current implementation and connection instructions.

## chikin implementation reference

https://github.com/jra3/chikin

cloned to `/tmp/chikin`

Version recorded: `c3175a1eeb1ed986a9523924f30044c04b59f2b9` (2026-08-28)

Checked: 2026-09-02.

### Findings

chikin is a **local-only Docker fleet**. ADR 0001: gateway binds loopback;
remote hosting is rejected. Per-browser MCP at `/b/<name>/`. Gateway provisions
sibling Chrome containers through `tecnativa/docker-socket-proxy`. Headed
Google Chrome (amd64) or Chromium (arm64) on Xvfb; optional x11vnc+noVNC.
`chrome-devtools-mcp@1.1.1` (pinned, old). MCP SDK `^1.12.0`. Dashboard is
unauthenticated and loopback-trusted. Cross-browser CDP/VNC reachability is an
accepted residual (ADR 0003, `EXPECTED_PEER_REACHABLE`). Renderer sandbox is
probed via unprivileged userns; fallback `--no-sandbox`. Seed volumes clone a
stopped golden profile. `chikin_identify` is a required first tool. Unit tests:
`npm test` in `gateway/` reported 182 pass / 0 fail at this SHA. README still
recommends `puppeteer-extra-plugin-stealth`; we did not follow that.

### Design decision

Tallylamp uses one container with Chrome child processes. Its adapted ideas
include Xvfb headed Chrome, singleton-lock cleanup, a userns sandbox probe, SSE
keepalives, seed snapshots, and a `--browser-url` child. It does not reuse the
Docker-in-Docker model, `/b/<name>/` routing, loopback-only trust, or stealth
recommendations. See [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution.

## MCP specification: Streamable HTTP and authorization

Official MCP spec

https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
https://modelcontextprotocol.io/specification/2026-07-28/basic/transports (newer revision exists)

Version recorded: Spec versions `2025-11-25` (widely deployed) and `2026-07-28` (recorded as the stable spec release on 2026-09-02)

Checked: 2026-09-02.

### Findings

A server MUST expose a single MCP endpoint supporting POST and GET (example
`https://example.com/mcp`). Sessions MAY be assigned via `MCP-Session-Id` on
initialize. Origin MUST be validated. Authorization is OPTIONAL; when used over
HTTP the server is an OAuth 2.1 resource server, MUST implement RFC 9728
Protected Resource Metadata, and MUST use `Authorization: Bearer` (never query
tokens). `WWW-Authenticate` on 401 should carry `resource_metadata`. Clients
MUST send `MCP-Protocol-Version` after initialize. SDK v1 (`@modelcontextprotocol/sdk@1.30.0`,
2026-07-27) was recorded as the npm `latest` tag at this check; v2 split packages existed for the
2026-07-28 spec. chrome-devtools-mcp 1.8.0 still speaks the v1 SDK world.

### Design decision

The canonical endpoint is `/mcp`, using SDK 1.30 Streamable HTTP and RFC 9728
metadata. A pre-issued agent bearer token is the primary credential when the
client supports headers.

Correction, 6 September 2026: the earlier note described discovery without token
issuance. The current [`src/oauth.ts`](../src/oauth.ts) implements
`authorization_code` and rotating refresh tokens with PKCE S256, dashboard
consent, and connector agents. `TALLYLAMP_OAUTH=0` disables discovery and new
OAuth flows; it does not revoke existing grants. The
[client guide](mcp-compatibility.md#when-only-authentication-tools-appear) describes
the reported Claude Code header/discovery issue and its limits.

## chrome-devtools-mcp

Official repository and generated docs

https://github.com/ChromeDevTools/chrome-devtools-mcp
https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/configuration.md
https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/tool-reference.md

Version recorded: v1.8.0 (released 2026-08-25, tag `chrome-devtools-mcp-v1.8.0`)

Checked: 2026-09-02.

### Findings

Node LTS required. `--browser-url` / `--browserUrl` connects to a running
debuggable Chrome (`http://127.0.0.1:9222`). `--wsEndpoint` alternative.
`--headless` defaults **false**. `--experimental-structured-content` exists.
`--no-usage-statistics` and env `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` /
`CI` disable telemetry. `--page-id-routing` default true (pageId required).
Input tools: `click`, `fill`, `type_text`, `press_key`, `hover`, `drag`,
`fill_form`, `click_at`. Navigation: `navigate_page`, `new_page`, `list_pages`,
`select_page`, `close_page`, `wait_for`. Screenshots: `take_screenshot`.
Screencast tools exist but need `--experimentalScreencast` and ffmpeg.
Connecting to an already-running Chrome avoids Puppeteer's launch flags
(`--enable-automation`, headless).

### Design decision

Tallylamp launches Chrome itself (headed, remote debugging on loopback) and
spawns `chrome-devtools-mcp --browser-url=...`. Native tools are forwarded, not
reimplemented. Mutating tools are intercepted during human control. Telemetry
and update checks disabled in the child env.

## MCP client compatibility

First-party client docs

https://code.claude.com/docs/en/mcp (Claude Code, fetched 2026-09-01 docs)
https://code.claude.com/docs/en/agent-sdk/mcp

Checked: 2026-09-02.

### Findings

Claude Code: `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <token>"`.
JSON `type` accepts `http` and `streamable-http`. `${ENV}` expansion in headers.
OAuth is also supported; bugs exist where discovery overrides a configured
bearer header. Cursor / VS Code Copilot / Gemini CLI: configuration examples
were **not** live-tested in this workspace; see `docs/mcp-compatibility.md`.

### Design decision

Keep documentation checks separate from live client tests. The 2 September
review checked the Claude Code header flow. The 6 September audit also checked
Codex CLI 0.153.4 help and the official Codex, Cursor, and VS Code documentation.
Examples and test status are in [client compatibility](mcp-compatibility.md).

## Railway volumes, healthchecks, templates, IaC

Railway first-party docs

https://docs.railway.com/volumes
https://docs.railway.com/volumes/reference
https://docs.railway.com/guides/healthchecks
https://docs.railway.com/templates/best-practices
https://docs.railway.com/guides/config-as-code
https://docs.railway.com/infrastructure-as-code/reference

Version recorded: Docs as of 2026-09-02. Config-as-code (`railway.json`/`railway.toml`) is
**deprecated**; new services should use `.railway/railway.ts`. Hard cutoff
2026-12-01 for existing legacy configurations. New services cannot opt in.
Clarified on 6 September against [Railway's migration notice](https://docs.railway.com/config-as-code).

Checked: 2026-09-02.

### Findings

Volumes mount at a path the operator chooses; Railway's build puts app files in
`/app`. `RAILWAY_VOLUME_MOUNT_PATH` / `RAILWAY_VOLUME_NAME` are injected.
Volumes are **not** mounted at build or pre-deploy. Replicas cannot be used
with volumes. Redeploy of a volume-backed service has downtime (single mount).
Hobby default volume size 5GB. Healthcheck path must return HTTP 200; default
timeout 300s; not used for continuous monitoring. Dockerfiles at repo root are
auto-detected. Template secrets should use template variable functions, never
hardcoded credentials. `RAILWAY_RUN_UID=0` can fix non-root volume permissions.
No first-party doc states that Railway services can spawn sibling containers or
use a Docker socket.

### Design decision

Single service, Dockerfile, volume mounted at `/data`, healthcheck `/healthz`,
process-based Chrome fleet (not Docker provisioner). IaC in
`.railway/railway.ts`. Do not claim privileged mode, GPU passthrough, or
Docker-in-Docker.

## Chrome remote debugging and headed mode

Chrome for Developers + chrome-devtools-mcp advanced usage

https://developer.chrome.com/blog/remote-debugging-port
https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md

Checked: 2026-09-02.

### Findings

`--remote-debugging-port` requires a non-default `--user-data-dir`. Chrome
binds the debugging port on loopback. `--remote-allow-origins=*` is required
when the CDP client omits Origin (chrome-devtools-mcp does). Headless mode is
opt-in (`--headless`); default chrome-devtools-mcp is headed. Puppeteer launch
injects automation switches; connecting to a pre-launched Chrome does not.

### Design decision

Launch stock headed Chrome with a dedicated profile dir and loopback CDP. Do
not pass `--headless` or `--enable-automation`. Measure remaining surfaces
against a reference launch in the same environment rather than applying
stealth plugins.

## Chrome GPU / SwiftShader

Chromium GPU docs and chikin README admission

chikin README (SwiftShader/null WebGL); Chromium `--use-gl` / `--use-angle=swiftshader`

Checked: 2026-09-02.

### Findings

Railway does not document GPU passthrough for ordinary services. Software GL
(SwiftShader, llvmpipe) is detectable. Spoofing `Intel Iris` while rendering
via software produces an inconsistent fingerprint.

### Design decision

`TALLYLAMP_GPU=auto|software|hardware`. Default auto: do not claim a GPU.
Surface renderer in the dashboard. Never rewrite WebGL unmasked renderer.

## Proxying Chrome without TLS interception

Chromium network settings

https://www.chromium.org/developers/design-documents/network-settings/

Checked: 2026-09-02.

### Findings

`--proxy-server` with an HTTP CONNECT proxy leaves destination TLS to Chrome.
`--proxy-bypass-list=<-loopback>` removes the implicit localhost bypass so
pages cannot reach sibling loopback ports while Node still talks to CDP
directly.

### Design decision

Tallylamp runs a CONNECT egress proxy that resolves DNS and refuses
private/link-local/metadata targets, then tunnels. Chrome performs e2e TLS.
No HTTP MITM. WebRTC/UDP is not covered by an HTTP proxy; documented
limitation.

## Huemint palette

Huemint transformer API via local skill

https://huemint.com (api.huemint.com)

Version recorded: n/a

Checked: 2026-09-02.

### Findings

Locked dark web palette (bg/text 19.0:1 AA): `#0c1014`, `#161d24`, `#fdffff`,
`#ea1c25`, `#177abf`. Teal `#108578` and human orange `#ee572a` taken from
earlier unlocked runs for semantic status, not as additional body text colours.

### Design decision

These colours informed the initial dashboard palette, with `#ea1c25` for the
live tally. This entry is a design record; consult `dashboard/app.css` for the
current theme tokens.
