# Tallylamp 0.6.1

This release changes who can use a linked browser. In 0.6.0 you picked one agent
when approving a browser, and that agent could lend it to others without asking
you. Now you tick the agents, and only you can change the list.

## What changes

- The approval page lists your agents as checkboxes, most recently used first,
  with when each was last used. **Any agent on this server** covers every agent,
  including ones you connect later. Nothing is ticked unless you have exactly one
  agent.
- A linked browser's page has **Who can use it**, where you change the list. An
  agent you untick loses the browser at its next tool call.
- The administrator owns every linked browser. The agents on its list can use it,
  but cannot delete it, lend it or change the list.
- Lending is refused for linked browsers in every form: asking, the idle rule and
  answering a request. 0.6.0 refused only the idle rule.
- The Proxy, Extensions, Lending and Loopback tunnels sections no longer appear on
  a linked browser's page, since it supports none of them.

## Before upgrading

Back up `/data`. A redeploy stops Chrome; persistent profiles remain. This
release adds a `linked_access` table. Linked browsers from 0.6.0 move to the
administrator, and the agent that owned each one goes on its list, so no agent
loses access. An older image ignores the table, which would leave those browsers
owned by the administrator and visible to no agent.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35417599332)
passed application tests, headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.6.1` for Linux amd64, then
attached `tallylamp-link.zip`. Anonymous registry access, the manifest digest,
the version and source-revision labels, and the extension's manifest version
were verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:56745b7c579633286816bbdaffbd6c0d0cfdf1cb94390ab08ae7c9dd04d31957
```

Existing deployments do not upgrade automatically. See the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading)
for upgrade steps.

See [linked browsers](linked-browsers.md#change-who-can-use-it).
