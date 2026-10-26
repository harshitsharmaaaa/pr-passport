import { describe, expect, it } from "bun:test";
import { toChangedFile, truncatePatch } from "./client";
import { MAX_PATCH_CHARS } from "../limits";

describe("toChangedFile", () => {
  it("maps fields and keeps the previous filename for renames", () => {
    const file = toChangedFile(
      {
        filename: "src/after.ts",
        previous_filename: "src/before.ts",
        status: "renamed",
        additions: 3,
        deletions: 1,
        changes: 4,
        patch: "@@ -1 +1 @@",
      },
      false,
    );
    expect(file).toMatchObject({
      filename: "src/after.ts",
      previousFilename: "src/before.ts",
      status: "renamed",
      additions: 3,
      deletions: 1,
      changes: 4,
    });
    expect(file?.patch).toBeUndefined();
  });

  it("normalises unknown statuses to modified and defaults changes", () => {
    expect(toChangedFile({ filename: "f.txt", status: "weird" }, false)?.status).toBe("modified");
    expect(toChangedFile({ filename: "f.txt" }, false)?.changes).toBe(0);
  });

  it("returns null when GitHub sends no filename", () => {
    expect(toChangedFile({}, true)).toBeNull();
  });

  it("attaches the patch only when allowed", () => {
    expect(toChangedFile({ filename: "a.ts", patch: "@@ -1 +1 @@" }, true)?.patch).toBe("@@ -1 +1 @@");
    expect(toChangedFile({ filename: "a.ts", patch: "@@ -1 +1 @@" }, false)?.patch).toBeUndefined();
    expect(toChangedFile({ filename: "a.ts", patch: "   " }, true)?.patch).toBeUndefined();
  });
});

describe("truncatePatch", () => {
  it("normalises line endings", () => {
    expect(truncatePatch("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("keeps short patches unchanged", () => {
    const patch = "@@ -1,2 +1,3 @@\n+line";
    expect(truncatePatch(patch)).toBe(patch);
  });

  it("truncates long patches with a visible marker", () => {
    const long = "x".repeat(MAX_PATCH_CHARS + 500);
    const truncated = truncatePatch(long);
    expect(truncated.endsWith("\n[truncated by PR Passport]")).toBe(true);
    expect(truncated.indexOf("x")).toBe(0);
    expect(truncated.length).toBeLessThan(long.length);
  });
});