# Full browser input: investigation handoff

**Status: root cause found and the fix verified by hand in the production container; not yet
deployed or exercised through the dashboard.** See the next section. Everything below it is
the investigation as it stood before, kept as the record.

## Root cause (2026-09-20)

**`xdotool mousemove --sync X Y` hangs for 15 seconds when the pointer is already at X,Y.**

The man page says `--sync` does not wait when no movement is needed. In xdotool 3.20160805.1
(bookworm, and the version in the image) that early return exists only on the `--step` path
(`cmd_mousemove.c:201`). The default path calls `xdo_wait_for_mouse_move_from(mx, my)`
unconditionally, which polls until the pointer *leaves* its starting position: `MAX_TRIES`
500 x 30ms = 15s (`xdo.c:1741`).

The operator's pointer is always already there when a click arrives, because the preceding
`mouseMoved` put it there. So `mousemove --sync X Y mousedown 1` sat in the wait, the 2s
watchdog SIGKILLed it, and `mousedown` never ran. Same for `mouseup`, and for every scroll tick
after the first. This explains every observation:

- (4) hover works, clicks do not: motion goes to a *new* position, so `--sync` returns.
- (5) motion "stopped" after `86d24ef`: before it, `mouseleave` SIGKILLed the hung process and
  unjammed the queue by accident. After it, each click blocks the queue for 2s + 2s.
- The agent path "worked" because the proven click moved to a fresh coordinate. A second agent
  click on the same spot times out at 3s; it had simply never been tried.

Evidence, all against the live deployment, display `:1399`, using the test page under "How to
reproduce and test":

| Step | Result |
| --- | --- |
| MCP `move` to (611,433) | returns at once |
| MCP `move` to (611,433) again | `native operation timed out` |
| MCP `click` at (611,433), pointer at rest there | timed out, `clicks: 0` |
| MCP `click` at (612,433) | `clicks: 1` |
| in-container `timeout 4 xdotool mousemove --sync 612 433`, at rest | exit 124 after 4002ms |
| in-container `xdotool mousemove 612 433 mousedown 1`, then a second process `… mouseup 1` | 2ms each, `clicks: 2` |
| separate processes: `keydown Shift_L`, `keydown U0061`, `keyup U0061`, `keyup Shift_L`, `keydown U00e9`, `keyup U00e9` | input gained `Aé` |

The last two rows close open questions 1 and 2 below: press/release and keydown/keyup split
across processes both work, held modifiers carry across, and non-ASCII keysyms survive.

**The fix** drops `--sync` from `point()` in `desktopInput()`, which both the viewer and the
agent path build on. Ordering never needed it: the warp and the button event share one X
connection, and `XCloseDisplay` syncs before xdotool exits. `tests/desktop-linux.test.ts` now
clicks twice at rest through the viewer and twice through the agent, and
`.github/workflows/test.yml` has a `desktop` job that runs it (runner xdotool is the same
3.20160805.1, so it fails without the fix).

**Deployed and verified on the agent path** (`14b9edd`, live 2026-09-20): two MCP `click`s at
the same (640,480) both returned at once and the page showed `clicks: 2`. Before the fix the
second timed out.

The first CI run of the `desktop` job failed, on a test bug rather than on input: the fit
assertion from `65c1de3` demanded exactly 1280x800, and Chromium always keeps an X11 window one
pixel short of the display so no window manager mistakes it for fullscreen. Measured over CDP
in the production container: asked for 2560x1600, `Browser.getWindowBounds` reports 2559x1599.
The assertion now accepts that. The second run failed on another latent test bug: it typed
as soon as a parsed `<title>` appeared, before autofocus had run, and lost the first
characters. The test now clicks the input through the viewer first, then types. **The
`desktop` job is green as of `c5cc3a6`**, covering the viewer's split press/release with the
pointer at rest, held-modifier keys, paste, and two agent clicks on one spot. The "CI never
runs the native test" and "covers keys and paste only" gaps below are closed.

