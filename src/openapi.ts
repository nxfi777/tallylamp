const proxyInput = {
  type: ["object", "null"], required: ["server"], additionalProperties: false,
  description: "HTTP/HTTPS CONNECT proxy. Null means direct. Updates replace all settings. Credentials are stored in SQLite but never returned. See docs/proxies.md.",
  properties: {
    server: { type: "string", description: "http://host:port or https://host:port, without credentials or path" },
    username: { type: "string", maxLength: 1024, writeOnly: true },
    password: { type: "string", maxLength: 1024, writeOnly: true },
  },
};
const browserInput = { type: "object", properties: {
  name: { type: "string" }, metadata: { type: "object" }, proxy: proxyInput,
} };

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Tallylamp Control API",
    version: "0.1.0",
    description:
      "Non-MCP control plane. MCP is a separate protocol at POST /mcp and is not encoded here.",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
      cookie: { type: "apiKey", in: "cookie", name: "tallylamp_session" },
    },
  },
  paths: {
    "/status": { get: { summary: "Authenticated deployment status", responses: { "200": { description: "ok" } } } },
    "/export": { post: {
      summary: "Export portable instance data (admin only)",
      description: "Stops selected managed browsers and leaves them stopped. Includes all saved profiles, agents, metadata and downloads, including workers. Source data is retained. Import offline into a new data directory with the CLI.",
      requestBody: { content: { "application/json": { schema: { type: "object", properties: {
        browsers: { type: "array", items: { type: "string" }, description: "Browser IDs or slugs; omitted means all." },
        exclude: { type: "array", items: { type: "string" }, description: "Browser IDs or slugs to leave out." },
      } } } } },
      responses: { "200": { description: "Portable gzip tar archive", content: { "application/gzip": { schema: { type: "string", format: "binary" } } } },
        "403": { description: "admin only" }, "409": { description: "browser operation or another export is in progress" } },
    } },
    "/browsers": {
      get: { summary: "List browsers", responses: { "200": { description: "ok" } } },
      post: { summary: "Create a browser", requestBody: { content: { "application/json": { schema: { ...browserInput, properties: { ...browserInput.properties,
        persistent: { type: "boolean", default: true }, start: { type: "boolean", default: true }, seedId: { type: "string" },
      } } } } }, responses: { "201": { description: "created; browser.proxy contains only server and hasAuthentication, or null" } } },
    },
    "/browsers/{id}": {
      get: { summary: "Get browser", responses: { "200": { description: "ok" } } },
      patch: { summary: "Rename a browser, edit metadata, or replace its proxy", description: "Proxy edits require an owner/admin and a stopped browser. Omitted proxy stays unchanged; null removes it. Credentials are never returned.",
        requestBody: { content: { "application/json": { schema: browserInput } } },
        responses: { "200": { description: "ok" }, "400": { description: "invalid proxy settings" }, "403": { description: "not the owner or missing scope" }, "409": { description: "stop the browser or return human control before changing its proxy" } } },
      delete: { summary: "Delete browser and profile", responses: { "204": { description: "deleted" } } },
    },
    "/browsers/{id}/sites": {
      post: { summary: "Record observed signed-in access for one website", responses: { "201": { description: "recorded" } } },
    },
    "/browsers/{id}/sites/{siteId}": {
      delete: { summary: "Remove a website from the profile inventory", responses: { "204": { description: "removed" } } },
    },
    "/browsers/{id}/tunnels": {
      get: { summary: "List live loopback tunnels on this browser", responses: { "200": { description: "ok" } } },
      post: {
        summary: "Bind one private address to this browser. Returns the connect token once.",
        responses: { "201": { description: "created" }, "403": { description: "missing browser:tunnel" } },
      },
    },
    "/tunnels/{id}": { delete: { summary: "Close a tunnel", responses: { "204": { description: "closed" } } } },
    "/browsers/{id}/start": { post: { summary: "Start Chrome", responses: { "200": { description: "ok" } } } },
    "/browsers/{id}/stop": { post: { summary: "Stop Chrome, keep profile", responses: { "200": { description: "ok" } } } },
    "/browsers/{id}/restart": { post: { summary: "Restart Chrome", responses: { "200": { description: "ok" } } } },
    "/browsers/{id}/control": {
      post: { summary: "Take human control", responses: { "200": { description: "ok" } } },
      delete: { summary: "Return control to the agent", responses: { "200": { description: "ok" } } },
    },
    "/browsers/{id}/viewer-ticket": {
      post: { summary: "Mint a short-lived viewer ticket", responses: { "200": { description: "ok" } } },
    },
    "/browsers/{id}/guests": {
      get: { summary: "List guest links for this browser, without their tokens (admin only)", responses: { "200": { description: "ok" } } },
      post: {
        summary: "Create a guest link: one person, this browser, watch and optionally control (admin only). The token is returned once and the link works once. See docs/guest-access.md.",
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["label"], additionalProperties: false, properties: {
          label: { type: "string", maxLength: 80, description: "Who the link is for. Shown to the guest and recorded in the audit log." },
          modes: { type: "array", items: { enum: ["watch", "control"] }, default: ["watch"] },
          expiresInSec: { type: "integer", minimum: 60, description: "Default TALLYLAMP_GUEST_TTL_SEC; at most TALLYLAMP_GUEST_MAX_TTL_SEC" },
          allowedHosts: { type: "array", items: { type: "string" }, maxItems: 20, default: [], description: "Hosts the guest may open from the address bar and tabs. [] = none, [\"*\"] = any." },
        } } } } },
        responses: { "201": { description: "created; includes token and url once" }, "400": { description: "invalid input, a linked browser, or too many live links" } },
      },
    },
    "/browsers/{id}/guests/{guestId}": {
      delete: { summary: "Revoke a guest link: ends its sessions, its lease and its open viewers (admin only)", responses: { "200": { description: "ok" } } },
    },
    "/browsers/{id}/extensions": {
      put: { summary: "Enable or disable extensions for a stopped browser (administrator only). Requires a host that supports full-browser viewing.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
        responses: { "200": { description: "updated" }, "400": { description: "invalid input or unsupported host" }, "403": { description: "administrator required" }, "409": { description: "stop the browser first" } } },
    },
    "/browsers/{id}/pinned": {
      put: { summary: "Pin or unpin a managed browser (administrator only). On a host with a process ceiling, room is held for a pinned browser, it is never stopped to make room for another, and it may stop unpinned browsers to start or to keep running. Pinned browsers are also exempt from the idle reaper.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["pinned"], properties: { pinned: { type: "boolean" } } } } } },
        responses: { "200": { description: "updated" }, "400": { description: "invalid input or a linked browser" }, "403": { description: "administrator required" } } },
    },
    "/browsers/{id}/threads/reset": {
      post: { summary: "Forget a managed browser's measured thread counts, launchThreads and peakThreads (administrator only). Works on a stopped browser. A running browser is measured again from now; its launch is measured on its next start, and until then a start is assumed to need TALLYLAMP_BROWSER_THREADS (startThreads). Use it when a browser was sized from an unusually heavy run and is refused starts it would fit.",
        responses: { "200": { description: "reset" }, "400": { description: "a linked browser" }, "403": { description: "administrator required" } } },
    },
    "/browsers/{id}/move": {
      post: { summary: "Move a stopped browser, profile and all, to a worker or back to the main instance (administrator only).",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["workerId"], properties: { workerId: { type: ["string", "null"], description: "A worker's id, or null for the main instance." } } } } } },
        responses: { "200": { description: "moved" }, "409": { description: "stop the browser first, or a host is unreachable or on another release" }, "403": { description: "administrator required" } } },
    },
    "/workers": {
      get: { summary: "List workers: other services running this image with TALLYLAMP_JOIN, which run Chrome for this instance (administrator only).", responses: { "200": { description: "ok" } } },
    },
    "/workers/join-tokens": {
      post: { summary: "Make a one-time join token for a new worker (administrator only). Shown once; expires in an hour.", responses: { "201": { description: "created; includes the token" } } },
    },
    "/workers/{id}": {
      delete: { summary: "Remove a worker that holds no browsers (administrator only).", responses: { "200": { description: "removed" }, "409": { description: "browsers still live on it" } } },
    },
    "/workers/join": {
      post: { summary: "A worker joining with its one-time token. Called by the worker, not by people.", security: [], responses: { "200": { description: "joined; returns the worker's id and secret" }, "403": { description: "unknown, used or expired token" }, "409": { description: "the worker runs a different release" } } },
    },
    "/browsers/{id}/agent-desktop": {
      put: { summary: "Grant or revoke the owning agent's full native browser access (administrator only). Not inherited by borrowed or copied browsers.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
        responses: { "200": { description: "updated; revocation interrupts in-flight native work" }, "400": { description: "invalid input or unsupported browser" }, "403": { description: "administrator required" } } },
    },
    "/agents": {
      get: { summary: "List agent principals", responses: { "200": { description: "ok" } } },
      post: { summary: "Create an agent principal and credential", responses: { "201": { description: "created" } } },
    },
    "/agents/{id}": { patch: { summary: "Update agent", responses: { "200": { description: "ok" } } } },
    "/agents/{id}/rotate": { post: { summary: "Rotate agent credential", responses: { "200": { description: "ok" } } } },
    "/seeds": {
      get: { summary: "List seed profiles", responses: { "200": { description: "ok" } } },
      post: { summary: "Save a new reusable profile; automatically pause/resume a running source. Requires admin or seed:write and ownership.", responses: { "201": { description: "created" }, "403": { description: "missing permission or source ownership" } } },
    },
    "/seeds/{id}": {
      put: { summary: "Update a saved profile from a browser. Agents need seed:write, ownership, and a matching linked profile.", responses: { "200": { description: "updated" }, "403": { description: "not authorized" } } },
      delete: { summary: "Delete a saved snapshot, not its existing browsers. Administrator only; body.confirmName must match the current name.", responses: { "200": { description: "deleted; cleanupPending reports any pending disk cleanup" }, "400": { description: "confirmation missing or stale" }, "403": { description: "not authorized" }, "404": { description: "not found" } } },
    },
    "/seeds/{id}/sites": {
      post: { summary: "Record or amend one site in a saved profile's inventory, without republishing the snapshot. Administrator only. Copies no cookies and invents no confirmation timestamp; clones still inherit it as expected.", responses: { "201": { description: "recorded" }, "400": { description: "origin missing or not http(s)" }, "403": { description: "not authorized" }, "404": { description: "saved profile not found" }, "409": { description: "the profile is being saved; retry" } } },
      delete: { summary: "Drop one site from a saved profile's inventory; body.origin identifies it. Administrator only. Existing browsers and stored logins are unchanged.", responses: { "204": { description: "removed" }, "403": { description: "not authorized" }, "404": { description: "saved profile or site not found" } } },
    },
    "/audit": { get: { summary: "Recent audit events", responses: { "200": { description: "ok" } } } },
    "/events": { get: { summary: "SSE control-plane events", responses: { "200": { description: "ok" } } } },
  },
};
