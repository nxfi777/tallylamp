# Tallylamp 0.10.1

Moving a browser to a worker is now one step.

## What changes

- **Move to… does the whole move.** It is in every browser's ⋯ menu and on its
  page. A running browser stops, its profile is copied across with its logins
  and tabs, and it starts again on the new host. Before, you had to stop it,
  find Runs on in its settings, move it, then start it again. If the copy
  fails, the browser stays where it was and starts again there.
- **You can watch it happen.** The dialog closes as soon as you pick a host.
  The browser's card and page show how much of the profile has been copied,
  updated every second. When it finishes, a message says where the browser
  runs now. On a phone that message stays at the top while you scroll.
- **The agent using it is told.** Its next tool call carries a note saying
  where the browser went and what does not work there. A call made during the
  move is refused as retryable.
- **The fleet keeps updating while events keep coming.** The dashboard used to
  wait for a quiet 1.5 seconds before it refetched. A busy agent, or a move
  reporting every second, could hold the cards still for as long as it lasted.
  Now it refetches at most every 1.5 seconds, and waits while a ⋯ menu is
  open, so a repaint no longer closes the menu under your pointer.
- **A worker's browser claims less that is not true.** Save profile is gone
  from its menu and page, and its Pinned and Extensions rows say what applies
  on a worker.

## Upgrading

No schema change and no new settings. Upgrade the main instance and every
worker together: a main instance on 0.10.1 gives a worker on 0.10.0 nothing to
start.

Tallylamp Link is unchanged apart from its version number, so a linked browser
does not need the extension reinstalled.
