/**
 * decern-gate — CI gate that requires an approved Decern decision for high-impact changes.
 * Uses only git + env vars; works on any CI (GitHub Actions, GitLab, Jenkins, etc.).
 */

import { execSync } from "child_process";
import { pathMatchesRequired } from "./required-patterns.js";

// --- Config from env (never log DECERN_CI_TOKEN) ---

const DECERN_BASE_URL = process.env.DECERN_BASE_URL?.trim();
const DECERN_CI_TOKEN = process.env.DECERN_CI_TOKEN?.trim();
const DECERN_GATE_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.DECERN_GATE_TIMEOUT_MS ?? "5000", 10) || 5000
);

const CI_BASE_SHA = process.env.CI_BASE_SHA?.trim();
const CI_HEAD_SHA = process.env.CI_HEAD_SHA?.trim();
const CI_PR_TITLE = process.env.CI_PR_TITLE?.trim();
const CI_PR_BODY = process.env.CI_PR_BODY?.trim();
const CI_COMMIT_MESSAGE = process.env.CI_COMMIT_MESSAGE?.trim();

const VALIDATE_PATH = process.env.DECERN_VALIDATE_PATH?.trim() || "/api/decision-gate/validate";

/** When true, gate blocks unless the decision has the current PR linked in Decern (requires API to return hasLinkedPR). */
const DECERN_GATE_REQUIRE_LINKED_PR =
  process.env.DECERN_GATE_REQUIRE_LINKED_PR?.toLowerCase() === "true" ||
  process.env.DECERN_GATE_REQUIRE_LINKED_PR === "1";

export function isDecisionRequired(changedFiles: string[]): { required: true; reason: string } | { required: false; reason: string } {
  const matched = changedFiles.filter(pathMatchesRequired);
  if (matched.length > 0) {
    return { required: true, reason: `High-impact patterns matched: ${matched.slice(0, 5).join(", ")}${matched.length > 5 ? "..." : ""}` };
  }
  return { required: false, reason: "No high-impact file patterns matched." };
}

// --- Extract decision IDs and ADR refs from text (PR description / commit message) ---

const DECERN_PREFIX = /decern:\s*([a-zA-Z0-9_-]+)/gi;
const DECERN_TICKET = /DECERN-([a-zA-Z0-9_-]+)/g;
const DECISIONS_URL = /\/decisions\/([a-zA-Z0-9_-]+)/g;
/** Standalone ADR refs (e.g. ADR-001, ADR-123) */
const ADR_REF = /\b(ADR-[a-zA-Z0-9_-]+)\b/gi;

/** ADR ref (e.g. ADR-001); anything else is treated as decision ID (e.g. UUID). */
const ADR_REF_REGEX = /^ADR-[a-zA-Z0-9_-]+$/i;

export function extractDecisionIds(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const ids = new Set<string>();
  for (const re of [DECERN_PREFIX, DECERN_TICKET, DECISIONS_URL, ADR_REF]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ids.add(m[1].trim());
    }
  }
  return [...ids];
}

/** Returns whether the ref is an ADR ref (e.g. ADR-001); otherwise treated as decision ID (UUID). */
function isAdrRef(ref: string): boolean {
  return ADR_REF_REGEX.test(ref.trim());
}

// --- Git: changed files ---

