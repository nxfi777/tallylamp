# Tallylamp 0.7.0

This release adds guest links. When someone else has to sign in or clear a 2FA
prompt inside one of your browsers, you can send them a link to that browser
instead of the admin secret. It also closes several gaps in how the viewer and
control leases were protected, for administrators as well as guests.

## What changes

- A browser's page has a **Guest links** section. **Share with a person…** makes
  a link for one person: watch only, or watch and take control. It expires in
  15 minutes to 24 hours. The link works once, and whoever opens it first gets
  access. It opens a small page at `/guest` that loads no dashboard code.
- A guest can take control from the agent, never from you or another person, and
  can never force a takeover. You can always take control back. **Revoke** ends
  the guest's session, releases their control and closes their view at once.
- A guest sees the tab you handed over and nothing else. They get no Full
  browser, no other tabs, no browser settings and no other browsers. The address
  bar and tab strip are off unless you list the hosts they may open, or `*` for
  anywhere.
- A guest holds control for at most 30 minutes at a stretch, then waits a minute.
  Giving control back and taking it again does not reset that clock.
- Every guest action is in the audit log with their id and the name you gave
  them. Each link has a budget of 1,000 log entries, so a hostile guest cannot
  push older records out of the log.
- The admin API gains `POST`, `GET` and `DELETE` on `/api/v1/browsers/:id/guests`.
  See [guest links](guest-access.md) and the [security model](security.md#guest-links).

A guest can use every login saved in the browser you share. Share one that holds
only what the job needs.

## Security fixes

These apply whether or not you use guest links.

- A viewer ticket is now bound to the dashboard session that requested it and is
  refused once that session has logged out. The ticket table used to store the
  raw session token; it now stores a hash, and upgrading scrubs old values.
- Renewing a control lease now needs the same side that holds it. The token
  alone, which appears in every browser view, used to be enough.
- The live-view WebSocket refuses a foreign `Origin`, like the API already did.
  A client that sends no `Origin`, such as a script, is still accepted with an
  administrator ticket.

## Before upgrading

Back up `/data`. A redeploy stops Chrome; persistent profiles remain. This
release adds the `browser_guests` and `guest_sessions` tables. An older image
ignores them. Guest links stop working if you roll back, and no other data
changes. If you open the dashboard from an address that is not
`TALLYLAMP_PUBLIC_URL`, add it to `TALLYLAMP_EXTRA_ORIGINS`. The API already
required this, and the live view now does too.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35453298714)
passed application tests, headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.7.0` for Linux amd64, then
attached `tallylamp-link.zip`. Anonymous registry access, the manifest digest,
the version and source-revision labels, and the extension's manifest version
were verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:61818262dab57c3f880a029d5bbc85b42c47d7a21741d34ea34bdb05ca99ef25
```

Existing deployments do not upgrade automatically. See the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading)
for upgrade steps.
