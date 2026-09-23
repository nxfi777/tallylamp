# Tallylamp 0.8.4

Two fixes for linked browsers. Snapshots no longer hang on pages that load a
cross-site frame late, and Tallylamp Link keeps agents out of other extensions'
frames.

## What changes

- **Snapshots of shared tabs no longer hang.** In a linked browser, a
  cross-site frame that loaded after the agent connected made the agent's next
  snapshot wait a full minute and then fail. Ads, embeds, and payment and
  sign-in frames all do this. The server announced the frame twice to the
  agent's browser tools, and they lost track of it. It is announced once now,
  and the same snapshot takes milliseconds.
- **Agents are kept out of other extensions' frames.** Chrome normally won't
  let Tallylamp Link control a tab that holds another extension's frame, such
  as a password manager's autofill menu. The chrome://flags setting
  "Extensions on chrome-extension:// URLs" removes that rule. With it on, an
  agent's tools could get a debugger session inside the other extension's
  frame. Tallylamp Link now detaches from such a frame before the agent can use
  it, and the panel says the flag is probably on. Extensions can't read Chrome's
  flags, so this is the first the panel can know of it.
- **The panel explains a tab that won't share.** When another extension's frame
  stops a tab from sharing, the panel links to
  [a guide](https://tallylamp.dev/guides/another-extension-blocks-sharing) with
  the fixes and the flag's risks.

## Upgrading

No schema change and no configuration change. The snapshot fix is on the
server and works with any Tallylamp Link. The other two changes are in the
extension: replace its folder with the new zip's contents, then press the
reload arrow on its card at `chrome://extensions`.
