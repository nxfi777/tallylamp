# Railway

Use the [Railway template](https://railway.com/deploy/tallylamp), or deploy
Tallylamp from its public GHCR image with a volume mounted at `/data`.
The volume keeps browser profiles and the database across redeploys.

## Deploy and connect

1. Create an image service using `ghcr.io/nxfi777/tallylamp:0.10.1` and pin the
   [release digest](#releasing-and-upgrading). The published Railway template
   pins the same digest, supplies these settings, and leaves automatic image
   updates disabled.
2. Attach a volume at `/data`.
3. Set **`ADMIN_SECRET`** (`openssl rand -hex 32`); the template generates it for you.
   Do not paste `.env.example`. There is no browser cap unless you set `TALLYLAMP_MAX_BROWSERS`.
4. Set the healthcheck to `/healthz` with a 120-second timeout.
5. Generate a public domain on port **8080**.
6. Open the URL and log in.
7. Header-based clients: create an agent, copy `tl_ag_…`.
   OAuth-only hosts: add `https://<host>/mcp`, then approve the connector on the consent page while signed into the dashboard.

## Service settings

| Setting | Value |
|---|---|
| Source | Public GHCR image, pinned to a release digest |
| Automatic image updates | Disabled |
| Healthcheck | `/healthz` |
| Timeout | 120s recommended (startup healthcheck) |
| Volume mount | `/data` |
| Start command | Leave unset; keep the image's entrypoint |
| Replicas | 1 |

## Required and inferred variables

Set variables in the Railway service UI. Keep `.env.example` for local use;
copying the whole file into Railway can override deployment defaults.

| Name | Required | Notes |
|---|---|---|
| `ADMIN_SECRET` | yes | Dashboard password. Generate with `openssl rand -hex 32`; the image supplies no default. OAuth consent uses the dashboard session. Rotation revokes all dashboard sessions and OAuth grants. |
| `TALLYLAMP_PUBLIC_URL` | no | Inferred from `RAILWAY_PUBLIC_DOMAIN` once a domain exists. Set explicitly if cookies/MCP metadata look wrong. |
| `TALLYLAMP_DATA_DIR` | **leave unset** | Tallylamp uses `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached. It ignores relative overrides in that case. An absolute override outside the mount would put data on ephemeral storage. |

## Browser and session settings

Upstream proxies are configured per browser, through the dashboard, API, or MCP.
Do not set a shared `HTTP_PROXY` variable or add provider credentials to the
template. Browser proxy settings persist in SQLite on `/data`; credentials are
unencrypted at rest. See [proxy setup and limits](proxies.md).

| Name | Required | Notes |
| --- | --- | --- |
| `TALLYLAMP_MAX_BROWSERS` | no | Unset or `0` = no cap. A positive number caps running Chromes; each is memory-heavy. |
| `TALLYLAMP_IDLE_TTL_SEC` | no | default 900. Idle *unattached* browsers are stopped (profiles kept). `0` disables reaping. |
| `TALLYLAMP_ATTACHED_IDLE_TTL_SEC` | no | default 14400. Applies while a watcher with the tab in view, or a human controller, is attached. |
| `TALLYLAMP_MCP_ATTACHED_IDLE_TTL_SEC` | no | default 1800. Applies when an MCP session is the only attachment. Tool calls reset the clock; a client left open does not. |
| `TALLYLAMP_EVICT_PAGE_CACHE` | no | default on for Linux. Drops the file cache a stopped Chrome leaves behind, which Railway bills as memory. Needs `vmtouch`, which the image includes. |
| `TALLYLAMP_MCP_SESSION_IDLE_SEC` | no | default 600. Closes an MCP session whose client vanished without `DELETE /mcp`. |

## Process limit settings

These apply only where the host sets a process ceiling, as Railway does. See
[Isolating production browsers](#isolating-production-browsers).

| Name | Required | Notes |
| --- | --- | --- |
| `TALLYLAMP_ADMISSION_WAIT_SEC` | no | default 30. How long a start waits for room before it fails with `fleet_full`. `0` refuses at once. |
| `TALLYLAMP_BROWSER_THREADS` | no | default 300. What a start is assumed to need before that browser has been measured. After its first start, its own launch peak plus a quarter and 25 is used. |
| `TALLYLAMP_PROCESS_HEADROOM` | no | default 50. Kept free at all times, so ffmpeg, xdotool and MCP bridges can still start. |
| `TALLYLAMP_SHED_IDLE_SEC` | no | default 300. A browser unused this long, with nobody watching, may be stopped to make room. `0` never stops an idle browser for room. |
| `TALLYLAMP_UNHEALTHY_RESTARTS` | no | default 3. Automatic restarts of a broken browser allowed in 30 minutes. Past that it is left running and reported `unhealthy`. |
| `TALLYLAMP_CHROME_CPUS` | no | default off; the template sets `4`. Runs each Chrome under `taskset` on this many CPUs, a different set for each browser. Measured below. It caps one browser at that many cores. |
| `TALLYLAMP_RENDERER_PROCESS_LIMIT` | no | default off. Not measured. Passes `--renderer-process-limit`, a soft cap that site isolation exceeds. |
| `TALLYLAMP_PLACEMENT` | no | default `overflow`. With [workers](workers.md), a new browser stays on this instance while it has room, then goes to the worker with the most. `spread` always picks the host with the most room; `local` always picks this instance. |

Chrome sizes its thread pools from the CPUs it sees, and a Railway container
shows 48 while its quota is 32. `TALLYLAMP_CHROME_CPUS` pins each Chrome to a
few of them. Measured on Railway with Chrome 154, for ten minutes each on
ChatGPT, BBC News and Grok, reloading every minute:

| Run | CPUs Chrome saw | Median threads | Max | Threads per renderer | Crashed tabs | Failed reloads |
| --- | --- | --- | --- | --- | --- | --- |
| Unpinned | 48 | 346 | 369 | 24.2 | 0 | 0 of 27 |
| 4 CPUs | 4 | 203 | 232 | 11.1 | 0 | 0 of 27 |
| 8 CPUs | 8 | 234 | 240 | 13.4 | 0 | 0 of 27 |
| Unpinned again | 48 | 338 | 370 | 23.9 | 0 | 0 of 27 |

Four CPUs cut a browser's threads by about 40%. Page speed was not measured.
The GPU process stayed at about 30 threads in every run.

When this setting or the renderer limit changes, Tallylamp forgets each
browser's measured thread counts on its next boot, and measures again on the
browser's next start. Counts taken under the old setting would size a start
wrongly.

`--in-process-gpu` was an option in 0.9.x and is gone. Chrome 154 dies at launch
with it here, before its debugging port opens. Turning site isolation off is
not offered either. It would cut the most processes, but these browsers hold
signed-in sessions, and site isolation is the boundary between them.

To measure another setting yourself, use a service that holds no production
browser, because the test Chrome shares that service's limit. `railway ssh`
connects as root, and Chrome will not run as root with its sandbox on, so drop
to the service's user as the entrypoint does:

```sh
railway ssh -- setpriv --reuid=1100 --regid=1100 --init-groups \
  node /app/scripts/thread-soak.mjs --variant baseline --minutes 10 \
  --url https://chatgpt.com/ --out /tmp/soak-baseline.jsonl
railway ssh -- setpriv --reuid=1100 --regid=1100 --init-groups \
  node /app/scripts/thread-soak.mjs --variant cpus=4 --minutes 10 \
  --url https://chatgpt.com/ --out /tmp/soak-cpus4.jsonl
```

Run a baseline and the variant back to back, on the same URLs. The summary
gives threads per process kind, crashed tabs, failed reloads and whether the
renderer zygote was lost. `hardwareConcurrency` in the first line is the CPU
count Chrome saw.

## Viewer settings

| Name | Required | Notes |
| --- | --- | --- |
| `TALLYLAMP_VIEWER_WATCH_QUALITY` | no | default 60 (JPEG). Lower it if bandwidth-bound. |
| `TALLYLAMP_VIEWER_WATCH_MIN_FRAME_MS` | no | default 100 (10fps). Minimum time between frames. Counting compositor updates with `everyNthFrame` alone does not set a time limit. |
| `TALLYLAMP_VIEWER_CONTROL_MIN_FRAME_MS` | no | default 66 (~15fps) |
| `TALLYLAMP_VIEWER_HIGH_WATER_BYTES` | no | default 2 MiB. Frames are dropped and the screencast ack withheld above this, so a stalled viewer cannot grow the process. |
| `TALLYLAMP_VIEWER_CONGESTED_BYTES` | no | Unused; stream adaptation now uses socket drain time. The setting remains accepted for compatibility. |
| `TALLYLAMP_VIEWER_MAX_ENCODED_WIDTH` | no | default 1280. A ceiling on the encoded frame, independent of the window. Measured on a photo-heavy page: 1440x800 at q70 is 143 KB a frame, 2.2 MB/s at 15fps. Clicks map through the frame's reported size, so a smaller encode stays exact and only costs sharpness. |

## Runtime settings

| Name | Required | Notes |
| --- | --- | --- |
| `TALLYLAMP_MCP_BRIDGE_NODE_OPTIONS` | no | default `--max-old-space-size=192 --max-semi-space-size=1`, applied to each chrome-devtools bridge child. |
| `NODE_OPTIONS` | set in the image | `--max-semi-space-size=2 --max-old-space-size=256`. V8 otherwise sizes its heap against the container's visible 32 GB. |
| `TALLYLAMP_VIEWER_MAX_WIDTH` / `_HEIGHT` | no | the starting screencast clamp; defaults to `TALLYLAMP_WINDOW_SIZE`. A control viewer then resizes the window to its stage and moves the clamp with it. |
| `TALLYLAMP_XVFB_SCREEN` | no | default `2560,1600`. The X root window, and the ceiling a control viewer can grow the Chrome window to. Deliberately larger than `TALLYLAMP_WINDOW_SIZE`. |
| `TALLYLAMP_SANDBOX` | no | `auto` (likely `fell-back` on Railway) |
| `TALLYLAMP_GPU` | no | `auto`; uses the available renderer |
| `TALLYLAMP_ALLOW_PRIVATE_NETWORK` | no | default blocked |

## OAuth settings

| Name | Required | Notes |
| --- | --- | --- |
| `TALLYLAMP_OAUTH` | no | Default on. Required for OAuth-only clients. Turning it off stops discovery and new OAuth flows; revoke existing grants on the Agents page. |
| `TALLYLAMP_OAUTH_ACCESS_TTL_SEC` | no | default 3600 |
| `TALLYLAMP_OAUTH_REFRESH_TTL_SEC` | no | default 2592000 (30 days) |
| `TALLYLAMP_OAUTH_MAX_BROWSERS` | no | Default `0` = no cap. Browser cap for a new connector agent. |
| `TALLYLAMP_OAUTH_CLIENT_HOSTS` | no | empty = accept any https client-metadata URL. Comma-separated hostnames to restrict it. |
| `TALLYLAMP_ADMIN_BEARER` | no | default **off**. Turning it on lets `ADMIN_SECRET` be used as a bearer token, which is a brute-forceable master key. |
| `TALLYLAMP_EXTENSIONS_DEFAULT` | no | default **on**. Every new managed browser starts with extension support enabled, whoever created it. Set `0` to start them with it off. Existing browsers keep their saved choice, and Disable extensions still wins. It installs nothing. Extensions can read signed-in pages and keep running after control returns to an agent. Ignored on a host without Full browser. |
| `TALLYLAMP_AGENT_DESKTOP_DEFAULT` | no | default **on**. New agent-owned browsers start with **Allow agent control**. Set `0` to start them with it off. Existing browsers keep their saved choice. This does not enable or install extensions. Native UI includes host-file dialogs. |

## Deployment limits

- No GPU: WebGL is software or absent. Dashboard shows `gpuStatus`.
- Chrome renderer sandbox will likely show `fell-back`.
- `/dev/shm` is often small; we pass `--disable-dev-shm-usage`.
- One replica. Redeploy stops every browser process; **profiles survive** on
  the volume and are lazy-started on the next use.
- Memory: budget roughly 1–2 GB per headed Chrome plus the Node process.
- Processes: Railway limits a container to 1,000 processes and threads,
  shared by every browser. A Chrome on one quiet tab uses about 200; one
  loading heavy pages can pass 600. Past the limit Chrome cannot start
  renderers, tabs crash in every browser, and a browser can lose the zygote it
  starts renderers from, after which every navigation fails while Chrome
  itself keeps running. See [Isolating production browsers](#isolating-production-browsers).

## Isolating production browsers

The 1,000 limit is per container, and cannot be raised on a normal plan:
Railway staff said in April 2026 that higher pids limits are for Enterprise
customers only. `/sys/fs/cgroup` is read-only inside the container, even for
root, so Tallylamp cannot give each browser a limit of its own either. What it
does instead:

- It counts each browser's processes and threads by process tree. The
  dashboard and `GET /api/v1/browsers` show each browser's share
  (`threads`), and `/api/v1/status` shows the host's (`host`).
- It admits a start on the peak that browser reached in the first minute of
  its last start. When there is no room yet, the start waits for up to
  `TALLYLAMP_ADMISSION_WAIT_SEC`.
- When room runs short it stops idle, unpinned browsers, largest first.
  Profiles and tabs are kept, and the browser starts again on its next use.
- It finds a browser that lost its renderer zygote, or whose navigations all
  fail with `net::ERR_ABORTED`, reports it `unhealthy` and restarts it.
- When the kernel refuses a process, the dashboard shows it, and every
  running browser's agent gets a note on its next tool call.

To keep a browser from ever being starved by another, either pin it or put it
on a worker.

**Pin it.** On the browser's page, turn on **Pinned**, or call
`PUT /api/v1/browsers/{id}/pinned` with `{"pinned": true}`. Only the
administrator can pin. Tallylamp holds room for a pinned browser, so an
unpinned one cannot start into it. It stops idle unpinned browsers to start
it, and it stops an unpinned browser that is in use only when a running pinned
browser is about to run short. It never stops a browser a person has taken
control of, and pinned browsers are never stopped for idleness. Pinning works
within one service, but everything still shares that service's 1,000.

**Put it on a worker.** A [worker](workers.md) is a second service running
this image, which runs browsers for this instance within its own 1,000. Add
one from **Workers** in the dashboard, then choose **Move to…** on the browser.
It stops for the copy and starts again on the worker. You keep one dashboard
and one `/mcp` URL, and the browser keeps its logins. Nothing on the main instance can use up a
worker's processes, or the other way round.

## Publishing the template

The published template is at [railway.com/deploy/tallylamp](https://railway.com/deploy/tallylamp).
The listing copy is in [template-overview.md](template-overview.md), including
Railway's required section headings. Railway refuses listing copy over 10,000
characters, and the current copy is within a few characters of that, so trim
before adding a section. `.railway/railway.ts` is a separate project
configuration example; it does not update the marketplace template.

Create the template from a clean test project using the public release image.
Pin its digest and set `source.autoUpdates.type` to `disabled`. Keep the image's
entrypoint, one replica, a `/data` volume, an HTTP domain on port `8080`,
and a `/healthz` healthcheck with a 120-second timeout. Set these template variables:

| Variable | Template value |
| --- | --- |
| `ADMIN_SECRET` | `${{secret(64, "abcdef0123456789")}}` |
| `TALLYLAMP_ALLOW_PRIVATE_NETWORK` | `0` |
| `TALLYLAMP_SANDBOX` | `auto` |
| `TALLYLAMP_CHROME_CPUS` | `4` |

The secret expression creates a different dashboard password for each deployment.
Users retrieve it from their own Railway variables after deployment. Leave the
public URL inferred from the generated domain and use the volume for data.
Keep personal domains, credentials, and project IDs out of the template.
See [Railway's template creation guide](https://docs.railway.com/templates/create)
for variables and service settings.

The current CLI supports `railway templates create --project PROJECT_ID` and
`railway templates publish TEMPLATE_ID`, including a `--readme-file` option.
Creation produces an unpublished template; marketplace publication is a separate
step. Use `railway templates publish --help` for the current required fields, or
use the dashboard. [CLI reference](https://docs.railway.com/cli/templates).

Deploy an unpublished copy into a fresh project before publishing. Verify login,
an agent connection, watch/takeover/return, and profile persistence after a redeploy.
Then publish and add its real deploy URL to the README and website.

The worker has a template of its own, Tallylamp Worker, with its listing copy in
[worker-template-overview.md](worker-template-overview.md). It is one service
from the same image digest, with a `/data` volume, a `/healthz` healthcheck and
no public domain. Its variables are `TALLYLAMP_JOIN`, which the person
deploying fills in, plus `TALLYLAMP_SANDBOX` as `auto` and
`TALLYLAMP_CHROME_CPUS` as `4`. Pin both templates to the same digest at each
release: a worker and the instance it joins must run the same release.

## Releasing and upgrading

The current release is [0.10.1](https://github.com/nxfi777/tallylamp/releases/tag/v0.10.1)
for Linux amd64. To pin the tested artifact, use this image reference:

```text
ghcr.io/nxfi777/tallylamp@sha256:84e7560a906fc3467a4befd493feeb1a39ec5b4db2ebd4ba47b7aedc7e676df5
```

The [0.10.1 release workflow](https://github.com/nxfi777/tallylamp/actions/runs/36764518716)
passed application tests, headed Chrome tests, and running-container checks
before publishing the same artifact, then attached `tallylamp-link.zip`, the
linked-browser extension, to the release. Anonymous registry access, the manifest
digest, the version and source-revision labels, and the zip's manifest version
were verified afterward. The image's source revision is
`eae6846820de181021baf598dba424f4be013f48`.

The Railway template pins the `0.10.1` digest for new installations, and the
[Tallylamp Worker](https://railway.com/deploy/tallylamp-worker) template pins
the same one. Each template's published configuration was read back after the
update, and only the image had changed. Existing deployments keep their
selected image. Version 0.10.1 changes no tables and adds no settings.

Before the pin, the release's source was deployed to Railway as a main instance
with one worker. A running browser with a 2.2 GB profile was moved to the
worker from its menu. It stopped, crossed in about 17 seconds with its progress
on the card, and started again there, and the message saying where it runs
stayed on screen at phone width. The 0.10.0 checks were not repeated: driving
a browser on a worker through `/mcp`, reading storage back after a move each
way, and `upload_file` being refused on a worker. Railway redeploy
persistence and unique passwords across two template installations were checked
for `0.1.1`, not repeated since. These checks do not certify every
external MCP client, proxy provider, or Chrome extension.

Version 0.10.0 adds `workers` and `worker_join_tokens` tables and a
`browsers.worker_id` column. Older images ignore them, but do not roll back
while a browser is on a worker: an older image would start it on an empty
profile. Version 0.9.0 adds `pinned`, `launch_threads` and `peak_threads` columns to
`browsers`. No browser is pinned after the upgrade, and older images ignore all
three. Version 0.8.0 adds an `access` column to `browser_grants`, and `access` and
`granted_access` columns to `browser_requests`. All three default to `control`,
so existing grants keep their access, and older images ignore the columns. It
also starts new browsers with extension support on, and new agent-owned browsers
with Allow agent control on; set `TALLYLAMP_EXTENSIONS_DEFAULT=0` or
`TALLYLAMP_AGENT_DESKTOP_DEFAULT=0` to keep the old defaults. Version 0.7.1
changes no database tables and adds no settings. Version 0.7.0 adds the
`browser_guests` and `guest_sessions` tables for guest links and scrubs raw
session tokens from `viewer_tickets`; older images ignore the new tables, and
guest links stop working if you roll back. Version 0.6.1 adds the
`linked_access` table and moves 0.6.0 linked browsers to the administrator,
keeping their agent on the list. Version 0.6.0 added the `browser_links` and
`link_pairings` tables and a `browsers.kind` column; existing browsers read as
`managed`. Version 0.5.2 added `browsers.extensions_enabled` and
`browsers.agent_desktop_enabled`. Older images ignore all of these. Version
0.5.0 added the nullable `browsers.proxy_json` column; existing browsers keep
their direct route unless a proxy is configured. Credentials are stored
unencrypted in that column. Back up and protect `/data` before upgrading. Older
versions ignore proxy settings and can send traffic directly, so do not
downgrade a proxied browser and expect its route to hold. Restore a compatible
backup and review routing before rolling back. See the [0.5.0 proxy release
notes](release-0.5.0.md), [0.5.1 dashboard release notes](release-0.5.1.md),
[0.5.2 extension release notes](release-0.5.2.md), [0.6.0 linked-browser release
notes](release-0.6.0.md), [0.6.1 linked-browser access notes](release-0.6.1.md),
[0.7.0 guest-link release notes](release-0.7.0.md), [0.7.1 Full browser
notes](release-0.7.1.md), [0.8.0 read-access notes](release-0.8.0.md), [0.8.1 browser-cap
notes](release-0.8.1.md), [0.8.2 dashboard thumbnail notes](release-0.8.2.md),
[0.8.3 profile-save live view notes](release-0.8.3.md), [0.8.4 linked-browser
frame notes](release-0.8.4.md), [0.8.5 process-limit notes](release-0.8.5.md),
[0.9.0 pinning and recovery notes](release-0.9.0.md), [0.9.1 zygote and
pinning fixes](release-0.9.1.md), [0.10.0 worker notes](release-0.10.0.md), and
[0.10.1 one-step move notes](release-0.10.1.md).

The template's image change was applied through its dashboard change-set API,
then verified through the public API. `railway templates publish` updates listing
metadata, not the image source. For the image, the dashboard currently uses
`templateChangeSetStage` with a patch shaped as
`{config: {services: {SERVICE_ID: {source: {image: DIGEST_REFERENCE}}}}}`,
followed by `templateChangeSetApply`. These operations live at Railway's
`/graphql/internal` endpoint and can authenticate with an existing CLI OAuth
session. This is not a stable public API: inspect the current dashboard operations,
check for other pending edits, review the staged patch, and read back the published
configuration before reporting success. Never print or store a CLI token in scripts
or command arguments.

The `release image` workflow runs when a GitHub release is published. It checks
that the `vX.Y.Z` tag matches `package.json`, builds a Linux amd64 image, and tests
the application and headed Chrome before pushing to GHCR. A second job then
zips `extension/` and attaches it to the release as `tallylamp-link.zip`; the
test suite fails if `extension/manifest.json` and `package.json` disagree on the
version. Normal commits and
pull requests run CI without publishing an image. Release tags are never replaced
once an image has been published, and the workflow refuses an existing image
version. There is no floating `latest` tag.

An operator upgrades by reading the release notes, backing up `/data`, and
changing Railway's image reference to the new release digest. Keep automatic
image updates disabled. A source push or a new release leaves existing template
deployments on their chosen digest. Redeploys interrupt active browsers; the
volume keeps their profiles. Before reverting an image, check whether the newer
release changed the database format and restore a compatible backup if needed.

## Platform notes

- Dockerfile at repo root is auto-detected.
- Healthcheck path must return 200 (`/healthz`).
- Volumes persist across redeploys and are not present during the build.
- Use one replica with a volume. Redeploys have downtime.
- `RAILWAY_VOLUME_MOUNT_PATH` is injected when a volume is attached.
- Config-as-code `railway.json` is deprecated; `.railway/railway.ts` is the
  current project-level IaC.
- No first-party documentation of Docker sockets, privileged mode, or GPU
  passthrough for a normal service.

These platform notes retain the checks recorded on 2 September 2026. See
[Railway volumes](https://docs.railway.com/volumes) and the
[IaC migration guidance](https://docs.railway.com/config-as-code) for platform changes.
