# Linked browsers

A linked browser is the browser you already use, on your own machine, driven by an agent through Tallylamp. Every other browser in the fleet is a Chrome that Tallylamp launched in a container. A linked one is your own Chrome, Edge, Brave, Vivaldi, Opera or Arc, with the logins it already has. The agent gets the tabs you hand it and nothing else.

It exists for the jobs a container is bad at. Dribbble serves Tallylamp's hosted Chrome a "confirm you are human" page and loads normally in a laptop browser, because the difference is the datacenter IP. Some accounts are enrolled to one device and you would rather not enrol a second. And sometimes the page you want the agent to look at is already open in front of you.

## What you need

A Tallylamp server new enough to show a **Link your own browser** button on the Browsers page, and a Chromium browser at version 125 or later.

Firefox and Safari cannot be linked. Neither gives extensions a debugger API, so there is nothing for the extension to attach with. Mobile browsers are out for the same reason.

## Link a browser

1. Download [`tallylamp-link.zip`](https://github.com/nxfi777/tallylamp/releases/latest/download/tallylamp-link.zip) from the latest release and unzip it somewhere it can stay. Chrome reads an unpacked extension from its folder every time it starts, so a folder in Downloads that later gets cleared takes the extension with it.
2. Open `chrome://extensions`, turn on Developer mode, press **Load unpacked** and choose the `tallylamp-link` folder. The extension is not in the Chrome Web Store yet.
3. Click the Tallylamp Link icon. It opens as a side panel, which stays open while you switch tabs. A browser without side panels shows the same thing as a popup. Enter your server's address. `tallylamp.example.com` is enough. Plain `http://` is only accepted for a server on the same computer.
4. Press **Connect**. The panel shows a code such as `KXQ7-M2PD`, and the approval page opens in a new tab. Sign in to the dashboard if it asks.
5. Check the code on the page matches the panel. Tick the agents that may use this browser, then press **Approve and link**. **Any agent on this server** covers every agent, including ones you connect later. Leave everything unticked to watch it from the dashboard only.

The panel now says Connected. Nothing is shared yet.

The code lasts 10 minutes and works once. It is safe to read aloud, because all it does is name a request, and only somebody signed in to your dashboard can approve one. If a code appears that you did not ask for, press **Deny**.

## Share a tab

Open the tab you want to hand over, click the extension icon and press **Share this tab**. Chrome puts a bar across every window that says Tallylamp Link started debugging this browser. Chrome draws that bar and no extension can remove it. Pressing Cancel on it stops all sharing, the same as pressing Stop in the panel.

Shared tabs are collected into a tab group called Tallylamp where the browser has tab groups. Arc and Vivaldi do not. The number on the toolbar icon is how many tabs are shared right now, and it is there in every Chromium browser.

**Keep the agent on this site** is ticked by default. With it on, the agent cannot navigate the tab to another site, and if the tab leaves that site for any other reason (a link, a redirect, you) sharing stops. Subdomains count as the same site. Untick it for work that has to roam, such as following search results or an OAuth sign-in that bounces through another domain.

To take a tab back, press **Stop sharing this tab**, close the tab, or press Cancel on Chrome's bar. If your server is unreachable for a full minute, every shared tab is handed back without you doing anything.

## What the agent can do, and what it cannot

Inside a shared tab the agent is you. It can click, type, read the page, run JavaScript, take screenshots, watch network traffic and record a performance trace. If that tab is signed in to your email, the agent can read your email. With the site limit off it can also take the tab to any other site you are signed in to. Share tabs the way you would hand somebody your unlocked laptop with one window open.

What it cannot do is reach past the tab. The Chrome DevTools Protocol was written for a developer debugging their own browser, so many of its methods are browser-wide, and the extension refuses those before they reach Chrome:

- reading or clearing the whole browser's cookies (`Storage.getCookies`, `Network.getAllCookies` and their relatives). `Network.getCookies` still works, with its `urls` argument removed so it can only answer for the page in the tab
- listing, attaching to or opening other tabs through the `Target` domain
- uploading files from your disk (`DOM.setFileInputFiles`), choosing where downloads are written, or opening `file://`, `chrome://` and `javascript:` addresses
- reading another site's localStorage, IndexedDB or cache by naming its origin
- closing a tab it did not open, and closing or resizing your window. `resize_page` has no effect here. Use `emulate` to change the viewport

These rules live in [`extension/guard.js`](../extension/guard.js) and are tested in `tests/linked-guard.test.ts`. They run in the extension on purpose. The server is the party being limited, so a server that did its own checking would be marking its own homework.

The agent can open new tabs once at least one tab is shared. Those tabs are shared from the start, marked "opened by agent" in the panel, and held to the same site limit as the tabs you shared.

## What is different from a managed browser

Tallylamp did not launch a linked browser and does not hold its profile, so anything that depends on either is refused with an error that says why:

- saving the profile, proxies, tunnels, installing extensions and native desktop access
- lending. No agent can lend a linked browser or borrow one, whether by asking or by the idle rule
- the fleet cap. It runs on your machine, so it does not use a slot

## Change who can use it

The administrator owns every linked browser. The agents you ticked are on a list beside it, so they can use its shared tabs but cannot delete it, lend it or change who else gets in. To change the list, open the browser in the dashboard and edit **Who can use it**. An agent you untick loses the browser at its next tool call, even mid-task.

Each client that connects over OAuth gets its own agent, so one app can appear several times, such as three **OpenCode (connector)** entries. The list shows when each was last used, most recent first.

Linked browsers from 0.6.0 were owned by the one agent picked at approval. Upgrading to 0.6.1 moves them to the administrator and puts that agent on the list, so nothing loses access.

Start and restart mean nothing for it. **Hand back its shared tabs** in the dashboard menu stops the agent and detaches from every tab. **Revoke link** disconnects the extension at once and kills its token. Deleting it from Tallylamp changes nothing in the browser itself.

Watching it from the dashboard works like any other browser. The live view shows the shared tab at whatever size your real window is.

## How it works

The extension dials out to `wss://<server>/api/v1/links/connect` and sends its token in the first message, so the token never appears in a URL or an access log. That socket carries six calls from the server (`cdp`, `tabs.create`, `tabs.close`, `tabs.activate`, `window.get`, `unshare.all`) and tab and debugger events back.

On the server, `src/linked-cdp.ts` opens a loopback CDP endpoint for each linked browser that is online. The chrome-devtools-mcp bridge, the viewer and the thumbnailer all connect to it the way they connect to a container's Chrome. It invents the browser-level half of the protocol that `chrome.debugger` does not have. Puppeteer attaches to `tab` targets and then to the page beneath each one, so every shared tab gets a synthetic tab target wrapped round its real page target. Each client gets its own session id on top of one shared debugger attachment. A tab is announced only after the extension has attached to it, because Puppeteer's `connect()` waits on every target it is told about.

When the last client disconnects, the shim turns off every CDP domain that a client had turned on, and stops auto-attaching to new children. Chrome cannot do this itself: the extension holds one debugger attachment per tab for however many clients are looking, so a client's socket dying detaches nothing. Without it a tab whose agent finished an hour ago keeps pushing `Network` and `Page` events up the link for nobody, and a left-behind `Fetch.enable` holds every request in that tab waiting on a handler that has gone. Stopping the browser does not come through here, because that hands every tab back and the domains go with the attachment.

Pairing, the link token and the socket are in `src/linked.ts`. The token (`tl_ln_…`) is minted when the extension collects an approved pairing, so it exists in plaintext only in that one response and in the extension's storage. It is refused everywhere except the link socket. Rotating `ADMIN_SECRET` revokes every link.

Set `TALLYLAMP_LINK_TRACE=1` to log every CDP method crossing the shim. When a client hangs while connecting, that log shows which message it is waiting for.

## Working on the extension

Load the `extension` folder of this repo instead of the release zip, and press the reload arrow on its card at `chrome://extensions` after each change. If your checkout is on an external drive, run `make extension` and load the copy it puts in `~/Desktop/tallylamp-link` instead. Chrome drops an unpacked extension whose folder is missing when it starts. Run `make extension` again after pulling changes.

`extension/manifest.json` carries the same version as `package.json`, and a test fails when they differ. The release workflow zips the folder and attaches it to each GitHub release as `tallylamp-link.zip`, after the image has passed its checks.

## Testing it

`npm test` covers pairing, the socket, the shim and the guard rules. One of those tests runs the real chrome-devtools-mcp binary against the shim with a scripted extension on the other side.

`node scripts/linked-e2e.mjs` goes further. It loads the real extension into a real headless Chrome, pairs it with a local server, shares a tab and drives it over MCP: snapshot, click, script, screenshot, navigation, the site limit, a new tab, and Stop. It needs Chrome installed, so it is not part of `npm test`. Run it after changing anything under `extension/` or `src/linked*.ts`. The first time it ran, it found that Chrome lets an extension debug its own pages. The extension's own page had just been shared with the agent, along with everything the extension itself is allowed to do. The worker now refuses anything that is not an ordinary web page.

## Things that go wrong

**The dashboard says offline.** The browser is closed, the laptop is asleep, or the extension lost its link. Open the browser and look at the panel. If it asks you to connect again, the link was revoked or the server's admin secret changed.

**The agent says no tab is shared.** It is right. Nothing on the server can share a tab for you.

**Another tool is already debugging this tab.** Some other extension holds the debugger on that tab. Chrome's own DevTools window does not cause this.

**Sharing stopped by itself.** The panel says why when you next open it: the tab left its site, somebody pressed Cancel on Chrome's bar, the server was unreachable for a minute, or sharing was stopped from the dashboard.

## Not done yet

The extension is not in the Chrome Web Store. The `debugger` permission gets a manual review there. How long that takes, and whether the listing is accepted as it stands, is an open question. Microsoft's Playwright extension and Anthropic's Claude in Chrome both ship with the same permission, so it is possible.

There are no per-action approvals. Claude in Chrome can ask before each action on a new site. Here the controls are which tabs you share, the site limit and Stop. For an agent you do not fully trust, in a browser signed in to things that matter, that may not be enough. A container browser with a fresh profile is the safer tool.
