# Railway

Tallylamp is a **single Dockerfile service** plus one volume.

## What was verified from current docs (2026-09-02)

- Dockerfile at repo root is auto-detected.
- Healthcheck path must return 200 (`/healthz`).
- Volumes persist across redeploys; they are **not** present at build.
- A volume-backed service cannot use replicas; redeploy has downtime.
- `RAILWAY_VOLUME_MOUNT_PATH` is injected when a volume is attached.
- Config-as-code `railway.json` is deprecated; `.railway/railway.ts` is the
  current project-level IaC.
- No first-party documentation of Docker sockets, privileged mode, or GPU
  passthrough for a normal service.

## Intended service settings

| Setting | Value |
|---|---|
| Builder | Dockerfile |
| Healthcheck | `/healthz` |
| Timeout | ≥ 120s (Chrome image pull/start) |
| Volume mount | `/data` |
| Start | `node dist/index.js` (entrypoint already does this) |
| Replicas | 1 |

Variables:

| Name | Required | Notes |
|---|---|---|
| `ADMIN_SECRET` | yes | Generate with `openssl rand -hex 32`. Never commit. |
| `TALLYLAMP_PUBLIC_URL` | recommended | `https://<your-domain>` for cookies, PRM, MCP resource id |
| `TALLYLAMP_DATA_DIR` | `/data` | Set in the image |
| `TALLYLAMP_MAX_BROWSERS` | no | default 4; Chrome is memory-heavy |
| `TALLYLAMP_SANDBOX` | no | `auto` (likely `fell-back` on Railway) |
| `TALLYLAMP_GPU` | no | `auto` — do not claim a GPU |
| `TALLYLAMP_ALLOW_PRIVATE_NETWORK` | no | default blocked |
| `TALLYLAMP_OAUTH` | no | default on (discovery only) |

## User journey

1. Deploy the template / `railway up`.
2. Attach a volume at `/data` if the template did not.
3. Set `ADMIN_SECRET` and `TALLYLAMP_PUBLIC_URL`.
4. Open the public URL, log in, create an agent, copy the token.
5. Point an MCP client at `https://<host>/mcp` with the bearer token.
6. Watch the browser; take control when a site needs you.

## Limits we will not disguise

- No GPU: WebGL is software or absent. Dashboard shows `gpuStatus`.
- Chrome renderer sandbox will likely show `fell-back`.
- `/dev/shm` is often small; we pass `--disable-dev-shm-usage`.
- One replica. Redeploy stops every browser process; **profiles survive** on
  the volume and are lazy-started on the next use.
- Memory: budget roughly 1–2 GB per headed Chrome plus the Node process.
  Default max browsers is 4.

## Template

`.railway/railway.ts` describes the service + volume. Publishing a marketplace
template (icon, generated `ADMIN_SECRET`, deploy button) is a dashboard action
for the repository owner and cannot be completed from this workspace alone.
