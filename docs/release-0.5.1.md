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

The release workflow tests the Linux amd64 image before publishing
`ghcr.io/nxfi777/tallylamp:0.5.1`. See the
[release and upgrade notes](https://github.com/nxfi777/tallylamp/blob/main/docs/railway.md#releasing-and-upgrading)
for the verified digest once publication finishes. Existing Railway installations
do not upgrade automatically.
