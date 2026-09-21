# Tallylamp 0.8.0

An agent can now ask you for one of your browsers, and you can say yes to less
than it asked for. Until now a grant could only pass between two agents, and it
was all or nothing: whoever held one could navigate, click, type and run
scripts. There is now a **read** level that sees pages and nothing else. A
request for a browser you own lands in the dashboard, and you answer it there.

Full browser also takes clicks now. In 0.7.1 the pointer moved and hover
worked, but most clicks never reached Chrome and letters could come out in
capitals.

## An agent can ask you for a browser

- **Requests land on Browsers.** A request for a managed browser you own appears
  in the requests panel on **Browsers**, with the agent's name, the browser, the
  level it asked for and its reason. A count on the **Browsers** nav link shows
  from the other pages. Linked browsers work as before: you share their tabs
  from the browser's own page.
- **Two access levels.** `read` allows binding, `list_pages`, `take_snapshot`,
  `take_screenshot`, `list_console_messages`, `list_network_requests`, their
  `get_*` companions, and the new `tallylamp_select_page`. Anything that changes
  a page is refused at that level: navigating, clicking, typing,
  `evaluate_script`. The error names the level, so the agent asks for more
  instead of retrying. `control` is what a grant has always been.
- **You can approve a control request as read.** The row offers **Approve read
  only** next to **Approve control**, and the agent is told which one it got. An
  answer can never grant more than was asked for.
- **You pick how long.** Anything from 30 minutes to 24 hours, or until you
  revoke it. A read request defaults to until-revoked, because the clients that
  want one run for a long time and reconnect often. A control request defaults
  to 8 hours.
- **Reading leaves the browser alone.** A read grant takes no control lease, so
  nobody sees an agent holding the browser or gets a **Take control back**
  button for a session that cannot type. It never brings a tab to the front,
  and it keeps working while you hold control.
- **`tallylamp_select_page`** picks which tab an agent reads without bringing it
  to the front. `select_page` still counts as a change and is refused at the
  read level.
- **Asking needs no scope, and a rate limit bounds it.** A scope you had to add
  first would lock out the very agent that needs to ask. So an agent may file 2
  requests a minute (`TALLYLAMP_LEND_REQUESTS_PER_MIN`) and hold 3 at once
  (`TALLYLAMP_LEND_MAX_PENDING`). Past either limit it gets a clear error that
  says not to retry. Asking again for a browser it already has a request for
  costs nothing and keeps its place.
- **A grant outlives the session.** An until-revoked grant survives session
  cleanup, reconnects and restarts. Every browser page lists who has access, at
  what level and until when, with **Revoke**. A revoke takes effect on the next
  call of a session that is already connected.
- **Lending between agents is unchanged.** Asking a peer still needs
  `browser:borrow`, and answering still needs `browser:lend`. A browser is still
  handed over automatically only if its owning agent marked it lendable and
  left it idle. Your own browsers are never handed over for being idle; only
  your approval does that. Both scopes now have a **Lending** editor on the
  Agents page, so you no longer need the API to set them.
- **A loan never lets an agent stop a browser or change its metadata or signed-in
  sites,** at either level. Deleting, saving or copying a profile, and changing
  a proxy or a name, were already owner-only.
- Requests, answers, revokes and every tool call made under a grant are audited
  against the real agent and the grant that allowed it.

## Connecting over OAuth

- The consent screen says what each scope that hands over logins actually
  does, in the same words the dashboard uses, and gives each one its own
  checkbox. None of them arrives ticked, even when the client asked for it.
  The rest are folded away, since a connector needs them to work at all.
- A client that reconnects can change what it was given, and the form starts
  from the grant you are editing.

## Full browser

- **Clicks land.** The xdotool in the image, 3.20160805.1, waits up to 15
  seconds in `mousemove --sync` when the pointer is already where it is told to
  go. For a click it always is, because your last mouse movement put it there.
  So the press sat waiting until a 2-second watchdog killed it. Tallylamp no
  longer asks xdotool to wait.
- Moving the pointer off the stage right after a click no longer throws the
  click away.
- **Letters stop coming out in capitals.** A Shift or Option release that never
  arrived, or Caps Lock on a Mac, could leave a modifier held down on the remote
  display. Every key and mouse press now releases the modifiers you are not
  holding, and Caps Lock is no longer sent.
