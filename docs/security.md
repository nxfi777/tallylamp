# Security

## Threat model

Tallylamp is designed for one administrator and the agents they create. A Railway
deployment is exposed to the public internet. Treat websites loaded in Chrome as
untrusted: an agent with browser control can access the accounts signed into that
profile. Browsers in one deployment share a container and a Unix user.

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

### Viewer tickets and control leases

Viewer tickets are 192-bit random values. They are hashed, scoped to one browser,
valid for about 60 seconds, and single-use. A ticket authenticates the WebSocket
upgrade, and its mode determines whether the viewer can watch or drive.

A watch socket drops mouse, key, scroll, navigation, tab, and resize messages
on the server, so a valid watch ticket exposes page content without granting
authority to type, navigate, or change the browser.

A control socket must heartbeat its lease token. The server checks every message
that changes the browser against the current lease, so when a second operator
takes control, the first operator loses control access even if their socket is
still connected. Browser credentials and
control access carry the authority of the accounts signed into that Chrome.

## What a control viewer can do

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

## Signed-in-site records

The inventory stores an HTTP(S) origin, display name, observed state, reporter,
and timestamps. It does not read or store cookie values, local-storage tokens,
or account identifiers.

`confirmed` means someone saw authenticated UI at the recorded time. A website
may expire that session later. A profile-template clone receives `expected`
records until the cloned browser checks each site itself.

## Private endpoints

- Chrome DevTools Protocol binds to `127.0.0.1` and is not published.
- The viewer proxies that loopback CDP connection after validating its ticket.
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
