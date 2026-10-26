# Tallylamp 0.12.0

A browser can now reach the web from a computer of yours, through a gateway.
Some sites judge a datacenter address before anyone touches the page. On a
Railway host, Cloudflare showed a human check in front of claude.ai that a
person clicking in the viewer could not pass, and a signed-in ChatGPT stopped
at "The browser check couldn't finish", which has nothing to click. Through a
gateway, sites see your own connection instead.

Your clicks in the viewer also reach the page the way a real mouse's do.

## What changes

- **Gateways.** Add one under **Gateways** in the dashboard and run the command
  it shows on your computer, with Node 22 or newer. Then stop a browser and
  choose the gateway under **Gateway** in its Settings. The client dials out to
  Tallylamp, so nothing listens on your computer, and it reconnects by itself.
  On a Mac it keeps the computer from idling to sleep while it runs. Your
  instance serves the client at `/tallylamp.mjs`, so no checkout is needed. See
  [gateways](gateways.md).
- **A gateway fails closed.** While it is not connected, that browser's pages
  fail. They never fall back to the host's own connection. The browser's page
  and card say so, and agents see `gateway.online: false`.
- **One route out per browser.** Each browser now uses this host, a proxy, or a
  gateway, never two at once. Gateways work for browsers on the main instance,
  not on workers.
- **Clicks in Tab view look like a mouse.** Before this release, every hover
  reached the page as a left-button drag at zero pressure, and every press at
  zero pressure. A real mouse produces neither. Hovers are now plain hovers,
  presses and drags carry the buttons you actually hold at a mouse's 0.5
  pressure, and a button let go outside the viewer is released before your next
  move. Full browser already sent real input.
- **New API.** `GET` and `POST /api/v1/gateways`, `DELETE /api/v1/gateways/{id}`
  and `PUT /api/v1/browsers/{id}/gateway`, all administrator only.

## Security

- Only the administrator can add, assign or remove a gateway. An agent, owner or
  not, cannot route a browser through one.
- Tallylamp still resolves and vets every destination, then hands the gateway a
  pinned public IP address and port, never a name. The client refuses its own
  computer's networks, private and special address ranges, and every port but
  80 and 443 unless told otherwise.
- HTTPS stays encrypted from Chrome to the site. A gateway sees which addresses a
  browser connects to, and when.
- A gateway's `tl_gw_…` token is shown once and stored as a hash. The client
  sends it as a WebSocket subprotocol, so it never appears in a URL. It does not
  expire: remove the gateway to revoke it.

See [security: gateways](security.md#gateways).

## Upgrading

The database gains a `gateways` table and a `browsers.gateway_id` column at
startup. No settings change. Upgrade the main instance and every worker
together: while they run different releases, the main instance starts nothing
on a worker. Redeploys restart running browsers; their profiles remain on the
persistent volume.

Before rolling back to 0.11.x, switch every browser back to this host's
connection. Older releases do not know about gateways and would start those
browsers on the host's own address.

Tallylamp Link is unchanged apart from its version number.

## Release validation

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/40259910270)
passed application, headed Chrome, and running-container checks before
publishing the tested image. Its anonymous registry access, digest, version and
source-revision labels were verified, along with the extension zip's manifest
version. Pin this Linux amd64 artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:ccb6b5d1eda69bbc355351cb6bf8d43e8a1362641e0d7f28b9aa6f3cd01c7bdb
```

Before release, the gateway client carried HTTPS through a gateway to
Cloudflare, which saw the gateway computer's own address, and a 2.5 MB download
arrived with every byte (`npm run test:gateway-net`). After deploying the
artifact, production listed the gateway routes and served the same client at
`/tallylamp.mjs`, and its worker reported 0.12.0.

Then a production browser was put on a gateway. Cloudflare saw it at the
gateway computer's own address, in its own country, instead of Railway's.
claude.ai's sign-in page, which had stopped at Cloudflare's "Verify you are
human" from Railway, loaded with no check. A signed-in ChatGPT that had stopped
at "The browser check couldn't finish" loaded the account, its projects and its
chat history.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.
