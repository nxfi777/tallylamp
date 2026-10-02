# Deploy and Host Tallylamp Worker on Railway

Add another 1,000 processes to a Tallylamp you already run.

Railway gives each service 1,000 processes and threads, and will not raise that
on a normal plan. One Chrome on a few heavy pages can use 700 of them. So when
your Tallylamp answers `fleet_full` and its dashboard shows the host near 1,000,
you are not short of memory, and a bigger plan will not help. Another service
will. A worker is that service: it runs browsers for the Tallylamp you already
have, with a process limit of its own.

If one Tallylamp runs all your browsers without trouble, you do not need this.
Set `TALLYLAMP_CHROME_CPUS=4` on it first. In a ten-minute test on Railway that
took one browser from 346 threads to 203.

This template is not a Tallylamp by itself. It has no dashboard and no MCP
endpoint. Deploy [Tallylamp](https://railway.com/deploy/tallylamp) first.

## About Hosting Tallylamp Worker

One service from the same image as Tallylamp, plus a volume at `/data` for the
profiles of the browsers it runs. It has no public domain. Your Tallylamp
reaches it over the project's private network, and it answers nothing else.

You still have one Tallylamp: one dashboard, one `/mcp` URL, the same agent
tokens. Each browser's page says which host it runs on, and **Move to…** in its
menu moves it between hosts, logins included.

## Add it to your project

1. In your Tallylamp dashboard, open **Workers** and press **Add worker**.
   Copy the join token. It works once and expires in an hour.
2. In the same Railway project as your Tallylamp, choose **New**, then
   **Template**, and pick Tallylamp Worker.
3. Paste the token into `TALLYLAMP_JOIN` and deploy.
4. The worker shows under **Workers** within a minute. From then on, when
   your Tallylamp has no room for a new browser, it starts on the worker.

It has to be the same project. Railway's private network does not cross
projects, so a worker in another one cannot be reached.

To put a browser you already have on the worker, choose **Move to…** from its
menu. A running browser stops for the copy and starts again on the worker,
logins and tabs included.

## Why Deploy Tallylamp Worker on Railway?

Railway's limit is per service, so a second service is the one way to get more
room on a normal plan. Railway also gives the two services a private network.
Browser traffic between your Tallylamp and its worker never crosses the public
internet.

## Common Use Cases

- Keep a production browser away from test browsers. Put one kind on the worker
  and the other on the main instance, and neither can use up the other's
  processes.
- Run more browsers at once than one service holds.
- Give one heavy browser a host to itself.

## Dependencies for Tallylamp Worker

A running Tallylamp in the same Railway project, on the release this template
installs, currently 0.11.1. A worker that tries to join a different release
refuses to start and names both versions.

### Deployment Dependencies

- [Tallylamp on Railway](https://railway.com/deploy/tallylamp)
- The image `ghcr.io/nxfi777/tallylamp`, pinned to a release digest
- A Railway volume at `/data`

## Settings

| Variable | Needed | What it does |
| --- | --- | --- |
| `TALLYLAMP_JOIN` | Yes | The join token from Add worker. Setting it is what makes this image run as a worker. |
| `TALLYLAMP_CHROME_CPUS` | No | Set to `4` by this template. Runs each Chrome on four CPUs, which cuts its threads by about 40%. Remove it to let Chrome use every CPU. |
| `TALLYLAMP_WORKER_NAME` | No | The name shown in the dashboard. Defaults to the Railway service name. |
| `TALLYLAMP_SANDBOX` | No | `auto`, as on Tallylamp. |

Leave `TALLYLAMP_DATA_DIR` and `PORT` alone. The worker finds its own private
address from Railway.

## What works on a worker

Everything a browser does on your Tallylamp: Full browser and extensions, agent
control of Chrome's own windows, tunnels to your machine, file uploads from an
agent, the live view, takeover, guest links and per-browser proxies. The one
exception is saved profiles, which your Tallylamp keeps. A browser on a worker
cannot be saved as one until it is moved back.

Room held for a pinned browser is per host too. On a worker, a start is checked
against that worker's own limit, and nothing is stopped to make room for it.

## Updates are your choice

The template pins an image digest and leaves automatic updates off. Upgrade the
worker and your Tallylamp to the same release, together. While they differ, the
dashboard says so and the worker is given no browsers to start.

## Source and documentation

- [Workers guide](https://github.com/nxfi777/tallylamp/blob/main/docs/workers.md)
- [Source, MIT licensed](https://github.com/nxfi777/tallylamp)