Still unverified: nobody has clicked through the dashboard's Full browser view since the fix. Shell access for hand tests: `railway ssh --project … --service … -- sh -c
'export DISPLAY=:<n>; …'`, display number from `ls /tmp/.X11-unix`.

## Stuck uppercase (2026-09-20, second bug)

Reported right after the click fix: letters came out uppercase in Full browser with Shift not
held. By the time anyone looked the display was clean (`mask 0`, no keys down), because the
pointer leaving the stage releases everything held. Three ways to get there were reproduced on
a scratch Xvfb in the production container, reading the server's state with QueryPointer and
QueryKeymap:

| Sequence, one xdotool process each | Display afterwards |
| --- | --- |
| `keydown Shift_L`, and the release never arrives | Shift down (keycode 50) |
| `keydown U0040` then `keyup U0032`: "@" released as "2" | Shift down. xdotool pressed it for "@", and only a shifted release lets it go |
| `keydown Caps_Lock`, `keyup Caps_Lock`: what macOS sends for Caps Lock on, then off | Lock on, for good |

A release goes missing when the OS takes the chord, or when the stage loses focus without a
blur. A release comes back under another name when the modifier that made the character is let
go first: Option on a Mac, AltGr elsewhere. Shift let go first is harmless, since its own keyup
releases `Shift_L`.

The fixes, in `src/desktop-viewer.ts`:

- Every key press and mouse press carries the modifiers really held. The argv now starts with a
  `keyup` for each one that is not. It only ever releases. Verified: `keyup ... Shift_L keydown
  U0064` on a display with Shift stuck leaves only `d` down.
- Held keys are tracked by physical key (`code`), and a release sends the keysym the press
  sent.
- Caps Lock is never forwarded. The operator's `key` already has it applied, and X reads
  Shift+Lock as lowercase, so a remote Lock inverted every letter on every platform.

Do not test a scratch display with xdotool as its only client. Xvfb resets when its last client
disconnects, which wipes the key state and makes every one of these look fine.


---

Written for an engineer or model picking this up cold. Everything
below is either evidence with a citation, or is labelled as untested. Three theories have
already been disproved by experiment; do not re-run them.

## The feature

**Full browser** streams the whole X display of a managed Chrome to the dashboard, so the
operator sees Chrome itself — tab strip, toolbar, extension popups, native dialogs — rather
than just page content. The ordinary **Tab** view uses CDP `Page.startScreencast`, which
captures page content only.

```
dashboard <canvas>  ──WebSocket──▶  runDesktopViewer()  ──spawn──▶  xdotool  ──XTEST──▶  Xvfb ──▶ Chrome
       ▲                                                └─spawn──▶  ffmpeg x11grab ──JPEG frames─┘
