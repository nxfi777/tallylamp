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
