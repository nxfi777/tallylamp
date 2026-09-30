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
because a worker's browser cannot do everything yet (see below), so it should
not land there without a reason. Set `TALLYLAMP_PLACEMENT=spread` on the main
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

## What does not work on a worker yet

These need the main instance's display or disk, and are refused on a worker's
browser with a message saying to move it back first:

- Full browser, and extension management, which uses it
- agent control of Chrome's own windows
- tunnels
- saved profiles, both saving one and creating a browser from one
- `upload_file` from an agent

The live view, takeover, guest links, lending, recording and per-browser
proxies all work.

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
