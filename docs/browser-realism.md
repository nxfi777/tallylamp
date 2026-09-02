# Browser realism

Principle: **behave like a manually launched stock headed Chrome in the same
runtime**, not "apply stealth patches."

Tallylamp does **not** install `puppeteer-extra-plugin-stealth`. It does not
pass `--enable-automation` or `--headless`. Chrome is launched by Tallylamp and
chrome-devtools-mcp **connects** via `--browser-url`.

## What we measure

`src/realism.ts` captures user agent, client hints (`userAgentData`),
`navigator.webdriver`, plugins, mimeTypes, languages, `window.chrome`, screen
and window metrics, hardwareConcurrency, deviceMemory, timezone, locale,
WebGL vendor/renderer, AudioContext sampleRate, WebRTC presence, mediaDevices,
touch points, and a couple of CDP/Puppeteer global artefacts.

A reference launch (same binary, headed, dedicated profile, same Xvfb if any)
is compared to the Tallylamp launch. Differences are classified:

- automation artifact
- container/environment artifact
- deployment hardware artifact
- intentional configuration
- unavoidable difference
- unknown

There is no composite "stealth score." CI fails on **automation artifacts**
that appear in Tallylamp but not in the reference (for example
`HeadlessChrome` in the UA, or `navigator.webdriver === true`) when a real
Chrome binary is available. Hardware/container diffs are reported, not failed,
unless you set a stricter local check.

## Expected environment differences

On Railway / Docker:

- WebGL often reports SwiftShader, llvmpipe, or a null renderer. That is a
  **hardware** fact. `TALLYLAMP_GPU=software` makes it explicit.
  `hardware` only if the host actually has a GPU.
- Screen size follows `TALLYLAMP_WINDOW_SIZE` and Xvfb.
- Font coverage is the image's font packages, not a desktop's.
- `--disable-dev-shm-usage` is an intentional container configuration.

## Interaction

chrome-devtools-mcp 1.8.0 injects clicks and typing through Puppeteer. We do
not currently wrap those in a "humanized" path by default
(`TALLYLAMP_INTERACTION=off`). Adding jittered sleeps without a recorded
baseline would be the thing the requirements told us not to do. Human takeover
is the supported way through verification UIs.

## Running the lab

```bash
npm test -- tests/realism.test.ts
```

Needs a Chrome/Chromium binary. On macOS the detector looks at
`/Applications/Google Chrome.app`. In Linux CI, install `chromium` and set
`TALLYLAMP_CHROME_BIN`.
