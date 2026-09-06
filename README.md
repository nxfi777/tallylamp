# Tallylamp

Give your AI agent a browser you can watch and take over.

Tallylamp runs Chrome on your server and keeps its profile between sessions.
Your agent uses it through MCP, the protocol agents use to call tools, while you
can watch the same browser live from the dashboard. When a site needs your help,
take control to sign in or finish a verification step, then return control so the
agent can continue where it left off.

[MIT licensed](LICENSE). Self-host on Railway or a Docker host with a persistent
disk. The software is free; you pay for the infrastructure you run it on.

[Get started](#get-started) · [Connect an agent](#connect-an-agent) ·
[User guide](docs/usage.md) · [Security model](docs/security.md)

## When to use it

Use Tallylamp when an agent needs a browser it can come back to, especially on
sites where you need to sign in yourself.

- Keep cookies and logins in a persistent Chrome profile across restarts, though
  websites can still expire their own sessions.
- Watch what an agent is doing from the dashboard. Take control when it needs
  your help; while you have control, Tallylamp blocks agent actions that change
  the browser.
- Keep browsers for different projects and agents. The dashboard shows who
  created each browser, its purpose, and who currently has control.
- Prepare a browser by hand and let an agent use that profile later. Profile
  templates can also copy it into new browsers, with explicit permission.

Tallylamp runs headed Chrome, with a display even on a server. Sites may still
identify or block automation. It does not bypass CAPTCHAs.

## Get started

### Railway

Deploy this repository as one service using the root Dockerfile:

1. Attach a volume at `/data` to keep browser profiles and the database.
2. Set `ADMIN_SECRET` to a long random value. Generate one with
   `openssl rand -hex 32` and save it as your dashboard password.
3. Set the healthcheck path to `/healthz` and its timeout to 120 seconds.
4. Generate a public domain targeting port `8080`.
5. Open the domain, log in, and [connect an agent](#connect-an-agent).

Tallylamp infers its public URL from Railway's domain. Leave
`TALLYLAMP_DATA_DIR` unset in Railway variables and keep `.env.example` for local
use. The default cap is four browsers; start with fewer if memory is limited.
Budget roughly 1–2 GB per active Chrome, plus the server, and measure your workload.

[Railway setup, variables, and deployment limits](docs/railway.md).

### Docker

Run these commands from a clone of this repository:

```bash
export ADMIN_SECRET="$(openssl rand -hex 32)"
# Save ADMIN_SECRET in your password manager before closing this shell.
docker build -t tallylamp .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e ADMIN_SECRET \
  -e TALLYLAMP_PUBLIC_URL=http://127.0.0.1:8080 \
  -v tallylamp-data:/data \
  tallylamp
```

Open <http://127.0.0.1:8080> and log in with that secret. This command binds to
your local machine. For a remote host, put the service behind HTTPS and set
`TALLYLAMP_PUBLIC_URL` to its public origin.

## Connect an agent

Tallylamp serves MCP at `/mcp` using Streamable HTTP. Choose the authentication
method your client supports.

### Bearer token

Create an agent in the dashboard and copy its token. Configure your MCP client
with the server URL and this header:

```text
Authorization: Bearer YOUR_AGENT_TOKEN
```

For Claude Code, replace the URL and token in this command:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer YOUR_AGENT_TOKEN" \
  tallylamp https://YOUR_HOST/mcp
```

For local use, the URL is `http://127.0.0.1:8080/mcp`. The command follows
[Claude Code's HTTP MCP setup](https://code.claude.com/docs/en/mcp).
Tallylamp's automated tests exercise the protocol; they do not launch Claude Code.

Agent tokens have no expiry. Each agent has its own scopes and browser cap, so
you can give a new agent access to Tallylamp and later rotate or revoke its token
from the dashboard.

### OAuth

For clients that require OAuth, first sign into the Tallylamp dashboard. Add
`https://YOUR_HOST/mcp` to your client, then approve its connection on Tallylamp's
consent page. The page names the client and the host receiving the authorization
code. It uses your dashboard session and does not ask for your administrator secret.

Approval creates a connector agent with ordinary agent scopes and a browser cap,
which you can disconnect from the Agents page whenever you want to withdraw its
access to Tallylamp. See the
[compatibility notes](docs/mcp-compatibility.md) for supported flows and test coverage.

### Try the handoff

Ask your agent to create a Tallylamp browser and open a website. In the dashboard,
choose **Watch** to see its activity. Choose **Take control** to interact with
the page, then **Return to agent** when you're finished.

Watching is read-only. You need control to navigate, switch tabs, or type.
Your agent's MCP connection stays open during the handoff.

## How it runs

One Node.js process manages Chrome children, and Xvfb provides their display
inside the container. SQLite and browser profiles live on the `/data` volume,
so replacing the container keeps the saved data as long as you attach the same
volume to the new deployment.

| Interface | Path |
| --- | --- |
| Dashboard | `/` |
| MCP | `/mcp` |
| Control API | `/api/v1` |
| Healthcheck | `/healthz` |

The live viewer streams the agent's Chrome through an authenticated WebSocket.
Chrome's debugging port stays on loopback.

[Architecture](docs/architecture.md) · [Browser realism tests](docs/browser-realism.md) ·
[Technical research](docs/research.md)

## Before you deploy

- Railway uses one replica with a persistent volume. Redeploys interrupt running
  browsers; their profiles survive and Chrome starts again on the next use.
- Railway has no GPU for this service, and Chrome's renderer sandbox may fall
  back to running without it. The dashboard reports the sandbox and GPU state.
  Set `TALLYLAMP_SANDBOX=on` to refuse to start without a working sandbox.
- Browsers in the same container share its isolation boundary, so separate agent
  permissions and browser profiles do not give you the isolation of running each
  browser in its own virtual machine.
- The egress proxy blocks private networks by default. WebRTC/UDP is a known
  gap. Optional [loopback tunnels](docs/usage.md#loopback-tunnels) let one browser
  reach one private address with an explicit scope.
- Idle browsers stop to free memory, but persistent profiles remain until you or
  an authorized agent explicitly deletes them. Logged-in profiles and their
  snapshots contain credentials.
- There is no promise of an undetectable browser or an identical TLS fingerprint.
  Agent interaction uses chrome-devtools-mcp, not a recorded human mouse path.

Read the [security model](docs/security.md) before using sensitive accounts.
For GPU hosts, `TALLYLAMP_GPU=hardware` enables the hardware configuration.

## Develop locally

Use a current Node.js 22 release or newer, npm, and an installed Chrome or Chromium.
Linux needs a display or Xvfb. If Tallylamp cannot find Chrome in a standard
installation path, set `TALLYLAMP_CHROME_BIN` to the full path of the binary you
want it to launch.

```bash
npm ci
cp .env.example .env
# Set ADMIN_SECRET in .env to a long random value.
node --env-file=.env --import tsx src/index.ts
```

Open <http://127.0.0.1:8080>. Local browser data is stored in `./data`.
The explicit `--env-file` flag loads your settings; the app does not load `.env` itself.

```bash
npm run build
npm test                  # fake Chrome; no display needed
npm run test:realism      # installed Chrome and a display required
```

On a Linux host without a display, install Xvfb and set `TALLYLAMP_XVFB=1` for
the realism command. Use `TALLYLAMP_FAKE_CHROME=1` only in tests.

The command-line tool runs from this checkout as `node bin/tallylamp.mjs`.
See [the user guide](docs/usage.md) for recording, profiles, and tunnel commands.
Project rules and local cleanup instructions are in the
[contributor guide](docs/contributing.md).

## License and credits

Tallylamp is [MIT licensed](LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) for its dependencies and credits.
It is not a chikin fork and is not endorsed by chikin's author.
