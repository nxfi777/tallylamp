# Tallylamp 0.5.1

This patch clarifies the browser dashboard's profile actions and makes the
browser ID easier to copy. It does not change the API or database schema.

## What changes

- **Edit profile** is now **Edit browser details**, with a **Browser name** field.
  It edits the browser's name and metadata, not a saved profile template.
- The browser page shows its stable ID and a **Copy browser ID** button. The
  browser-list menu offers the same action. If clipboard access fails, the
  dashboard shows the ID for manual copying.
- Help text explains that **Record signed-in site** adds an inventory note,
  while **Save profile** copies all saved logins and storage into a reusable
  snapshot. Persistent browsers keep their own data without a separate save step.
- Regression tests cover ID copying, clipboard failure, and the renamed form.

## Before upgrading

Back up `/data` and finish active browser work. A redeploy stops Chrome; the
data volume keeps persistent browser profiles. This release keeps database
schema 7 and the proxy behaviour introduced in 0.5.0.

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/35163328002)
passed 231 application tests, 8 headed-Chrome tests, and running-container checks
before publishing `ghcr.io/nxfi777/tallylamp:0.5.1` for Linux amd64. Anonymous
registry access, the manifest digest, and version/source-revision labels were
verified. Pin this artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:3a7d90ccad442cdd2ce0e8bb298de008d8827cf44ae793f2f7068c631f4d6ead
```

The Railway template pins this digest for new installations. Existing deployments
do not upgrade automatically. See the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading)
for upgrade steps and the limits of these checks.
