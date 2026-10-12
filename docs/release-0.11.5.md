# Tallylamp 0.11.5

Agents can now debug Chrome extensions in Tallylamp's own browsers. This
release also adds instance export and import, lets Tallylamp Link recover from
network interruptions on its own, and makes the dashboard, API and Full browser
respond faster.

## Debug extensions with an agent

- A browser with the **Extensions** switch on starts its Chrome DevTools MCP
  bridge with the extension tools. `list_pages` lists extension service workers,
  `evaluate_script` with `serviceWorkerId` runs code inside one,
  `list_console_messages` includes content-script messages, and `navigate_page`
  opens an extension's own `chrome-extension://` pages.
- `list_extensions` lists unpacked extensions. `trigger_extension_action`
  presses an extension's toolbar button on the selected page.
  `install_extension` loads an unpacked folder from the Tallylamp host's disk,
  and `reload_extension` and `uninstall_extension` manage it afterwards.
- Only the browser's owner can install, reload or uninstall. A grant never
  permits those, at either access level, because an installed extension keeps
  running after the loan ends. A `control` grant can trigger an action and run
  code in a service worker, with that extension's permissions. A `read` grant
  can list extensions.
- Linked browsers never get these tools. Calls are refused with a reason on a
  linked browser, on a browser with extensions off, and for `install_extension`
  on a browser that runs on a worker.

See [debugging an extension](usage.md#debugging-an-extension).

## Export and import

`node bin/tallylamp.mjs export` saves the instance's stored data as one
`.tar.gz` archive, for a backup or to move selected browsers, saved profiles
and downloads to another machine. Export stops the browsers it includes and
leaves them stopped, so Chrome cannot write to a profile while it is read.
Import checks the archive offline and restores it into a new data directory.
The archive holds browser logins, proxy credentials and agent token hashes, so
protect it like the data volume. See [export and import](transfer.md).

## Tallylamp Link

The extension retries a dropped connection or DNS failure by itself. Shared
tabs stay shared while it reconnects, and the agent can use them again once the
panel says Connected. If the server stays unreachable for a minute, the tabs
are handed back, even when Chrome restarts the extension's background worker.

## Dashboard and speed

- Navigation fits narrow screens, pages show loading and error states reliably,
  forms show when they are saving, and tabs work from the keyboard. Each browser
  shows who holds control.
- The OAuth consent page has **Select all**.
- Refreshes and screen captures no longer pile up, compiled SQLite queries are
  reused, and profile file work runs off the main event loop. Full browser input
  has no added delays, capture pauses while the view is hidden, and the control
  stream responds faster at the same image quality.

## Upgrading

No database changes and no new settings. Source installs gain one npm
dependency, `tar`, for export and import. Upgrade the main instance and every
worker together: while they run different releases, the main instance starts
nothing on a worker. Redeploys restart running browsers; their profiles remain
on the persistent volume.

Existing Tallylamp Link installs keep working with this server. Load this
release's `tallylamp-link.zip` to get the reconnect behaviour.
