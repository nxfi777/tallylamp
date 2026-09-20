# Full-browser release checks

These checks need Linux, Chrome/Chromium, Xvfb, ffmpeg and xdotool. The Docker image
includes the runtime tools. Allow memory for a real Chrome process.

## Automated native smoke test

In a Linux checkout with dev dependencies installed, run:

```sh
TALLYLAMP_TEST_DESKTOP=1 npx tsx --test tests/desktop-linux.test.ts
```

The test uses a fresh temporary profile and a loopback test server. It enables
extensions, starts real Chrome on its own Xvfb display, checks for JPEG frames,
types a local test page URL through Chrome's native address bar, and types into
that page. It also checks that closing the viewer releases control, then grants the
owner agent native access and tests its screenshot and typing paths. It skips on
other platforms and without the opt-in flag; a skip is not a successful native test.

## Manual extension and viewer checks

On a test deployment with a dedicated Xvfb display for each browser:

- Create a persistent test browser. Stop it, enable extensions, then start it.
- Take control and open **Full browser**. Chrome must fill the display without
  being asked, and typing must reach it before anything is clicked. **Refit
  Chrome window** must do the same again on demand.
- Install a trusted test extension from the Chrome Web Store. Check that its
  permission dialog is visible and accepts a click. Do not use a profile with real logins.
- Open its toolbar popup. Click and type into the popup; verify a visible change.
  Check a side panel too if the extension provides one.
- Open **Manage extensions**. Verify the correct Chrome settings page opens.
- Restart the browser and check that the extension and its saved settings remain.
- Stop it and disable extension support. Start it and verify the extension does not run.
- Open a read-only full-browser viewer. Try clicking, typing and scrolling; none
  should reach Chrome. A second full-browser viewer should show a recoverable error.
- While a control viewer is open, force a new takeover from another session. The
  old viewer must stop sending input, including queued text and held modifiers.
- Switch between Tab and Full browser without losing control. Move focus away
  while holding a modifier and verify that it is released remotely.
- Review at 375, 768 and 1440 pixels. Buttons should wrap, the selected view should
  be clear, and fullscreen should keep every control reachable. Check connection,
  stopped-browser and capture-failure states, not just the live stream.
- Close the viewer. Confirm that its ffmpeg process exits and no keys stay held.
- For an agent-owned browser, turn on **Allow agent control**. Use
  `tallylamp_desktop_screenshot`, then `tallylamp_desktop_action` to open and operate
  the extension popup. Check screenshot-to-screen coordinate scaling.
- While the agent is typing, take human control. Verify its tool call fails and
  no further text arrives. Repeat by turning **Allow agent control** off.
- Confirm new profile copies follow the host's `TALLYLAMP_AGENT_DESKTOP_DEFAULT`
  policy, not the source's grant. Agents must not be able to change the toggle.
- With that default on, revoke one browser's grant and restart it. Its grant must
  stay off, and its native tools must ask for approval rather than execute.

Native extension installation, popup interaction and the three rendered layouts
must be checked before treating the feature as release-verified.
