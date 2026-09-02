import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeMetadata, METADATA_LIMITS } from "../src/metadata.js";
import { AppError } from "../src/errors.js";

describe("metadata", () => {
  it("allows empty metadata", () => {
    assert.deepEqual(sanitizeMetadata(undefined), {});
    assert.deepEqual(sanitizeMetadata({}), {});
  });

  it("stores known fields", () => {
    const m = sanitizeMetadata({ source: "claude-code", project: "tallylamp", purpose: "test" });
    assert.equal(m.source, "claude-code");
    assert.equal(m.project, "tallylamp");
  });

  it("rejects unknown keys", () => {
    assert.throws(() => sanitizeMetadata({ cookies: "x" }), AppError);
  });

  it("rejects oversized values", () => {
    assert.throws(() => sanitizeMetadata({ purpose: "x".repeat(METADATA_LIMITS.maxValueLength + 1) }), AppError);
  });

  it("rejects secret-looking values", () => {
    assert.throws(() => sanitizeMetadata({ purpose: "password=hunter2" }), AppError);
  });

  it("enforces label limits", () => {
    const labels: Record<string, string> = {};
    for (let i = 0; i < METADATA_LIMITS.maxLabels + 1; i++) labels[`k${i}`] = "v";
    assert.throws(() => sanitizeMetadata({ labels }), AppError);
  });
});
