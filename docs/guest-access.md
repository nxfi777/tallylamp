# Guest links

A guest link lets one more person watch a single browser and, if you allow it,
take control of it. It is for moments like these: a colleague has to sign in, or
clear a 2FA prompt that goes to their phone, inside a browser your agent is
using. Before guest links, the only way to do that was to hand over the admin
secret, which opens every browser and every login on the deployment.

A guest link opens one browser and nothing else. You can revoke it at any time,
and everything the guest does is recorded in the audit log under their name.

## Before you share

**A guest can use every login saved in that browser.** A link to the browser that
is signed in to your bank and your email gives the guest your bank and your
email, not only the site you asked them to sign in to. When the job is "sign in
to example.com", start with a browser that holds nothing else: create a new one,
or use one kept for that site.

## Create a link

1. Open the browser in the dashboard.
2. Under **Guest links**, choose **Share with a person…**.
3. Fill in:
   - **Who is it for?** A name the guest will see. It is also the name the
     audit log records against everything they do.
   - **They can.** *Watch and take control*, or *Watch only*.
   - **Link expires in.** 15 minutes to 24 hours. Pick the shortest time that
     covers the job.
   - **Address bar and tabs.** Leave this empty and the guest stays on the page
     you show them, with no address bar and no tab switching. List host names
     (`example.com, accounts.example.com`) to let them open those hosts and their
     subdomains, or enter `*` to let them go anywhere.
4. Copy the link. It is shown once. Tallylamp stores only a hash of it.

The link works once. The first browser to open it gets access, and after that
the link opens nothing. If the guest says it did not work for them, someone
else may have opened it first: revoke it and make a new one. The dashboard shows
whether each link has been opened yet.

Before you send the link, open the page you want the guest to use (take control
and navigate, or let the agent get there). The guest lands on the newest tab that
has a page loaded and stays on it, so open that page last or close newer tabs.

Over the API, an administrator session can call:

```http
POST /api/v1/browsers/:id/guests
{"label": "Sam, finance", "modes": ["watch", "control"], "expiresInSec": 3600, "allowedHosts": ["example.com"]}
```

The response includes `token` and `url` once. `modes` defaults to `["watch"]`,
`expiresInSec` defaults to one hour, and `allowedHosts` defaults to `[]`.
`GET /api/v1/browsers/:id/guests` lists links without their tokens.
`DELETE /api/v1/browsers/:id/guests/:guestId` revokes one.

## Hand it over

Send the link privately, for example in a direct message. Whoever opens it first
gets access until it expires or you revoke it. The secret part comes after the
`#`, so it never reaches Tallylamp's logs or any proxy in between.

The guest opens the link and presses **Open the shared browser**. The page
waits for that click on purpose: some mail and chat services open links to scan
them, and without the click a scanner could use the link up first. The page then
trades the link for a session cookie and removes the secret from the address
bar. The session lasts until the link expires, so the guest can close the tab
and come back to `/guest` in the same browser.

The guest sees the browser's name, the live page and one button: **Take
control**. While they hold control, the agent cannot change the browser. When
they choose **Give control back**, or close the tab, control returns to the
agent. **Leave** ends the link for good.

## What the guest can and cannot do

The guest can:

- watch the tab they land on (the newest tab with a page loaded when they first
  open the link)
- take control when the agent holds it or nobody does
- click, type, scroll, paste text and reload
- go back and forward, but not into pages that were open before you shared the
  browser, unless the link allows their host
- use the address bar and tabs, but only if you allowed hosts
- start the browser if it went idle and stopped

The guest cannot:

- take control from you or from another person, or force a takeover
- see or switch to other tabs in the browser, apart from blank tabs and tabs on
  hosts the link allows
- see or use any other browser, the fleet list, agents, saved profiles, audit
  log, proxy settings, metadata or signed-in-site records
- use Full browser (Chrome's own window, settings and extensions)
- stop, restart, delete, rename or reconfigure the browser
- download files, upload files or read the remote clipboard

The host list controls only what a guest can open directly. A link on an
allowed page still goes wherever it points. If the guest must never reach
somewhere, the browser's profile and network have to stop it, not the list.

## Take it back

- **Revoke.** Under **Guest links**, choose **Revoke**. The guest's session ends,
  their live view closes, and if they held control it goes back to the agent at
  once. A link cannot be used again after it is revoked.
- **Take control.** You can always take control from a guest. Their view drops
  back to watching.
- **Expiry.** The link and every session it opened stop working when it expires.
- **Delete the browser.** Its guest links go with it.

Stopping the browser does not lock a guest out. A guest can start a stopped
browser, so that a browser that went idle before they arrived still works.
Revoke the link if the browser has to stay stopped.

A guest holds control for at most 30 minutes at a stretch. After that, control
returns to the agent, and the same guest has to wait a minute before taking it
again. Giving control back and taking it again straight away does not restart
the 30 minutes. Only a full minute without control does.

If the tab you handed over is closed and the link allows nothing else, the
guest's view ends.

A link has a budget of 1,000 audit-log entries. That is far more than a sign-in
needs. It exists so that a hostile guest cannot flood the audit log and push
older entries out of it. When a link runs out, the guest's actions are refused
and you need to make a new link.

## Audit log

These are recorded with the guest's id and label:

| Action | When |
| --- | --- |
| `guest.created`, `guest.revoked` | you create or revoke a link |
| `guest.session.started` | the guest opens the link |
| `guest.left` | the guest pressed Leave, which ends the link |
| `guest.link.reused` | someone tried to open a link that was already used. It may have leaked, so revoke it. |
| `guest.session.denied` | someone presents a link that is not valid (recorded by IP, rate limited) |
| `human.takeover`, `control.preempted`, `control.released` | the guest takes or returns control |
| `guest.control.max_age` | a guest's control reached the maximum hold time |
| `guest.viewer_ticket` | the guest's page opens a live view |
| `guest.control.denied`, `guest.viewer_ticket.denied`, `guest.request.denied` | the guest asks for something it may not have (a burst of 20, then 2 a minute) |
| `guest.audit_budget.exhausted` | the link used up its audit budget; its actions are refused from now on |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `TALLYLAMP_GUEST_TTL_SEC` | `3600` | Link lifetime when none is given |
| `TALLYLAMP_GUEST_MAX_TTL_SEC` | `86400` | Longest lifetime a link may be given |
| `TALLYLAMP_GUEST_MAX_LEASE_SEC` | `1800` | Longest continuous control by a guest |
| `TALLYLAMP_GUEST_LEASE_COOLDOWN_SEC` | `60` | Wait before the same guest may take control again after reaching that limit |
| `TALLYLAMP_GUESTS_PER_BROWSER` | `10` | Live links allowed on one browser |
| `TALLYLAMP_GUEST_MAX_VIEWERS` | `3` | Live views one guest may have open at once |
| `TALLYLAMP_GUEST_AUDIT_BUDGET` | `1000` | Audit-log entries one link may cause over its life |

The guest's cookie is `Secure` when `TALLYLAMP_PUBLIC_URL` is HTTPS. Guest
requests must come from an origin in the trusted list (`TALLYLAMP_PUBLIC_URL`,
loopback on the service port, and `TALLYLAMP_EXTRA_ORIGINS`). Set
`TALLYLAMP_PUBLIC_URL` to the address people actually use.

Guest links are for browsers Tallylamp runs. A [linked browser](linked-browsers.md)
is already somebody's own Chrome, so it cannot have guest links.
