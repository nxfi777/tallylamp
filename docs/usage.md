# Using Tallylamp

Start with the [setup and connection instructions](../README.md#get-started).
Once an agent has opened a browser, use the dashboard to watch it or take control.

## Watch and take control

Sign into the dashboard with the administrator secret. Tallylamp stores the
session in an HttpOnly cookie. The home grid lists running browsers first, with
a thumbnail, project, purpose, current URL, recorded signed-in sites, and controller.

**Watch** opens a read-only view. It cannot send input, navigate, switch tabs,
open or close them, or resize the window. An open watch tab counts as an
attachment, so the browser is not stopped by the ordinary unattached idle timer.
The separate attached-idle limit still applies. Closing the tab ends that attachment.

**Take control** acquires a lease on the same Chrome instance. While the lease is
live, agent tools that change the browser return an error asking the agent to
retry later. The MCP connection stays open. Choose **Return to agent** to release
the lease when you are done.

### Tabs, navigation, and clipboard

The browser page has a tab strip and address bar above the frame. These controls
belong to the dashboard because Chrome's screencast contains page content only.
The strip lists the browser's tabs and marks the one you are watching; once you
have control, you can use the same strip to switch, open, and close tabs.

The address bar accepts HTTP and HTTPS addresses. Other schemes are refused
because they can bypass the egress proxy. Text that is not an address goes to
the search engine you selected in the sidebar. A blank tab shows the browser
name and instructions for using it.

Pasting sends text from your clipboard into the remote page's focused field.
The remote Chrome has its own clipboard, so Tallylamp inserts the text directly.
The pointer follows the cursor shape requested by the remote page.

In control mode, Chrome's window resizes to match the viewer stage. Full screen
resizes it to the available screen area. The streamed image can be encoded at a
smaller resolution to save bandwidth; input coordinates are mapped back to the
remote window so clicks still land on the intended element.

On mobile, you can view the fleet and browser status, watch, start or stop a
browser, and return control. The first release does not aim to provide a full
remote desktop experience on a phone.

### Stream quality

The viewer sends binary JPEG frames. Compared with base64 inside JSON, this saves
about a third of the transferred bytes for the same image. When the connection
falls behind, Tallylamp lowers the encoded resolution and then JPEG quality.
Quality rises again when the socket drains, while the browser window keeps its
requested size so page layout and click targets do not move.

In an earlier stream measurement, halving image width halved the bitrate; reducing
JPEG quality from 70 to 55 saved about 18%. Those observations informed the order
of the quality adjustments. See the [viewer settings](railway.md#viewer-settings)
for the current limits.

## Record a page interaction

An agent can call `tallylamp_screencast_start`, perform an interaction, then call
`tallylamp_screencast_stop` to get timestamped frames. This helps answer questions
such as how long a transition took or whether the page acknowledged a click.

The recording clock starts when the page first changes. This leaves time for the
start call to return to the agent before it performs the interaction, even when
the connector round trip takes several seconds. Waiting consumes no frame budget.
There is a separate bound on how long the recording can wait for movement.

Chrome sends one frame as soon as the screencast starts. Tallylamp keeps that as
the before image and measures timings from the motion that follows. After the
page has been still briefly, recording ends automatically, so the agent does not
have to guess a duration for a short transition.

Later frames arrive only when the page repaints. A still page can therefore yield
no motion frames. Captures stay in memory, have server-side limits, and report
which limit stopped them. A human control lease blocks recording as it does
other mutating tools.

## Agents and browser ownership

Create agents in the dashboard. Each gets a bearer token, a browser cap, and
scopes such as `browser:create` and `browser:list:own`.

Four scopes require an explicit grant: `seed:use`, `browser:lend`,
`browser:borrow`, and `browser:tunnel`. They allow access to copied logins,
another agent's browser, or a private network address. Set them deliberately
with `PATCH /api/v1/agents/:id`.

Agents create browsers through `tallylamp_create_browser` or
`POST /api/v1/browsers`. Source, project, and purpose metadata are optional.
The tool asks for them when known, but they cannot change the recorded identity
of the creator. A browser created by an agent is attributed to that agent even
if its metadata claims `source: human`.

MCP `clientInfo` is stored alongside the authenticated principal as a reported
client name. If you want to prepare an account before an agent uses it, you can
create a browser in the dashboard, sign into sites, stop it, and let the agent
use that profile later. See [browser lending](architecture.md#lending-a-browser-between-agents)
for the separate rules for handing a browser between agents.

## Persistent profiles

Browsers use `persistent: true` by default. An idle stop ends Chrome but keeps
its profile; only an explicit delete destroys it. With `persistent: false`,
the idle expiry policy can also delete the profile, so choose persistence when
you want to return to saved logins after Chrome has been stopped.

Each browser can carry a record of signed-in sites. A person records the current
site after signing in, or an agent calls `tallylamp_report_site_access` after
seeing authenticated UI. The record contains the canonical origin, state,
timestamp, and reporter. It contains no cookies or tokens.

`tallylamp_list_browsers` includes these records, but they describe access at the
time it was observed: a website may have expired the session by the time another
agent comes back to use it.

There is no separate save step for a persistent profile. Reopen the same browser
with `tallylamp_use_browser` for later work on the same project and account.
MCP instructions ask agents to check for a suitable browser before creating one
or requesting another sign-in. After a successful human sign-in and return of
control, the agent should confirm access, record the site, and explain that the
profile is saved. If future reuse is unclear, it should ask once whether you want
to reuse that browser. A temporary-session choice still needs to be respected.
For routine cleanup, stop a persistent browser rather than deleting its profile.

### Profile templates

Reuse the same browser when you can; it does not need a template. When separate
browsers need the same prepared setup, stop the source browser after active work
is finished, snapshot it, and clone the snapshot into new browsers. The API calls
these templates seeds. Only an administrator can create a snapshot, and a running
profile cannot be snapshotted. There is no MCP tool for creating a template;
an agent should offer the option, explain that it copies every saved login, ask
for consent, and direct the administrator to the dashboard to create it.

Cloning requires `seed:use` because the clone receives every login in the profile.
A seed ID is not a secret or proof of permission. Some websites invalidate copied
sessions; inherited site records start as `expected` and become `confirmed` only
after the new browser checks them.

## Authentication

The administrator secret signs you into the dashboard. Agent and connector tokens
are stored as hashes in the database and can be revoked. Their roles differ:

- `ADMIN_SECRET` creates a dashboard session cookie. It works as a bearer token
  only if `TALLYLAMP_ADMIN_BEARER=1`. Rotating it ends every dashboard session and
  revokes the OAuth grants it approved.
- `tl_ag_…` agent tokens work with MCP and the control API. They have no expiry
  and can be rotated.
- `tl_oa_…` connector access tokens work only at `/mcp`. They are bound to that
  audience, refused on `/api/v1`, and last one hour by default before renewal.
- `tl_rt_…` connector refresh tokens work only at the token endpoint. They rotate;
  reusing an old one revokes the whole grant.

Agents cannot administer other agents or read dashboard session cookies.
The [security model](security.md) also covers viewer tickets and tunnel tokens.

## Network isolation

The egress proxy blocks loopback, private, ULA, link-local, and metadata addresses
by default. Chrome still handles TLS directly with the destination through CONNECT.
`TALLYLAMP_ALLOW_PRIVATE_NETWORK=1` disables the private-network restriction.
WebRTC/UDP traffic is outside the HTTP proxy's coverage.

Each browser has its own proxy, which lets a tunnel apply to just that browser.

### Loopback tunnels

Chrome runs on the server, so an address such as `localhost:5173` refers to the
server. If an OAuth provider redirects to `http://localhost:PORT/callback`,
the callback will not reach the app waiting on your own machine.

A tunnel lets one browser reach one private `host:port`. Run the following from
a clone of this repository on the machine running the local app:

```sh
TALLYLAMP_TOKEN=tl_ag_… TALLYLAMP_URL=https://… \
  node bin/tallylamp.mjs tunnel 5173 --browser my-browser
```

`localhost` and `127.0.0.1` are separate bindings. For an OAuth callback, bind
the spelling used in the registered `redirect_uri`.

The local machine opens an outbound socket. No new local listener or public
hostname is created. Unlike a public quick tunnel, there is no public URL through
which strangers can reach the app. The authority must be private: a public
hostname is rejected because it would redirect that browser's traffic for a real site.

Tunnels require the non-default `browser:tunnel` scope. While one is open, any
page in that browser can reach its bound address. Read the
[tunnel security rules](security.md#loopback-tunnels) before opening one.

## Fleet limits and browser realism

The default fleet cap is four browsers. `/api/v1/status` reports the available
slots. Idle Chrome processes stop while persistent profiles remain; the fleet
and idle limits are configured in the [Railway settings](railway.md#browser-and-session-settings).

Tallylamp connects MCP to headed Chrome without Puppeteer stealth plugins.
The [realism reference](browser-realism.md) describes the surfaces captured,
what the tests check, and the limits of those checks.
