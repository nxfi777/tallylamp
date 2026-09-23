# Tallylamp 0.8.3

Saving a profile no longer takes control away from you or leaves the live view
blank.

## What changes

- **You keep control through a save.** Saving a running browser stops Chrome,
  copies the profile and starts Chrome again. When the save finished, the
  dashboard reloaded the browser page and closed the live view in a way the
  server took to mean you had left. It handed control back to the agent, and
  the page came back in watch mode. You now keep control, and the agent still
  cannot act until you press Return to agent.
- **The live view reconnects when Chrome restarts.** When Chrome stopped, the
  live view stayed connected to nothing and never tried again, so it froze on
  the last picture. It now reconnects by itself after a save, a restart or a
  crash, and you keep control while it does.
- **The live view opens on the tab Chrome is showing.** After a restart Chrome
  reopens your tabs, but not always in the same order. The live view picked
  the newest tab in that order, which was often a background tab. Chrome only
  draws the tab in front, so you saw one still picture and then nothing. The
  live view now opens on the tab that is in front. It never switches tabs to
  do this, so it does not move a tab away from an agent or a person using it.
  A guest opening their link for the first time lands on that tab too.

## Upgrading

No schema change and no configuration change. Tallylamp Link is unchanged apart
from its version number, so a linked browser does not need the extension
reinstalled.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35809594604)
passed application tests, headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.8.3` for Linux amd64, then
attached `tallylamp-link.zip`. Anonymous registry access, the manifest digest,
the version and source-revision labels, and the extension's manifest version
were verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:60a5beebc1bd40c316c400311a2259af37b426c65f15380f821fc37d9efed03f
```
