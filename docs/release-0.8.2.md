# Tallylamp 0.8.2

An open dashboard no longer makes the server screenshot every running browser
every few seconds.

## What changes

- **The page poll only reports changes.** The server checks each running
  browser's page every four seconds. It used to announce the page every time,
  even when nothing had changed, and each announcement made every open dashboard
  reload the fleet and request a new thumbnail for every running browser. It
  now announces a page only when its address or title changes.
- **Thumbnails are kept between repaints.** A card keeps its picture until that
  browser's page, title or activity changes. The pictures on screen also refresh
  every 20 seconds while the dashboard tab is visible, and not while it is
  hidden.

For a linked browser, each thumbnail is a screenshot of its owner's own tab,
taken on their machine and sent over their link. With an agent attached, that
used to happen about every five seconds for as long as the dashboard stayed open.

The live view is unchanged. Card previews can now be up to 20 seconds behind a
page that changes without navigating, such as a video or a live feed.

## Upgrading

No schema change and no configuration change. Tallylamp Link is unchanged apart
from its version number, so a linked browser does not need the extension
reinstalled.
