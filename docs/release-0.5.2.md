# Tallylamp 0.5.2

This release adds Chrome extension support and a Full browser view.

## What changes

- **Tab** still shows the page. **Full browser** shows Chrome's toolbar, extension
  popups, side panels, and dialogs.
- **Enable extensions** is a per-browser dashboard toggle. Stop the browser
  before changing it.
- **Allow agent control** is a second toggle. It lets the owning agent use
  `tallylamp_desktop_screenshot` and `tallylamp_desktop_action`. Off by default.
- `TALLYLAMP_AGENT_DESKTOP_DEFAULT=1` turns **Allow agent control** on for new
  agent-owned browsers. Existing browsers keep their saved choice.
- The Docker image includes ffmpeg and xdotool.

## Before upgrading

Back up `/data`. A redeploy stops Chrome; persistent profiles remain. This
release adds `browsers.extensions_enabled` and `browsers.agent_desktop_enabled`.
Older images ignore those columns.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35206121625)
passed application tests, headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.5.2` for Linux amd64. Anonymous
registry access, the manifest digest, and version/source-revision labels were
verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:1326f0b017063a4ae5eeca02439aa4536a08b57aae2b1698e6d9405ad252f9c7
```

Existing deployments do not upgrade automatically. See the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading)
for upgrade steps.
