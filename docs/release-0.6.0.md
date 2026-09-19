# Tallylamp 0.6.0

This release adds linked browsers. An agent can now use a tab in your own
Chromium browser, through a new extension called Tallylamp Link.

## What changes

- Tallylamp Link works in Chrome, Edge, Brave, Vivaldi, Opera and Arc, version
  125 or later. It is attached to this release as `tallylamp-link.zip`. Unzip it
  and load it unpacked; it is not in the Chrome Web Store yet.
- Press **Connect** in its side panel, then approve the code on the dashboard's
  new `/pair` page and choose which agent may drive the browser. No token is
  copied or pasted.
- **Share this tab** hands one tab to that agent. It sees a browser whose `kind`
  is `linked` and can use only the tabs you shared. **Keep the agent on this
  site** is on by default.
- The extension refuses CDP calls that reach past a shared tab: the browser-wide
  cookie jar, other tabs, local files, download paths and other sites' storage.
  It never attaches to browser or extension pages.
- Stop in the side panel, Cancel on Chrome's debugging bar, **Hand back its
  shared tabs** in the dashboard and **Revoke link** all end sharing. If the
  server is unreachable for a minute, the extension hands every tab back.
- Linked browsers do not use a fleet slot. Saving the profile, proxies, tunnels,
  lending, extensions and native desktop access are refused for them.
- The Browsers page has a **Link your own browser** button.

## Before upgrading

Back up `/data`. A redeploy stops Chrome; persistent profiles remain. This
release adds the `browser_links` and `link_pairings` tables and a `browsers.kind`
column. Existing browsers read as `managed`. Older images ignore all three.
Rotating `ADMIN_SECRET` now revokes every browser link as well.

See [linked browsers](linked-browsers.md) for setup, limits and testing.
