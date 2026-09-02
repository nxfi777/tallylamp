# Security

## Threat model (self-hosted, single owner)

Tallylamp is meant for one administrator and the agent principals they create.
It is exposed to the public internet on Railway. Websites loaded in Chrome are
hostile. Agent tokens grant real browser control, including whatever the
profile is logged into.

## Credentials

- **Admin.** `ADMIN_SECRET` compared with a length-checked
  `crypto.timingSafeEqual`. Successful login sets `tallylamp_session`
  (HttpOnly, SameSite=Lax, Secure on HTTPS). Not stored in localStorage.
  CSRF: mutating cookie requests must present a trusted `Origin` when the
  header is present.
- **Agents.** Bearer tokens `tl_ag_…`, stored as SHA-256 hashes. Rotation
  revokes previous hashes. Disabled agents cannot authenticate.
- **Viewer tickets.** 192-bit random, hashed, browser-scoped, ~60s, single use.
  The WebSocket upgrade is authenticated by the ticket, not by a public VNC
  port.

Browser credentials and viewer access are equivalent to keyboard and mouse on
that Chrome. Treat them like session cookies for every site in the profile.

## Surfaces that stay private

- Chrome DevTools Protocol binds `127.0.0.1` only. It is not published.
- The viewer backend is the same loopback CDP connection, proxied after
  ticket check.
- `/healthz` returns `{"status":"ok"}` and nothing else.

## Network

Default: Chrome is launched with `--proxy-server` pointing at Tallylamp's
CONNECT proxy. The proxy resolves DNS and refuses loopback, RFC1918, link-local,
ULA, metadata hostnames, and CGNAT. Chrome still does destination TLS (CONNECT).
Opt in to private-network access with `TALLYLAMP_ALLOW_PRIVATE_NETWORK=1`.

Limitations: WebRTC/UDP is not an HTTP CONNECT flow. DNS rebinding to a public
name that later points private is mitigated by connecting to the resolved
address at CONNECT time; it is not a full pin for the life of a long TCP
connection.

## Process

Chrome's environment is allowlisted (`PATH`, `HOME`, `DISPLAY`, locale, …).
`ADMIN_SECRET`, agent tokens, Railway tokens, and GitHub tokens are not passed
through.

Each browser has its own profile directory and download directory. Path
parameters are generated ids, not user paths.

## Sandbox

`TALLYLAMP_SANDBOX=auto|on|off`. Auto probes `unshare --user --map-root-user`.
If the host cannot create an unprivileged user namespace (typical on Railway),
Chrome starts with `--no-sandbox` and the dashboard shows `fell-back`.
`on` refuses to start unsandboxed.

A disabled renderer sandbox means a renderer exploit is in-process code
execution as the tallylamp user. That user can see sibling profile directories
on the same volume. Same-container isolation is **not** equivalent to separate
VMs. Do not run untrusted tenants on one deployment.

## Browser realism is not anti-detection

Matching stock Chrome in the same environment reduces *accidental* automation
artefacts. It is not a guarantee against bot detection, fingerprinting, or
bans. Tallylamp will not spoof GPUs it does not have and will not solve
CAPTCHAs. When a site needs a human, take control.

## Reporting

Email the operator of your deployment. This repository has no separate paid
bounty. Please do not file public issues that include live tokens, cookies, or
profile dumps.