```

Files:

| Path | Role |
| --- | --- |
| `src/desktop-viewer.ts` | Server: the desktop WebSocket, input queue, xdotool spawning, ffmpeg capture, window fit |
| `src/agent-desktop.ts` | The *other* consumer of the same input primitives, for MCP agent tools |
| `dashboard/app.js` | Client: `browserView()` renders the stage; `connectViewer()` owns the socket and input handlers; `framePoint()` maps pointer coordinates |
| `dashboard/app.css` | `.stage`, `.stage-status`, `.bar`, `.watchmark` |
| `tests/desktop-linux.test.ts` | The only end-to-end native test. **CI does not run it** (see Gaps) |

Relevant defaults (`src/config.ts`): `TALLYLAMP_XVFB_SCREEN=2560,1600`,
`TALLYLAMP_WINDOW_SIZE=1280,800`, `TALLYLAMP_HUMAN_LEASE_TTL_SEC=90`.
**There is no window manager in the image** (`Dockerfile` installs `xvfb ffmpeg xdotool` and
nothing else), so X leaves the input focus on `PointerRoot`: key events go to whatever window
the pointer is over.

## Symptom timeline, as reported

1. "Can't type in Full browser." Chrome was 1280×800 in the corner of a 2560×1600 desktop; its
   UI rendered tiny; the operator had to press a **Fit Chrome window** button.
2. After auto-fit shipped: the operator was in **watch** mode, where the fit did not run. Read
   as "the fix does not work". (Diagnosis error, mine.)
3. With control held and Chrome correctly fitted: clicks and keystrokes still did not land.
4. **The decisive observation:** Chrome's tab hover card was open over a tab in the operator's
   screenshot. That only appears on hover, so pointer *motion* was reaching Chrome and moving
   the X pointer. *Presses* were not. "It notices my cursor but clicking doesn't work."
5. After the fix for (4): pointer motion reportedly stopped being tracked as well, and the
   literal word `null` appeared in the stage's top-left corner. **The `null` is explained and
   fixed** (see Regressions). The motion claim is **unexplained and unverified**.

## Proven, with evidence

**The native input path works.** Run against the live Railway deployment through
`tallylamp_desktop_action` (MCP), which calls the *same* `desktopInput()` / `desktopKey()`
code and spawns xdotool with the same environment as the viewer:

| Action | xdotool argv | Result |
| --- | --- | --- |
| click at screen (357, 269) | `mousemove --sync 357 269 click --repeat 1 --delay 80 1` | click counter incremented, input focused |
| type `xdotool-type` | `type --clearmodifiers --delay 0 -- xdotool-type` | text appeared |
| key `k` | `key --clearmodifiers U006b` | `k` appeared |

Chrome was **unfitted** (1280×800 on a 2560×1600 display) throughout, with the pointer inside
the window. So xdotool, XTEST, Chrome's keyboard focus under `PointerRoot` with no window
manager, and the Unicode keysym form (`U006b` → `XK_k`) are all confirmed working.

**The window fit works.** Operator screenshot after `65c1de3`: Chrome fills the capture,
letterboxed by `object-fit: contain` as expected.

## Disproved — do not revisit

- **`PointerRoot` focus was not the cause of "can't type".** Keys landed with the window
  unfitted. The auto-fit in `65c1de3` is a genuine improvement but was shipped on this wrong
  theory.
- **Watch mode was not the cause.** The operator reproduced it holding a valid lease.
- **Unicode keysym mapping is fine.** `U006b` produced `k`.
- **xdotool is installed and runs.** It is in the image and executed successfully above.

## The leading untested hypothesis

**The viewer and the agent use different xdotool command shapes, and only the agent's shape
has ever been exercised.**

| | viewer (`desktopInput`) | agent (`agentDesktopCommand`) |
| --- | --- | --- |
| click | `mousemove --sync X Y mousedown 1`, then a **separate process** `mousemove --sync X Y mouseup 1` | one process: `mousemove --sync X Y click --repeat 1 --delay 80 1` |
| key | `keydown U00xx`, then a **separate process** `keyup U00xx` | one process: `key --clearmodifiers U00xx` |

The viewer splits press and release across two `spawn()` calls because it must support held
modifiers (Shift-click, Ctrl+A) and drag. **That split has never been tested anywhere.** The
agent path cannot exercise it, and `tests/desktop-linux.test.ts` only sends `key` events and
`paste`, never `mouse`.

Worth checking on a real display, by hand, in this order:

1. Does `xdotool mousedown 1` in one process followed by `xdotool mouseup 1` in another
   produce a click Chrome accepts? XTEST button state is global to the server, so it should —
   but confirm rather than assume.
2. Does xdotool's scratch-keycode remapping for `keydown`/`keyup` survive process exit? For
   keysyms already in the keymap no remap is needed, so ASCII should be safe; non-ASCII may
   not be.
3. `pump()` runs exactly one xdotool process at a time, and `mousemove --sync` polls the
   pointer at 30ms granularity. Measure the real per-event latency: the queue (cap 32) runs
   behind the operator, and that timing is what made the bug in `86d24ef` reachable.

## Fixes shipped during this investigation

| Commit | Change | Verified? |
| --- | --- | --- |
| `65c1de3` | Auto-fit the Chrome window when Full browser opens | Yes, by screenshot |
| `7b41c74` | **Take control** in the stage bar; watch-mode hint copy | Visually |
| `e0146ff` | Report xdotool's non-zero exit / kill. `child.on("error")` only fires when the process cannot be *spawned*; a process that started and then failed exited non-zero and was **silently ignored**, so input vanished with no message. The agent path had always checked this. Toast moved to the top of the stage, because at up to 1400px tall the bottom bar is below the fold | No |
| `7313ff1` | `.btn:disabled` had no styling, so every disabled button looked live and did nothing when pressed | Visually |
| `568574a` | Report the two remaining silent drops: input arriving without a bound lease, and `desktopInput()` returning null for an out-of-range pointer or an unmappable key | No |
| `86d24ef` | `blur`/`mouseleave` sent `releaseInputs`, which wiped the queue **and** SIGKILLed the running xdotool. Split "let go of held keys/buttons" from "discard pending work"; the former now drains first. Also: fit the window for watchers too, and add the read-only overlay | **No — and the next report was worse** |

`86d24ef` is the one to scrutinise first. It is the fix for observation (4) and it immediately
preceded observation (5).

## Regressions introduced here

- **`null` in the stage corner** — `86d24ef` passed `human ? null : h(…)` to `stage.append()`.
  `stage.append` is the DOM method, not the `h()` helper: `h()` skips `null` and `false`
  children, `append()` stringifies any non-Node. Fixed by guarding the call instead. No other
  `.append()` in `app.js` has this shape.
- **Pointer motion reportedly stopped** — unexplained. The stray text node is an in-flow child
  of `.stage`, visible only in the letterbox because the absolutely positioned canvas paints
  above it, and it should not intercept pointer events. Either the `null` fix resolves it, or
  something in `86d24ef` broke motion and needs isolating. **Bisect `86d24ef` before building
  on it.**

## Gaps that let this run this long

- **CI never runs the native test.** `.github/workflows/release.yml` runs `npm test` with
  `TALLYLAMP_FAKE_CHROME=1`, `tests/realism.test.ts` on Xvfb, and `scripts/check-image.mjs`
  against a running container. `tests/desktop-linux.test.ts` is gated behind
  `TALLYLAMP_TEST_DESKTOP=1` and is **not** in that workflow. The image already contains Xvfb,
  ffmpeg and xdotool, so wiring it in is a small change and would have caught this class of
  bug. Do this first.
- **That test covers keys and paste only.** It never sends a `mouse` message, so the
  press/release split above is untested. Extend it.
- **The development machine cannot run any of it.** macOS, so `config.xvfb` is false and
  `fullBrowser` is off; Docker was not an option on a box with 573 MB of swap free out of
  12 GB. Every fix here was reasoned from source and shipped unverified. **Get a Linux box or
  CI before changing anything else.**

## How to reproduce and test

**Through MCP (what produced the proven results above).** Requires a running,
agent-owned browser with **Allow agent control** on — the operator must enable it in the
dashboard under Extensions; an agent cannot grant itself this. It is privileged: full native
Chrome UI including settings and host-file dialogs. Then
`tallylamp_desktop_screenshot` → `tallylamp_desktop_action` → screenshot again. Screenshot
coordinates are downscaled; multiply by `screenWidth / imageWidth` (2560/1600 = 1.6).

**Test page** (self-reporting, no network):

```
data:text/html,<title>input-test</title><body style="font:28px system-ui;padding:40px;background:%23fff"><h1>Full browser input test</h1><input id=i style="font:24px monospace;width:600px;padding:8px" placeholder="type here"><p id=o>typed: (nothing yet)</p><p id=c>clicks: 0</p><script>let n=0;i.addEventListener('input',()=>{o.textContent='typed: '+i.value;document.title='typed:'+i.value});document.addEventListener('click',()=>{n++;c.textContent='clicks: '+n;document.body.style.background='%23cfc'})</script>
```

**Through the dashboard.** Take control, open Full browser, click. Since `568574a` the four
silent failure paths each print a reason at the top of the stage: a non-zero xdotool exit,
a killed xdotool, input without a bound lease, and a pointer that maps outside the display
(that one prints the coordinate and the display size, which separates a mapping bug from a
lease bug).

## Coordinate mapping, for reference

The server sends `hello` with `content = rt.screen` (2560×1600). ffmpeg scales frames to
`min(1600, iw)` wide, so the canvas backing store is 1600×1000 while input coordinates are in
2560×1600 screen space. `framePoint()` in `app.js` reverses `object-fit: contain` using the
canvas backing-store size, then scales to `frameSize`. `desktopInput()` rejects anything
outside `rt.screen`. A mismatch here would look exactly like "clicks land in the wrong place"
rather than "clicks do nothing", so it is lower on the list — but it has not been measured.

## Environment

Railway project `b3f091af-3d28-45bc-b7be-78689eea0b9b`, service
`a9587cc5-0472-4250-99ab-aefe51bfc0d4`, deploying from `main` on push. Published image
`ghcr.io/nxfi777/tallylamp:0.7.1`
(`sha256:c16e2c3e6daaf37cd004b4cfb3e3c1bfcc5b021ec4618042e6b82c52571d5538`). Everything after
`bb98a1e` is unreleased; the GHCR image and the Railway template still carry 0.7.1.
