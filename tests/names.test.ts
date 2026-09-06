import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidName, slugify } from "../src/names.js";

describe("names", () => {
  it("accepts dns-safe slugs", () => {
    assert.equal(isValidName("alice"), true);
    assert.equal(isValidName("b-1"), true);
  });
  it("rejects leading dashes and empty", () => {
    assert.equal(isValidName("-x"), false);
    assert.equal(isValidName(""), false);
  });
  it("slugifies display names", () => {
    assert.equal(slugify("Caregenie OAuth", "b-x"), "caregenie-oauth");
  });
});
