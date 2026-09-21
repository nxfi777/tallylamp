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
its own local egress proxy. They share the container's isolation boundary.

A proxy per browser adds one loopback listener to each runtime. It also lets the
server identify which browser made a connection, so a private-address tunnel
can be restricted to that browser. Chrome receives the proxy port at launch.

For outbound web traffic, the route is:

```text
Chrome → local safety proxy → matching browser tunnel, if one exists
                           → vetted destination via saved HTTP/HTTPS proxy
                           → vetted destination directly, if no proxy is set
```

The service resolves and checks both the destination and upstream proxy, then
connects to the checked IPs. An upstream failure ends the request; it never
selects the direct route as a fallback. Chrome handles website TLS through
CONNECT. The [proxy guide](proxies.md) covers authentication and protocol limits.

## Data model

| Concept | Store |
|---|---|
| Administrator | `ADMIN_SECRET` + HttpOnly session cookie |
| Agent principal | `agents` + hashed `credentials` |
| Browser resource | `browsers` row (survives process death) |
| Upstream proxy | `browsers.proxy_json`; includes unencrypted credentials, excluded from public views |
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
Proxy settings stay with the original browser and are not included in a snapshot.
Changing them requires a stopped browser and its owner or an administrator.

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

## Linked browsers

A linked browser is not launched here. The Tallylamp Link extension in a person's
own Chromium dials out to `/api/v1/links/connect`, and `src/linked-cdp.ts` puts a
loopback CDP endpoint in front of that socket. It is the third `ChromeRuntime`
factory beside `launchChrome` and the test fake, so the MCP child, the viewer and
the thumbnailer reach it the way they reach any other browser. `browsers.kind`
is `linked` for these rows. They take no fleet slot, have an empty profile
directory, and refuse everything that needs launch flags or an X display.
Details are in [linked-browsers.md](linked-browsers.md).

## Lending and granting access to a browser

An agent requesting another agent's browser gets `unauthorized` (403) by default.
Agent-to-agent lending requires explicit `browser:lend` and `browser:borrow` scopes.
Both are excluded from `DEFAULT_AGENT_SCOPES`, as is `seed:use`, because access to a
browser also gives access to the sessions still logged into its profile.

Requesting a browser the **administrator** owns is a separate path with different
rules, described under [asking the administrator](#asking-the-administrator) below.
Linked browsers are excluded from both: they are shared from the browser's own page
in the dashboard and can never be lent on.

Tallylamp cannot wake an idle or crashed agent to answer a request. Lending must
therefore work without an immediate answer from the owner. A request is resolved
when one of these events occurs:

- The owner answers. Pending requests are appended to its next tool result, so
  an active owner can grant or deny them.
- A browser marked `lendable` passes `TALLYLAMP_LEND_AUTO_GRANT_IDLE_SEC` and the
  server grants the request automatically. The setting is per browser and off
  by default; an idle browser without that opt-in is not automatically lent.
- The request expires, and the requester learns that it is no longer pending.

`tallylamp_request_browser` returns immediately. Its result is `granted` with the
`access` level and an `expiresAt` (`null` means until revoked), `pending` with a
`retryAfterSec`, `answeredBy` and the `access` asked for, `denied`, or `unavailable`.
Holding the call open would occupy an MCP request slot and SSE stream until a client
timeout.
A pending request keeps its queue position even when the requester stops polling,
so an agent can return later without starting over, and repeated calls do not
move it forward in the queue.

Omitting `browserId` asks for any suitable browser. The server ranks candidates
from local database rows, favouring opted-in and longer-idle browsers, then asks
exactly one. It does not broadcast requests that could leave one requester
holding several Chrome instances. Administrator-owned browsers are never ranked
here: they must be named, because nothing about them resolves without a person.

A browser under human control returns `unavailable`; lending requests cannot
queue behind a human lease. A grant never permits deletion, stopping, saving or
copying the profile, or changing the browser's proxy, name, metadata or signed-in
sites, at either access level. `publicView` reports every live grant in `lentTo`
with its `granteeId`, `access` and `expiresAt`. Ownership and creator provenance
remain unchanged. Granting `control` also closes the browser's loopback tunnels; a
`read` grant does not, because a reader cannot reach one. See the
[tunnel security rules](security.md#loopback-tunnels).

### Access levels

A grant carries one of two levels. `control` is the historic behaviour and the
default for agent-to-agent requests, so existing callers are unaffected.

`read` permits binding and the non-mutating tools only: `list_pages`,
`take_snapshot`, `take_screenshot`, `list_console_messages`,
`list_network_requests`, their `get_*` companions, and `tallylamp_select_page`.
Every tool in `MUTATING_TOOLS` is refused with a non-retryable
`grant_level_insufficient` error naming the level, and a read session is not
offered those tools in `tools/list` at all.

A read bind differs from a control bind in two further ways. It does not take the
agent control lease, so a reader never displaces another agent and never shows a
person that their browser has been taken. And it never foregrounds a tab: the bind
and `tallylamp_select_page` both pass `bringToFront: false`, which
chrome-devtools-mcp honours by moving only its own per-child page pointer. Reading
therefore continues to work while a human holds control, as non-mutating tools
already did.

Levels are re-read from the `browser_grants` row on every tool call rather than
cached on the session. A revoked or expired grant therefore fails the next call on
a session that is already connected and already bound, and a grant outlives the
session that first used it.

### Asking the administrator

A managed browser owned by the administrator can be requested by any agent, and is
answered only by the administrator, in the dashboard or through
`POST /api/v1/requests/:id/answer`. The idle auto-grant never applies: a person can
be asked, so there is no crashed-owner problem to solve, and absence from the
keyboard is not consent.

Filing such a request needs no scope. A scope the administrator must add first
would make the request flow unreachable by the agent that needs it, and asking
grants nothing by itself. Two limits bound it instead, both per agent and both
returning a non-retryable `lend_request_throttled` error:
`TALLYLAMP_LEND_REQUESTS_PER_MIN` (default 2, burst
`TALLYLAMP_LEND_REQUEST_BURST`) and `TALLYLAMP_LEND_MAX_PENDING` outstanding
requests (default 3). Re-asking for a browser an agent already has a pending
request for reuses that request and is not charged.

Unqualified requests default to `read` for an administrator-owned browser and
`control` for an agent-owned one. An answer may grant a lower level than was asked
for but never a higher one, and may set a fixed duration
(capped by `TALLYLAMP_LEND_MAX_GRANT_SEC`) or no expiry at all. An agent holding
`read` can request `control` on the same browser; that is a new request, the read
grant stays in force while it is pending, and approval replaces it.

Requests, answers, revocations and every tool call made under a grant are written
to the audit log against the requesting agent's own id and the grant id, never the
owner's.

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
