# Architecture

Tallylamp runs one Node.js server that manages headed Chrome processes.
Agents drive those browsers through MCP or the control API. Humans watch and
control the same browsers through an authenticated dashboard.

```
                    Internet
                       │
                    HTTPS
                       │
              ┌────────▼────────┐
              │    Tallylamp    │
              │ Auth            │
              │ MCP /mcp        │
              │ Control /api/v1 │
              │ Dashboard       │
              │ Browser manager │
              │ Viewer (CDP)    │
              │ Egress CONNECT  │
              └────────┬────────┘
                       │ loopback CDP only
            ┌──────────┼──────────┐
            ▼          ▼          ▼
         Chrome A   Chrome B   Chrome C
            │          │          │
         Profile A  Profile B  Profile C
```

Browsers run as processes inside one container. Each has separate profile and
download directories, a loopback debugging port, a sanitized environment, and
its own egress proxy. They share the container's isolation boundary.

A proxy per browser adds one loopback listener to each runtime. It also lets the
server identify which browser made a connection, so a private-address tunnel
can be restricted to that browser. Chrome receives the proxy port at launch.

## Data model

| Concept | Store |
|---|---|
| Administrator | `ADMIN_SECRET` + HttpOnly session cookie |
| Agent principal | `agents` + hashed `credentials` |
| Browser resource | `browsers` row (survives process death) |
| Owner | `owner_type` / `owner_id` |
| Descriptive metadata | `metadata_json` (optional, not identity) |
| Declared website access | `browser_site_access` (origin + observed state; no credential material) |
| Provenance | `created_by_*` / `created_via` (immutable) |
| Profile | `/data/profiles/<id>` |
| Running Chrome | in-memory `BrowserManager` runtime |
| MCP session | `MCP-Session-Id`, in-memory |
| Current controller | `control_leases` |
| Human viewer | short-lived single-use ticket → loopback CDP screencast |
| Loopback tunnel | `browser_tunnels` + an outbound WebSocket from the machine reached |

## Interfaces

- Agents: `POST/GET/DELETE /mcp` (Streamable HTTP) and `/api/v1` with bearer.
- Humans: cookie session at `/` (dashboard).
- Health: `GET /healthz` → `{"status":"ok"}`.

The server stores each MCP session's selected browser, so after a client calls
`tallylamp_create_browser` or `tallylamp_use_browser`, subsequent chrome-devtools-mcp
tools drive that browser until the session selects another one.

## Persistence

SQLite at `$TALLYLAMP_DATA_DIR/tallylamp.sqlite` (WAL). Chrome profiles and
seeds live next to it. A Railway volume must be mounted at `/data`.

Stopping Chrome does not delete a persistent profile. Deleting a browser does.
Profile templates copy both the Chrome profile and its declared website-access
manifest. A clone downgrades inherited `confirmed` entries to `expected` because
copying bytes cannot prove that a remote site still accepts the session.

## Viewer

The viewer uses Chrome DevTools `Page.startScreencast` over an authenticated
WebSocket. Watch mode forwards no input. Taking control acquires a lease that
allows input to the Chrome instance already used by the agent. The service
needs no noVNC, VNC, or websockify endpoint.

## MCP child

Each bound session starts `chrome-devtools-mcp@1.8.0` with
`--browser-url=http://127.0.0.1:<cdp>` and telemetry disabled. While a human
lease is live, mutating tools such as `click`, `fill`, and `navigate_page` return
the same structured tool error as the lifecycle tools:

```json
{"error":{"code":"human_controlling_browser","message":"browser is controlled by a human; retry later","retryable":true}}
```

Callers can inspect `retryable` without parsing the message. Read-only tools
such as `take_snapshot` and `take_screenshot` keep working, and the MCP session
stays open.

## Lending a browser between agents

An agent requesting another agent's browser gets `unauthorized` (403) by default.
Lending requires explicit `browser:lend` and `browser:borrow` scopes. Both are
excluded from `DEFAULT_AGENT_SCOPES`, as is `seed:use`, because access to a browser
also gives access to the sessions still logged into its profile.

Tallylamp cannot wake an idle or crashed agent to answer a request. Lending must
therefore work without an immediate answer from the owner. A request is resolved
when one of these events occurs:

- The owner answers. Pending requests are appended to its next tool result, so
  an active owner can grant or deny them.
- A browser marked `lendable` passes `TALLYLAMP_LEND_AUTO_GRANT_IDLE_SEC` and the
  server grants the request automatically. The setting is per browser and off
  by default; an idle browser without that opt-in is not automatically lent.
- The request expires, and the requester learns that it is no longer pending.

`tallylamp_request_browser` returns immediately. Its result is `granted`,
`pending` with a `retryAfterSec`, `denied`, or `unavailable`. Holding the call
open would occupy an MCP request slot and SSE stream until a client timeout.
A pending request keeps its queue position even when the requester stops polling,
so an agent can return later without starting over, and repeated calls do not
move it forward in the queue.

Omitting `browserId` asks for any suitable browser. The server ranks candidates
from local database rows, favouring opted-in and longer-idle browsers, then asks
exactly one. It does not broadcast requests that could leave one requester
holding several Chrome instances.

A browser under human control returns `unavailable`; lending requests cannot
queue behind a human lease. A grant permits driving but never deletion, and
`publicView` reports the borrower in `lentTo`. Ownership and creator provenance
remain unchanged. Lending also closes the browser's loopback tunnels; see the
[tunnel security rules](security.md#loopback-tunnels).

## Memory

One Node process, plus one Chrome per running browser, plus one chrome-devtools-mcp bridge
per bound MCP session. Earlier development measurements recorded these footprints;
actual use depends on the pages, Chrome version, and environment:

- Idle, zero browsers: ~61 MB. The MCP SDK (~20 MB resident) is imported on the first
  `/mcp` request rather than at boot, so a deployment serving only the dashboard does not load it.
- Each running Chrome: ~930 MB-1.2 GB depending on the page. `--disable-extensions` and
  `--disable-component-extensions-with-background-pages` remove four renderer processes
  Chrome would otherwise start for its own component extensions.
- Each MCP bridge child: a full Node process carrying puppeteer-core. Capped with
  `NODE_OPTIONS`, released as soon as its browser stops or is deleted, and reaped with its
  session after `TALLYLAMP_MCP_SESSION_IDLE_SEC`.

A slow viewer could otherwise accumulate screencast frames in memory. When the
socket's `bufferedAmount` exceeds `TALLYLAMP_VIEWER_HIGH_WATER_BYTES`, the server
drops frames and withholds the CDP acknowledgement. Chrome's flow control then
slows frame production until the connection can keep up.