function getChangedFiles(): string[] {
  let base = "";
  let head = "";

  if (CI_BASE_SHA && CI_HEAD_SHA) {
    base = CI_BASE_SHA;
    head = CI_HEAD_SHA;
  } else {
    try {
      execSync("git rev-parse --verify origin/main", { stdio: "pipe" });
      base = "origin/main";
      head = "HEAD";
    } catch {
      try {
        execSync("git rev-parse --verify origin/master", { stdio: "pipe" });
        base = "origin/master";
        head = "HEAD";
      } catch {
        base = "HEAD~1";
        head = "HEAD";
      }
    }
  }

  const out = execSync(`git diff --name-only ${base}...${head}`, {
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Git: commit message fallback ---

function getCommitMessage(): string {
  try {
    return execSync("git log -1 --pretty=%B", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function getPrOrCommitText(): string {
  const parts: string[] = [];
  if (CI_PR_TITLE) parts.push(CI_PR_TITLE);
  if (CI_PR_BODY) parts.push(CI_PR_BODY);
  if (parts.length > 0) return parts.join("\n\n");
  if (CI_COMMIT_MESSAGE) return CI_COMMIT_MESSAGE;
  return getCommitMessage();
}

// --- Validate: call API ---

type ValidateResult =
  | { ok: true; decisionStatus?: string; hasLinkedPR?: boolean }
  | { ok: false; status: number; reason: string; body?: unknown };

async function validateRef(ref: string): Promise<ValidateResult> {
  if (!DECERN_BASE_URL || !DECERN_CI_TOKEN) {
    return { ok: false, status: 0, reason: "DECERN_BASE_URL and DECERN_CI_TOKEN are required." };
  }

  const base = DECERN_BASE_URL.replace(/\/$/, "");
  const url = new URL(VALIDATE_PATH.startsWith("/") ? VALIDATE_PATH : `/${VALIDATE_PATH}`, `${base}/`);
  if (isAdrRef(ref)) {
    url.searchParams.set("adrRef", ref.trim());
  } else {
    url.searchParams.set("decisionId", ref.trim());
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DECERN_GATE_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${DECERN_CI_TOKEN}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const body = (await res.json().catch(() => ({}))) as {
      valid?: boolean;
      reason?: string;
      status?: string;
      hasLinkedPR?: boolean;
    };
    if (res.status === 200 && body.valid === true) {
      return {
        ok: true,
        decisionStatus: body.status,
        hasLinkedPR: body.hasLinkedPR,
      };
    }
    const rawReason = body.reason ?? `HTTP ${res.status}`;
    const reason = rawReason.startsWith("HTTP ") ? rawReason : formatLabel(rawReason);
    const statusDetail =
      body.status != null ? ` (decision status: ${formatLabel(body.status)})` : "";
    return {
      ok: false,
      status: res.status,
      reason: `${reason}${statusDetail}`,
      body,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, status: 0, reason: `Request timeout after ${DECERN_GATE_TIMEOUT_MS}ms.` };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, reason: `Network error: ${msg}.` };
  }
}

// --- Output (deterministic) ---

/** Turns API slugs (e.g. not_approved, proposed) into human-readable labels (Not Approved, Proposed). */
function formatLabel(s: string): string {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function log(line: string): void {
  console.log(line);
}

const MAX_FILES_LIST = 10;

/** Format a list of paths for output; truncate with "… and N more" if needed. */
function formatFileList(files: string[], max: number = MAX_FILES_LIST): string {
  if (files.length === 0) return "(none)";
  if (files.length <= max) return files.join(", ");
  return `${files.slice(0, max).join(", ")} … and ${files.length - max} more`;
}

/** Runs the gate; returns exit code (0 = pass, 1 = fail). */
export async function run(): Promise<number> {
  const missingEnv = [];
  if (!DECERN_BASE_URL) missingEnv.push("DECERN_BASE_URL");
  if (!DECERN_CI_TOKEN) missingEnv.push("DECERN_CI_TOKEN");

  log("decern-gate — high-impact change check");
  log("");

  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles();
  } catch {
    log("Diff: could not compute (git error)");
    log("Decision required: YES");
    log("Reason: cannot compute diff");
    log("");
    log("Gate: blocked — fix git refs or set CI_BASE_SHA / CI_HEAD_SHA.");
    return 1;
  }

  if (CI_BASE_SHA && CI_HEAD_SHA) {
    log(`Diff: ${CI_BASE_SHA.slice(0, 7)} … ${CI_HEAD_SHA.slice(0, 7)}`);
  }
  log(`Changed files (${changedFiles.length}): ${formatFileList(changedFiles)}`);
  log("");

  const policy = isDecisionRequired(changedFiles);
  const matchedFiles = policy.required ? changedFiles.filter(pathMatchesRequired) : [];

  log(`Policy: decision required — ${policy.required ? "YES" : "NO"}`);
  log(`Reason: ${policy.reason}`);
  if (matchedFiles.length > 0) {
    log(`Matched (high-impact): ${formatFileList(matchedFiles)}`);
  }
  log("");

  if (!policy.required) {
    log("Gate: passed (no high-impact patterns matched).");
    return 0;
  }

  const text = getPrOrCommitText();
  const ids = extractDecisionIds(text);

  log(`References: found ${ids.length} ref(s) (decision ID or ADR) — ${ids.length > 0 ? ids.join(", ") : "none"}`);

  if (ids.length === 0) {
    log("");
    log("Gate: blocked — high-impact change detected.");
    log("");
    log("Add a Decern reference to the PR description or commit message: decision ID (decern:<uuid>, /decisions/<id>) or ADR ref (e.g. ADR-001). The decision must be approved in Decern before merge.");
    if (DECERN_BASE_URL) {
      log(`Dashboard: ${DECERN_BASE_URL}`);
    }
    return 1;
  }

  if (missingEnv.length > 0) {
    log("");
    log(`Gate: blocked — missing env: ${missingEnv.join(", ")}. Set them in CI to validate decisions.`);
    return 1;
  }

  log("");
  for (const id of ids) {
    const result = await validateRef(id);
    if (result.ok) {
      const statusLabel =
        result.decisionStatus != null ? formatLabel(result.decisionStatus) : null;
      if (statusLabel != null) {
        log(`Decision ${id}: status ${statusLabel}.`);
      } else {
        log(`Decision ${id}: valid.`);
      }
      if (result.hasLinkedPR != null) {
        log(`Linked PR: ${result.hasLinkedPR ? "yes" : "no"}.`);
      }

      if (DECERN_GATE_REQUIRE_LINKED_PR) {
        if (result.hasLinkedPR === undefined) {
          log("");
          log(`Gate: blocked — DECERN_GATE_REQUIRE_LINKED_PR is set but the API did not return hasLinkedPR for decision ${id}. Link the PR to the decision in Decern, or ensure the validate API includes hasLinkedPR in the response.`);
          if (DECERN_BASE_URL) {
            log(`Dashboard: ${DECERN_BASE_URL}`);
          }
          return 1;
        }
        if (result.hasLinkedPR !== true) {
          log("");
          log("Gate: blocked — this PR must be linked to the decision in Decern (DECERN_GATE_REQUIRE_LINKED_PR is set).");
          if (DECERN_BASE_URL) {
            log(`Dashboard: ${DECERN_BASE_URL}`);
          }
          return 1;
        }
      }

      log("");
      log("Gate: passed.");
      return 0;
    }
    log(`Decision ${id}: FAIL — ${result.reason}`);
  }

  log("");
  log("Gate: blocked — no referenced decision is valid.");
  log("");
  log("Ensure the decision is approved in Decern, or add a reference to an approved decision (decision ID or ADR-XXX in PR/commit).");
  if (DECERN_BASE_URL) {
    log(`Dashboard: ${DECERN_BASE_URL}`);
  }
  return 1;
}
