/**
 * decern gate — CI gate command.
 *
 * Reads ADRs locally, evaluates diff against them, produces verdict A/B/C.
 * Reports results to cloud (if configured) for evidence + PR comments.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readAdrs } from "../adr/reader.js";
import { evaluateAdrs } from "../adr/evaluator.js";
import { createLlmClient, checkModelRecommendation } from "../llm/client.js";
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
  const confidenceThreshold = parseFloat(process.env.DECERN_CONFIDENCE_THRESHOLD ?? "0.75");
  const evalConcurrency = parseInt(process.env.DECERN_EVAL_CONCURRENCY ?? "3", 10);

  if (!llmBaseUrl || !llmApiKey || !llmModel) {
    log("Error: DECERN_LLM_BASE_URL, DECERN_LLM_API_KEY, and DECERN_LLM_MODEL are required.");
    return 1;
  }

  if (!checkModelRecommendation(llmModel).recommended) {
    log(`⚠️  Decern is running with ${llmModel}, which is not in the recommended model list.`);
    log(`   Quality may be degraded. See https://docs.decern.dev/models for details.`);
    log("");
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
  const { evaluations, signals, diffTruncated } = await evaluateAdrs(
    adrs, diffResult.diff, changedFiles, llm, log,
    { confidenceThreshold, concurrency: evalConcurrency },
  );

  // Truncation transparency
  if (diffResult.truncated || diffTruncated) {
    log("");
    log("Note: the diff was truncated for analysis. Some changes may not have been evaluated.");
  }

  // ── Compute verdict ──
  // Case A (pass), B (violation), and C (new decision signal) are independent
  // dimensions. A PR can pass ADR-007, violate ADR-012, AND introduce a new
  // caching pattern — all three at the same time.
  const blockingViolations = evaluations.filter(e => e.result === "violation" && e.enforcement === "blocking");
  const warningViolations = evaluations.filter(e => e.result === "violation" && e.enforcement === "warning");
  const passes = evaluations.filter(e => e.result === "pass");
  const errors = evaluations.filter(e => e.result === "error");

  if (errors.length > 0) {
    log("");
    for (const e of errors) {
      log(`⚠️  ${e.adrId}: evaluation failed — ${e.reason}`);
    }
    log(`   ${errors.length} ADR(s) could not be evaluated (fail-open: treated as pass).`);
  }

  log("");

  // Violations (Case B)
  let exitCode: 0 | 1 = 0;
  if (blockingViolations.length > 0) {
    exitCode = 1;
    for (const v of blockingViolations) {
      log(`BLOCKED: ${v.adrId} (${(v.confidence * 100).toFixed(0)}%) — ${v.reason}`);
    }
  }
  if (warningViolations.length > 0) {
    for (const v of warningViolations) {
      log(`WARNING: ${v.adrId} (${(v.confidence * 100).toFixed(0)}%) — ${v.reason}`);
    }
  }

  // Signals (Case C) — always shown, regardless of violations
  if (signals.length > 0) {
    if (blockingViolations.length > 0 || warningViolations.length > 0) log("");
    for (const s of signals) {
      log(`SIGNAL: ${s.suggestedAdrTitle} — ${s.description}`);
    }
  }

  // Overall verdict — B is the "worst", then C, then A
  let verdictCase: "A" | "B" | "C";
  if (blockingViolations.length > 0 || warningViolations.length > 0) {
    verdictCase = "B";
  } else if (signals.length > 0) {
    verdictCase = "C";
  } else {
    verdictCase = "A";
  }

  // Summary line
  log("");
  if (exitCode === 1) {
    log(`Gate: blocked.${signals.length > 0 ? ` (${signals.length} new decision${signals.length > 1 ? "s" : ""} also detected)` : ""}`);
  } else if (warningViolations.length > 0) {
    log(`Gate: passed (with warnings).${signals.length > 0 ? ` ${signals.length} new decision${signals.length > 1 ? "s" : ""} detected.` : ""}`);
  } else if (signals.length > 0) {
    log(`Gate: passed. ${signals.length} new decision${signals.length > 1 ? "s" : ""} detected (not covered by existing ADRs).`);
  } else {
    if (passes.length > 0) log(`Checked ${passes.length} ADR(s): all pass.`);
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
        diffHash: createHash("sha256").update(diffResult.diff, "utf-8").digest("hex"),
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
