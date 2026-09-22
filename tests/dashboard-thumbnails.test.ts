import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { strict as assert } from "node:assert";
import { test } from "node:test";

// The dashboard is a plain script, so the part under test is cut out and run against fakes,
// the way dashboard-identity.test.ts does it.
const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
const slice = source.slice(source.indexOf("const thumbs = new Map();"), source.indexOf("function card(b) {"));

type Img = { src: string; isConnected: boolean };

function harness() {
  const made: Img[] = [];
  let tick: (() => void) | undefined;
  const document = { visibilityState: "visible" };
  let clock = 0;
  const thumbnail = runInNewContext(`${slice}; thumbnail`, {
    h: () => {
      const img: Img = { src: "", isConnected: true };
      made.push(img);
      return img;
    },
    setInterval: (fn: () => void) => { tick = fn; return 1; },
    document,
    // Two paints in one millisecond must still tell apart a refreshed picture from a kept one.
    Date: { now: () => ++clock },
  }) as (b: Record<string, unknown>) => Img;
  return { made, thumbnail, document, tick: () => tick?.() };
}

const running = { id: "b1", status: "running", url: "https://a.test/", title: "A", lastActivityAt: "t1" };

test("a repaint carries the same thumbnail over while the browser has not moved on", () => {
  const { made, thumbnail } = harness();
  const first = thumbnail(running);
  assert.equal(thumbnail({ ...running }), first);
  assert.equal(made.length, 1);
  assert.notEqual(thumbnail({ ...running, url: "https://b.test/" }), first);
  assert.notEqual(thumbnail({ ...running, url: "https://b.test/", lastActivityAt: "t2" }), first);
  assert.equal(made.length, 3);
});

test("the slow clock refreshes only pictures somebody can see, and forgets the ones whose card is gone", () => {
  const { made, thumbnail, document, tick } = harness();
  const img = thumbnail(running);
  const gone = thumbnail({ ...running, id: "b2" });
  const was = img.src;
  const goneWas = gone.src;
  gone.isConnected = false;
  document.visibilityState = "hidden";
  tick();
  assert.equal(img.src, was);
  document.visibilityState = "visible";
  tick();
  assert.notEqual(img.src, was);
  assert.equal(gone.src, goneWas, "a picture without a card is left alone");
  // Forgotten: the next paint of b2 makes a new one instead of reviving the old node.
  assert.notEqual(thumbnail({ ...running, id: "b2" }), gone);
  assert.equal(made.length, 3);
});
