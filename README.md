# Tallylamp

Tallylamp gives AI agents persistent real browsers you can watch and take over.

Agents provision headed Chrome sessions, drive them through remote MCP, and keep
authenticated profiles across restarts. You get a dashboard that shows every
browser, who created it and why, a live view of the **same** Chrome the agent
is using, and a control lease when a site needs a human.

It is open source and meant to be deployed as a single Railway service with a
volume. It is not undetectable, unbannable, or a CAPTCHA solver.

## Why it exists

Coding agents need a real browser: cookies, logins, a normal user-agent. Humans
need to see what those agents are doing and to type into the awkward bits
(OAuth consent, bank 2FA, a stubborn widget) without destroying the session.

## Architecture

One Node.js process. Headed Chrome children (Xvfb in containers). SQLite +
profiles on a volume. MCP at `/mcp`. Control API at `/api/v1`. Dashboard at `/`.
Viewer is a CDP screencast through an authenticated WebSocket — not a second
browser, not a public VNC port.

Details: [docs/architecture.md](docs/architecture.md).
Research that justified the choices: [docs/research.md](docs/research.md).

## Quickstart (local)

```bash
cp .env.example .env
# set ADMIN_SECRET to a long random string
npm install
npx tsx src/index.ts
```

Open http://127.0.0.1:8080, log in, create an agent, copy the token.

```bash
claude mcp add --transport http tallylamp http://127.0.0.1:8080/mcp \
  --header "Authorization: Bearer tl_ag_…"
```

That Claude Code command is taken from current Claude Code docs. This repo's
automated tests speak Streamable HTTP with a bearer token; they do not launch
Claude Code itself.

Docker (local image, same as the Railway Dockerfile — Railway does not use Compose):

```bash
export ADMIN_SECRET="$(openssl rand -hex 32)"
docker build -t tallylamp .
docker run --rm -p 8080:8080 \
  -e ADMIN_SECRET \
  -e TALLYLAMP_PUBLIC_URL=http://127.0.0.1:8080 \
  -v tallylamp-data:/data \
  tallylamp
```

## Railway

See [docs/railway.md](docs/railway.md).

1. Deploy this repo with the Dockerfile.
2. Attach a volume at `/data`.
3. Set `ADMIN_SECRET` and `TALLYLAMP_PUBLIC_URL`.
4. Open the public URL.

`.railway/railway.ts` is the IaC description of that service + volume.

## Dashboard

Authenticated with the administrator secret. HttpOnly session cookie.

The home grid is live browsers: thumbnail, trusted creator, reported source /
project / purpose, URL, who has control. Watch is the default and cannot inject
input. Take control acquires a lease on that Chrome; Return to agent releases
it. The agent's MCP session stays up and mutating tools fail until you return
control.

Mobile: fleet, status, watch, start/stop, return control. Full remote-desktop
feel on a phone is not a v1 goal.

## Agents and browsers

Create agent principals in the dashboard. Each gets a bearer token, scopes
(`browser:create`, `browser:list:own`, …), and a max-browser cap.

Agents create browsers through MCP (`tallylamp_create_browser`) or `POST /api/v1/browsers`.
Metadata is optional. The tool description asks for source / project / purpose
when known. Metadata cannot override provenance: if Claude-on-your-laptop
created it, the dashboard says so even if metadata claims `source: human`.

MCP `clientInfo` is stored as a reported client, next to the authenticated
principal, never instead of it.

Humans can also create a browser, log into sites, stop it, and later hand the
same profile to an agent.

## Persistent profiles

`persistent: true` (default): idle stop kills Chrome and keeps the profile.
`persistent: false`: idle stop can delete the profile according to TTL.
Explicit delete is the only way to destroy a persistent profile.

Seeds: stop a browser, snapshot it, clone the snapshot into new browsers. Some
websites invalidate cloned sessions. Snapshotting a running profile is refused.

## MCP

- Endpoint: `https://host/mcp`
- Transport: Streamable HTTP
- Auth: `Authorization: Bearer`
- Discovery: `/.well-known/oauth-protected-resource`

Lifecycle tools always exist. After create/use, chrome-devtools-mcp tools
(`navigate_page`, `click`, `fill`, `take_screenshot`, …) are forwarded.

Compatibility notes: [docs/mcp-compatibility.md](docs/mcp-compatibility.md).

## Authentication

Admin secret → dashboard session. Agent token → MCP and control API. Agents
cannot administer other agents or open the dashboard cookie jar. Tokens are
hashed at rest, rotatable, revocable.

## Browser realism

Tallylamp launches headed Chrome and connects MCP to it. It does not wrap
Puppeteer stealth plugins. Differential tests compare a reference launch to
Tallylamp's launch. [docs/browser-realism.md](docs/browser-realism.md).

## Security model

[docs/security.md](docs/security.md). Short version:

- Websites are untrusted.
- CDP is loopback-only.
- Viewer tickets are short-lived and single-use.
- Egress CONNECT proxy blocks private networks by default.
- Chrome env is sanitized.
- Sandbox state is measured and shown. On Railway it will often be `fell-back`.
- Same-container browsers are not separate VMs.

## Network isolation

Default deny for 127.0.0.0/8, RFC1918, ULA, link-local, metadata. Chrome still
does end-to-end TLS through CONNECT. `TALLYLAMP_ALLOW_PRIVATE_NETWORK=1` opts
out. WebRTC/UDP is a documented gap.

## Resource usage

Default max 4 browsers. Each headed Chrome is roughly a gigabyte. Idle browsers
are stopped; persistent profiles stay. `/api/v1/status` shows fleet slots.

## Limitations

- Railway: no GPU, likely no renderer sandbox, one replica, downtime on
  volume redeploy (profiles persist).
- No CAPTCHA bypass.
- No claim of TLS-fingerprint equivalence beyond "Chrome speaks TLS".
- OAuth authorization_code is not a real login; use bearer tokens.
- Interaction path is chrome-devtools-mcp's, not a human mouse recording.

## Self-hosting

Any Docker host with a persistent disk at `/data` works. GPU hosts may set
`TALLYLAMP_GPU=hardware`. Set `TALLYLAMP_SANDBOX=on` if you would rather fail
closed than run `--no-sandbox`.

## Development

```bash
npm install
npx tsx src/index.ts
npm test
```

`TALLYLAMP_FAKE_CHROME=1` is used by the unit tests so they do not need a
display.

## Testing

```bash
npm test
npm test -- tests/realism.test.ts   # needs a Chrome binary
```

## Third-party licenses

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Tallylamp is not a chikin
fork and is not endorsed by chikin's author.
