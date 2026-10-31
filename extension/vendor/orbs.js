// The dashboard's "something is happening" indicator, shared with the guest page and copied
// into Tallylamp Link. The drawing is thinking-orbs' engine (thinking-orbs.js, MIT); this file is
// the part its React wrapper did: one canvas per orb, and one animation loop for all of them.
//
// Each state means one thing everywhere it appears, so an orb always reads the same:
//   working     an agent is acting right now
//   connecting  a live view is linking up
//   breathing   Chrome is starting, stopping, moving or queued
//   listening   waiting on someone else: a worker, a gateway, an approval
// Only 20 and 64 px are tuned designs. `connecting` thins to a few loose dots at 20, so it is
// used at 64 only.
import { MODE_DRAWS, resolvePreset } from "./thinking-orbs.js";

const DPR = Math.min(2, globalThis.devicePixelRatio || 1);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
// A representative pose for every state, shown still under reduced motion.
const STILL = 0.6;
const shown = new Set();
let raf = 0;

// The page's own choice first (the dashboard's theme setting writes data-theme), then the system.
function isDark() {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === "dark" : darkScheme.matches;
}

function paint(canvas, seconds, dark) {
  const o = canvas.orb;
  o.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  o.ctx.clearRect(0, 0, o.size, o.size);
  o.draw(o.ctx, o.size, seconds * o.speed, dark, o.opts);
}

// One clock for every orb, so two on the same screen move in step.
function frame(now) {
  raf = 0;
  const dark = isDark();
  const t = reduced.matches ? STILL : now / 1000;
  for (const canvas of shown) paint(canvas, t, dark);
  if (shown.size && !reduced.matches) raf = requestAnimationFrame(frame);
}

function wake() {
  if (!raf && shown.size) raf = requestAnimationFrame(frame);
}

// Off screen, removed, or inside something hidden, an orb is not drawn, and the loop ends once
// none is left to draw. A background tab gets no animation frames at all.
const watch = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      shown.add(e.target);
    } else {
      shown.delete(e.target);
      if (!e.target.isConnected) watch.unobserve(e.target);
    }
  }
  wake();
});

// Under reduced motion nothing loops, so a theme switch has to ask for the repaint itself.
reduced.addEventListener("change", wake);
darkScheme.addEventListener("change", wake);
new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/**
 * An orb, as a canvas to put beside the words that say what is happening. Those words carry the
 * meaning, so the orb is hidden from assistive technology rather than announced twice.
 */
export function orb(state, size = 20) {
  const px = size === 64 ? 64 : 20;
  const { mode, speed, opts } = resolvePreset(state, px);
  const canvas = document.createElement("canvas");
  canvas.className = "orb";
  canvas.width = canvas.height = Math.round(px * DPR);
  // CSSOM, not a style attribute: the guest page's policy refuses inline styles.
  canvas.style.width = canvas.style.height = `${px}px`;
  canvas.setAttribute("aria-hidden", "true");
  canvas.orb = { size: px, speed, opts, draw: MODE_DRAWS[mode], ctx: canvas.getContext("2d") };
  // Drawn once now, so it never shows up blank for the frame before the observer reports it.
  paint(canvas, reduced.matches ? STILL : performance.now() / 1000, isDark());
  watch.observe(canvas);
  return canvas;
}
