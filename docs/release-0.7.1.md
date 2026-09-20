# Tallylamp 0.7.1

This release fixes Full browser. Opening that view gave you a small Chrome
window in the corner of a much larger desktop, and keys typed into it went
nowhere unless you pressed **Fit Chrome window** first. Nothing said so. The
fit is automatic now.

## What changes

- **Full browser fits Chrome to the display when it opens.** Nothing runs a
  window manager on these displays, so the keyboard follows the pointer: keys
  reach whatever window it is over. Chrome started at `TALLYLAMP_WINDOW_SIZE`
  on a `TALLYLAMP_XVFB_SCREEN` desktop, 1280x800 inside 2560x1600 by default,
  which left most of the view as bare desktop that silently swallowed anything
  you typed there. The fit also doubles how large Chrome's own toolbar and tab
  strip are drawn.
- **Fit Chrome window** is now **Refit Chrome window**, for a dialog or an
  extension that moves Chrome after the view has opened.
- Full browser takes the full width of the page and says that Chrome's own
  address bar and tabs are the ones to type into. This view hides the
  dashboard's own, because Chrome brings them.
- A passing message over the live view no longer covers it. These used the
  same full-stage overlay as a connection failure, so any four-second notice
  blacked out the browser and swallowed every click in it. A failure that needs
  **Reconnect** still covers the stage, because that is where the button is.
- Pasting into Full browser is capped at 2,048 characters in the dashboard, the
  same limit the server applies. Longer pastes used to be rejected whole.

Watch-only viewers still do not resize the browser they are watching.

## Before upgrading

Back up `/data`. A redeploy stops Chrome; persistent profiles remain. This
release changes no database tables and adds no settings, so an older image
reads the same volume. Full browser still needs Linux, a dedicated Xvfb
display, ffmpeg, and xdotool, all of which the published image carries.

`TALLYLAMP_XVFB_SCREEN` decides how much desktop there is to fill, and so how
large Chrome's toolbar and tabs are drawn in the viewer. Lower it, for example
to `1920,1200`, if Full browser is still smaller than you want.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35478636367)
passed application tests, headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.7.1` for Linux amd64, then
attached `tallylamp-link.zip`. Anonymous registry access, the manifest digest,
the version and source-revision labels, and the extension's manifest version
were verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:c16e2c3e6daaf37cd004b4cfb3e3c1bfcc5b021ec4618042e6b82c52571d5538
```

Existing deployments do not upgrade automatically. See the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading)
for upgrade steps.
