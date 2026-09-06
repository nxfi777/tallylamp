# Browser realism

Tallylamp launches stock headed Chrome and connects chrome-devtools-mcp through
`--browser-url`. It does not install `puppeteer-extra-plugin-stealth` or pass
`--enable-automation` or `--headless`.

The aim is to avoid accidental automation artefacts while making the host's
actual hardware and browser configuration visible. This does not guarantee
that a website will accept the session.

## Captured surfaces

[`src/realism.ts`](../src/realism.ts) captures these properties:

- User agent, client hints (`userAgentData`), `navigator.webdriver`, languages,
  locale, timezone, platform, and `window.chrome`.
- Plugins, mimeTypes, cookie support, PDF viewer support, screen and window
  metrics, hardwareConcurrency, deviceMemory, and touch points.
- WebGL vendor and renderer, AudioContext sampleRate, WebRTC and mediaDevices
  presence, and a small set of CDP/Puppeteer global artefacts.

`diffSurfaces` compares two supplied captures and classifies each difference as
an automation artifact, container/environment artifact, deployment hardware
artifact, intentional configuration, or unknown. The type also reserves
`unavoidable difference`; identical values are marked `match`.

These classifications help diagnose differences. There is no composite stealth
score, and a classification does not establish how a particular website detects
automation.

## What the tests establish

[`tests/realism.test.ts`](../tests/realism.test.ts) checks identical sample maps,
a synthetic `HeadlessChrome` difference, GPU flags, and viewer size defaults.
When a real Chrome binary is available, it also launches Tallylamp's Chrome and
asserts that its user agent excludes `HeadlessChrome` and that
`navigator.webdriver` is not `true`.

The suite does not launch an independent stock-Chrome reference and compare every
captured property against it. `runReferenceCapture` uses Tallylamp's own launch
helper, so it is not an independent launch baseline either. Hardware and container
differences need a separate controlled comparison using the same binary, profiles,
and display environment. The real-browser test group is skipped when Chrome is
unavailable or `CI_SKIP_REALISM` is set.

## Expected environment differences

On Railway or Docker, software rendering may report SwiftShader, llvmpipe, or a
null WebGL renderer. Use `TALLYLAMP_GPU=software` for an explicit software
configuration; use `hardware` only on a host with a GPU.

The virtual screen follows `TALLYLAMP_XVFB_SCREEN`, which defaults to
`2560,1600`. The initial window follows `TALLYLAMP_WINDOW_SIZE`. Keeping those
settings separate avoids forcing every window to fill its screen. The screen
also limits how far a control viewer can enlarge Chrome's window.

Font coverage comes from the packages installed in the image. The
`--disable-dev-shm-usage` flag is an intentional container setting.

## Website challenges and network reputation

A website may consider browser properties, account history, network reputation,
and other signals. A difference between a hosted and residential connection does
not by itself identify which signal caused a challenge.

A static outbound IP gives a deployment a stable network identity. It does not
guarantee a favourable reputation or prevent future challenges. A persistent
profile can retain cookies issued after a person completes a challenge, but the
site controls their expiry and may ask for verification again.

An earlier development note records one successful manual challenge: the page
changed from a verification screen to real content, and a second page loaded
after an MCP re-bind and page reset. That observation supports persistence in
that session. It does not establish a once-per-site guarantee, and this audit
did not repeat the observation.

Use human takeover when a site needs a person. Tallylamp provides no automated
CAPTCHA bypass.

## Interaction

chrome-devtools-mcp 1.8.0 sends clicks and typing through Puppeteer. Tallylamp
does not wrap those actions in a recorded human mouse path. The configuration
retains `TALLYLAMP_INTERACTION=off`; timing jitter alone would not demonstrate
that an interaction matches human behaviour.

## Run the tests

```bash
npm run test:realism
```

Install Chrome or Chromium first. On macOS, the detector checks
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. On Linux without
a display, install Xvfb and set `TALLYLAMP_XVFB=1`. Set `TALLYLAMP_CHROME_BIN`
to the browser binary if it is outside a detected path.