- **Text is sharper.** Frames were shrunk to 1600 pixels wide and then scaled up
  again on a high-density screen. They now go out at the display's width, or at
  the stage's width in device pixels when that is smaller. A frame is about
  418 KB instead of 192 KB and costs about 45% more encoding CPU. A still screen
  sends nothing, as before.
- **Watching fits Chrome to the display too.** A read-only viewer now resizes
  the live browser it watches. That is deliberate: Chrome adrift in a corner of
  a desktop four times its size looked broken. The
  [security model](security.md) says so.
- **Take control** sits in the stage bar next to "Watching · read only". When
  input stops reaching Chrome (xdotool fails, the lease is not bound, a pointer
  lands outside the display), the viewer now says so instead of dropping it.

## The browser page

- Proxy, Extensions, Allow agent control and Lending are four rows under one
  **Settings** heading. Each has a name, one line of state and one control.
- The header shows **Start** or **Stop**, not both with one greyed out, and
  disabled buttons now look disabled.
- If you hold control of a stopped browser, you can turn on extensions or set
  its proxy without first returning it to the agent.
- You can correct a saved profile's recorded sites. **Edit** beside its badges
  lets you add a site that detection missed, fix a service name, mark a site as
  needing sign-in, or drop one. This changes the list only, not the snapshot or
  its cookies. Administrators only. Over the API, use `POST` and `DELETE` on
  `/api/v1/seeds/:id/sites`.

## Tallylamp Link 0.8.0

- **The panel names the real reason a tab won't share.** Password managers and
  similar extensions put a frame of their own inside pages with forms. Chrome
  won't let one extension debug a page that holds another extension's frame.
  Its error, "Cannot access a chrome-extension:// URL of different extension",
  used to reach you as "Chrome doesn't let extensions control this page". The
  panel now says another extension is in the way. If only one extension has a
  frame open, **Show that extension** opens its settings, where you can set its
  site access to "On click".
- A shared tab that such a frame turns up in is handed back with a notice that
  says why. So is a tab that goes to a `chrome://` page. That notice existed
  before but never appeared, because Chrome detaches before the tab's address
  changes.
- **Your Tallylamp dashboard can't be shared.** You approve agents' requests
  there, and an agent in that tab would be signed in as you. The panel won't
  share it, the agent can't navigate to it, and a shared tab that gets there
  some other way (a link, a redirect, a script) is handed back as the page
  loads.

To update the extension, replace its folder with the new zip's contents, then
press the reload arrow on its card at `chrome://extensions`.

## Before upgrading

Back up `/data`. A redeploy stops Chrome; persistent profiles remain.

This release adds three columns: `access` on `browser_grants`, and `access` and
`granted_access` on `browser_requests`. They are added automatically at boot.
All three default to `control`, so existing grants and requests keep exactly
the access they were issued with, and agents borrowing today notice nothing.
The columns are additive, so an older image still reads the same volume.

Two defaults change for browsers created after the upgrade. Existing browsers
keep what they have.

- New managed browsers start with extension support on, wherever Full browser
  can run, which includes the published image. It installs nothing. Set
  `TALLYLAMP_EXTENSIONS_DEFAULT=0` to keep the old default.
- New agent-owned browsers start with **Allow agent control** on. That gives the
  owning agent Chrome's own UI, including settings and host-file dialogs. Set
  `TALLYLAMP_AGENT_DESKTOP_DEFAULT=0` to keep the old default.

Four new settings bound requests. All are optional:

```text
TALLYLAMP_LEND_REQUESTS_PER_MIN   2        requests an agent may file per minute
TALLYLAMP_LEND_REQUEST_BURST      5        burst allowance on that rate
TALLYLAMP_LEND_MAX_PENDING        3        requests one agent may have outstanding
TALLYLAMP_LEND_MAX_GRANT_SEC      2592000  longest fixed grant an answer can set
```

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35554977191)
passed application tests, headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.8.0` for Linux amd64, then
attached `tallylamp-link.zip`. Anonymous registry access, the manifest digest,
the version and source-revision labels, and the extension's manifest version
were verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:27afb555cd44cdca4e6d4a0262f1a1dd9c6ddf01632503186f4bb26034c70d92
```

Existing deployments do not upgrade automatically. See the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading)
for upgrade steps.
