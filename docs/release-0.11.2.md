# Tallylamp 0.11.2

You can make Tallylamp forget how many threads a browser has used, so that it
is measured again.

A browser's next start is sized from what its last start reached, plus a
quarter and 25. One heavy run could leave a browser sized past what it needs.
It was then refused starts it would have fitted, or, if pinned, held room it
would not use. The only way to clear those counts was to change a Chrome thread
setting, which clears every browser's.

## What changes

- **Reset a browser's thread counts.** On a host with a process limit, a
  browser's page has a **Processes and threads** row under **Pinned**. It says
  what the browser is using, the most it has reached, and how much room its
  next start needs. **Reset** forgets those counts, whether the browser is
  running or stopped, on the main instance or a worker. A running browser is
  measured again from then on, and its launch on its next start. Until then a
  start is assumed to need `TALLYLAMP_BROWSER_THREADS`, 300 by default. The
  same reset is `POST /api/v1/browsers/{id}/threads/reset`.
- **Only the administrator can reset.** A smaller estimate is room that another
  browser's start was counting on, so this works like pinning. A start refused
  for room now says when a reset would let it in: "That estimate comes
  from an earlier start. If it needs less now, the administrator can reset its
  thread counts on its page." It says so only when the browser's own
  measurement is larger than the default and the default would fit. Agents are
  told to pass this on to you rather than retry.
- **A waiting start picks up a reset.** A start queued for room is sized again
  every second, so a reset lets it in as soon as it fits.
- **Browsers report what their next start needs.** `GET /api/v1/browsers`
  returns `startThreads` beside `threads`, `peakThreads` and `launchThreads`.
- **Tallylamp Link stops reporting errors for other extensions' pages.** With
  another extension's page in front, such as daily.dev's new tab page, the side
  panel tried to load that extension's icon. Chrome refused it and listed the
  refusal on `chrome://extensions` as an error in Tallylamp Link. The panel now
  loads only web and inline icons, and shows a letter for any other tab.

## Upgrading

No schema change and no new settings. Upgrade the main instance and every
worker together: while they run different releases, the main instance starts
nothing on a worker.

Install the new `tallylamp-link.zip`, or reload an unpacked copy, to get the
side panel fix. A linked browser keeps working with the old extension.
