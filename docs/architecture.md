# Architecture

Tallylamp is a **single Node.js process** that launches headed Chrome processes
beside it, fronts them with MCP + a control API, and gives a human an
authenticated dashboard over the **same** Chrome instances.

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

This differs from the originating prompt's Docker-fleet hypothesis and from
chikin: Railway cannot spawn sibling containers, so the provisioner is
**process-based**. Isolation is loopback CDP ports, separate profile/download
directories, a sanitized Chrome environment, and an egress proxy — not
per-container networks.

## Concepts (kept separate)

| Concept | Store |
|---|---|
| Administrator | `ADMIN_SECRET` + HttpOnly session cookie |
| Agent principal | `agents` + hashed `credentials` |
| Browser resource | `browsers` row (survives process death) |
| Owner | `owner_type` / `owner_id` |
| Descriptive metadata | `metadata_json` (optional, not identity) |
| Provenance | `created_by_*` / `created_via` (immutable) |
| Profile | `/data/profiles/<id>` |
| Running Chrome | in-memory `BrowserManager` runtime |
| MCP session | `MCP-Session-Id`, in-memory |
| Current controller | `control_leases` |
| Human viewer | short-lived single-use ticket → loopback CDP screencast |

## Interfaces

- Agents: `POST/GET/DELETE /mcp` (Streamable HTTP) and `/api/v1` with bearer.
- Humans: cookie session at `/` (dashboard).
- Health: `GET /healthz` → `{"status":"ok"}`.

Browser routing is **server-side session state**, not `/b/name/`. After
`tallylamp_create_browser` or `tallylamp_use_browser`, chrome-devtools-mcp
tools drive that browser.

## Persistence

SQLite at `$TALLYLAMP_DATA_DIR/tallylamp.sqlite` (WAL). Chrome profiles and
seeds live next to it. A Railway volume must be mounted at `/data`.

Stopping Chrome does not delete a persistent profile. Deleting a browser does.

## Viewer

Dashboard watch/control uses Chrome DevTools `Page.startScreencast` proxied
over an authenticated WebSocket. Watch mode never forwards Input-domain events.
Takeover takes a lease, then Input events are allowed. This is the same Chrome
the agent attached to — not a preview browser.

noVNC is not used. That removes public VNC/websockify ports.

## MCP child

Each bound session spawns `chrome-devtools-mcp@1.8.0` with
`--browser-url=http://127.0.0.1:<cdp>` and telemetry off. Mutating tools
(`click`, `fill`, `navigate_page`, …) return a tool error
`browser is controlled by a human; retry later` while a human lease is live.
The MCP session is not torn down.
