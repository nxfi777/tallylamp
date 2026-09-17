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
    "/browsers/{id}/extensions": {
      put: { summary: "Enable or disable extensions for a stopped browser (administrator only). Requires a host that supports full-browser viewing.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
        responses: { "200": { description: "updated" }, "400": { description: "invalid input or unsupported host" }, "403": { description: "administrator required" }, "409": { description: "stop the browser first" } } },
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
    "/audit": { get: { summary: "Recent audit events", responses: { "200": { description: "ok" } } } },
    "/events": { get: { summary: "SSE control-plane events", responses: { "200": { description: "ok" } } } },
  },
};
