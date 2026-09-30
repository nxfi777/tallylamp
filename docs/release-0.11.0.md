# Tallylamp 0.11.0

A browser on a worker now does everything a browser on the main instance does,
apart from being saved as a saved profile.

Until now, moving a browser to a worker cost it Full browser, agent control of
Chrome's windows, tunnels and uploads. A browser that needed any of those could
not have a host to itself, which is the reason to add a worker.

## What changes

- **Full browser works on a worker.** The worker captures the browser's own
  display and does the clicks and keystrokes there, so the dashboard's Full
  browser view shows Chrome's toolbar, popups and dialogs as it does on the
  main instance. Extensions can be switched on and managed through it.
- **Agents can use Chrome's own windows on a worker.**
  `tallylamp_desktop_screenshot` and `tallylamp_desktop_action` work once
  **Allow agent control** is on, the same switch as on the main instance.
- **Tunnels reach a worker's browser.** The tunnel still connects to the main
  instance. When Chrome on the worker asks for a private address, the worker
  checks with the main instance, which carries the traffic if a tunnel is bound
  to it. Public sites never wait on that check.
- **`upload_file` works on a worker.** It takes a file from the main instance's
  temp directory, the same rule as before, and copies it to the worker first.
  Its answer names the path the agent gave, not the copy's.
- **A call made during a move keeps its browser.** An agent whose call landed in
  the seconds a move takes was told no browser was bound, and had to call
  `tallylamp_use_browser` itself. Now that call is refused as retryable, and the
  next one reconnects to the same browser.
- **A browser's page follows a move made elsewhere.** A move from another tab,
  or from the API, left the browser's open page naming the old host until it
  was reloaded. The page now redraws when its browser moves.

On Railway, with a main instance and one worker, a running browser moved to the
worker in 0.6 seconds and was driven there through `/mcp`. Chrome on the worker
read a file uploaded from the main instance, loaded a page from a laptop through
a tunnel, and took keystrokes that opened `chrome://extensions`. Full browser
showed its first frame in 0.4 seconds.

## Security

xdotool can run programs and ffmpeg can write files. So a worker runs only what
Tallylamp builds: a capture of that browser's own display, and pointer and
keyboard commands. Each is checked argument by argument. Anything else is
refused, so the secret the main instance holds cannot run other commands on a
worker.

`upload_file` still refuses a file outside the main instance's temp directory,
exactly as it does for a browser there. The file is only copied after that
check passes.

## Upgrading

No schema change and no new settings. Upgrade the main instance and every
worker together: while they run different releases, the main instance starts
nothing on a worker.

Tallylamp Link is unchanged apart from its version number, so a linked browser
does not need the extension reinstalled.
