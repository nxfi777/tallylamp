# Workers

A worker is another service running the Tallylamp image. It runs browsers for
your Tallylamp, and it exists for one reason: a host's process limit.

Railway gives a container 1,000 processes and threads and will not raise that
on a normal plan. The limit is per container, so a second container has a
second 1,000. A worker is that container. Your Tallylamp, called the main
instance below, starts, drives and stops the browsers on it. You keep one
dashboard, one `/mcp` URL and the same agent tokens.

## Before you add one

Try CPU pinning first. It costs nothing and needs no second service. Set
`TALLYLAMP_CHROME_CPUS=4` on the main instance. In a ten-minute test on Railway
with Chrome 154, on three heavy pages, it took one browser from a median of 346
threads to 203. See [process limit settings](railway.md#process-limit-settings).

Add a worker when the main instance still runs out of room, or when you want a
production browser on a host no test browser can touch.

## Add a worker on Railway

1. In the dashboard, open **Workers** and press **Add worker**. Copy the join
   token. It works once and expires in an hour.
2. In the same Railway project and environment as the main instance, choose
   **New**, then **Template**, and pick
   [Tallylamp Worker](https://railway.com/deploy/tallylamp-worker).
3. Paste the token into `TALLYLAMP_JOIN` and deploy.
4. The worker shows under **Workers** within a minute.

To set it up by hand instead, create a service from the same image digest as the
main instance, attach a volume at `/data`, set `TALLYLAMP_JOIN`, and give it no
public domain. Set the healthcheck to `/healthz`.

It has to be the same project and environment. Railway's private network does
not cross either, and the main instance reaches a worker only over it.

## Add a worker anywhere else

Run the same image with `TALLYLAMP_JOIN` set, a volume at `/data`, and
`TALLYLAMP_WORKER_URL` set to the address the main instance should use to reach
it, as `http://host:port`. Off Railway a worker cannot work that address out by
itself, and it refuses to start without it.

The link between the two is plain HTTP with a shared secret. On Railway the
private network encrypts it. Anywhere else, put both on a network you trust, or
a private one such as WireGuard or Tailscale. Do not expose a worker's port to
the internet.

## Where a browser runs

A new browser stays on the main instance while that has room for one. When it
has not, the browser goes to the worker with the most room. That is the default
because everything a worker's browser does crosses the private network, and it
cannot be saved as a saved profile, so it should not land there without a
reason. Set `TALLYLAMP_PLACEMENT=spread` on the main
instance to always use the host with the most room, or `local` to keep every
new browser on the main instance. A browser made from a saved profile always
starts on the main instance, where saved profiles are kept.

The administrator can choose the host when creating a browser in the dashboard,
and can move one later with **Move to…**, in the browser's ⋯ menu or on its
page. A running browser is stopped for the copy and started again on the new
host, and its card shows how much of the profile has been copied. A move copies
the whole profile, logins and tabs included, then deletes it from the old host.
If the copy fails, the browser stays where it was, and starts again there if it
was running. Downloads are not moved. An agent using the browser gets a note on
its next tool call saying where it went. Agents cannot choose or change where a
browser runs.

Each browser's card and page name its worker. The API reports it as `worker`
on a browser, and `GET /api/v1/workers` lists the workers.

## What works on a worker

Linked browsers automatically use an available worker for each MCP control
bridge. Chrome stays on its owner's machine; the bridge's Node process and
threads run on the worker. Each bound session gets its own bridge, so page
selection stays independent. The main instance still checks access and human
control and relays the extension connection.

Under both `overflow` and `spread`, new linked bridges prefer the available
worker with the most process capacity. `TALLYLAMP_PLACEMENT=local` keeps them
on the main instance. With no compatible worker with room, a bridge runs on
the main instance if it has capacity. Existing bridges stay where they were
started until their connection is closed or recreated.

If a worker disconnects, the linked browser and its shared tabs stay online.
The next tool call can reconnect through another worker or the main instance.
A tool interrupted by the disconnect is reported as failed and is never
automatically repeated. Output files are copied back to the main instance
before their paths are returned. Closing or revoking a session also closes
its worker bridge; a heartbeat reaps abandoned bridges after a lost connection.

Everything a browser does on the main instance, except saved profiles. Saved
profiles are kept on the main instance, so a browser on a worker cannot be
saved as one, and a browser made from one starts on the main instance. Saving
is refused with a message saying to move the browser back first.

Some features reach the worker in their own way:

- **Full browser and agent control of Chrome's windows.** Each worker browser
  has its own display on the worker. The worker captures it and does the
  clicks and keystrokes there. It runs only the screen capture and the pointer
  and keyboard commands Tallylamp sends, so the link's secret cannot run
  anything else on it. Extensions are managed through Full browser, as on the
  main instance.
- **Tunnels.** The tunnel still connects to the main instance. When Chrome on
  the worker asks for a private address, the worker checks with the main
  instance, which carries the traffic if a tunnel is bound to that address.
  Public sites never wait on that check.
- **`upload_file`.** It takes a file from the main instance's temp directory,
  as it does for a browser there, and copies it to the worker before Chrome
  gets it. Up to 512 MB per file. The copies are deleted when the browser
  stops.

The live view, takeover, guest links, lending, recording and per-browser
proxies all work as they do on the main instance.

Three more things differ:

- Room is managed per host. On a worker, a start is checked against that
  worker's own limit and refused if it does not fit. Nothing is stopped to make
  room there, and no room is held for a pinned browser. A pinned browser on a
  worker still skips the idle timeout.
- When the main instance restarts, it stops the browsers on its workers too.
  They start again on their next use, as browsers on the main instance do.
- If a worker stops answering for about half a minute, its browsers show as
  crashed. Their profiles are safe on the worker's volume.

## How the two talk

The worker joins once, by calling the main instance's public URL with the join
token. The main instance keeps only a hash of the token. The join returns a
secret, which the worker keeps in `/data/worker.json` and the main instance
keeps in its database, in clear, like proxy credentials. Protect both volumes
and their backups.

After that the main instance calls the worker, and every call carries the
secret. A browser's debugging port on a worker is still bound to `127.0.0.1`.
It is reachable only through the worker's relay, with the secret. A worker
answers nothing without it except `/healthz`.

Deleting a browser deletes its profile on the worker. If the worker cannot
confirm that, the browser is not deleted, so a profile full of logins is never
left behind unrecorded.

## Upgrading

Run the same release on the main instance and every worker. The API between
them is internal and changes without notice. Upgrade them together.

While a worker's release differs, the dashboard says so, and the main instance
starts nothing on it. A worker trying to join on a different release refuses to
start and names both versions.

## Removing a worker

Move or delete its browsers first; the dashboard will not remove a worker that
still has any. Then press **Remove** on the Workers page, and delete the
worker's Railway service. A removed worker that is still running fails its next
start with a message saying it was removed.

To join the same service to a different Tallylamp, set `TALLYLAMP_JOIN` to a
new token from that instance.

## Settings

On the worker:

| Name | Required | Notes |
| --- | --- | --- |
| `TALLYLAMP_JOIN` | yes | The join token. Setting it is what makes the image run as a worker. |
| `TALLYLAMP_WORKER_URL` | off Railway | `http://host:port` as the main instance reaches the worker. On Railway it comes from the service's private domain. |
| `TALLYLAMP_WORKER_NAME` | no | Shown in the dashboard. Defaults to the Railway service name. |
| `TALLYLAMP_CHROME_CPUS` | no | As on the main instance. The worker template sets `4`. |
| `TALLYLAMP_PROCESS_HEADROOM` | no | default 50. Kept free on the worker when a start is checked. |

On the main instance:

| Name | Required | Notes |
| --- | --- | --- |
| `TALLYLAMP_PLACEMENT` | no | `overflow` (default) keeps a new browser on the main instance while it has room, then uses the worker with the most. `spread` always uses the host with the most room. `local` always uses the main instance. |
