# Route a browser through a proxy

Each browser can use its own HTTP or HTTPS proxy. Tallylamp supports proxies
with no login or with a Basic-auth username and password. SOCKS and PAC files
are not supported.

## Dashboard

Enter the proxy server and optional credentials when creating a browser.
For an existing browser, stop it, then choose **Configure proxy** in its sidebar.
Save the settings and start the browser again. Clear all three fields to return
to direct access.

The sidebar shows the saved server and whether it uses authentication, not its
credentials. To edit an authenticated proxy, re-enter both credentials. A saved
setting does not mean the proxy has been tested or is reachable.

## API and MCP

Pass `proxy` to `POST /api/v1/browsers` or `tallylamp_create_browser`:

```json
{
  "name": "Proxied research",
  "proxy": {
    "server": "https://proxy.example.com:8443",
    "username": "your-proxy-user",
    "password": "your-proxy-password"
  }
}
```

The server URL must contain only the scheme, host and port. Do not embed
credentials in it. Omit both credential fields for a proxy with no login.
An empty password is allowed when paired with a nonempty username.

To change the route, stop the browser and pass `proxy` to
`PATCH /api/v1/browsers/{id}` or `tallylamp_update_browser`. Only the owner or
an administrator can change it. A running or starting browser returns a conflict;
Tallylamp will not restart it without being asked.

Updates replace all proxy settings, including credentials. Omitting `proxy`
leaves it unchanged. Passing `"proxy": null` removes it. API responses return
only `server` and `hasAuthentication`, or `null` for direct access.

Settings survive stops and service restarts. They belong to the browser, not
its saved profile template, so cloning a profile does not copy its proxy.
A borrower uses the browser's existing route but cannot change it.

## Routing and limits

Chrome still connects to Tallylamp's local safety proxy. That proxy checks the
website address before opening a connection through your chosen upstream proxy.
It also checks the upstream server's address. Private addresses are blocked
unless the operator has enabled `TALLYLAMP_ALLOW_PRIVATE_NETWORK=1`.

Tallylamp resolves DNS locally and asks the upstream to connect to the checked
IP address. DNS does not run through the upstream. The upstream must support
HTTP/1.x CONNECT to destination IPs, including port 80 for plain HTTP sites.
Plain HTTP connections close after each request. WebSockets are supported;
secure WebSockets travel inside CONNECT like other HTTPS traffic.

Browser-specific loopback tunnels take precedence and do not use the upstream.
If a proxy connection or login fails, the request fails with 502; it does not
fall back to direct access. Check the provider's host, port, credentials and
CONNECT policy if sites fail to load.

For browsers with an upstream proxy, Chrome starts with QUIC disabled and
WebRTC's non-proxied UDP disabled. This is not a system-wide VPN or an OS network
sandbox. The service's DNS, API, MCP and viewer traffic keep their normal routes.

## Credentials

Credentials never appear in browser API responses, audit details, or Chrome's
command line. **They are stored unencrypted in the service's SQLite database.**
Restrict access to the data directory and encrypt volumes and backups as needed.
Do not put credentials in browser names or metadata.

Use an HTTPS proxy when possible. Basic-auth credentials sent to an HTTP proxy
are not encrypted on the link between Tallylamp and that proxy. HTTPS proxies
must present a trusted certificate for their hostname. Website TLS stays between
Chrome and the website; Tallylamp does not intercept it.
