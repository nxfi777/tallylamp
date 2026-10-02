import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
const copyFunction = source.slice(source.indexOf("async function copyBrowserId("), source.indexOf("function sitePills("));

test("copy browser ID uses the canonical ID, not the slug", async () => {
  const copied: string[] = [];
  const messages: string[] = [];
  const copy = runInNewContext(`${copyFunction}; copyBrowserId`, {
    navigator: { clipboard: { writeText: async (text: string) => copied.push(text) } },
    flash: (message: string) => messages.push(message),
  });
  await copy({ id: "canonical-id", slug: "friendly-slug" });
  assert.deepEqual(copied, ["canonical-id"]);
  assert.deepEqual(messages, ["Browser ID copied."]);
});

test("clipboard failure provides the ID for manual copying", async () => {
  const messages: string[] = [];
  const copy = runInNewContext(`${copyFunction}; copyBrowserId`, {
    navigator: {},
    flash: (message: string) => messages.push(message),
  });
  await copy({ id: "canonical-id" });
  assert.deepEqual(messages, ["Could not copy. Select and copy the browser ID: canonical-id"]);
});

test("browser metadata editing is not labelled as saved-profile editing", () => {
  assert.ok(!source.includes('"Edit profile'));
  assert.ok(source.includes('askFor("Edit browser details"'));
  assert.ok(source.includes('label: "Browser name"'));
  assert.ok(source.includes('class: "browser-id"'));
});

const scopesWithStart = source.indexOf("function scopesWith(");
const scopesWithFunction = source.slice(scopesWithStart, source.indexOf("\n}\n", scopesWithStart) + 2);
const scopesWith = runInNewContext(`${scopesWithFunction}; scopesWith`, {
  state: { permissions: [{ scope: "seed:use" }, { scope: "seed:write" }, { scope: "browser:lend" }] },
}) as (current: string[], ticked: string[]) => string[];

test("a new agent gets its defaults plus exactly the permissions ticked", () => {
  // Spread: arrays made inside the vm context have another realm's prototype.
  assert.deepEqual([...scopesWith(["browser:create", "browser:control:own"], ["seed:use"])],
    ["browser:create", "browser:control:own", "seed:use"]);
  assert.deepEqual([...scopesWith(["browser:create"], [])], ["browser:create"]);
});

test("saving permissions changes only the scopes the form shows", () => {
  // A connector approved without browser:delete:own must not get it back from this form, and
  // unticking lending must not take seed:write with it.
  assert.deepEqual([...scopesWith(["browser:create", "browser:lend", "seed:write"], ["seed:write", "seed:use"])],
    ["browser:create", "seed:write", "seed:use"]);
});
