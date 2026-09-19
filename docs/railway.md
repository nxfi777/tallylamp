# Railway

Use the [Railway template](https://railway.com/deploy/tallylamp), or deploy
Tallylamp from its public GHCR image with a volume mounted at `/data`.
The volume keeps browser profiles and the database across redeploys.

## Deploy and connect

1. Create an image service using `ghcr.io/nxfi777/tallylamp:0.7.0` and pin the
   [release digest](#releasing-and-upgrading). The published Railway template
   pins the same digest, supplies these settings, and leaves automatic image
   updates disabled.
2. Attach a volume at `/data`.
3. Set **`ADMIN_SECRET`** (`openssl rand -hex 32`); the template generates it for you.
   Do not paste `.env.example`. Start with `TALLYLAMP_MAX_BROWSERS=2`.
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
| `TALLYLAMP_MAX_BROWSERS` | no | default 4; Chrome is memory-heavy |
| `TALLYLAMP_IDLE_TTL_SEC` | no | default 900. Idle *unattached* browsers are stopped (profiles kept). `0` disables reaping. |
| `TALLYLAMP_ATTACHED_IDLE_TTL_SEC` | no | default 14400. Applies while an MCP session, a watcher or a human controller is attached. |
| `TALLYLAMP_MCP_SESSION_IDLE_SEC` | no | default 600. Closes an MCP session whose client vanished without `DELETE /mcp`. |

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
| `TALLYLAMP_OAUTH_MAX_BROWSERS` | no | Default 2. Browser cap for a new connector agent. |
| `TALLYLAMP_OAUTH_CLIENT_HOSTS` | no | empty = accept any https client-metadata URL. Comma-separated hostnames to restrict it. |
| `TALLYLAMP_ADMIN_BEARER` | no | default **off**. Turning it on lets `ADMIN_SECRET` be used as a bearer token, which is a brute-forceable master key. |
| `TALLYLAMP_AGENT_DESKTOP_DEFAULT` | no | default **off**. When on, new agent-owned browsers start with **Allow agent control**. Existing browsers keep their saved choice. This does not enable or install extensions. Native UI includes host-file dialogs. |

## Deployment limits

- No GPU: WebGL is software or absent. Dashboard shows `gpuStatus`.
- Chrome renderer sandbox will likely show `fell-back`.
- `/dev/shm` is often small; we pass `--disable-dev-shm-usage`.
- One replica. Redeploy stops every browser process; **profiles survive** on
  the volume and are lazy-started on the next use.
- Memory: budget roughly 1–2 GB per headed Chrome plus the Node process.
  Default max browsers is 4.

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
| `TALLYLAMP_MAX_BROWSERS` | `2` (conservative starting cap; app default is 4) |
| `TALLYLAMP_ALLOW_PRIVATE_NETWORK` | `0` |
| `TALLYLAMP_SANDBOX` | `auto` |

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

## Releasing and upgrading

The current release is [0.7.0](https://github.com/nxfi777/tallylamp/releases/tag/v0.7.0)
for Linux amd64. To pin the tested artifact, use this image reference:

```text
ghcr.io/nxfi777/tallylamp@sha256:61818262dab57c3f880a029d5bbc85b42c47d7a21741d34ea34bdb05ca99ef25
```

The [0.7.0 release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35453298714)
passed application tests, headed Chrome tests, and running-container checks
before publishing the same artifact, then attached `tallylamp-link.zip`, the
linked-browser extension, to the release. Anonymous registry access, the manifest
digest, and the zip's manifest version were verified afterward. The image's
source revision is `316cd9f970c2e8d7571a8d48c52b79d17d334bd5`.

The Railway template pins the `0.7.0` digest for new installations. Its published
configuration and listing copy were read back after the update. Existing
deployments keep their selected image. Railway redeploy persistence and unique
passwords across two template installations were checked for `0.1.1`, not repeated
for `0.7.0`. These checks do not certify every external MCP client, proxy provider,
or Chrome extension.

Version 0.7.0 adds the `browser_guests` and `guest_sessions` tables for guest
links and scrubs raw session tokens from `viewer_tickets`; older images ignore the
new tables, and guest links stop working if you roll back. Version 0.6.1 adds the
`linked_access` table and moves 0.6.0 linked browsers to
the administrator, keeping their agent on the list. Version 0.6.0 added the
`browser_links` and `link_pairings` tables and a `browsers.kind` column; existing
browsers read as `managed`. Version 0.5.2 added
`browsers.extensions_enabled` and `browsers.agent_desktop_enabled`. Older images
ignore all of these. Version 0.5.0
added the nullable `browsers.proxy_json` column; existing browsers keep their
direct route unless a proxy is configured. Credentials are stored unencrypted in
that column. Back up and protect `/data` before upgrading. Older versions ignore
proxy settings and can send traffic directly, so do not downgrade a proxied
browser and expect its route to hold. Restore a compatible backup and review
routing before rolling back. See the [0.5.0 proxy release notes](release-0.5.0.md),
[0.5.1 dashboard release notes](release-0.5.1.md),
[0.5.2 extension release notes](release-0.5.2.md),
[0.6.0 linked-browser release notes](release-0.6.0.md),
[0.6.1 linked-browser access notes](release-0.6.1.md), and
[0.7.0 guest-link release notes](release-0.7.0.md).

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
