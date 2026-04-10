/**
 * decern gate — CI gate command.
 *
 * Reads ADRs locally, evaluates diff against them, produces verdict A/B/C.
 * Reports results to cloud (if configured) for evidence + PR comments.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { readAdrs } from "../adr/reader.js";
import { evaluateAdrs } from "../adr/evaluator.js";
import { createLlmClient } from "../llm/client.js";
import { collectCiMetadata } from "../ci-metadata.js";
import { getBaseAndHead, getDiffForJudge } from "../judge-diff.js";
import { reportToCloud } from "../cloud/reporter.js";

function log(msg: string) { console.log(msg); }

export async function runGate(): Promise<number> {
  log("decern gate — architecture decision check");
  log("");

  // ── Config ──
  const llmBaseUrl = process.env.DECERN_LLM_BASE_URL?.trim();
  const llmApiKey = process.env.DECERN_LLM_API_KEY?.trim();
  const llmModel = process.env.DECERN_LLM_MODEL?.trim();
  const adrDir = resolve(process.env.DECERN_ADR_DIR?.trim() || "docs/adr");
  const cloudUrl = process.env.DECERN_BASE_URL?.trim();
  const ciToken = process.env.DECERN_CI_TOKEN?.trim();

  if (!llmBaseUrl || !llmApiKey || !llmModel) {
    log("Error: DECERN_LLM_BASE_URL, DECERN_LLM_API_KEY, and DECERN_LLM_MODEL are required.");
    return 1;
  }

  // ── Read ADRs ──
  const adrs = readAdrs(adrDir);
  log(`ADRs: found ${adrs.length} approved in ${adrDir}`);
  if (adrs.length === 0) {
    log("No approved ADRs found. Gate passes (nothing to enforce).");
    log("");
    log("Gate: passed.");
    return 0;
  }

  // ── Get diff ──
  const baseSha = process.env.CI_BASE_SHA?.trim();
  const headSha = process.env.CI_HEAD_SHA?.trim();
  let changedFiles: string[];
  try {
    const { base, head } = getBaseAndHead(baseSha, headSha);
    const out = execSync(`git diff --name-only ${base}...${head}`, { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 });
    changedFiles = out.split("\n").map(f => f.trim()).filter(Boolean);
  } catch {
    log("Error: could not compute diff (git error).");
    return 1;
  }

  log(`Changed files: ${changedFiles.length}`);
  if (changedFiles.length === 0) {
    log("No files changed. Gate passes.");
    log("");
    log("Gate: passed.");
    return 0;
  }

  // ── Get full diff for LLM ──
  const { base: diffBase, head: diffHead } = getBaseAndHead(baseSha, headSha);
  const diffResult = getDiffForJudge(diffBase, diffHead);
  if (diffResult.truncated) {
    log("Warning: diff truncated to 2MB.");
  }

  // ── Evaluate ──
  const llm = createLlmClient(llmBaseUrl, llmApiKey, llmModel);
  const { evaluations, signals } = await evaluateAdrs(adrs, diffResult.diff, changedFiles, llm, log);

  // ── Compute verdict ──
  const blockingViolations = evaluations.filter(e => e.result === "violation" && e.enforcement === "blocking");
  const warningViolations = evaluations.filter(e => e.result === "violation" && e.enforcement === "warning");
  const passes = evaluations.filter(e => e.result === "pass");

  log("");

  let verdictCase: "A" | "B" | "C";
  let exitCode: 0 | 1;

  if (blockingViolations.length > 0) {
    verdictCase = "B";
    exitCode = 1;
    for (const v of blockingViolations) {
      log(`BLOCKED: ${v.adrId} — ${v.reason}`);
    }
    log("");
    log("Gate: blocked.");
  } else if (warningViolations.length > 0) {
    verdictCase = "B";
    exitCode = 0;
    for (const v of warningViolations) {
      log(`WARNING: ${v.adrId} — ${v.reason}`);
    }
    log("");
    log("Gate: passed (with warnings).");
  } else if (signals.length > 0) {
    verdictCase = "C";
    exitCode = 0;
    for (const s of signals) {
      log(`SIGNAL: ${s.suggestedAdrTitle} — ${s.description}`);
    }
    log("");
    log("Gate: passed (new decisions detected, not covered by existing ADRs).");
  } else {
    verdictCase = "A";
    exitCode = 0;
    if (passes.length > 0) {
      log(`Checked ${passes.length} ADR(s): all pass.`);
    }
    log("");
    log("Gate: passed.");
  }

  // ── Report to cloud (if configured) ──
  if (cloudUrl && ciToken) {
    const ciMeta = collectCiMetadata(changedFiles, Buffer.byteLength(diffResult.diff, "utf-8"), diffResult.base, diffResult.head);
    try {
      await reportToCloud(cloudUrl, ciToken, {
        verdictCase,
        exitCode,
        evaluations,
        signals,
        diffHash: require("node:crypto").createHash("sha256").update(diffResult.diff, "utf-8").digest("hex"),
        diffSizeBytes: Buffer.byteLength(diffResult.diff, "utf-8"),
        changedFiles,
        ciMetadata: ciMeta,
        prTitle: process.env.CI_PR_TITLE?.trim(),
        prUrl: process.env.CI_PR_URL?.trim(),
        baseSha: diffResult.base,
        headSha: diffResult.head,
      });
    } catch (e) {
      log(`Warning: could not report to cloud: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return exitCode;
}
