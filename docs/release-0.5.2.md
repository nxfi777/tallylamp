# Tallylamp 0.5.2

This release adds Chrome extension support and a Full browser view. Keep
existing deployments on `0.5.1` until a digest is recorded here.

## What changes

- **Tab** still shows the page. **Full browser** shows Chrome's toolbar, extension
  popups, side panels, and dialogs.
- **Enable extensions** is a per-browser dashboard toggle. Stop the browser
  before changing it.
- **Allow agent control** is a second toggle. It lets the owning agent use
  `tallylamp_desktop_screenshot` and `tallylamp_desktop_action`. Off by default.
- `TALLYLAMP_AGENT_DESKTOP_DEFAULT=1` turns **Allow agent control** on for new
  agent-owned browsers. Existing browsers keep their saved choice.
- The Docker image now includes ffmpeg and xdotool.

## Before upgrading

Back up `/data`. A redeploy stops Chrome; persistent profiles remain. This
release adds `browsers.extensions_enabled` and `browsers.agent_desktop_enabled`.
Older images ignore those columns.

Do not change the Railway template image pin until this file lists a verified
digest. The current published pin remains:

```text
ghcr.io/nxfi777/tallylamp@sha256:3a7d90ccad442cdd2ce0e8bb298de008d8827cf44ae793f2f7068c631f4d6ead
```
