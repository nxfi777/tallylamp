# Tallylamp 0.11.6

OAuth connectors now stay signed in when a client runs several processes off
one saved login. Before this release, two of those processes refreshing around
the same time looked like a stolen token, and Tallylamp disconnected every
process using that login until someone approved it again.

## What changes

- A client that presents the refresh token rotated just before the live one
  gets that same successor back, with a fresh access token. This happens
  without any theft when several processes share one saved login and another
  one refreshes first. Codex does this when its desktop threads each run their
  own process. It also happens when a refresh response never reaches the
  client's store.
- A successor refresh token is now derived from the token it replaces, using a
  key based on `ADMIN_SECRET`, so the same token always has the same successor.
  Every other check still applies. The token must be unexpired and belong to
  the same client, the successor must be live in the same grant, and the
  connector must be enabled.
- Presenting a token two or more rotations old, or replaying an authorization
  code, still revokes the whole grant. The tradeoff: someone holding the most
  recently rotated token can keep pace with the real client until one of them
  falls two refreshes behind. Without `ADMIN_SECRET`, rotation stays strict.
- The audit log records a tolerated catch-up as `oauth.refresh_reuse_tolerated`.
  A replay that revokes a grant is recorded once as `oauth.refresh_reuse`, not
  again for every retry against the dead grant.

See [OAuth protocol details](mcp-compatibility.md#protocol-details).

## Upgrading

No new dependencies, database changes, or settings. Upgrade the main instance
and every worker together: while they run different releases, the main instance
starts nothing on a worker. Redeploys restart running browsers; their profiles
remain on the persistent volume.

Connectors approved before this release keep working. Their next rotation
follows the old rule, because the token being replaced was drawn at random. A
client that falls one refresh behind across the upgrade can still be signed out
once. From the following rotation on, catching up works. Rotating
`ADMIN_SECRET` still revokes every OAuth grant.

Tallylamp Link is unchanged apart from its version number.

## Release validation

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/38724207043)
passed application, headed Chrome, and running-container checks before
publishing the tested image. Its anonymous registry access, digest, version and
source-revision labels were verified, along with the extension zip's manifest
version. Pin this Linux amd64 artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:33557d1796c3ba09b3482827245a1203e2e9e45e172f49f86d07c7dd0441f179
```

After deploying that artifact, the production instance and its worker both
reported 0.11.6. A Claude Code connector refreshed its token through the new
code, its next MCP call succeeded, and the audit log recorded no refresh-token
reuse. The release's tests cover a client one refresh behind; production only
exercises that path when a client actually falls behind.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.
