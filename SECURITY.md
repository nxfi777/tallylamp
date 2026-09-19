# Security

Browser tokens can grant access to accounts signed into Chrome. Viewer tickets
expose page content; control tickets also allow input. Do not share them. Do not file public issues that include cookies, tokens, or
profile data.

See [docs/security.md](docs/security.md) for the model.

Selecting **Full browser** in the dashboard gives administrators access to Chrome's
native UI, including settings and local-file dialogs. This requires trusted administrators
and a dedicated Xvfb display for each browser. Tab is the default view. Full-browser
watch tickets remain read-only; input requires a current human control lease.

Enabling extensions is a separate administrator choice for each stopped browser.
Treat installed extensions as trusted code: they can read signed-in pages and may
change proxy settings or otherwise bypass the service's egress restrictions. They
can keep running after the administrator returns control to an agent. A human lease
blocks agent tool input, not extension background work. Disabling extension support
keeps the saved extension data; uninstall in Chrome to remove an extension.

**Allow agent control** is a separate per-browser administrator grant, off by default.
It permits the owning agent's native screenshot and input tools. It is full native UI
access, not an extension-only sandbox: the agent can reach Chrome settings and host-file
dialogs. Only grant it to an agent trusted with the host's browser-process privileges.
Borrowers cannot use it, and profile copies do not inherit it. Human takeover or revoking
the grant interrupts in-flight native work. Native screenshots are also blocked while a
human holds control. Action logs record the action kind, not typed text or images.

`TALLYLAMP_AGENT_DESKTOP_DEFAULT=1` preauthorizes this access when a new agent-owned
browser is created, including a new profile copy. It is a trusted-agent deployment
policy, off by default. It does not alter existing saved choices or override a later
dashboard revocation. It does not enable or install extensions.

A **guest link** hands one browser to another person. Treat that person as fully
untrusted apart from holding a valid token for that one browser. The link lets
them watch and, if allowed, drive that browser, so they can use every login saved
in its profile. It opens nothing else. The link works once, and a second use is
audited. Guests are not API principals: `/api/v1`, `/mcp` and the other sockets
cannot resolve a guest credential. They cannot force a takeover, take control
from a person, use Full browser, see other tabs, or keep control past
revocation, expiry or 30 continuous minutes. Share a guest link only for a
browser that holds nothing beyond what the guest needs, and revoke it when the
job is done. See [docs/guest-access.md](docs/guest-access.md) and the guest
section of [docs/security.md](docs/security.md#guest-links).

Report vulnerabilities to the operator of the deployment you are using. There
is no paid bounty on this repository.
