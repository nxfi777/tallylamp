# Tallylamp 0.12.4

Star the browsers you use most and the dashboard lists them first. This
release also shows what a pressed button is waiting on, and the dashboard
reports its real version.

## What changes

- **Starred browsers.** Star a browser from the star on its card, its ⋯ or
  right-click menu, or the star beside its name on its own page. Starred
  browsers get their own group at the top of Browsers, running ones first, and
  everything else follows under a second heading. A filter applies to both
  groups. Linked browsers can be starred too. With a mouse, an unstarred card
  shows its star only under the pointer; on touch it is always shown.
- **Starring is not pinning.** A star changes only the order on the page. It
  holds no room on the host and never stops another browser, which is what
  **Pinned** on a browser's Settings tab does. Only the administrator can star,
  through the dashboard or `PUT /api/v1/browsers/{id}/starred`. Browsers now
  report `starred`, and agents are told not to delete or repurpose a starred
  browser unless asked.
- **Pressed buttons say they are working.** A button waiting on the server used
  to fade to the disabled look, so a slow Save read as switched off. It now
  keeps its colour and width and, after a short beat, shows a small orb beside
  its label. Start, Stop and Restart breathe, like the browser cards do while
  Chrome changes state. Tallylamp Link's Connect, Share, Try now and Reload and
  share buttons, and the guest page's Open the shared browser, do the same.
- **The dashboard shows the release it runs.** The sidebar and Settings said
  v0.1.0 on every install since the 0.12.2 redesign. They now show the release
  number from the image, the same one workers compare.

## Upgrading

On first start the main instance adds a nullable `starred_at` column to the
`browsers` table. Nothing else in the schema or settings changes. The column is
ignored by older releases, so rolling back to 0.12.3 keeps working and only
forgets which browsers were starred.

Upgrade the main instance and every worker together: while they run different
releases, the main instance starts nothing on a worker. Redeploys restart running
browsers; their profiles remain on the persistent volume.

Tallylamp Link 0.12.4 changes only how its buttons look while they wait, and it
asks for no new permissions.

See the [Railway upgrade instructions](railway.md#releasing-and-upgrading) for
backups and deployment settings.
