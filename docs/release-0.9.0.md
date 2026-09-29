# Tallylamp 0.9.0

Railway gives a container 1,000 processes and threads, and every browser on it
draws from that one pool. On 29 September a test browser took 612 of them. The
kernel then refused new threads and killed a production browser's renderer
zygote, the process Chrome starts its pages from. That browser was still listed
as running, but every page it tried to load failed. When it was stopped, its
restart was refused for lack of room, while the test browser kept running.

In 0.9.0 you can pin the browsers that must stay up. Tallylamp also counts what
each browser uses, makes room by stopping idle ones, tells you when the pool
runs dry, and restarts a browser the limit has broken.

## What changes

- **Pin the browsers that must stay up.** Turn on **Pinned** on a browser's
  page, or call `PUT /api/v1/browsers/{id}/pinned`. Only the administrator can.
  Tallylamp holds room for a pinned browser, so no other browser can start
  into it. To start a pinned browser, or keep one running, it stops unpinned
  browsers: idle ones first, and busy ones only when a running pinned browser
  is about to run out. It never stops a browser a person has taken control of.
  Pinned browsers also skip the idle timeout.
- **Each browser's share is counted.** Tallylamp counts the processes and
  threads in each browser's whole tree. That includes its Xvfb display, its MCP
  bridges, and renderers left behind when their parent died. The dashboard
  shows each browser's count and the host's total. The API returns them as
  `threads` on a browser and `host` on `/api/v1/status`.
- **A start waits for room.** A browser is admitted on its own peak from its
  last start, plus a quarter and 25 more. One that has never run under 0.9.0 is
  assumed to need 300. Version 0.8.5 assumed 450 for every browser, which
  refused a browser that runs at about 187 while 356 were free. With no room,
  the start waits up to 30 seconds and shows as queued. Then it fails with
  `fleet_full`, and the error names the largest running browsers.
- **Idle browsers make room.** When free room falls below what is held for
  pinned browsers and starts in progress, Tallylamp stops idle unpinned
  browsers, largest first. Their profiles and tabs are kept, and they start
  again on their next use.
- **A broken browser is restarted.** Some browsers lose the zygote their pages
  start from. Others fail every navigation with `net::ERR_ABORTED`, three times
  in a row on more than one site. Either way the browser shows as `unhealthy`
  and is restarted. After three restarts in 30 minutes it is left running for a
  person to look at.
- **You hear when the pool runs dry.** When the kernel refuses a process, the
  dashboard shows a banner. Each running browser's agent gets a `[tallylamp]`
  note on its next tool call. An agent also gets a note when its browser was
  stopped for room or restarted.
- **Thread-saving Chrome flags stay off until measured.**
  `TALLYLAMP_CHROME_CPUS`, `TALLYLAMP_RENDERER_PROCESS_LIMIT` and
  `TALLYLAMP_IN_PROCESS_GPU` each cut Chrome's thread count, and each has a
  cost. None has had a long test yet, so all three are off. The image now
  includes `scripts/thread-soak.mjs` to measure them on your own host.

## Upgrading

The `browsers` table gains three columns, `pinned`, `launch_threads` and
`peak_threads`, which older images ignore. Nothing needs configuring; the new
settings are listed under [process limit settings](railway.md#process-limit-settings).

No browser is pinned after the upgrade, so pin the ones that matter. Each
browser is measured on its first start under 0.9.0.

To keep production browsers fully apart from test browsers, run them on a
second Railway service, which gets its own 1,000. See
[isolating production browsers](railway.md#isolating-production-browsers).

Tallylamp Link is unchanged apart from its version number, so a linked browser
does not need the extension reinstalled.
