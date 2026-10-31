# Tallylamp 0.12.2

The dashboard is redesigned. Before this release its text and borders sat on half
pixels, settings were scattered across the pages, and confirmations used the
browser's native dialog, which blocks the whole page, live view included, until it
is answered. The dashboard also
never showed whether an agent was actually doing something. It does now, and so do
the guest page and Tallylamp Link.

## What changes

- **Sharper type, one palette.** The dashboard, the OAuth consent page and the guest
  page use the same Graphite colours, light or dark. Text and spacing use whole
  pixels. Geist and Geist Mono ship with Tallylamp instead of loading from Google
  Fonts, so the dashboard paints in its own typeface at once and works on an instance
  with no internet access.
- **See when an agent is working.** While an agent calls tools in a browser, the
  browser's card and page show an animated orb and say who is working. It clears
  15 seconds after the last call. The same orbs mark a live view connecting, Chrome
  starting or stopping, and a wait on a worker, a gateway or an approval. Under
  reduced motion they hold still, and they stop drawing when none is on screen.
- **Confirmations in the page.** Every native `confirm()` is gone. Dialogs name the
  action on their button and start on Cancel when the action destroys something.
  Deleting a hosted browser or a saved profile asks for its name first. Stopping a
  persistent browser and renaming one offer Undo. Successes show as toasts, so the
  red banner now shows only errors.
- **Find things faster.** A sidebar lists every page, with counts for browsers and
  waiting requests. Cmd/Ctrl+K searches browsers, pages, requests and actions.
  Single-key shortcuts act only when no field, dialog or live view has the keyboard.
  Requests has its own page.
- **The browser page has tabs.** Live, Settings, Access and Activity replace one long
  side column. Rename a browser in place. Its next step (Start, Take control or
  Return to agent) is the one filled button. Proxy and gateway are now one
  Connection choice: this host, a gateway, or a proxy.
- **Settings has its own page.** Preferences, Security, Instance and Account replace
  the Security page, and `/security` redirects there. Agents, saved profiles, workers
  and gateways are redesigned, and adding a worker or a gateway waits until it
  connects and then says so.
- **A new Tallylamp Link panel.** First run walks through Connect, Approve and Share.
  A shared tab shows in red, with how long it has been shared, how far the agent may
  take it, and what was done in it. The panel records kinds and counts of actions,
  never what was typed. Stop offers Undo. Alt+Shift+S shares the tab in front, or
  stops sharing it.

## Upgrading

No settings or schema change. Upgrade the main instance and every worker together:
while they run different releases, the main instance starts nothing on a worker.
Redeploys restart running browsers; their profiles remain on the persistent volume.

Clients of `/api/v1/events` receive one new event type, `browser.agent_active`. The
server sends it at most every 3 seconds per browser while an agent calls tools.

Tallylamp Link 0.12.2 has the redesigned panel and a keyboard shortcut, and it asks
for no new permissions.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.
