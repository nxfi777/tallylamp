# Deploy and Host Tallylamp with Railway

Tallylamp gives AI agents persistent headed Chrome sessions you can watch and take over. Deploy one service, attach a volume, set an admin secret, and point MCP clients at `/mcp`.

## About Hosting Tallylamp

Tallylamp is a single Docker service. It launches real headed Chrome processes (Xvfb) inside the container, stores profiles and SQLite state on a volume at `/data`, and fronts them with Streamable HTTP MCP plus an authenticated dashboard. A volume is required: without it, logins and browser records vanish on every deploy. Chrome is memory-heavy; start with a small fleet cap (`TALLYLAMP_MAX_BROWSERS=4`). The renderer sandbox often cannot enable on Railway — the dashboard reports that instead of hiding it. There is no GPU; WebGL is software or absent.

## Common Use Cases

- Give Claude Code / Codex a persistent logged-in browser
- Watch an agent live and take the keyboard when OAuth or verification appears
- Prepare a golden profile by hand, snapshot it, clone it for new browsers
- Keep cookies across Railway redeploys on the volume

## Dependencies for Tallylamp Hosting

- Docker image with Google Chrome or Chromium, Xvfb, Node 22
- One Railway volume mounted at `/data`
- `ADMIN_SECRET` (generate; never commit)
- `TALLYLAMP_PUBLIC_URL` set to the public HTTPS origin

### Deployment Dependencies

- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) 1.8.0
- [Model Context Protocol](https://modelcontextprotocol.io/) Streamable HTTP
- [Railway volumes](https://docs.railway.com/volumes)

### Why Deploy Tallylamp on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Tallylamp on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
