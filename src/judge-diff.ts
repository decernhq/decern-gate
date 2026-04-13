/**
 * Builds the diff payload for the judge API: full diff with exclusions and 2MB cap.
 * - Excludes image/binary and per-file diffs > 1MB (with warning).
 * - Total diff sent to backend is at most 2MB; if larger, truncate and set truncated flag.
 */

import { execSync } from "child_process";

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2MB operational limit
const MAX_FILE_DIFF_BYTES = 1 * 1024 * 1024; // 1MB per file — exclude file if its diff exceeds this

/** Extensions treated as image/heavy; these files are excluded from the diff sent to judge. */
const IMAGE_OR_HEAVY_EXTENSIONS = new Set(
  [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".tif",
    ".svg", ".avif", ".heic", ".webm", ".mp4", ".mov", ".avi", ".pdf", ".woff2",
    ".woff", ".ttf", ".eot", ".otf",
  ].map((e) => e.toLowerCase())
);

function isImageOrHeavyByPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const ext = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".")) : "";
  return IMAGE_OR_HEAVY_EXTENSIONS.has(ext);
}

export type JudgeDiffResult = {
  diff: string;
  excludedFiles: string[];
  truncated: boolean;
  base: string;
  head: string;
};

/**
 * Returns base and head refs used for diff (same logic as getChangedFiles).
 */
export function getBaseAndHead(ciBaseSha?: string, ciHeadSha?: string): { base: string; head: string } {
  if (ciBaseSha?.trim() && ciHeadSha?.trim()) {
    return { base: ciBaseSha.trim(), head: ciHeadSha.trim() };
  }
  try {
    execSync("git rev-parse --verify origin/main", { stdio: "pipe" });
    return { base: "origin/main", head: "HEAD" };
  } catch {
    try {
      execSync("git rev-parse --verify origin/master", { stdio: "pipe" });
      return { base: "origin/master", head: "HEAD" };
    } catch {
      return { base: "HEAD~1", head: "HEAD" };
    }
  }
}

/**
 * Splits raw git diff output into per-file segments. Each segment starts with "diff --git ".
 */
function splitDiffByFile(rawDiff: string): string[] {
  if (!rawDiff || !rawDiff.trim()) return [];
  const segments = rawDiff.split(/(?=\ndiff --git )/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0 && rawDiff.trim()) {
    const first = rawDiff.trimStart();
    if (first.startsWith("diff --git ")) return [first];
  }
  return segments;
}

/**
 * Extracts file path from a diff segment first line "diff --git a/path b/path".
 */
function pathFromSegment(segment: string): string {
  const firstLine = segment.split("\n")[0] ?? "";
  const match = firstLine.match(/^diff --git a\/(.+?) b\//);
  return match ? match[1].trim() : "";
}

function segmentIsBinary(segment: string): boolean {
  return segment.includes("Binary files ") && segment.includes(" differ");
}

/**
 * Returns only the diff segments for files in the given list.
 * Used to send ADR-scoped diff to the LLM: if an ADR covers src/api/**,
 * only hunks touching src/api/* are sent, making the eval more focused
 * and staying within token limits.
 */
export function filterDiffByFiles(fullDiff: string, files: string[]): string {
  if (!fullDiff || files.length === 0) return "";
  const fileSet = new Set(files.map(f => f.replace(/\\/g, "/")));
  const segments = splitDiffByFile(fullDiff);
  const matching = segments.filter(seg => {
    const p = pathFromSegment(seg);
    return p && fileSet.has(p);
  });
  return matching.join("\n");
}

/**
 * Builds diff for judge: excludes images and per-file diffs > 1MB; caps total at 2MB.
 */
export function getDiffForJudge(
  base: string,
  head: string
): JudgeDiffResult {
  const excludedFiles: string[] = [];
  let fullRaw: string;
  try {
    fullRaw = execSync(`git diff ${base}...${head}`, {
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024, // allow reading up to 8MB from git; we cap at 2MB for payload
    });
  } catch {
    return {
      diff: "",
      excludedFiles: [],
      truncated: false,
      base,
      head,
    };
  }

  const segments = splitDiffByFile(fullRaw);
  const included: string[] = [];
  let totalBytes = 0;
  let didTruncate = false;

  for (const seg of segments) {
    const path = pathFromSegment(seg);
    const segBytes = Buffer.byteLength(seg, "utf-8");
    const isImage = path && isImageOrHeavyByPath(path);
    const isBinary = segmentIsBinary(seg);
    const overSize = segBytes > MAX_FILE_DIFF_BYTES;

    if (isImage || isBinary || overSize) {
      if (path) excludedFiles.push(path);
      continue;
    }

    if (totalBytes + segBytes <= MAX_DIFF_BYTES) {
      included.push(seg);
      totalBytes += segBytes;
    } else {
      const remaining = MAX_DIFF_BYTES - totalBytes;
      if (remaining > 0) {
        const truncatedSeg = seg.slice(0, remaining);
        included.push(truncatedSeg);
        totalBytes = MAX_DIFF_BYTES;
        didTruncate = true;
      }
      if (path) excludedFiles.push(path);
    }
  }

  const diff = included.join("\n");
  const totalRawBytes = Buffer.byteLength(fullRaw, "utf-8");
  const truncated = didTruncate || totalRawBytes > MAX_DIFF_BYTES;

  return {
    diff,
    excludedFiles: Array.from(new Set(excludedFiles)),
    truncated,
    base,
    head,
  };
}
