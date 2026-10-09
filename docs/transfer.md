# Export and import

Export creates one portable `.tar.gz` archive of Tallylamp's stored data. You can
keep it as a backup, restore it on a laptop, or transfer selected browsers while
leaving unattended browsers in the cloud.

## Export from a running instance

Run the CLI on the machine where you want to save the archive. Use the instance's
admin secret; agent credentials cannot export instance data.

```sh
TALLYLAMP_URL=https://your-instance.example \
ADMIN_SECRET="$TALLYLAMP_CLOUD_ADMIN_SECRET" \
node bin/tallylamp.mjs export tallylamp.tar.gz
```

To leave Kraken out, use its browser slug from `tallylamp browser list`:

```sh
TALLYLAMP_URL=https://your-instance.example \
ADMIN_SECRET="$TALLYLAMP_CLOUD_ADMIN_SECRET" \
node bin/tallylamp.mjs export laptop.tar.gz --exclude kraken
```

Repeat `--exclude` for several browsers. To export only specific browsers, repeat
`--browser SLUG`. Both flags also accept browser IDs. Unknown names are rejected.
All saved profile templates are included in every export, including templates
that were originally saved from an excluded browser.

Export **stops selected managed browsers and leaves them stopped**, so Chrome
cannot write to a profile while it is being read. Excluded browsers keep running.
The source profiles and downloads remain in place. Export refuses to start while
browser starts, moves, profile saves or cleanup operations are in flight. Profile
writes and API mutations are blocked for the duration of the export.

The CLI streams the archive into a private temporary file and publishes the final
filename only after a complete download. It refuses to overwrite an existing
file. The archive contains browser logins, proxy credentials, and agent token
hashes; protect it as you would the original data volume.

## What transfers

- Browser IDs, names, slugs, ownership, metadata, proxy configuration, extension
  settings and recorded signed-in sites.
- Managed Chrome profile files, including browser storage, bookmarks, history,
  installed extensions and session files. Chrome runtime locks are omitted.
- All saved profile templates and their metadata and site manifests.
- Browser downloads, including downloads stored on workers.
- Agents, raw API credential hashes, standing browser permissions, audit and
  activity records.

The export collects worker data through the authenticated worker connection.
Workers must run the version containing the export route. An unreachable worker,
missing required profile, interrupted transfer, or invalid archive fails the
export; the service does not silently substitute an empty profile.

The SQLite snapshot includes committed WAL data. Local profile files stream
directly into the archive without a second full copy. Worker profiles and
downloads are temporarily staged on the main volume; allow enough free disk
space for that worker data. Compression uses a low level to limit CPU cost.

Linked browsers belong to the person's installed Chrome, outside Tallylamp's
managed storage. Their inventory and permissions transfer; their actual Chrome
profiles do not. Pair the extension with the new instance after restore.

## Import into a new data directory

Build the service first. Import runs offline and requires a destination directory
that does not already exist. It never merges or overwrites a live instance.

```sh
npm run build
node bin/tallylamp.mjs import laptop.tar.gz --data-dir ./laptop-data
```

The import validates paths, file types, size limits, the manifest and SQLite
integrity before publishing the destination. It rejects archive links and special
files. Files are unpacked beside the destination, then the completed directory is
renamed into place. Failed imports remove their staging data. The default limit
is 64 GiB of decompressed data and is bounded by available disk space; change it
with `--max-gb NUMBER` if needed.

Set `TALLYLAMP_DATA_DIR` to the restored directory, choose an `ADMIN_SECRET`, and
start Tallylamp. For example, after configuring your local `.env`:

```sh
TALLYLAMP_DATA_DIR=./laptop-data HOST=127.0.0.1 \
node --env-file=.env dist/index.js
```

All restored managed browsers run locally and start stopped. Paths are rewritten
for the new storage location. Previously confirmed site records become expected
until a login is observed on the new machine. Worker registrations, active leases, dashboard
sessions, guest links, tunnels, pairing requests and pending access requests are
discarded. OAuth credentials are bound to the old instance URL, so reconnect
those clients. Raw agent tokens retain their original scopes and ownership.
Your deployment's environment settings, admin secret and external keystore are
not part of the archive.

## Moving from Linux to macOS

Use the same or a newer Chrome version when opening the restored profiles.
Chrome profiles are [not backwards compatible](https://www.chromium.org/administrators/policy-list-3/user-data-directory-variables/).
Tallylamp supports an installed Chrome on macOS, but full browser desktop
automation needs the Linux/X11 environment.

Profile files transfer byte for byte; an authenticated session cannot be promised
across machines or operating systems. Chrome's credential encryption depends on
the [platform's storage mechanism](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/security/faq.md#does-the-password-manager-store-my-passwords-encrypted-on-disk).
Some sites will require sign-in again. Running the Linux container on the laptop
keeps the browser environment closer to Railway, but does not override a site's
session checks or migrate an external keystore.

Verify the restored browsers before deleting anything from Railway. Export itself
does not delete the cloud data, stop excluded browsers, or change infrastructure.
