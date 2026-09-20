# Security

## Threat model

Tallylamp is designed for one administrator and the agents they create. A Railway
deployment is exposed to the public internet. Treat websites loaded in Chrome as
untrusted: an agent with browser control can access the accounts signed into that
profile. Browsers in one deployment share a container and a Unix user.

The administrator can also hand one browser to another person with a
[guest link](guest-access.md). Treat that person as fully untrusted apart from
holding a valid token for that one browser. See [Guest links](#guest-links) below.

## Credentials

### Administrator

`ADMIN_SECRET` is compared with a length-checked `crypto.timingSafeEqual`.
A successful login sets `tallylamp_session`, an HttpOnly cookie with SameSite=Lax
and Secure on HTTPS. The session is not stored in localStorage.

For cookie-authenticated requests that change state, an `Origin` header must be
trusted when present. `ADMIN_SECRET` is accepted as a bearer token only when
`TALLYLAMP_ADMIN_BEARER=1`.

### Agent tokens

Agent bearer tokens (`tl_ag_…`) are stored as SHA-256 hashes. Rotating a token
revokes its previous hashes, and disabled agents cannot authenticate.

### OAuth connectors

Completing an authorization-code grant creates a connector agent. It receives
ordinary agent permissions and tokens bound to the `<publicUrl>/mcp` audience:
`tl_oa_…` access tokens last one hour by default; `tl_rt_…` refresh tokens rotate
and have a default 30-day idle expiry. They are refused on `/api/v1`.

The consent page requires a live dashboard session and an HMAC token bound to
that session, client, and exact redirect URI. The `client_id` must identify a
registration issued by this server or an HTTPS client-metadata document that
names itself. Whichever registration method the client uses, the redirect URI must be one
registered for that client, so consent cannot send an authorization code to an
arbitrary address supplied in the request.

Replaying an authorization code or reusing a refresh token revokes the whole
grant. Revoking the connector agent disconnects the client, but its browser
profiles keep their cookies. If a profile was compromised, delete the browser
as well; revocation alone does not remove those saved logins.

### Tunnel tokens

A `tl_tn_…` token authenticates a WebSocket connection to one tunnel binding.
It is shown once, stored as a SHA-256 hash in `browser_tunnels`, and refused
as a bearer credential on both `/api/v1` and `/mcp`.

### Link tokens

A `tl_ln_…` token authenticates the Tallylamp Link extension's WebSocket for one
[linked browser](linked-browsers.md). It is minted when the extension collects an
approved pairing, shown once, stored as a SHA-256 hash in `browser_links`, and
refused as a bearer credential on both `/api/v1` and `/mcp`. It travels in the
socket's first message, never in the URL. Revoking the link, deleting the browser
or rotating `ADMIN_SECRET` ends it.

The pairing code a person reads off the extension is not a credential. It names a
request that only a signed-in administrator can approve, lasts 10 minutes and
works once.

### Guest links

A guest link token (`tl_guest_…`) is shown once and stored as a SHA-256 hash in
`browser_guests`. It travels in the URL fragment, which browsers do not send, so
it stays out of server logs, proxy logs and `Referer`. The guest page reads it,
removes it from the address bar and, only after the guest presses a button,
exchanges it at `POST /guest/api/v1/session` for a `tallylamp_guest` session
cookie. The button is there so that link scanners in mail and chat services do
not use up the link.

The link is single use. The first exchange spends it atomically. A later
exchange gets the same 401 as any invalid token and is audited as
`guest.link.reused`, which tells the operator the link got out. The cookie is
HttpOnly and SameSite=Strict, Secure on HTTPS, scoped to `Path=/guest`, and
expires with the link. The link token is not a bearer credential anywhere:
`/api/v1` and `/mcp` refuse it.

Guests are not API principals. Every existing permission check was written for
two kinds of caller, an administrator and an agent. A number of them restrict
agents with a `type === "agent"` test and let every other caller through as the
administrator. A third principal type would have landed on the administrator
side of each of those checks, on every entry point. So a guest session is read
only by the guest router under `/guest/api/v1`, from its own cookie on its own
path. `/api/v1`, `/mcp`, the OAuth pages and the tunnel and link sockets cannot
resolve it, and they do not receive the cookie. A route added there later is
closed to guests without anyone having to remember. The guest router takes no
browser id: the browser is the one on the grant. Every other path under
`/guest/api` returns the same 403, whether or not it exists.

The guest router requires a trusted `Origin` on every request that changes
state, with no bearer exemption and no allowance for a missing header. `GET`
requests refuse a foreign `Origin` or a cross-site `Sec-Fetch-Site`. The guest
page is served with its own script and stylesheet, never the dashboard bundle,
under `default-src 'none'; script-src 'self'`, `frame-ancestors 'none'`,
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

A guest can take control only when nobody holds it or an agent does. It can never
use `force`, and it can never take control from the administrator or another
guest. Returning control releases only the guest's own lease. The guest's lease
ends when the link is revoked or expires, or after
`TALLYLAMP_GUEST_MAX_LEASE_SEC` (30 minutes) of continuous control. That clock
belongs to the guest, not to one lease. Every way a guest's lease can end
records when it ended: release, lapse, displacement or expiry. Taking control
again before `TALLYLAMP_GUEST_LEASE_COOLDOWN_SEC` has passed continues the same
hold. A guest that reaches the limit must wait out that cooldown. Revoking a
link, or the guest pressing Leave, deletes its session, releases its lease and
closes its viewer sockets at once. Expiry is checked on every lease read and
every 10 seconds on each open guest socket.

A guest viewer is refused the `desktop` surface, since that surface drives the
whole X display, `chrome://extensions` included. A guest may hold at most
`TALLYLAMP_GUEST_MAX_VIEWERS` sockets (3) at once and may open at most 10 tabs,
because each socket holds a CDP connection and a screencast.

A guest sees the tab the link was handed over on. The first viewer pins it for
the link's lifetime, so a reconnect cannot land the guest on whatever tab is
newest. A guest also sees blank tabs and, if the link allows navigation, tabs on
its hosts. Nothing else, including the viewer's own choice of a tab when the
streamed tab closes or an attach fails. When no permitted tab is left, the
guest's socket closes. The tab list a guest receives is filtered the same way,
so it does not reveal the titles and URLs of other open tabs.

Page input, paste, reload and resize are allowed. Back and forward are allowed,
except into history entries that existed when the guest's viewer first showed
that tab, unless the link allows their host. Those entries are what the agent or
operator browsed before the handoff. The mouse's back and forward buttons are
refused. Navigation, new tabs and tab switching are allowed only for the hosts
the link lists (subdomains included), for any host with `*`, and not at all by
default. The start page, which shows the browser's project and purpose, is never
injected for a guest. The host list limits what a guest can open directly. It is
not a network boundary: a link on an allowed page still goes where it points.

A guest can use every login saved in the profile it is given. That is the main
risk of a guest link, and no control in Tallylamp narrows it. Give guests a
browser that holds only what the job needs.

Everything a guest does is audited with its id and label. The audit table keeps a
bounded tail of the newest rows, so a guest who could write rows without limit
could push every other record, including its own, out of the log. Each link
therefore has an audit budget (`TALLYLAMP_GUEST_AUDIT_BUDGET`, 1,000 rows). An
action reserves its rows before it runs and is refused with 429 once the budget
is spent, so nothing a guest does goes unrecorded. Records of refused requests
are limited to a burst of 20, then 2 a minute, and are dropped rather than
refused past the budget. Failed link exchanges are recorded by IP behind a rate
limit of 10 a minute.

### Viewer tickets and control leases

Viewer tickets are 192-bit random values. They are hashed, scoped to one browser,
valid for about 60 seconds, and single-use. A ticket authenticates the WebSocket
upgrade, and its mode determines whether the viewer can watch or drive.

A ticket is bound to whoever minted it: the administrator's dashboard session,
recorded by hash, or one guest session. It is refused if that session has
logged out or expired, or if the guest link was revoked, even within the
ticket's 60 seconds. The upgrade refuses a foreign `Origin` for every caller.
Browsers always send `Origin` on a WebSocket, so an absent one means a
non-browser client. That is allowed for administrator tickets, because a
cross-site page cannot produce it. Guest tickets require a trusted `Origin`.

A watch socket drops mouse, key, scroll, navigation, tab, and resize messages
on the server, so a valid watch ticket exposes page content without granting
authority to type, navigate, or change the browser.

A control socket must heartbeat its lease token. The server checks every message
that changes the browser against the current lease, so when a second operator
takes control, the first operator loses control access even if their socket is
still connected. A heartbeat must also come from the side holding the lease: an
administrator renews only an administrator's lease, and a guest only its own. The
token alone, which appears in every browser view, is not enough. Browser credentials and
control access carry the authority of the accounts signed into that Chrome.

## What a tab control viewer can do

The address bar accepts `http` and `https` only. These requests pass through the
egress proxy. Schemes such as `file:`, `javascript:`, `chrome:`, and `devtools:`
can reach local files, run code in the current origin, or access browser internals.
They are refused with an explanation. A person already controlling the browser
can still follow links within a page.

Cmd/Ctrl+V reads text from the operator's clipboard and inserts it into the remote
page with `Input.insertText`. It does not read the remote clipboard back. Text is
capped at 16 KiB and stripped of control characters before transmission.

A control viewer can open, close, and foreground tabs, and resize the shared
Chrome window. The server clamps sizes to the browser's X screen. Resizing uses
`Browser.setContentsSize` and restoration uses `Browser.setWindowBounds`.
It does not use `Emulation.setDeviceMetricsOverride`, which would alter the
device metrics reported to the page.

## Optional full-browser control and extensions

The restrictions above describe the default tab viewer. By selecting **Full browser**
in the dashboard, an administrator can instead view the browser's dedicated
Xvfb display. This includes Chrome's toolbar, extension popups and native dialogs.
It never captures a shared host display. Watch sockets still cannot send input;
control sockets must bind to a current human lease. Input runs through X11 with
bounded arguments, without a shell. Disconnecting stops capture and releases held
keys and mouse buttons. Only one full-browser stream runs per browser.

Full-browser control is privileged access. Chrome's native address bar can open
local files and browser settings; it does not use the tab viewer's URL filter.
Use it only where dashboard administrators are trusted with those capabilities.
Paste types up to 2,048 characters into the focused native window. It does not read
the remote clipboard back. Opening Full browser fits the main window to the
display, and **Refit Chrome window** does it again on demand; switching back to a
control tab viewer lets that viewer size the content again. A watch-only viewer
fits the window too: it changes no page content and reads nothing back, but it
does resize the window the agent is working in, which is the one thing a watcher
does here that the browser can observe.

Extensions are off by default and require a separate administrator choice for each
stopped browser. Installed extensions and their data remain in the saved Chrome
profile. Disabling support skips loading them; it does not remove their saved data.
Profile copies include extension data but do not inherit the source's enable flag.

Treat extensions as trusted code. They can read signed-in pages, run in the
background after human control ends, and may change proxy settings or otherwise
bypass egress restrictions. The human lease blocks agent input, not extension work.
The egress proxy is not a sandbox for a privileged extension.

### Agent native UI permission

The administrator can grant **Allow agent control** for an agent-owned browser. It is
stored separately from extension enablement and defaults to off. Only the owning agent
with both ordinary read and control scopes may use the desktop tools; lending does not
grant this permission. Copied profiles do not inherit the source's permission.

The optional `TALLYLAMP_AGENT_DESKTOP_DEFAULT=1` policy preauthorizes newly created
agent-owned browsers, including profile copies. Otherwise they start with access off.
The default is written into the browser record at creation; runtime checks always use
that saved value. Changing the default does not change existing browsers, and a saved
revocation is never overridden by it. It does not enable or install extensions.

This permits full native UI access, including host-file dialogs and Chrome settings.
It is not a sandbox limited to extension popups. Treat this as granting the agent the
browser process's local-file capabilities; browser ownership checks do not isolate the
host filesystem from an authorized native operator.

The tools check the actual target browser, not just the MCP session binding. They
recheck ownership, the saved grant, current agent status/scopes, runtime identity and
control lease during execution. Human takeover and grant revocation cancel in-flight
work. Calls are serialized per browser, have input/output and time limits, and clean up
keys/buttons even on interruption. Raw key-down or button-down operations are not exposed
to agents. Typed text and screenshots are not included in audit logs.

## Signed-in-site records

The inventory stores an HTTP(S) origin, display name, observed state, reporter,
and timestamps. It does not read or store cookie values, local-storage tokens,
or account identifiers.

`confirmed` means someone saw authenticated UI at the recorded time. A website
may expire that session later. A profile-template clone receives `expected`
records until the cloned browser checks each site itself.

## Private endpoints

- Chrome DevTools Protocol binds to `127.0.0.1` and is not published.
- The tab viewer uses that loopback CDP connection after validating its ticket.
  Full-browser viewing uses local capture/input subprocesses and the same ticket checks;
  it opens no additional public port.
- `/healthz` returns only `{"status":"ok"}`.

## Network

Chrome uses `--proxy-server` to send traffic through Tallylamp's CONNECT proxy.
By default, the proxy refuses loopback, RFC1918, link-local, ULA, metadata
hostnames, and CGNAT destinations. Chrome handles TLS directly with the
website through CONNECT. `TALLYLAMP_ALLOW_PRIVATE_NETWORK=1` permits private
network access.

The proxy resolves a hostname and connects to the address that passed validation.
It does not resolve the name again between checking and connecting. This prevents
a DNS answer from switching to a private address during that gap. A later
connection gets its own resolution and check.

WebRTC/UDP is outside the HTTP CONNECT proxy's coverage. Each browser has its own
proxy, allowing the server to apply tunnel bindings to that browser's traffic.

An optional [upstream HTTP/HTTPS proxy](proxies.md) sits behind this local proxy,
not in place of it. Tallylamp checks and pins both the upstream IP and the website
IP. DNS runs locally; failed upstream requests never fall back to direct access.
Loopback tunnels retain precedence. Proxied browsers disable QUIC and WebRTC's
non-proxied UDP at launch, but this is not an OS-level network sandbox.

Proxy credentials are write-only in API/MCP responses and excluded from audit
details and Chrome arguments. They are stored **unencrypted in SQLite**, so the
data directory and its backups must be protected. Profile templates do not copy
proxy settings. A borrower inherits use of the route, not permission to edit it.

## Loopback tunnels

A hosted Chrome resolves `localhost` inside its own container. An OAuth provider
redirecting to `http://localhost:PORT/callback` therefore cannot reach the app
waiting on the operator's machine without a route to that machine.

A tunnel provides that route under these constraints:

- A binding connects one browser to one `host:port`. The tunnel client forwards
  only the authority it was started for; Chrome cannot choose another destination.
- The authority must be one the egress policy would refuse, such as loopback,
  RFC1918, ULA, link-local, `.local`, or `.internal`. Public names are rejected.
  Otherwise, a binding could divert traffic intended for a real public site to
  the machine holding the tunnel token.
- The target machine opens an outbound WebSocket. It needs no new local listener,
  public hostname, or certificate published in a Certificate Transparency log.
  A public quick tunnel exposes a different surface: anyone holding its public
  URL may be able to reach the forwarded service.
- The proxy checks tunnel bindings before applying its SSRF rule. For a private
  destination without a binding, the request falls through to that rule and is
  refused with 403.
- A tunnel expires after one hour by default, with a 12-hour maximum. It requires
  the non-default `browser:tunnel` scope and can be revoked; revocation closes
  live streams.
- Only the browser owner or an administrator can open a tunnel. Lending the
  browser closes existing tunnels, and a tunnel cannot open while a borrower
  holds it. Borrowers cannot list tunnels either. These checks prevent a borrower
  from inheriting access to the owner's machine.
- The client's restriction to one authority also prevents a compromised or
  misconfigured server from using it as a general proxy into the local machine.

While a binding is live, any page in that browser can reach the bound address.
The dashboard shows open tunnels with a Close button. The short expiry and
explicit scope limit access, but do not isolate it to one page or tab.

Revocation closes connections without undoing changes a page made to the profile.
Chrome treats `http://127.0.0.1:PORT` as potentially trustworthy, so a page served
there can register a service worker and write storage. Those changes survive the
tunnel's closure, and a later binding to the same authority inherits them.
Delete the browser if a tunnel served content you do not trust.

## Linked browsers

A linked browser is somebody's own browser and profile. An agent driving a shared
tab acts as that person on whatever the tab is signed in to, and with the site
limit off it can navigate the tab to any other site they are signed in to. Tick
only agents you would trust with that. **Any agent on this server** also covers
agents connected later, including every new OAuth connector.

Only an administrator decides which agents may use a linked browser. The
administrator owns it, and the agents are on a list in `linked_access`, so none
of them can delete it, change the list, or lend it. Lending is refused for linked
browsers in every form: asking, the idle rule, and answering a request.

The limits that do hold are enforced in the extension, because the server is the
party being limited. The extension only attaches to tabs a person shared, only to
ordinary `http` and `https` pages, and never to its own pages. It refuses CDP
methods that reach past a shared tab: the browser-wide cookie jar, other tabs,
other origins' storage, files on disk and download paths. The list is in
`extension/guard.js`. It never re-attaches after Cancel on Chrome's debugging bar,
and it hands every tab back if the server is unreachable for a minute.

A compromised server, or a stolen link token, can drive the tabs that are shared
at that moment and nothing else. It cannot share a tab, and it cannot widen a
site limit. See [linked browsers](linked-browsers.md).

## Process isolation

Chrome receives only an allowlisted environment, including `PATH`, `HOME`,
`DISPLAY`, and locale settings. Administrator secrets, agent tokens, Railway
tokens, and GitHub tokens are not passed through.

Each browser has its own profile and download directories. Path parameters use
generated IDs rather than caller-supplied filesystem paths.

## Renderer sandbox

`TALLYLAMP_SANDBOX` accepts `auto`, `on`, or `off`. Auto probes
`unshare --user --map-root-user`. If the host cannot create an unprivileged user
namespace, Chrome starts with `--no-sandbox` and the dashboard shows `fell-back`.
This is common on Railway. Set `on` to refuse an unsandboxed launch.

With the renderer sandbox disabled, a renderer exploit can execute code as the
`tallylamp` user. That user can read sibling profile directories on the volume.
Browsers in the container do not have the isolation of separate virtual machines;
do not use one deployment for mutually untrusted tenants.

## Browser detection

Tallylamp aims to avoid accidental automation artefacts while running stock
headed Chrome. It does not guarantee that sites will accept the browser or avoid
fingerprinting and bans. It does not spoof unavailable GPUs or solve CAPTCHAs.
Use human takeover when a site requires human input.

## Reporting

Contact the operator of your deployment. This repository has no paid bounty.
Do not include live tokens, cookies, or profile dumps in public issues. A private
reporting route to the project maintainer still needs to be published before launch.
