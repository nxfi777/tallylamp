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
      post: { summary: "Create a browser", responses: { "201": { description: "created" } } },
    },
    "/browsers/{id}": {
      get: { summary: "Get browser", responses: { "200": { description: "ok" } } },
      patch: { summary: "Rename a browser or edit descriptive metadata", responses: { "200": { description: "ok" } } },
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
    "/seeds/{id}": { put: { summary: "Update a saved profile from a browser. Agents need seed:write, ownership, and a matching linked profile.", responses: { "200": { description: "updated" }, "403": { description: "not authorized" } } } },
    "/audit": { get: { summary: "Recent audit events", responses: { "200": { description: "ok" } } } },
    "/events": { get: { summary: "SSE control-plane events", responses: { "200": { description: "ok" } } } },
  },
};
