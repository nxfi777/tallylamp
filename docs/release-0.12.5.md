# Tallylamp 0.12.5

Tabs shared through Tallylamp Link stay shared until you take them back. This
release also lets you share a tab by dragging it into the Tallylamp group, and
opening a browser from the dashboard now grows its card into the live view.

## What changes

- **Linked browsers are never stopped for being idle.** The idle reaper
  stopped a linked browser 15 minutes after an agent last used it, the same as
  a Chrome the server runs. Stopping a linked browser hands back every tab you
  shared, so shares ended on their own and the panel said they were stopped
  from the dashboard. A linked browser's Chrome runs on your own machine, so
  the reaper now leaves it alone. Sharing ends when you stop it, close the tab,
  press Cancel on Chrome's bar, hand the tabs back from the dashboard, or the
  link stays down for a minute. The idle limits for browsers the server runs
  are unchanged.
- **Share a tab by dragging it into the Tallylamp group.** A tab dragged into
  the orange Tallylamp tab group is shared, kept to its site, the way
  Alt+Shift+S shares. It is on by default; **Share tabs dragged into the
  group** in the panel's ⋯ menu turns it off. Only a drag counts: a tab that a
  shared page opens lands in the group without being shared. A dragged tab
  that cannot be shared, such as a chrome:// page or one dragged while the
  server is unreachable, is moved back out with a notice saying why.
- **Opening a browser grows its card into the live view.** On the dashboard,
  a card's picture grows into the browser's page and shrinks back into the
  same card on Back. The fleet keeps its scroll position. A browser's details
  load alongside the rest of the page, one round trip instead of two. Menus
  open from the corner nearest what opened them. There is no animation under
  reduced motion.

## Upgrading

Nothing in the schema or settings changes, so rolling back to 0.12.4 keeps
working; a rolled-back server goes back to stopping idle linked browsers.

Upgrade the main instance and every worker together: while they run different
releases, the main instance starts nothing on a worker. Redeploys restart running
browsers; their profiles remain on the persistent volume.

Tallylamp Link 0.12.5 adds sharing by dragging and asks for no new permissions.
The fix for idle shares is on the server, so it applies to every Link version.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.
