# Using Tallylamp

Start with the [setup and connection instructions](../README.md#get-started).
Once an agent has opened a browser, use the dashboard to watch it or take control.

To give one browser a separate network route, see [per-browser proxies](proxies.md).

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

### Share one browser with a person

**Share with a person…**, under **Guest links** on a browser's page, makes a
single-use link for one other person. They can watch that browser and, if you
allow it, take control of it. They cannot see or change anything else. Use it
when someone else has to sign in or answer a 2FA prompt. While a guest holds
control, the page shows who they are, and **Take control** cuts them off. See
[guest links](guest-access.md).

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

## Chrome extensions and Full browser

Tab view shows the page. Full browser shows Chrome itself. Switch it on the
browser page after you take control. It needs Linux, a dedicated Xvfb display,
ffmpeg, and xdotool.

Chrome's own UI can open files on the host and change browser settings. An
installed extension can read signed-in pages and change proxy settings. The
egress proxy does not contain a privileged extension.

Stop the browser, choose **Enable extensions**, start it, take control, and
open **Full browser**. Chrome is fitted to the display when the view opens;
**Refit Chrome window** puts it back if a dialog moves it. Install from the
Chrome Web Store in Chrome's address bar. **Manage extensions** opens
`chrome://extensions/`. Switch back to Tab for ordinary work.

Nothing runs a window manager on these displays, so X keeps the keyboard on
whatever window the pointer is over. That is why the fit matters: an unfitted
Chrome leaves most of the view as bare desktop, where keystrokes go nowhere.
`TALLYLAMP_XVFB_SCREEN` sets how much desktop there is to fill, and so how large
Chrome's own toolbar and tabs are drawn in the viewer.

Persistent browsers keep installed extensions and their settings. Disable
extensions to skip loading them on the next start; that does not uninstall them.
A copied profile still needs Enable extensions on the new browser.

Set `TALLYLAMP_EXTENSIONS_DEFAULT=1` to start every new browser with extension
support on, copies included. Existing browsers keep their saved choice, and
Disable extensions still wins. It installs nothing.

**Allow agent control** is a second permission, for the owning agent only.
Borrowed browsers do not get it. Copies do not inherit it. New agent-owned
browsers start with it on. Set `TALLYLAMP_AGENT_DESKTOP_DEFAULT=0` to start
them with it off. Existing browsers keep their saved choice. Turning the toggle
off still wins. This does not enable extensions.

The agent uses `tallylamp_desktop_screenshot`, then `tallylamp_desktop_action`.
Coordinates are screen pixels. Human control stops these tools. If
`agentDesktopEnabled` is false, the agent is told to ask you to turn the toggle
on and wait. It cannot grant itself access.

Full-browser view is 6 fps and one viewer per browser. It streams the display at its
own width, or at the width of your stage if that is smaller, down to 1280px. Watch stays
read-only. Paste is 2,048 characters. Taking control or turning the permission
off interrupts in-flight native work.

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

## Use your own browser

A linked browser is your own Chrome, Edge, Brave or other Chromium browser,
reached through the Tallylamp Link extension. Choose **Link your own browser** on
the Browsers page for the three setup steps. After that, share a tab from the
extension's side panel and the agents you ticked for it can use it. Change that
list under **Who can use it** on the browser's page.
It gets no other tab. [Linked browsers](linked-browsers.md) covers what the agent
can and cannot reach, and what a linked browser does not support.

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

Five scopes require an explicit grant: `seed:use`, `seed:write`, `browser:lend`,
`browser:borrow`, and `browser:tunnel`. They allow access to copied logins,
shared profile updates, another agent's browser, or a private network address.
Use **Agents → Profile permissions** to grant profile access, or set scopes
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

## Browser details and identity

Choose **Edit browser details** to change a browser's name, project, purpose,
or task. These details belong to the browser, not a saved profile. The action
works even when you have never loaded or saved a profile template.

The browser page shows **Browser ID** with a **Copy browser ID** button. The
browser-list menu offers the same action. Use this ID for API and MCP calls.
If clipboard access fails, the dashboard shows the ID for manual copying.

In the dashboard URL `/browsers/<id>`, the final segment is the browser ID.
The browser also has a separate, name-derived slug. Renaming it changes neither
the ID nor the slug.

## Persistent profiles

Browsers use `persistent: true` by default. An idle stop ends Chrome but keeps
its profile; only an explicit delete destroys it. With `persistent: false`,
the idle expiry policy can also delete the profile, so choose persistence when
you want to return to saved logins after Chrome has been stopped.

Each browser can carry a record of signed-in sites. A person records the current
site after signing in, or an agent calls `tallylamp_report_site_access` after
seeing authenticated UI. The record contains the canonical origin, state,
timestamp, and reporter. It contains no cookies or tokens.

These records power the site badges. They are not a complete list of saved logins:
a missing badge does not mean its cookies were lost. Detection recognises visible
sign-out controls and Google's signed-in account-menu link. It can miss hidden
menus or tabs closed before inspection. **Record signed-in site** lets you add a
missed observation. It does not sign you in, copy cookies, or save a profile.
**Save profile** copies the current records into the snapshot along with all
saved logins and storage, not just the sites in the inventory.
Saving a running browser also refreshes site detection before Chrome closes.

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

### Save a reusable profile

**Stop browser** ends Chrome and keeps a persistent browser's data. It does not
create a shared snapshot. **Save profile** makes a reusable copy of its logins,
metadata, and recorded sites. It appears under **Saved profiles** right away.

1. Open the source browser and choose **Save profile**.
2. Name the saved profile and edit its project, purpose, and task if needed.
3. Choose **New browser → Use saved profile**, or **Create browser** on its saved
   profile row. The new browser keeps its own data and metadata.

Saving a running browser briefly closes Chrome to flush its data, copies the
profile, and resumes the source automatically. Finish any unsaved page edits first.
A stopped source stays stopped. If copying fails, the source is still resumed;
if restarting fails, the dashboard says so and offers **Start** to retry.

Each browser uses its own copy, not a shared Chrome directory. Changes in one
browser do not affect another. If you load a saved profile, log into another
site, then click **Save profile**, it updates that same saved profile. The save
target is shown beside the browser details. Renaming a browser does not change it.

**Save as new profile** creates a separate snapshot and makes it this browser's
new save target. The original stays unchanged. From the saved-profile list,
**Update saved profile** also lets an administrator choose a source browser.
Updates affect future copies only; browsers already created keep their own data.

To remove a saved profile, choose **Delete** on its row and confirm the popup.
This removes that snapshot and its metadata, not any browsers created from it.
Those browsers keep their logins and become unlinked from the deleted profile.
Their next Save creates a new profile rather than overwriting an older one.
Only an administrator can delete shared profiles. If disk cleanup fails, the
profile becomes unavailable immediately and cleanup retries in the background.

The compatibility API calls profiles seeds: `POST /api/v1/seeds` creates one,
and `PUT /api/v1/seeds/:id` updates it. Both accept `browserId`, `name`, and optional
`metadata`. Omitting metadata preserves it on updates; new profiles copy the
source browser's metadata.

### Save and update through MCP

- `tallylamp_list_profile_templates` lists profiles and their metadata.
- `tallylamp_create_browser` loads one with `seedId` into a new browser.
- `tallylamp_save_profile` updates the bound browser's linked profile, or creates
  one if it has none. Pass `asNew: true` to make a separate profile.
- `tallylamp_update_profile` updates an existing linked profile. It refuses to
  create one if the browser has no save target.

Both save tools accept an optional `browserId`, `name`, and replacement `metadata`.
By default they use the bound browser, preserve an existing profile's name and
metadata, and retain its ID. The update tool also accepts `profileId`, which must
match the agent's browser's save target. A running source resumes automatically,
and the calling agent reconnects to it before continuing.

Agents need the separate `seed:write` permission to save. This lets them publish
every login in an owned browser and replace its linked shared snapshot. It can
change what other authorized agents load next. An agent with only `seed:use`
cannot overwrite profiles. Borrowed browsers cannot be exported, and saving is
blocked while a human has control. Ask for consent before sharing or replacing
saved logins. Administrators can grant these permissions in **Agents → Profile
permissions**; they are not enabled automatically for existing agents.

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

Each browser has its own local safety proxy, which lets a tunnel apply to just
that browser. An optional [upstream HTTP/HTTPS proxy](proxies.md) changes its
web route without replacing those checks. DNS stays local and tunnels take
precedence. Failed upstream connections return 502 rather than falling back to
direct access. When an upstream is set, Chrome disables QUIC and WebRTC's
non-proxied UDP; the setting is not a system-wide VPN.

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
