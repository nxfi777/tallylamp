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
[User guide](docs/usage.md) · [Per-browser proxies](docs/proxies.md) · [Linked browsers](docs/linked-browsers.md) · [Security model](docs/security.md)

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
- Choose **Save profile** to make its logins and metadata reusable in new,
  independent browsers. A running source briefly pauses and resumes automatically.
  Copying every saved login requires explicit permission.
- Test pages with a different user agent, mobile or desktop viewport, touch
  input, or location through MCP's `emulate` tool.
- Route a browser through its own HTTP or HTTPS proxy, with optional username
  and password. Other browsers can keep their existing routes.
- Finish an OAuth flow whose redirect URI is `http://localhost:PORT/…`. A
  [loopback tunnel](#loopback-tunnels) lets one browser reach one port on your
  machine for a short time. Agents need a scope they do not get by default.
- Install a Chrome extension in **Full browser**. Optionally let the owning
  agent use its popup after you turn on **Allow agent control**.
- Let an agent look at one of your browsers without touching it. Approve its
  request at **read**, and it can see pages but not click, type or navigate.

Chrome runs in headed mode, not headless mode. Emulation changes selected browser
settings for testing; it does not make an agent behave like a person. Sites may
still identify or block automation. Tallylamp does not bypass CAPTCHAs. See the
[browser realism notes](docs/browser-realism.md) for what the tests cover.

## Get started

### Browser details, site records, and saved profiles

Persistent browsers keep their cookies and logins automatically. Reopen the same
browser to use them again; no separate save step is needed.

| Dashboard action | What it does |
| --- | --- |
| **Edit browser details** | Changes this browser's name, project, purpose, and task. No saved profile needs to be loaded. |
| **Record signed-in site** | Adds an observation for agents to find. It does not sign you in or copy cookies. |
| **Save profile** | Copies all saved logins and storage into a reusable snapshot, or updates the linked snapshot. It is not limited to recorded sites. |
| **Copy browser ID** | Copies the stable ID used by API and MCP tools. Find it beside Browser ID on the browser page, or in the browser-list menu. |

The dashboard URL uses `/browsers/<id>`. That ID is separate from the browser's
name-derived slug. Editing browser details changes neither. See the
[user guide](docs/usage.md#browser-details-and-identity) for details.

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/tallylamp?referralCode=nxfi777&utm_medium=integration&utm_source=template&utm_campaign=generic)

The template sets up the public `0.8.0` image, a persistent `/data` volume,
healthcheck, HTTPS domain, and a generated dashboard password. It pins the image
digest and leaves automatic upgrades disabled.

See the [release and upgrade notes](docs/railway.md#releasing-and-upgrading)
before changing an existing deployment's image.

1. Deploy the template into your Railway workspace.
2. Copy `ADMIN_SECRET` from the service's Railway variables and save it as your
   dashboard password.
3. Open the generated domain, log in, and [connect an agent](#connect-an-agent).

Tallylamp infers its public URL from Railway's domain. Leave
`TALLYLAMP_DATA_DIR` unset in Railway variables and keep `.env.example` for local
use. There is no browser cap by default; set `TALLYLAMP_MAX_BROWSERS` to add one.
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
   ghcr.io/nxfi777/tallylamp:0.8.0
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

### Let someone else sign in

When the 2FA code goes to a colleague's phone, send them a guest link instead of
the admin secret. On the browser's page, choose **Share with a person…**. The
link opens that one browser and nothing else. It works once, expires within 24
hours, and you can revoke it at any time. The guest can watch and, if you allow
it, take control from the agent, but never from you. Everything they do is
recorded in the audit log under their name. A guest can use every login saved in
that browser, so share one that holds only what they need. See
[guest links](docs/guest-access.md).

### Let an agent use one of your browsers

An agent can ask for a browser you own. The request shows up on **Browsers** with
the agent's name and its reason. You can approve it at **control**, which lets
the agent act in the browser, or at **read**, which lets it see pages and nothing
more. You can also approve a control request as read only. Pick how long the
grant lasts, from 30 minutes up to until you revoke it. The browser's page lists
everyone with access, with a **Revoke** button for each. See
[lending and granting access](docs/architecture.md#lending-and-granting-access-to-a-browser).

### Per-browser proxies

Set a proxy in **New browser**, or stop an existing browser and choose
**Configure** beside **Proxy**. Start it again to use the new route. The same settings
work through `tallylamp_create_browser`, `tallylamp_update_browser`, and the
browser create/update API:

```json
{
  "proxy": {
    "server": "https://proxy.example.com:8443",
    "username": "your-user",
    "password": "your-password"
  }
}
```

Omit both credentials for a proxy without a login. Set `proxy` to `null` to
return to direct access. Settings survive restarts but are not copied into
saved profile templates. Only the owner or an administrator can change them.

HTTP and HTTPS CONNECT proxies are supported; SOCKS and PAC are not. DNS is
resolved on the server, tunnels take precedence, and a failed proxy request
never falls back to direct access. Credentials are hidden from responses but
stored **unencrypted in SQLite**, so protect `/data` and its backups. See the
[proxy guide](docs/proxies.md) for setup, security, and connection limits.

### Chrome extensions

**Tab** shows the page. **Full browser** shows Chrome itself: toolbar, popups,
side panels, and dialogs. Switch it on the browser page. It needs Linux, a
dedicated Xvfb display, ffmpeg, and xdotool. The published `0.8.0` image
includes those tools.

Chrome's own UI can open files on the host and change browser settings. An
installed extension can read signed-in pages and change proxy settings. The
egress proxy does not contain a privileged extension. Use this only with
administrators and extensions you trust.

To install an extension:

1. Take control and open **Full browser**. Chrome is fitted to the display for
   you; **Refit Chrome window** puts it back if a dialog moves it. New browsers
   already have the **Extensions** switch on; if it was turned off, stop the
   browser, turn it back on, and start it again.
2. Open the Chrome Web Store in Chrome's address bar and install it there.
   Permission dialogs show in this view.
3. Use the toolbar for popups, or **Manage extensions** for
   `chrome://extensions/`. Switch back to **Tab** for ordinary work.

Persistent browsers keep installed extensions and their settings. **Disable
extensions** skips loading them on the next start; it does not uninstall them.
A copied profile brings its extensions with it, and new browsers load them by
default. There is no upload API.

Agents cannot turn extension support on. To let the owning agent use popups,
turn on **Allow agent control**. That is a second permission. It gives the
agent the same native UI, including settings and host-file dialogs. Borrowed
browsers do not get it. Copies do not inherit it.

New agent-owned browsers start with that permission on. Set
`TALLYLAMP_AGENT_DESKTOP_DEFAULT=0` to start them with it off. Existing browsers
keep whatever you already chose. Turning the toggle off still wins. This does
not enable extensions.

The agent uses `tallylamp_desktop_screenshot`, then `tallylamp_desktop_action`.
Coordinates are screen pixels, not the downscaled image. Human control stops
these tools. If `agentDesktopEnabled` is false, the agent is told to ask you to
turn the toggle on and wait. Limits and the API are in the
[user guide](docs/usage.md#chrome-extensions-and-full-browser).

### Loopback tunnels

Chrome runs on the server. Inside the browser, `localhost` is the server. The
server has no route to your laptop, and its egress proxy refuses private
addresses anyway. A redirect to `http://localhost:3000/callback` ends on the
server, and the app waiting on your machine never sees it.

A loopback tunnel is the one exception. It binds one browser to one private
`host:port` on your machine; public hostnames are rejected. Run this from a
clone of this repository, on the machine that has the port, with Node 22 or newer:

```bash
TALLYLAMP_TOKEN=tl_ag_… TALLYLAMP_URL=https://YOUR_HOST \
  node bin/tallylamp.mjs tunnel 3000 --host localhost --browser my-browser
```

The client binds `127.0.0.1` unless you pass `--host`, and `localhost` is a
separate binding. Match the spelling in your registered redirect URI. Your
machine opens an outbound WebSocket. Nothing new listens, and there is no
public URL.

Only the browser's owner or an administrator can open a tunnel. An agent also
needs the non-default `browser:tunnel` scope. With it, the agent that owns the
browser can call `tallylamp_open_tunnel`, which returns the command to run on
your machine. Lending the browser closes its tunnels.

A tunnel expires after an hour by default. While it is open, any page in that
browser can reach the bound address, so close it when the job is done. Ctrl-C
ends a tunnel the client opened. A tunnel an agent opened stays until it expires,
the agent closes it, or you close it in the dashboard. See [loopback tunnels](docs/usage.md#loopback-tunnels)
and the [security rules](docs/security.md#loopback-tunnels).

### Use the browser you already have

An agent can also drive a tab in your own Chrome, Edge, Brave or other Chromium
browser. Install [Tallylamp Link](https://github.com/nxfi777/tallylamp/releases/latest/download/tallylamp-link.zip),
approve the browser once in the dashboard, then share tabs one at a time from its
side panel. One click takes a tab back. It suits sites that challenge a datacenter
IP, and pages you already have open. It needs Tallylamp 0.6.0 or later; 0.6.1 adds choosing which agents may use it. Firefox
and Safari cannot be linked. Your Tallylamp dashboard can never be shared, because
an agent there could approve its own requests. A site where a password manager or
another extension has put its own frame will not share either, until that
extension stops running there. See [linked browsers](docs/linked-browsers.md).

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
- The local egress proxy blocks private networks by default, even when a browser
  uses an upstream proxy. Proxied browsers disable QUIC and WebRTC's non-proxied
  UDP, but this is not a VPN or an OS network sandbox. Optional
  [loopback tunnels](docs/usage.md#loopback-tunnels) let one browser reach one
  private address with an explicit scope.
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
