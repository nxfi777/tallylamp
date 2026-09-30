# Tallylamp 0.10.0

Railway gives a service 1,000 processes and threads and will not raise that on
a normal plan. The 0.9 releases made one service behave inside the limit. This
one adds a way past it, workers, and turns on a Chrome setting that cuts a
browser's threads by about 40%.

## What changes

- **Workers.** A worker is a second service running this image with
  `TALLYLAMP_JOIN` set. It runs browsers for your Tallylamp within its own
  1,000. You keep one dashboard, one `/mcp` URL and the same agent tokens. Add
  one from the new **Workers** page. A new browser stays on the main instance
  while it has room, and starts on a worker when it has not. To move one you
  already have, logins included, stop it and use **Runs on** on its page. The
  [workers guide](workers.md) has the rest.
- **Some things do not reach a worker yet.** Full browser, agent control of
  Chrome's own windows, tunnels, saved profiles and `upload_file` work only on
  the main instance. A worker's browser refuses each one and says to move it
  back first. The live view, takeover, guest links, lending, recording and
  per-browser proxies work on both.
- **CPU pinning is measured, and the template turns it on.** With
  `TALLYLAMP_CHROME_CPUS=4`, one browser went from a median of 346 threads to
  203, over ten minutes on three heavy pages. No tab crashed and no reload
  failed. The Railway template sets it for new installs. On an existing
  install, set it yourself. The numbers are in
  [process limit settings](railway.md#process-limit-settings).
- **A browser is measured again when that setting changes.** One browser was
  measured at 606 threads before pinning. After pinning it was still sized from
  that, at 783, and refused a start it would have fitted. Tallylamp now drops
  its thread measurements when the CPU or renderer setting changes.
- **`TALLYLAMP_IN_PROCESS_GPU` is gone.** Chrome 154 dies at launch with it
  here. The variable is now ignored, so remove it if you set it.

## Upgrading

The database gains `workers` and `worker_join_tokens` tables and a
`browsers.worker_id` column. Without a worker, nothing about your browsers
changes, and older images ignore all three.

Do not roll back while any browser is on a worker. An older image would treat
that browser as its own and start it on an empty profile. Move such browsers
back to the main instance first.

Run the same release on the main instance and its workers, and upgrade them
together. While they differ, the main instance starts nothing on that worker.

Tallylamp Link is unchanged apart from its version number, so a linked browser
does not need the extension reinstalled.
