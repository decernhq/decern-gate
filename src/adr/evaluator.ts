/**
 * ADR evaluator: orchestrates scope pre-filter → LLM evaluation → verdict.
 *
 * Case A (pass), Case B (violation), and Case C (new decision signal) are
 * independent dimensions — a single PR can produce all three simultaneously.
 * Signal detection always runs when ADRs exist and files changed, regardless
 * of whether any ADR was found relevant.
 */

import type { LocalAdr } from "./reader.js";
import { scopeMatchesFiles } from "./scope-filter.js";
import { filterDiffByFiles } from "../judge-diff.js";
import type { LlmClient } from "../llm/client.js";

export interface AdrEvalResult {
  adrId: string;
  adrTitle: string;
  adrHash: string;
  result: "pass" | "violation" | "unrelated" | "skipped" | "error";
  confidence: number;
  enforcement: "blocking" | "warning";
  reason: string;
}

export interface CaseCSignal {
  description: string;
  filesInvolved: string[];
  suggestedAdrTitle: string;
}

export interface EvaluationResult {
  evaluations: AdrEvalResult[];
  signals: CaseCSignal[];
  diffTruncated: boolean;
}

export interface EvalOptions {
  /** Confidence threshold (0-1). Violations below this degrade to warnings. Default 0.75. */
  confidenceThreshold: number;
  /** Max concurrent LLM calls for ADR evaluations. Default 3. */
  concurrency: number;
}

const DEFAULT_OPTIONS: EvalOptions = {
  confidenceThreshold: 0.75,
  concurrency: 3,
};

/**
 * Run tasks with a concurrency limit. No external dependency.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Evaluate all ADRs against a diff AND detect new architectural decisions.
 *
 * 1. Start signal detection immediately (runs in parallel with ADR evals)
 * 2. Pre-filter each ADR by scope, then call LLM concurrently (limit 3-5)
 * 3. For each ADR, send only the scope-filtered diff (not the full diff)
 * 4. Apply confidence threshold: violations below threshold degrade to warnings
 * 5. Await signal detection
 */
export async function evaluateAdrs(
  adrs: LocalAdr[],
  diff: string,
  changedFiles: string[],
  llm: LlmClient,
  log: (msg: string) => void,
  options?: Partial<EvalOptions>,
): Promise<EvaluationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let diffTruncated = false;

  // Prepare signal context: title + first line of Decision for disambiguation
  const existingAdrs = adrs.map((a) => ({
    title: a.title,
    decision: a.decision.split("\n")[0].trim().slice(0, 200),
  }));

  // Start signal detection early — runs concurrently with ADR evals.
  const signalPromise =
    adrs.length > 0 && changedFiles.length > 0
      ? (async () => {
          log("Detecting new architectural decisions...");
          return llm.detectNewDecisions(diff, changedFiles, existingAdrs);
        })()
      : Promise.resolve([] as CaseCSignal[]);

  // Separate ADRs into skipped (scope mismatch) and relevant (need LLM eval)
  const skipped: AdrEvalResult[] = [];
  const relevant: { adr: LocalAdr; scopedDiff: string; relevantFiles: string[] }[] = [];

  for (const adr of adrs) {
    if (adr.scope.length > 0 && !scopeMatchesFiles(adr.scope, changedFiles)) {
      skipped.push({
        adrId: adr.id,
        adrTitle: adr.title,
        adrHash: adr.contentHash,
        result: "skipped",
        confidence: 1,
        enforcement: adr.enforcement,
        reason: "Scope does not match changed files",
      });
      continue;
    }

    // Scope-filtered diff: only send hunks for files matching this ADR's scope.
    // This makes the eval more focused and keeps large diffs within token limits.
    const relevantFiles =
      adr.scope.length > 0
        ? changedFiles.filter((f) => scopeMatchesFiles(adr.scope, [f]))
        : changedFiles;

    const scopedDiff =
      adr.scope.length > 0 ? filterDiffByFiles(diff, relevantFiles) : diff;

    if (!scopedDiff.trim()) {
      // Scope matched file names but diff segments couldn't be extracted
      // (can happen with renames). Skip to avoid sending empty diff.
      skipped.push({
        adrId: adr.id,
        adrTitle: adr.title,
        adrHash: adr.contentHash,
        result: "skipped",
        confidence: 1,
        enforcement: adr.enforcement,
        reason: "No diff content for matching files",
      });
      continue;
    }

    relevant.push({ adr, scopedDiff, relevantFiles });
  }

  // Evaluate relevant ADRs with concurrency limit
  const evalResults = await mapConcurrent(
    relevant,
    opts.concurrency,
    async ({ adr, scopedDiff }) => {
      log(`Evaluating ${adr.id}: ${adr.title}...`);

      const adrText = `# ${adr.title}\n\n## Context\n${adr.context}\n\n## Decision\n${adr.decision}\n\n## Consequences\n${adr.consequences}`;

      const result = await llm.evaluateAdr(adrText, scopedDiff);

      // Confidence threshold: degrade blocking violations below threshold to
      // "pass with observation" to prevent false-positive blocks.
      let effectiveEnforcement = adr.enforcement;
      let effectiveResult = result.result;

      if (
        result.result === "violation" &&
        adr.enforcement === "blocking" &&
        result.confidence < opts.confidenceThreshold
      ) {
        // Low-confidence violation on a blocking ADR → degrade to warning
        effectiveEnforcement = "warning";
        log(
          `  ${adr.id}: confidence ${(result.confidence * 100).toFixed(0)}% < threshold ${(opts.confidenceThreshold * 100).toFixed(0)}% — degraded from blocking to warning`,
        );
      }

      return {
        adrId: adr.id,
        adrTitle: adr.title,
        adrHash: adr.contentHash,
        result: effectiveResult,
        confidence: result.confidence,
        enforcement: effectiveEnforcement,
        reason: result.reason,
      } satisfies AdrEvalResult;
    },
  );

  const evaluations = [...skipped, ...evalResults];

  // Await signal detection (may have already completed during ADR evals)
  const signals = await signalPromise;

  return { evaluations, signals, diffTruncated };
}
