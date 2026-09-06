# Connect an MCP client

Tallylamp serves Streamable HTTP at `https://YOUR_HOST/mcp`. For a local server,
use `http://127.0.0.1:8080/mcp`.

Choose a bearer token when your client accepts a static authorization header.
Otherwise, use Tallylamp's OAuth flow. These are server capabilities; a client's
support for the transport does not establish a tested connection to Tallylamp.

## Client setup and evidence

| Client | Setup path | Evidence |
| --- | --- | --- |
| Claude Code | [Bearer header](#claude-code) or OAuth | Official docs checked; no live client test recorded |
| Codex CLI | [Bearer environment variable](#codex-cli) or OAuth | CLI 0.153.4 help and official docs checked; no live client test recorded |
| Cursor | [HTTP server with headers](#cursor) or OAuth | Official docs checked; no live client test recorded |
| VS Code / GitHub Copilot | [HTTP server with headers](#vs-code--github-copilot) | Official docs checked; no live client test recorded |
| ChatGPT and Claude.ai custom connectors | OAuth flow to validate | No live client test recorded in this repository |
| Copilot Studio, Zapier | Check the client's remote MCP authentication options | Earlier notes proposed static headers; not verified in this audit |
| Gemini CLI / Gemini Enterprise | Needs client-specific validation | Remote HTTP authentication has not been verified |
| MCP TypeScript SDK | [Streamable HTTP client](#generic-mcp-typescript-client) | Protocol tests in this repository |

The documentation and CLI checks above were made on 6 September 2026. They do
not claim an end-to-end client test. A client that requires a confidential OAuth
client with a secret cannot use Tallylamp's public-client-only authorization server.

## Create an agent token

In the dashboard, open **Agents**, create an agent, and copy its token. Configure
the client to send it on every request:

```text
Authorization: Bearer YOUR_AGENT_TOKEN
```

The token has no expiry. It belongs to an agent with its own permissions and
browser cap, and the dashboard can revoke it. Keep it out of URLs.

## Claude Code

Replace the URL and token in this command:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer YOUR_AGENT_TOKEN" \
  tallylamp https://YOUR_HOST/mcp
```

Alternatively, use a JSON configuration. The `type` accepts `http` or
`streamable-http`, and `${TALLYLAMP_TOKEN}` reads the token from the environment
of the Claude Code process:

```json
{
  "mcpServers": {
    "tallylamp": {
      "type": "http",
      "url": "https://YOUR_HOST/mcp",
      "headers": {
        "Authorization": "Bearer ${TALLYLAMP_TOKEN}"
      }
    }
  }
}
```

Claude Code documents custom headers and OAuth. Reconnection is client-driven;
Tallylamp identifies sessions with `MCP-Session-Id` and sends SSE keepalives every
30 seconds. See [Claude Code's MCP guide](https://code.claude.com/docs/en/mcp).

## Codex CLI

Set `TALLYLAMP_TOKEN` to your agent token in the environment used to launch Codex.
Then add the server:

```bash
codex mcp add tallylamp --url https://YOUR_HOST/mcp \
  --bearer-token-env-var TALLYLAMP_TOKEN
```

The equivalent TOML entry is:

```toml
[mcp_servers.tallylamp]
url = "https://YOUR_HOST/mcp"
bearer_token_env_var = "TALLYLAMP_TOKEN"
```

Both the installed CLI's `codex mcp add --help` and the
[official MCP reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
document bearer tokens for HTTP servers.

## Cursor

Cursor accepts a remote URL and headers in `.cursor/mcp.json` for a project,
or `~/.cursor/mcp.json` for the user. Its environment interpolation uses
`${env:NAME}`. With `TALLYLAMP_TOKEN` available to Cursor:

```json
{
  "mcpServers": {
    "tallylamp": {
      "url": "https://YOUR_HOST/mcp",
      "headers": {
        "Authorization": "Bearer ${env:TALLYLAMP_TOKEN}"
      }
    }
  }
}
```

Cursor also documents OAuth support. See its
[MCP configuration guide](https://cursor.com/docs/mcp) for settings and policy
restrictions.

## VS Code / GitHub Copilot

VS Code's MCP configuration accepts `type: "http"`, a `url`, and optional
`headers`, including an Authorization bearer header. Follow the
[configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
for your client surface and configuration location.

## OAuth

Sign into the Tallylamp dashboard, then add the `/mcp` URL in your client and
approve the connection when its browser flow opens. If the dashboard session
has expired, Tallylamp sends you to `/login?next=…` and returns you afterward.
The consent page uses that session rather than asking for `ADMIN_SECRET` again.

Before approval, it shows the client, the host receiving the authorization code,
the requested scopes, and the browser cap. Approval creates a connector agent
named after the client, with `TALLYLAMP_OAUTH_MAX_BROWSERS` set to 2 by default.

With its default permissions, the connector can create and drive its own browsers.
Its token cannot access another agent's browsers, the control API, the audit log,
or human takeover. The Agents page shows its `connector` kind and lets you revoke
it. Tallylamp uses its own authorization server; it needs no third-party identity
provider.

### Protocol details

- The server supports `authorization_code` and `refresh_token`. It does not
  support `client_credentials`; every connection requires human approval.
- PKCE with `S256` is mandatory. Requests without it are refused before consent.
- Client ID Metadata Documents (CIMD) let an HTTPS `client_id` URL describe its
  own registration. Tallylamp fetches it through the SSRF guard and requires
  it to identify itself. RFC 7591 dynamic client registration (DCR) is the fallback.
  Client authentication uses `none`.
- `redirect_uri` must be registered. Loopback redirects are compared without the
  port so native clients can use ephemeral ports, as described in RFC 8252 §7.3.
- RFC 8707 `resource` is enforced. Access tokens have the `<publicUrl>/mcp`
  audience and are refused on `/api/v1`.
- Authorization responses include the RFC 9207 `iss` parameter. RFC 7009 token
  revocation is available at `/oauth/revoke`.
- Access tokens last one hour by default. Refresh tokens rotate; replaying an
  authorization code or reusing a refresh token revokes the whole grant.

Protected-resource and authorization-server metadata return HTTP 200 without a
redirect at both their root and `/mcp`-suffixed well-known paths. `OPTIONS`
requests are handled at those paths and `/mcp`, allowing browser clients to send
an Authorization header. Discovery begins at
`/.well-known/oauth-protected-resource`.

### When only authentication tools appear

Claude Code issue [#59467](https://github.com/anthropics/claude-code/issues/59467)
reports version 2.1.140 choosing OAuth discovery despite a configured bearer
header. It then exposed `authenticate` and `complete_authentication` rather than
the server's tools. The report is closed as a duplicate; it does not establish
that every current client has this problem.

If you see that symptom, first check the configured token and your client's
version and logs. You can complete OAuth while signed into the dashboard.
For a deployment used only by header-based clients, `TALLYLAMP_OAUTH=0` stops
advertising discovery. This disables the OAuth route for all clients and does
not revoke existing grants; use **Revoke** on the Agents page for that.

## Generic MCP TypeScript client

The protocol tests use `@modelcontextprotocol/sdk@1.30.0` and
`StreamableHTTPClientTransport` with `requestInit.headers.Authorization`.
The transport accepts custom headers. If a session returns 404, initialize a
new one.

See [`tests/mcp.test.ts`](../tests/mcp.test.ts) for bearer transport tests and
[`tests/oauth.test.ts`](../tests/oauth.test.ts) for authorization-code, PKCE,
registration, consent, and token checks. CIMD registration uses the client's
metadata URL; DCR uses `/oauth/register`.
