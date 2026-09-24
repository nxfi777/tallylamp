# Tallylamp 0.8.5

Tallylamp now refuses to start a browser when the host has no room left for
one, instead of letting it crash the tabs in every other browser. The live view
also keeps resizing, and a stopped browser offers Start.

## What changes

- **A start is refused when the host is out of processes.** Railway limits a
  container to 1,000 processes and threads, and each Chrome uses 230–420.
  Since 0.8.1 removed the default browser cap, a third or fourth browser could
  push the container past the limit. Chrome then could not start pages, so tabs
  in every running browser crashed and showed as blank, and Full browser could
  not start. Tallylamp now checks the host's limit before starting a browser
  and refuses if there isn't room, saying how many processes are in use. Stop a
  browser you are not using and try again. A host with no limit is unaffected.
- **Clearer errors when it happens anyway.** A running browser can still grow,
  for example by opening many tabs. The server now logs when the host refuses
  a process, the live view says when a tab has crashed and why, and Full
  browser gives the real reason it could not start instead of always saying
  ffmpeg is missing.
- **The live view keeps resizing.** Chrome 153 and newer refuse to restart a
  running screencast. Resizing the live view or changing its quality failed
  after the first time, which left the view letterboxed at its first size. It
  now stops the stream before restarting it.
- **A stopped browser offers Start.** Its card, menu and page used to offer
  Watch and Take control, which have nothing to act on until Chrome runs. They
  now offer Start and Open. Start, Stop and Restart say what they are doing as
  soon as you press them, and the page no longer says "Browser stopped" while
  Chrome is starting.

## Upgrading

No schema change and no configuration change. On Railway, expect two or three
browsers to run at once. Tallylamp Link is unchanged apart from its version
number, so a linked browser does not need the extension reinstalled.
