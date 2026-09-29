# Tallylamp 0.9.1

Two fixes to the recovery and pinning that 0.9.0 added. Both turned up on the
maintainer's own Railway service within an hour of upgrading.

## What changes

- **A browser that loses its renderer zygote is now detected.** Chrome
  retitles its child processes, so on Linux a renderer's or zygote's command
  line reads back as one string of flags joined by spaces. Version 0.9.0 split
  command lines only on the separators Linux puts between arguments, so it found
  no process type for any Chrome child and never saw a zygote to lose. Each
  browser's process and thread count was right; only this check was blind. A
  broken browser was still restarted, but only after three navigations had
  failed with `net::ERR_ABORTED`.
- **Pinning a browser whose start is waiting now counts.** A start checked
  whether its browser was pinned once, when it began. A browser pinned during
  the wait was still treated as unpinned, so it could stop only idle browsers.
  If a busy one held the room, the start failed with `fleet_full`. The start
  now checks again every second while it waits.

## Upgrading

No schema change and no new settings. Tallylamp Link is unchanged apart from
its version number, so a linked browser does not need the extension
reinstalled.
