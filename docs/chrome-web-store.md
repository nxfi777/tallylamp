# Chrome Web Store

Everything the Chrome Web Store dashboard asks for when Tallylamp Link is submitted, ready to paste. The zip, images, privacy policy and review answers are in this repository or on tallylamp.dev. The two things that can't live here are a server for the reviewers to pair with and the developer account itself.

The listing copy went through a surface edit, a structural edit and a readability check. It scores at about grade 6. The privacy practices answers were written against `extension/*.js`, not against the docs. If the extension starts sending or storing something new, change the answers and [the privacy page](https://tallylamp.dev/privacy) (`website/src/app/privacy/page.tsx`) in the same release.

## Before you submit

1. **Publish the privacy page.** The listing, the privacy practices tab and the extension's own Connect screen all link to `https://tallylamp.dev/privacy`. It must answer before the package is uploaded, because a reviewer will open it.
2. **Stand up a server for the reviewers.** The extension does nothing until it pairs, so review stalls without one. Deploy a separate Tallylamp from the Railway template, not your own, since its admin secret goes in the test instructions. Create one agent called Review agent and keep its token. Delete the server once the listing is approved.
3. **Build the zip.** `make store` writes `dist/tallylamp-link-<version>-store.zip`, with `manifest.json` at the top as the store requires. The release asset `tallylamp-link.zip` won't upload, because everything in it is inside a folder.
4. **Developer account.** Registration costs a one-time $5. The dashboard also asks you to verify a contact email, which is shown on the listing, and to declare whether you are a trader under the EU Digital Services Act.
5. Upload the zip, fill in the tabs below and submit. Google says items that ask for powerful permissions such as `debugger` may get an in-depth review, which takes longer than the usual few days.

## Store listing

| Field | Value |
|---|---|
| Name and summary | Read from the manifest: **Tallylamp Link**, and "Share one tab of your browser with an AI agent on your own Tallylamp server. You pick the tab, and one click takes it back." (123 of 132 characters) |
| Category | Developer Tools |
| Language | English |
| Store icon | `extension/icons/128.png`, the same icon the manifest uses: 96px of mark with 16px clear on every side |
| Screenshots, in this order | `store/screenshot-1-share.png`, `-2-shared`, `-3-pair`, `-4-sites`, `-5-handback`, all 1280×800 |
| Small promo tile | `store/promo-small.png`, 440×280 |
| Marquee promo tile | `store/promo-marquee.png`, 1400×560. Optional, but the store won't feature an item in the marquee without one |
| Homepage URL | `https://tallylamp.dev` (also `homepage_url` in the manifest) |
| Support URL | `https://github.com/nxfi777/tallylamp/issues` |
| Official URL | tallylamp.dev, once the domain is verified in Google Search Console. Optional |

### Description

Paste this as plain text. The store keeps line breaks and nothing else.

```text
Tallylamp Link lets an AI agent work in a tab of the browser you already use, with the logins that tab has. You choose the tab. The agent gets that tab and nothing else, and one click takes it back.

It pairs with a Tallylamp server that you run yourself. Tallylamp is free, open-source software that gives agents real Chrome browsers over MCP. This extension adds your own browser to them, for work where a fresh cloud browser gets in the way. Maybe you're already signed in to the site, or the account only trusts this device, or the page is open in front of you right now.

Before you install, you should know what Chrome is going to say. It will warn that this extension can "Read and change all your data on all websites." That warning comes with the debugger permission, which is how the agent drives a tab. Here is what the extension does with it.

- It attaches to a tab only after you press Share this tab. Installing it shares nothing, and neither does connecting it.
- Chrome shows a "started debugging this browser" bar the whole time anything is shared. No extension can hide that bar, and pressing Cancel on it stops sharing.
- It refuses the parts of the DevTools Protocol that reach past the tab, such as reading every cookie in the browser, listing or opening other tabs, uploading files from your disk, or reading another site's storage.
- "Keep the agent on this site" is on by default. If the tab leaves that site, sharing stops.
- The agent can't open your Tallylamp dashboard, which is where its requests get approved.
- If your server is unreachable for a minute, every shared tab is handed back.

Inside a shared tab the agent acts as you. If that tab is signed in to your email, the agent can read your email. Share a tab the way you would hand somebody your unlocked laptop with one window open.

Setting it up
1. Run a Tallylamp server. There is a one-click Railway template and a Docker image, both linked from tallylamp.dev.
2. Click the Tallylamp Link icon and type your server's address.
3. Approve the code in your dashboard. There are no keys to copy.
4. Open the tab you want to hand over and press Share this tab.

Where your data goes
The extension talks only to the server you connect it to. It has no analytics and no sign-up, and the developer receives nothing from it. What the agent reads in a shared tab goes to your server, then to the agents you approved. The privacy policy is at https://tallylamp.dev/privacy.

It works in Chrome, Edge, Brave, Vivaldi, Opera and Arc, from version 125. The code is MIT-licensed, in the extension folder of github.com/nxfi777/tallylamp.
```

It names the install warning before the reader meets it, then lists what limits it. Denying a fear gives it weight and naming it takes the sting out ("accusation audit", Voss, *Never Split the Difference*, "Don't feel their pain, label it"). The copy keeps set-up time and effort low and visible, with one click to share and no keys to paste. That follows Hormozi's value equation (*$100M Offers*, "The Value Equation"), which says to cut the time and effort side rather than inflate the promise.

## Privacy practices

**Single purpose**

> Share browser tabs that the user chooses with an AI agent that runs on the user's own Tallylamp server, and let the user take them back.

**Permission justifications**

| Permission | Justification |
|---|---|
| `debugger` | The extension's single purpose is letting an AI agent operate a tab the user has chosen to share, and chrome.debugger is the only Chrome API that can do that: read the page, click, type and take screenshots. It attaches only after the user presses "Share this tab" and detaches when they stop. It refuses DevTools Protocol commands that reach beyond the shared tab, such as browser-wide cookies, other tabs and local files. Chrome's "started debugging this browser" bar is visible the whole time. |
| `tabs` | Shows the user the title, address and icon of the tab they are about to share. Hands a shared tab back when it navigates to another site, a browser page or the user's Tallylamp dashboard. Opens, focuses and closes the tabs the agent opened. |
| `tabGroups` | Puts shared tabs in an orange tab group named "Tallylamp", so the tab strip shows which tabs an agent can use. |
| `storage` | Local storage keeps the address of the user's server and the link token it issued. Session storage keeps the list of shared tabs, so sharing survives the service worker restarting. |
| `alarms` | A 30-second alarm reconnects to the user's server after Chrome suspends the service worker. Without it, shared tabs would go unreachable and could not be handed back promptly when the server disappears. |
| `sidePanel` | The toolbar icon opens the extension as a side panel. It stays open beside the tab being shared, where a popup would close on the first click into the page. |

There are no host permissions. The only sites the extension contacts are the user's own server, which answers with CORS for any origin, and the `chrome.debugger` target the user shared.

**Remote code:** No. Every script is in the package, and it has no `eval`, no remote scripts and no build step.

**Data usage.** Tick these, because a shared tab's contents leave the device for the user's server:

| Category | Why |
|---|---|
| Website content | Page content, screenshots, network responses and console messages from shared tabs |
| Web history | The address and title of each shared tab |
| User activity | Network requests the agent can observe in a shared tab |
| Authentication information | The link token, plus cookies and storage the agent can read for the shared tab's own site |
| Personal communications | Any shared tab can be email or chat, and the agent reads what is on it |

Leave the others unticked: personally identifiable information, health, financial and payment information, and location. The extension neither asks for nor derives any of them. They reach the server only as the contents of a page the user chose to share, which "Website content" already covers. If a reviewer asks for a broader reading, tick them. Over-disclosing costs less than a rejection.

Tick all three certifications. The data is not sold or transferred to third parties outside the approved uses, not used for anything unrelated to the single purpose, and not used for creditworthiness or lending.

**Privacy policy URL:** `https://tallylamp.dev/privacy`

## Test instructions

Fill in the angle brackets from the reviewer server in step 2 above.

```text
Tallylamp Link does nothing until it pairs with a Tallylamp server. We run one for this review:

  Server address:        <review-server>.up.railway.app
  Administrator secret:  <ADMIN_SECRET of that server>

1. Click the Tallylamp Link icon in the toolbar. A side panel opens.
2. Type the server address and press Connect. An approval page opens in a new tab. Sign in with the administrator secret above.
3. Check that the code on that page matches the one in the side panel. Tick "Review agent" and press "Approve and link". The side panel now says Connected.
4. Open any ordinary website, for example https://example.com, and press "Share this tab" in the side panel. Chrome shows "Tallylamp Link started debugging this browser", and the tab joins an orange tab group named Tallylamp.
5. In the dashboard tab, open Browsers and then the linked browser to watch the shared tab live.
6. Press "Stop sharing this tab", or Cancel on Chrome's bar, to end sharing. "Disconnect" at the bottom of the side panel unlinks the browser.

To watch an agent drive the tab, connect an MCP client to https://<review-server>.up.railway.app/mcp with the bearer token <review agent token>, then call tallylamp_use_browser and take_snapshot.
```

## Changing the images

`node scripts/store-assets.mjs` redraws every image, and `extension/icons/128.png` with them, from `store/stage.html`. The side panel in each screenshot is the real `extension/panel.html` in demo mode, so a change to the panel's words or look shows up on the next run. Everything around the panel is drawn by `stage.html`: the browser window, the pages (all made-up sites on example.com) and Chrome's debugging bar. Open `store/stage.html?shot=share` from a local server to look at one while editing.

## After it is published

The store assigns the listing's URL on first publish. Once it exists, point these at it instead of the release zip and Load unpacked:

- `README.md`, the Tallylamp Link line under linked browsers
- `dashboard/app.js`, `LINK_EXTENSION_ZIP` and the install steps in the Link your own browser dialog
- `docs/linked-browsers.md`, steps 1 and 2 of "Link a browser", and the store paragraph under "Not done yet"
- `docs/template-overview.md`, the Tallylamp Link download link
- the website guide `use-your-own-browser-with-an-agent` in `website/src/content/guides.ts`

Keep attaching `tallylamp-link.zip` to releases. It is still the way in for a browser whose policy blocks the store, and for trying a release before the store has reviewed it.

Each later release uploads a new zip from `make store`. The version in `extension/manifest.json` has to be higher than the published one, and `tests/linked-guard.test.ts` keeps it equal to `package.json`, so a normal release already bumps it. Every upload is reviewed again.
