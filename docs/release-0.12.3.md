# Tallylamp 0.12.3

Filled buttons in the dashboard stay readable under the pointer. Until now a
hovered primary button took the plain buttons' hover background but kept its
own text colour. In the dark theme that was near-black text on dark grey,
and in the light theme white text on light grey. Sign in was the first place
anyone met it. The browser page's amber Take control and green Return to agent
buttons did the same.

## What changes

- Primary buttons, Take control and Return to agent keep their own fill on
  hover and dim slightly, as the guest page and Tallylamp Link already did.

## Upgrading

No settings or schema change. Upgrade the main instance and every worker
together: while they run different releases, the main instance starts nothing on
a worker. Redeploys restart running browsers; their profiles remain on the
persistent volume.

Tallylamp Link is unchanged apart from its version number.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.

## Release validation

The [release workflow](https://github.com/nxfi777/tallylamp/actions/runs/41207136886)
passed application, headed Chrome, and running-container checks before
publishing the tested image. Its anonymous registry access, digest, version and
source-revision labels were verified, and `tallylamp-link.zip` is attached to the
release. Pin this Linux amd64 artifact:

```text
ghcr.io/nxfi777/tallylamp@sha256:45449ecd9737a893c5fd74496e57d993b4c4aeead7e01d18819f2db63754125b
```

Before release, Sign in was hovered in both themes on a local build: it kept its
light fill with dark text in the dark theme, and its near-black fill with white
text in the light one. All 527 service tests passed. After the deploy,
production served the corrected stylesheet and its worker reported 0.12.3.
