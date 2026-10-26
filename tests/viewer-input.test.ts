import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mouseInput } from "../src/viewer.js";

/**
 * What a real mouse produces, measured in Chrome: a hover has no buttons and no pressure, a press
 * and a drag have their button bits and pressure 0.5, a release has neither. The viewer used to
 * send every hover as a left-button drag at pressure 0, and every press at pressure 0.
 */
describe("operator mouse input", () => {
  it("sends a hover as a hover: no button, no pressure, no click count", () => {
    const { events, held } = mouseInput({ event: "mouseMoved", x: 100.4, y: 50.6, buttons: 0 }, 0);
    assert.equal(held, 0);
    assert.deepEqual(events, [{ type: "mouseMoved", x: 100, y: 51, button: "none", buttons: 0, clickCount: 0, force: 0, modifiers: undefined }]);
  });

  it("presses, drags and releases the way the mouse did", () => {
    const press = mouseInput({ event: "mousePressed", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1 }, 0);
    assert.deepEqual(press.events, [{ type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1, force: 0.5, modifiers: undefined }]);
    const drag = mouseInput({ event: "mouseMoved", x: 20, y: 10, buttons: 1 }, press.held);
    assert.deepEqual(drag.events, [{ type: "mouseMoved", x: 20, y: 10, button: "left", buttons: 1, clickCount: 0, force: 0.5, modifiers: undefined }]);
    const release = mouseInput({ event: "mouseReleased", x: 20, y: 10, button: "left", buttons: 0, clickCount: 1 }, drag.held);
    assert.deepEqual(release.events, [{ type: "mouseReleased", x: 20, y: 10, button: "left", buttons: 0, clickCount: 1, force: 0, modifiers: undefined }]);
    assert.equal(release.held, 0);
  });

  it("keeps a double click's count and the modifiers", () => {
    const { events } = mouseInput({ event: "mousePressed", x: 1, y: 1, button: "left", buttons: 1, clickCount: 2, modifiers: 8 }, 0);
    assert.equal(events[0]!.clickCount, 2);
    assert.equal(events[0]!.modifiers, 8);
  });

  it("tracks buttons itself for a dashboard that does not send them", () => {
    const press = mouseInput({ event: "mousePressed", x: 5, y: 5, button: "right" }, 0);
    assert.equal(press.held, 2);
    assert.equal(press.events[0]!.force, 0.5);
    const move = mouseInput({ event: "mouseMoved", x: 6, y: 5 }, press.held);
    assert.equal(move.events[0]!.button, "right");
    assert.equal(move.events[0]!.buttons, 2);
    const release = mouseInput({ event: "mouseReleased", x: 6, y: 5, button: "right" }, move.held);
    assert.equal(release.held, 0);
    assert.equal(release.events[0]!.buttons, 0);
    assert.equal(release.events[0]!.force, 0);
  });

  it("releases a button let go outside the viewer before the move that shows it is up", () => {
    const { events, held } = mouseInput({ event: "mouseMoved", x: 30, y: 40, buttons: 0 }, 1);
    assert.equal(held, 0);
    assert.deepEqual(events.map((e) => [e.type, e.button, e.buttons, e.force]), [
      ["mouseReleased", "left", 0, 0],
      ["mouseMoved", "none", 0, 0],
    ]);
  });

  it("sends nothing for a message without a position, and ignores nonsense buttons", () => {
    assert.deepEqual(mouseInput({ event: "mouseMoved", x: "a", y: 1 }, 0).events, []);
    assert.deepEqual(mouseInput({ event: "mouseWiggled", x: 1, y: 1 }, 1), { events: [], held: 1 });
    assert.equal(mouseInput({ x: 1, y: 1 }, 0).events[0]!.type, "mousePressed");
    const odd = mouseInput({ event: "mousePressed", x: 1, y: 1, button: "thumb", buttons: 99 }, 0);
    assert.equal(odd.events[0]!.button, "left");
    assert.equal(odd.events[0]!.buttons, 1);
  });
});
