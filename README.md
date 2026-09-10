# Tallylamp

Give your AI agent a browser you can watch and take over.

[Tallylamp](https://tallylamp.dev) runs full, headed Chrome on your server, with
a display and Chrome's normal user agent. Each browser has its own profile,
saved by default, so you can return to the same cookies, logins, and local storage
after a restart. Websites can still expire logins or ask you to sign in again.

Your agent uses the browser through MCP, the protocol agents use to call tools.
You can watch that same browser live from the dashboard. When a site needs your
help, take control to sign in or finish a verification step, then return control
so the agent can continue where it left off.

[MIT licensed](LICENSE). Self-host on Railway or a Docker host with a persistent
disk. The software is free; you pay for the infrastructure you run it on.

[Website](https://tallylamp.dev) · [Get started](#get-started) · [Connect an agent](#connect-an-agent) ·
[User guide](docs/usage.md) · [Security model](docs/security.md)

## When to use it

Use Tallylamp when an agent needs a browser it can come back to, especially on
sites where you need to sign in yourself.

- Sign in by hand, then reuse that saved profile for recurring agent tasks.
  There is no separate save step or profile export to manage.
- Watch what an agent is doing from the dashboard. Take control when it needs
  your help; while you have control, Tallylamp blocks agent actions that change
  the browser.
- Keep browsers for different projects and agents. The dashboard shows who
  created each browser, its purpose, and who currently has control.
- Prepare a browser by hand and let an agent use that profile later. Profile
  templates can also copy it into new browsers, with explicit permission.
- Test pages with a different user agent, mobile or desktop viewport, touch
  input, or location through MCP's `emulate` tool.

Chrome runs in headed mode, not headless mode. Emulation changes selected browser
settings for testing; it does not make an agent behave like a person. Sites may
still identify or block automation. Tallylamp does not bypass CAPTCHAs. See the
[browser realism notes](docs/browser-realism.md) for what the tests cover.

## Get started

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/tallylamp?referralCode=nxfi777&utm_medium=integration&utm_source=template&utm_campaign=generic)

The template sets up the public `0.1.1` image, a persistent `/data` volume,
healthcheck, HTTPS domain, and a generated dashboard password. It pins the image
digest and leaves automatic upgrades disabled.

The newer `0.1.2` image is available for manual deployments; the published
template still pins `0.1.1`. See the [release and upgrade notes](docs/railway.md#releasing-and-upgrading).

1. Deploy the template into your Railway workspace.
2. Copy `ADMIN_SECRET` from the service's Railway variables and save it as your
   dashboard password.
3. Open the generated domain, log in, and [connect an agent](#connect-an-agent).

Tallylamp infers its public URL from Railway's domain. Leave
`TALLYLAMP_DATA_DIR` unset in Railway variables and keep `.env.example` for local
use. The template starts with `TALLYLAMP_MAX_BROWSERS=2`; the app default is four.
Budget roughly 1–2 GB per active Chrome, plus the server, and measure your workload.

[Railway setup, variables, and deployment limits](docs/railway.md).

### Docker

Run the published Linux amd64 image:

```bash
export ADMIN_SECRET="$(openssl rand -hex 32)"
# Save ADMIN_SECRET in your password manager before closing this shell.
docker run --rm --platform linux/amd64 -p 127.0.0.1:8080:8080 \
  -e ADMIN_SECRET \
  -e TALLYLAMP_PUBLIC_URL=http://127.0.0.1:8080 \
  -v tallylamp-data:/data \
  ghcr.io/nxfi777/tallylamp:0.1.2
```

Open <http://127.0.0.1:8080> and log in with that secret. This command binds to
your local machine. For a remote host, put the service behind HTTPS and set
`TALLYLAMP_PUBLIC_URL` to its public origin.

For a native ARM build or local changes, clone the repository and run
`docker build -t tallylamp .`, then use `tallylamp` as the image name and omit
`--platform linux/amd64`.

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
