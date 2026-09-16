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
