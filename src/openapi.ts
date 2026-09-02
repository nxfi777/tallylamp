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
      patch: { summary: "Edit descriptive metadata", responses: { "200": { description: "ok" } } },
      delete: { summary: "Delete browser and profile", responses: { "204": { description: "deleted" } } },
    },
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
      post: { summary: "Snapshot a stopped browser as a seed", responses: { "201": { description: "created" } } },
    },
    "/audit": { get: { summary: "Recent audit events", responses: { "200": { description: "ok" } } } },
    "/events": { get: { summary: "SSE control-plane events", responses: { "200": { description: "ok" } } } },
  },
};
