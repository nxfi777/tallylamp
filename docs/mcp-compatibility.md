# MCP client compatibility

Date checked: 2026-09-02.

Transport: Streamable HTTP at `https://<host>/mcp`.

Authorization: `Authorization: Bearer <agent-or-admin-token>` on every
request. RFC 9728 Protected Resource Metadata is served at
`/.well-known/oauth-protected-resource`.

Do not put tokens in the URL.

## Claude Code

| | |
|---|---|
| Remote Streamable HTTP | Yes. `claude mcp add --transport http` |
| Authorization | `--header "Authorization: Bearer <token>"` |
| OAuth | Supported by the client. If discovery overrides the header, set `TALLYLAMP_OAUTH=0` or use the header-only flow. |
| Static / pre-issued credential | Yes (the header) |
| Custom headers | Yes (`--header`, repeatable) |
| Reconnection | Client-driven; Tallylamp sessions use `MCP-Session-Id`. SSE keepalives every 30s. |
| Tested version | Docs at https://code.claude.com/docs/en/mcp (page dated 2026-09-01). **Not live-connected from this workspace.** |
| Date checked | 2026-09-02 |

Documented command (from current Claude Code docs, not executed here):

```bash
claude mcp add --transport http tallylamp https://YOUR_HOST/mcp \
  --header "Authorization: Bearer tl_ag_…"
```

JSON (`type` may be `http` or `streamable-http`):

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

Known limitation: GitHub issues #47424 and #59467 describe Claude Code ignoring
a configured bearer header when the server advertises OAuth. Tallylamp's OAuth
authorize endpoint explains the bearer-token path and does not mint codes.

## Codex

Official Codex MCP remote-HTTP docs were not exercised in this workspace.
Codex generally follows the MCP Streamable HTTP client. Use a bearer header if
the installed version accepts one; otherwise consult current Codex MCP docs
before publishing a snippet.

Tested version: not live-tested. Date checked: 2026-09-02.

## Cursor

Cursor's MCP config accepts HTTP servers in `mcp.json`. Header auth depends on
the Cursor version. **Not live-tested here.** Do not copy unverified JSON.

## VS Code / GitHub Copilot

Copilot MCP remote servers follow current VS Code MCP docs. **Not live-tested
here.**

## Gemini CLI

chrome-devtools-mcp's own README shows Gemini CLI stdio configs. Remote
Streamable HTTP + bearer for Gemini CLI was **not verified**.

## Generic MCP TypeScript client

`@modelcontextprotocol/sdk@1.30.0` `StreamableHTTPClientTransport` with
`requestInit.headers.Authorization`. This is the in-repo test client shape
(see `tests/mcp.test.ts`).

| | |
|---|---|
| Remote Streamable HTTP | Yes |
| Authorization | Bearer header |
| OAuth | Client can implement it; Tallylamp does not complete authorization_code |
| Static credential | Yes |
| Custom headers | Yes |
| Reconnection | New initialize if the session 404s |
| Tested version | `@modelcontextprotocol/sdk` 1.30.0 via unit tests |
| Date checked | 2026-09-02 |
