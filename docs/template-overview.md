# Deploy and Host Tallylamp on Railway

Give your AI agent a browser you can watch and take over.

[Tallylamp](https://tallylamp.dev) gives your agent full, headed Chrome with a
display and Chrome's normal user agent. Each browser saves its own profile by
default, including cookies, logins, and local storage. Your agent can come back
to that profile for its next task instead of starting with an empty browser.

Your agent drives the browser through MCP. You can watch the same browser live,
take control to sign in or finish a verification step, then return it to the agent.
Websites can still expire logins or ask you to sign in again.

Tallylamp is open source under the MIT license. You pay Railway for the
infrastructure used by your deployment.

## About Hosting Tallylamp

One prebuilt container with Chrome, Xvfb, and Node.js, plus a persistent volume
at `/data`. The volume holds browser profiles and the SQLite database.
The service provides an authenticated dashboard and an MCP endpoint at `/mcp`.

The template generates a unique `ADMIN_SECRET` for each deployment.
After deploying, copy that value from your service's Railway variables, open
the public domain, and use it to sign into the dashboard.

## Why Deploy Tallylamp on Railway?

Railway provisions the service, HTTPS domain, and persistent volume in your
workspace. The template supplies the healthcheck and a generated dashboard
password. You choose when to upgrade the application.

## Common Use Cases

- Keep a browser profile ready for an agent's recurring tasks.
- Take control to sign in, then let the agent continue.
- Watch a browser session live to inspect what the agent is doing.
- Test pages with different user agents, mobile or desktop viewports, touch
  input, and locations through MCP's `emulate` tool.
- Give one browser its own HTTP or HTTPS proxy without changing the others.
- Finish an OAuth flow whose redirect URI is `http://localhost:PORT/…`, through
  a short-lived loopback tunnel to one private address on your machine. Agents
  need a scope they do not get by default.
- Install a Chrome extension from the Web Store in Full browser.
- Let an agent use a tab in your own Chrome, with the logins it already has,
  through the Tallylamp Link extension.

## Dependencies for Tallylamp

The public Linux amd64 image includes Node.js 22, Google Chrome, Xvfb, ffmpeg,
and xdotool.
SQLite runs in the same container; there is no separate database service to set up.

### Deployment Dependencies

- A Railway account with enough memory for the browsers you run.
- A persistent volume mounted at `/data`, configured by the template.
- The generated `ADMIN_SECRET` from your service's variables, used to sign in.

## Connect your agent

For a client that accepts bearer tokens, create an agent in the dashboard.
Copy its token and configure the client with `https://YOUR_HOST/mcp` and an
`Authorization: Bearer YOUR_AGENT_TOKEN` header.

For a client that requires OAuth, sign into the dashboard first, add the same
MCP URL to your client, and approve the connection on Tallylamp's consent page.
The connector gets its own agent permissions and browser cap.

Ask your agent to create a browser and open a site. Choose **Watch** in the
dashboard to see it, **Take control** to use it yourself, and **Return to agent**
when you're done. Tallylamp blocks agent actions that change the browser while
you have control.

## Chrome extensions

Tab view is the page. Full browser is Chrome's toolbar and dialogs. Stop the
browser, choose Enable extensions, take control, then switch to Full browser
to install from the Chrome Web Store.

Chrome's own UI can open files on the host and change browser settings. An
installed extension can read signed-in pages. Use this only with administrators
and extensions you trust.

Allow agent control is a separate toggle, off by default. It lets the owning
agent see and use that native UI, including settings and host-file dialogs.
Set `TALLYLAMP_AGENT_DESKTOP_DEFAULT=1` only if you trust every new agent-owned
browser with that access. The published image includes ffmpeg and xdotool.

## Use your own browser

Your agent can also use a tab in your own Chrome, Edge, Brave or other Chromium
browser. Download [Tallylamp Link](https://github.com/nxfi777/tallylamp/releases/latest/download/tallylamp-link.zip),
unzip it and load it at `chrome://extensions` with Developer mode on. Enter your
Railway domain in its side panel, approve the code in the dashboard, then share
a tab. The extension connects out to your domain, so Railway needs no extra
variable or port.

The agent gets only the tabs you share, and you can take them back at any time.
Inside a shared tab it acts as you, on whatever that tab is signed in to. The
extension blocks the browser-wide cookie jar, other tabs and local files.
Firefox and Safari cannot be linked. The
[linked browser guide](https://github.com/nxfi777/tallylamp/blob/main/docs/linked-browsers.md)
covers the limits.

## Reach localhost on your own machine

Chrome runs in the Railway container, so `localhost` inside the browser means
the container. A redirect to `http://localhost:PORT/callback` ends there, and
the app waiting on your machine never sees it.

A loopback tunnel binds one browser to one private `host:port` on your machine.
Your machine dials out, with no new listener and no public URL. Only the
browser's owner or an administrator can open one, and an agent also needs the
non-default `browser:tunnel` scope. Lending the browser closes its tunnels.
A tunnel expires after an hour by default. While it is open, any page in that
browser can reach that address, so close it when the job is done. The
[tunnel guide](https://github.com/nxfi777/tallylamp/blob/main/docs/usage.md#loopback-tunnels)
has the command to run on your machine.

## Use a proxy for one browser

Enter the proxy server and optional username/password in **New browser**.
For an existing browser, stop it, choose **Configure proxy**, save, and start
it again. The API and MCP tools accept the same per-browser settings.
No shared proxy variable or credential is needed in Railway.

Settings persist on `/data` but are not copied into saved profile templates.
Only the owner or an administrator can edit them. HTTP and HTTPS CONNECT
proxies are supported; SOCKS and PAC are not. DNS stays on the server, loopback
tunnels keep their own route, and proxy failures never fall back to direct access.

Proxy credentials are hidden from API responses but stored unencrypted in
SQLite. Protect the volume and its backups, and prefer an HTTPS proxy so the
proxy login is encrypted in transit. The [proxy guide](https://github.com/nxfi777/tallylamp/blob/main/docs/proxies.md)
covers connection limits. A proxy is not a VPN or a guarantee that sites will
accept automation.

## Updates are your choice

The current release is `ghcr.io/nxfi777/tallylamp:0.5.2`. Pin this digest:

```text
ghcr.io/nxfi777/tallylamp@sha256:1326f0b017063a4ae5eeca02439aa4536a08b57aae2b1698e6d9405ad252f9c7
```

Automatic image updates are disabled. Pushing source code or publishing a new
release does not upgrade your deployment.

To upgrade, read the release notes, back up your `/data` volume, then change
the image reference in Railway to that digest and deploy it.
Redeploying the existing digest keeps the same application version.

## What to expect

Chrome runs in headed mode, not headless mode. Xvfb gives it a display inside
the container. User-agent and device emulation let you test browser settings;
they do not make an agent behave like a person.

Persistent browsers keep their own data automatically across stops and redeploys.
**Record signed-in site** only adds an inventory note for agents; it does not
sign you in or copy cookies. **Edit browser details** changes the browser's name
and metadata, whether or not you loaded a saved profile. Use **Copy browser ID**
on the browser page to get its stable API/MCP ID, not its name-derived slug.

**Save profile** creates a reusable snapshot, or updates the browser's linked
profile. **Save as new profile** creates a separate snapshot. Existing browsers
stay independent; updates affect future copies only. A snapshot contains all
saved logins, not just the sites listed in the inventory.

Agents can load, modify, and update profiles through MCP. Enable loading and
saving separately under **Agents → Profile permissions**. Saving requires
`seed:write`; borrowing a browser never permits exporting its logins. Saved
profiles contain every login, so share them only with agents you trust.

Delete a saved profile through its confirmation popup without deleting existing
browsers or signing them out. Site badges show detected or reported sign-ins,
not every saved login. A missing badge does not mean a login was lost.

Chrome needs memory. Start with a cap of two browsers and budget roughly
1–2 GB per active browser, plus the server. Measure your own workload before
raising the cap.

A volume-backed deployment uses one replica. Redeploys interrupt active browsers;
their profiles remain, and Chrome starts again on the next use. Railway provides
no GPU for this service, and Chrome's renderer sandbox may be unavailable.
The dashboard reports both states. Browsers share the container's isolation boundary.

Tallylamp does not bypass CAPTCHAs or guarantee that sites will accept automation.

## Source and documentation

- [Tallylamp website](https://tallylamp.dev)
- [Source code and setup](https://github.com/nxfi777/tallylamp)
- [Browser realism and emulation limits](https://github.com/nxfi777/tallylamp/blob/main/docs/browser-realism.md)
- [Railway configuration](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md)
- [Per-browser proxy setup](https://github.com/nxfi777/tallylamp/blob/main/docs/proxies.md)
- [Linked browsers](https://github.com/nxfi777/tallylamp/blob/main/docs/linked-browsers.md)
- [Security model](https://github.com/nxfi777/tallylamp/blob/main/docs/security.md)
- [MCP compatibility](https://github.com/nxfi777/tallylamp/blob/main/docs/mcp-compatibility.md)
- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Railway volumes](https://docs.railway.com/volumes)
