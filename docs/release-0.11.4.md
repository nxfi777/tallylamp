# Tallylamp 0.11.4

Linked-browser control connections now use available workers automatically.
Chrome stays on its owner's machine; the MCP bridge process and its threads
run on the worker. This frees capacity on the main instance while retaining
the per-browser routing introduced in 0.11.3.

## What changes

- Each linked browser connection has its own bridge, preserving independent
  page selection across MCP sessions.
- New bridges prefer a healthy, compatible worker with sufficient thread
  capacity. They fall back to the main instance when needed.
  `TALLYLAMP_PLACEMENT=local` keeps all bridges local. Existing connections
  keep their placement until they are closed or recreated.
- Access checks, human takeover, and the extension connection remain on the
  main instance. Each worker channel can reach only its assigned linked
  browser's debugging endpoint.
- A lost worker closes its bridge without disconnecting the user's browser
  or unsharing tabs. A later call can reconnect on another host; an interrupted
  command is never automatically replayed.
- Saved screenshots, snapshots, traces, script results, heap snapshots, and
  Lighthouse reports are copied back to the main instance before their paths
  are returned. Session shutdown removes the worker's temporary artifacts.

## Upgrading

No new dependencies, database changes, or settings. Upgrade the main instance
and workers to the same release. Redeploys restart running browser processes;
profiles remain on their persistent volumes. Existing Tallylamp Link
extensions remain compatible; this release's extension package carries the
matching version.

See [worker placement and recovery](workers.md#what-works-on-a-worker) for
operational details.
