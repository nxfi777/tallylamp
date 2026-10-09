# Tallylamp 0.11.3

Agents sharing one MCP connection can now work in different browsers at the
same time. Each browser tool call can name its target with `browserId`.

Previously, a connection had one active browser. If one agent selected browser
B while another was working in browser A, the other agent's next call could
land in B. An explicit ID now keeps that call on its intended browser without
changing the connection's default.

## What changes

- **Route each call.** Driving tools, page selection, and recording start/stop
  accept an optional `browserId`. Calls to different browsers use independent
  connections to Chrome and can run concurrently. Each agent should keep its
  browser ID and pass it on every browser operation. Agents sharing the same
  browser in one MCP session still share its selected tab.
- **Keep existing clients working.** `tallylamp_create_browser` and
  `tallylamp_use_browser` still set the shared default. Calls without an ID use
  that default. Separate MCP sessions retain independent defaults even when
  they use the same credentials.
- **Keep tools discoverable.** The advertised tool list stays stable when the
  default browser is read-only. A shared connection may also operate an owned
  browser, so selecting a read-only browser no longer hides its driving tools.
  Every call is checked against the permissions for its target.
- **Reconnect to the intended browser.** Once credentials have been used with
  multiple browsers, a new session asks for an explicit ID or browser selection
  instead of guessing which browser to restore. Connections to different
  browsers are tracked and cleaned up independently.
- **Check the named browser.** Ownership, grants, and human takeover apply to
  the actual target. Browser startup rechecks access before dispatch, and an
  unavailable or unauthorized explicit target never falls back to the default.
  A browser ID grants no permissions of its own.

See the [multiple-agent connection guide](mcp-compatibility.md#multiple-agents-and-browsers)
for call examples and reconnect guidance.

## Upgrading

No schema change and no new settings. Upgrade the main instance and every
worker together: while they run different releases, the main instance starts
nothing on a worker. Redeploys interrupt active browsers; their profiles remain
on the persistent volume.

The existing Tallylamp Link extension remains compatible. This release changes
MCP routing on the server; its extension package carries the matching version.

Use the digest produced by the release workflow when pinning the image. See the
[Railway upgrade instructions](railway.md#releasing-and-upgrading) for backups
and deployment settings.
