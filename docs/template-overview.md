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

## Dependencies for Tallylamp

The public Linux amd64 image includes Node.js 22, Google Chrome, and Xvfb.
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

## Updates are your choice

The template uses the public `ghcr.io/nxfi777/tallylamp:0.1.2` image, pinned
to its digest. Automatic image updates are disabled. Pushing source code or
publishing a new release does not upgrade your deployment.

To upgrade, read the release notes, back up your `/data` volume, then change
the image reference in Railway to the new release's digest and deploy it.
Redeploying the existing digest keeps the same application version.

## What to expect

Chrome runs in headed mode, not headless mode. Xvfb gives it a display inside
the container. User-agent and device emulation let you test browser settings;
they do not make an agent behave like a person.

Profiles are saved automatically on the volume and survive stops and redeploys.
There is no separate save step. You can also prepare a profile by hand and clone
it into new browsers with explicit permission. Profile templates copy every
saved login, so only share them with agents you trust with those accounts.

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
- [Security model](https://github.com/nxfi777/tallylamp/blob/main/docs/security.md)
- [MCP compatibility](https://github.com/nxfi777/tallylamp/blob/main/docs/mcp-compatibility.md)
- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Railway volumes](https://docs.railway.com/volumes)
