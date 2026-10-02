# Tallylamp 0.11.1

You can choose what an agent may do while you create it.

Until now New agent asked only for a name. To let an agent load a saved
profile, you created it, copied its token, went back to its row and opened a
second form.

## What changes

- **New agent asks for permissions.** Below the name are the five things an
  agent cannot do by default: load saved profiles, save and update them, lend
  its browsers, borrow other agents' browsers, and reach private addresses on
  your machine. Each one says what it hands over, and each starts off. The
  token screen then lists what you granted.
- **One Permissions editor.** Profile permissions and Lending on an agent's
  row are now one Permissions button with the same list. Saving tells you the
  change applies from the agent's next request, with the same token.
- **Tunnels have a control.** Reach private addresses on your machine
  (`browser:tunnel`) could only be granted with `PATCH /api/v1/agents/:id`. It
  is on both forms now.
- **The dashboard and the consent page say the same thing.** Both read the
  permission wording from one list, which `GET /api/v1/agents` now returns as
  `permissions`, alongside `defaultScopes`. The consent page used to say a
  tunnel reaches the computer running Tallylamp. It reaches the machine that
  runs the tunnel command, which on a hosted instance is never the server.
- **A failed create keeps your choices.** The request runs inside the form, so
  an error shows there and the name and ticks stay put. Before, the form had
  already closed.
- **Long dialogs scroll.** A dialog taller than the screen, as New agent is on
  a phone, used to run off both edges with no way to reach its buttons.
- **Checkboxes sit beside their labels.** In the permission list and in the
  list of agents that may use a linked browser, each box sat about 10px below
  its name.

## Upgrading

No schema change and no new settings. Upgrade the main instance and every
worker together: while they run different releases, the main instance starts
nothing on a worker.

Tallylamp Link is unchanged apart from its version number, so a linked browser
does not need the extension reinstalled.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/37013141176)
passed application tests, headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.11.1` for Linux amd64, then
attached `tallylamp-link.zip`. Anonymous registry access, the manifest digest,
the version and source-revision labels, and the extension's manifest version
were verified. Pin this artifact on the main instance and on every worker:

```text
ghcr.io/nxfi777/tallylamp@sha256:7de88ad3b765422b7ffb6002bfcb67d50206f932e522f163099ac908fc4f67d3
```
