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

## Release validation

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/40681152841)
passed application, headed Chrome, and running-container checks before
publishing the tested image. Its anonymous registry access, digest, version and
source-revision labels were verified, and `tallylamp-link.zip` is attached to the
release. Pin this Linux amd64 artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:12f81452827a66e122542fc61a8e6ed7540c6e58cf4634f49aa666be82f18523
```

Before release, the same Dockerfile was built and run on Linux amd64 with Google
Chrome 156, starting each run from a cold page cache, as a new container does.
A main instance and a worker on a private network reproduced production's idle
worker: 785 MiB a minute after its browser stopped, 128 MiB with this release.
The browser rendered the same canvas, WebGL, screenshot and X display bytes as
0.12.0, and a viewer in a hidden tab received no frames while Chrome's CPU fell
by about a third. All 519 service tests passed.

After the deploy, production's worker reported 0.12.1 and ran its next scheduled
browser for twelve minutes. As that Chrome exited the worker held 0.60 GB, and a
minute later 0.13 GB. On 0.12.0, the same job left it at about 0.75 GB for hours.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.
