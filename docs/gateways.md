# Reach the web from your own computer

A browser on a hosted Tallylamp reaches the web from the host's address. On
Railway that is a datacenter address, and some sites judge it before anyone
touches the page. Cloudflare can put up a check that a person at the viewer
cannot pass. A signed-in ChatGPT can stop with "The browser check couldn't
finish", which has no box to click at all.

A gateway is a computer of yours that a browser reaches the web from instead.
Sites then see your connection: the address you use every day, on your own
internet provider.

## Set one up

1. In the dashboard, open **Gateways** and choose **Add gateway**. Name it after
   the computer it will run on.
2. Copy the command it shows and run it in a terminal on that computer. It needs
   Node 22 or newer. The token in it is shown once.
3. Open the browser that should use it, stop it, and choose **Choose…** beside
   **Gateway** in its Settings. Start it again.

The command looks like this:

```bash
curl -fsSLo tallylamp.mjs https://YOUR_HOST/tallylamp.mjs && \
  TALLYLAMP_URL=https://YOUR_HOST TALLYLAMP_GATEWAY_TOKEN=tl_gw_… node tallylamp.mjs gateway
```

Your Tallylamp serves `tallylamp.mjs` itself, so it always matches your release.
From a clone of this repository, `node bin/tallylamp.mjs gateway` is the same
client. Leave it running. It reconnects by itself after a dropped network, a
sleep or a Tallylamp restart. On a Mac it also keeps the computer from idling to
sleep while it runs; pass `--allow-sleep` to turn that off. Closing the lid
still sleeps a laptop. Ctrl-C stops it.

The Gateways page shows each gateway, whether it is connected, the computer it
reported, the address it connected from, and which browsers use it.

## What it does and does not do

- **One route out.** A browser reaches the web from this host, through a
  [proxy](proxies.md), or through a gateway. Never two at once.
- **It fails closed.** While its gateway is not connected, every page in that
  browser fails to load. It never falls back to the host's own connection: you
  chose your address on purpose, and a site that sees a session's address change
  trusts it less. The browser page and its card say when this is happening.
- **Tallylamp still vets every address.** The browser's proxy on the server
  resolves the name and refuses private destinations exactly as before. Then it
  hands the gateway a public IP address and port, never a name.
- **The gateway checks again.** It refuses this computer, its LAN, your other
  devices, VPN and Tailscale ranges, and any address that is not on the public
  internet. It connects only to ports 80 and 443 unless you pass
  `--ports 80,443,8443`. `node tallylamp.mjs gateway --check 192.168.1.1` says
  whether it would connect somewhere, without connecting.
- **HTTPS stays encrypted.** Chrome's TLS runs to the site itself. The gateway
  passes on bytes it cannot read. It does see which addresses a browser connects
  to, and when, like any network does.
- **QUIC and WebRTC's UDP are off** for that browser, as for a proxied one, so
  neither goes around the gateway and shows the host's address.
- **Pages load at your upload speed.** Each page's bytes come into your computer
  and go back out to the host.
- **Main instance only.** A browser on a [worker](workers.md) cannot use a
  gateway. Move it back first.

Only the administrator can add, assign or remove a gateway. A gateway carries a
browser's traffic, so choosing one is the operator's decision, not an agent's.
Agents see a browser's `gateway` field, and are told to ask you to start it when
it is offline. A gateway in use by a browser cannot be removed; switch the
browser back to this host's connection first.

## API

All of these need the administrator.

| Request | Does |
| --- | --- |
| `GET /api/v1/gateways` | List gateways, their status and the browsers using them |
| `POST /api/v1/gateways` with `{ "name": "Studio Mac" }` | Add one. Returns the token, once, and the command to run |
| `DELETE /api/v1/gateways/{id}` | Remove one. Refused while a browser uses it |
| `PUT /api/v1/browsers/{id}/gateway` with `{ "gatewayId": "…" }` | Route a stopped browser through it. `null` returns it to the host |

The client connects to `/api/v1/gateways/connect` over a WebSocket and offers
the token as a second subprotocol, `tallylamp.token.<token>`, so it never
appears in a URL.

## When it stops

The client exits, rather than retrying, when retrying cannot help:

- **"Tallylamp rejected this gateway's token."** The token is wrong or the
  gateway was removed before it connected. Add the gateway again and run the new
  command.
- **"This gateway was removed in the Tallylamp dashboard."**
- **"Another computer connected with this gateway's token."** Run one copy per
  gateway. The newest connection wins.

Anything else, such as a dropped network, it retries with a growing delay of up
to a minute.

## Clicking a human check

A gateway changes where traffic comes from. It does not answer a challenge for
you. When a site still asks you to prove you are human, take control and answer
it yourself. Your clicks in the viewer reach the page the way a real mouse's
do, with a hover as a hover, a press at a mouse's pressure, and the buttons you
are actually holding.
