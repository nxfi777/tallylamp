# Tallylamp 0.12.1

Tallylamp holds much less memory when nothing is running, and stops doing work
nobody sees. Railway bills a container's page cache as memory, and nothing in a
32 GB container makes the kernel give it back. Before this release, a worker kept
about 0.75 GB for hours after its last browser had stopped.

## What changes

Measured on this release's image, one browser on its start page:

| | 0.12.0 | 0.12.1 |
|---|---:|---:|
| Worker, a minute after its browser stops | 785 MiB | 128 MiB |
| Main instance, a minute after its browser stops | 524 MiB | 292 MiB |
| Main instance with one browser running | 1,602 MiB | 1,406 MiB |

- **Workers give back their page cache.** A minute after a worker's last browser
  stops, the cache that browser left behind is dropped, as the main instance
  already did.
- **More is dropped once nothing runs.** On both hosts, the system libraries and
  fonts Chrome loaded go too. They held about 240 MB.
- **A smaller display per browser.** With software rendering, the normal case
  on Railway, Xvfb starts without GLX. Chrome renders in its own GPU process
  and never used it, but it cost about 70 MB per running browser. Pages render
  identically: canvas, WebGL and screenshot output match 0.12.0 byte for byte.
- **Hidden viewers cost nothing.** While a dashboard tab with Tab view is in the
  background, Chrome stops encoding frames for it. Shown again, it starts with
  a fresh frame. Full browser already worked this way.
- **Crashed browsers are cleaned up.** A Chrome that dies by itself now takes its
  display and any remaining processes with it. One killed by a signal, such as
  an out-of-memory kill, is seen as stopped at once, instead of looking like it
  was running until its idle timeout.
- **Less background checking.** Sign-in detection no longer inspects tabs on
  sites already recorded or dismissed for that browser.

The first start after a minute of idle reads those libraries back from disk. In
five paired runs the median start was unchanged, but two starts took 0.3 to
0.4 seconds longer.

## Upgrading

No settings or schema change. Upgrade the main instance and every worker
together: while they run different releases, the main instance starts nothing on
a worker. Redeploys restart running browsers; their profiles remain on the
persistent volume. `TALLYLAMP_EVICT_PAGE_CACHE=0` still turns page cache eviction
off, now on workers too.

Tallylamp Link is unchanged apart from its version number.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.
