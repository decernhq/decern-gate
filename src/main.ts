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

export function isDecisionRequired(changedFiles: string[]): { required: true; reason: string } | { required: false; reason: string } {
  const matched = changedFiles.filter(pathMatchesRequired);
  if (matched.length > 0) {
    return { required: true, reason: `High-impact patterns matched: ${matched.slice(0, 5).join(", ")}${matched.length > 5 ? "..." : ""}` };
  }
  return { required: false, reason: "No high-impact file patterns matched." };
}

// --- Extract decision IDs from text (PR description / commit message) ---

const DECERN_PREFIX = /decern:\s*([a-zA-Z0-9_-]+)/gi;
const DECERN_TICKET = /DECERN-([a-zA-Z0-9_-]+)/g;
const DECISIONS_URL = /\/decisions\/([a-zA-Z0-9_-]+)/g;

export function extractDecisionIds(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const ids = new Set<string>();
  for (const re of [DECERN_PREFIX, DECERN_TICKET, DECISIONS_URL]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ids.add(m[1].trim());
    }
  }
  return [...ids];
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
  | { ok: true; observationOnly?: boolean }
  | { ok: false; status: number; reason: string; body?: unknown };

async function validateDecision(decisionId: string): Promise<ValidateResult> {
  if (!DECERN_BASE_URL || !DECERN_CI_TOKEN) {
    return { ok: false, status: 0, reason: "DECERN_BASE_URL and DECERN_CI_TOKEN are required." };
  }

  const base = DECERN_BASE_URL.replace(/\/$/, "");
  const url = new URL(VALIDATE_PATH.startsWith("/") ? VALIDATE_PATH : `/${VALIDATE_PATH}`, `${base}/`);
  url.searchParams.set("decisionId", decisionId);
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
      observationOnly?: boolean;
      reason?: string;
      status?: string;
    };
    if (res.status === 200 && body.valid === true) {
      return { ok: true, observationOnly: body.observationOnly === true };
    }
    const reason = body.reason ?? `HTTP ${res.status}`;
    const statusDetail = body.status != null ? ` (decision status: ${body.status})` : "";
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

function log(line: string): void {
  console.log(line);
}

/** Runs the gate; returns exit code (0 = pass, 1 = fail). */
export async function run(): Promise<number> {
  const missingEnv = [];
  if (!DECERN_BASE_URL) missingEnv.push("DECERN_BASE_URL");
  if (!DECERN_CI_TOKEN) missingEnv.push("DECERN_CI_TOKEN");

  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles();
  } catch {
    log("Changed files: error");
    log("Decision required: YES");
    log("Reason: cannot compute diff");
    return 1;
  }

  log(`Changed files: ${changedFiles.length}`);
  const policy = isDecisionRequired(changedFiles);
  log(`Decision required: ${policy.required ? "YES" : "NO"}`);
  log(`Reason: ${policy.reason}`);

  if (!policy.required) {
    return 0;
  }

  const text = getPrOrCommitText();
  const ids = extractDecisionIds(text);
  log(`Found decision refs: ${ids.length > 0 ? ids.join(", ") : "none"}`);

  if (ids.length === 0) {
    log("");
    log("High-impact change detected. Add 'decern:<id>' to PR description or commit message referencing an APPROVED decision.");
    return 1;
  }

  if (missingEnv.length > 0) {
    log("");
    log(`Missing required env: ${missingEnv.join(", ")}. Set them to validate the decision.`);
    return 1;
  }

  for (const id of ids) {
    const result = await validateDecision(id);
    if (result.ok) {
      if (result.observationOnly) {
        log(`Validation result: observation only (decision ${id})`);
        log("");
        log("Observation only: decision is proposed, not approved. Upgrade to Team for enforcement.");
        return 0;
      }
      log(`Validation result: OK (decision ${id} is approved)`);
      return 0;
    }
    log(`Validation result: FAIL for ${id} — ${result.reason}`);
  }
  log("");
  log("High-impact change detected. Add 'decern:<id>' to PR description or commit message referencing an APPROVED decision.");
  return 1;
}
