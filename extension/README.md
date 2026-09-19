# Tallylamp Link

The browser extension that links your own Chromium browser to a Tallylamp server,
so an agent can use tabs you share with it.

To try it: open `chrome://extensions`, turn on Developer mode, press **Load unpacked**
and choose this folder. Then click the icon and enter your server's address.

How it works, what the agent can and cannot reach, and how to test changes are in
[docs/linked-browsers.md](../docs/linked-browsers.md).

| File | What it is |
|---|---|
| `background.js` | The service worker: pairing, the socket to the server, the set of shared tabs |
| `guard.js` | Which CDP calls a shared tab may receive. Pure functions, tested in `tests/linked-guard.test.ts` |
| `address.js` | Parses the server address a person types |
| `panel.*` | The side panel the toolbar icon opens, and the popup it falls back to where a browser has no side panels. `panel.html?demo=ready` renders any state in an ordinary tab, with no extension APIs |

There is no build step and no dependency. What is in this folder is what runs.
