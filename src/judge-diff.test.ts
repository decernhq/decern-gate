import { describe, it, expect, vi, beforeEach } from "vitest";
import { getBaseAndHead, getDiffForJudge } from "./judge-diff";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
});

/* ── getBaseAndHead ────────────────────────────────────────────────── */

describe("getBaseAndHead", () => {
  it("uses CI SHAs when both provided", () => {
    const result = getBaseAndHead("abc123", "def456");
    expect(result).toEqual({ base: "abc123", head: "def456" });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("trims CI SHAs", () => {
    const result = getBaseAndHead("  abc123  ", "  def456  ");
    expect(result).toEqual({ base: "abc123", head: "def456" });
  });

  it("falls back to origin/main when CI SHAs are empty", () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(""));
    const result = getBaseAndHead("", "");
    expect(result).toEqual({ base: "origin/main", head: "HEAD" });
  });

  it("falls back to origin/main when CI SHAs are undefined", () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(""));
    const result = getBaseAndHead();
    expect(result).toEqual({ base: "origin/main", head: "HEAD" });
  });

  it("falls back to origin/master when origin/main does not exist", () => {
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockReturnValueOnce(Buffer.from(""));
    const result = getBaseAndHead();
    expect(result).toEqual({ base: "origin/master", head: "HEAD" });
  });

  it("falls back to HEAD~1 when neither origin/main nor origin/master exist", () => {
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockImplementationOnce(() => { throw new Error("not found"); });
    const result = getBaseAndHead();
    expect(result).toEqual({ base: "HEAD~1", head: "HEAD" });
  });

  it("ignores whitespace-only CI base SHA", () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(""));
    const result = getBaseAndHead("   ", "def456");
    expect(result).toEqual({ base: "origin/main", head: "HEAD" });
  });
});

/* ── getDiffForJudge ──────────────────────────────────────────────── */

describe("getDiffForJudge", () => {
  it("returns empty diff when git diff fails", () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error("git error"); });
    const result = getDiffForJudge("abc", "def");
    expect(result).toEqual({
      diff: "",
      excludedFiles: [],
      truncated: false,
      base: "abc",
      head: "def",
    });
  });

  it("returns empty diff for empty git output", () => {
    mockExecSync.mockReturnValueOnce("");
    const result = getDiffForJudge("abc", "def");
    expect(result.diff).toBe("");
    expect(result.excludedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("includes normal text file diffs", () => {
    const rawDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;`;
    mockExecSync.mockReturnValueOnce(rawDiff);
    const result = getDiffForJudge("base", "head");
    expect(result.diff).toContain("src/foo.ts");
    expect(result.excludedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("excludes image files by extension", () => {
    const rawDiff = `diff --git a/assets/logo.png b/assets/logo.png
--- a/assets/logo.png
+++ b/assets/logo.png
@@ -0,0 +1 @@
+fake png data`;
    mockExecSync.mockReturnValueOnce(rawDiff);
    const result = getDiffForJudge("base", "head");
    expect(result.diff).toBe("");
    expect(result.excludedFiles).toContain("assets/logo.png");
  });

  it("excludes multiple heavy file types (.pdf, .woff2, .mp4, .svg)", () => {
    const segments = [
      "diff --git a/doc.pdf b/doc.pdf\n+data",
      "diff --git a/font.woff2 b/font.woff2\n+data",
      "diff --git a/video.mp4 b/video.mp4\n+data",
      "diff --git a/icon.svg b/icon.svg\n+data",
    ].join("\n");
    mockExecSync.mockReturnValueOnce(segments);
    const result = getDiffForJudge("base", "head");
    expect(result.diff).toBe("");
    expect(result.excludedFiles).toEqual(
      expect.arrayContaining(["doc.pdf", "font.woff2", "video.mp4", "icon.svg"])
    );
  });

  it("excludes binary files", () => {
    const rawDiff = `diff --git a/data.bin b/data.bin
Binary files a/data.bin and b/data.bin differ`;
    mockExecSync.mockReturnValueOnce(rawDiff);
    const result = getDiffForJudge("base", "head");
    expect(result.diff).toBe("");
    expect(result.excludedFiles).toContain("data.bin");
  });

  it("excludes per-file diffs over 1MB", () => {
    const largeDiff = `diff --git a/big.ts b/big.ts\n${"x".repeat(1.1 * 1024 * 1024)}`;
    mockExecSync.mockReturnValueOnce(largeDiff);
    const result = getDiffForJudge("base", "head");
    expect(result.diff).toBe("");
    expect(result.excludedFiles).toContain("big.ts");
  });

  it("truncates total diff at 2MB and sets truncated flag", () => {
    // Create two segments: first ~0.9MB (under per-file limit), second ~0.9MB
    // Total raw > 2MB triggers truncated flag
    const fileContent = "x".repeat(900 * 1024);
    const seg1 = `diff --git a/a.ts b/a.ts\n${fileContent}`;
    const seg2 = `\ndiff --git a/b.ts b/b.ts\n${fileContent}`;
    const seg3 = `\ndiff --git a/c.ts b/c.ts\n${fileContent}`;
    mockExecSync.mockReturnValueOnce(seg1 + seg2 + seg3);
    const result = getDiffForJudge("base", "head");
    expect(result.truncated).toBe(true);
  });

  it("mixes included and excluded files correctly", () => {
    const rawDiff = [
      "diff --git a/src/code.ts b/src/code.ts\n--- a/src/code.ts\n+++ b/src/code.ts\n@@ -1 +1 @@\n-old\n+new",
      "\ndiff --git a/logo.jpg b/logo.jpg\n+image data",
      "\ndiff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-hi\n+bye",
    ].join("");
    mockExecSync.mockReturnValueOnce(rawDiff);
    const result = getDiffForJudge("base", "head");
    expect(result.diff).toContain("code.ts");
    expect(result.diff).toContain("readme.md");
    expect(result.diff).not.toContain("image data");
    expect(result.excludedFiles).toContain("logo.jpg");
  });

  it("deduplicates excluded files", () => {
    // Binary + image extension on same file
    const rawDiff = `diff --git a/icon.png b/icon.png
Binary files a/icon.png and b/icon.png differ`;
    mockExecSync.mockReturnValueOnce(rawDiff);
    const result = getDiffForJudge("base", "head");
    expect(result.excludedFiles).toEqual(["icon.png"]);
  });

  it("returns correct base and head in result", () => {
    mockExecSync.mockReturnValueOnce("");
    const result = getDiffForJudge("my-base", "my-head");
    expect(result.base).toBe("my-base");
    expect(result.head).toBe("my-head");
  });
});
