/**
 * ADR evaluator: orchestrates scope pre-filter → LLM evaluation → verdict.
 */

import type { LocalAdr } from "./reader.js";
import { scopeMatchesFiles } from "./scope-filter.js";
import type { LlmClient } from "../llm/client.js";

export interface AdrEvalResult {
  adrId: string;
  adrTitle: string;
  adrHash: string;
  result: "pass" | "violation" | "unrelated" | "skipped";
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
}

/**
 * Evaluate all ADRs against a diff.
 *
 * 1. Pre-filter by scope (skip ADRs whose scope doesn't match changed files)
 * 2. Call LLM for each remaining ADR
 * 3. Detect case C (no ADR covers the changes)
 */
export async function evaluateAdrs(
  adrs: LocalAdr[],
  diff: string,
  changedFiles: string[],
  llm: LlmClient,
  log: (msg: string) => void,
): Promise<EvaluationResult> {
  const evaluations: AdrEvalResult[] = [];
  let anyRelevant = false;

  for (const adr of adrs) {
    // Pre-filter by scope
    if (adr.scope.length > 0 && !scopeMatchesFiles(adr.scope, changedFiles)) {
      evaluations.push({
        adrId: adr.id,
        adrTitle: adr.title,
        adrHash: adr.contentHash,
        result: "skipped",
        enforcement: adr.enforcement,
        reason: "Scope does not match changed files",
      });
      continue;
    }

    log(`Evaluating ${adr.id}: ${adr.title}...`);

    const adrText = `# ${adr.title}\n\n## Context\n${adr.context}\n\n## Decision\n${adr.decision}\n\n## Consequences\n${adr.consequences}`;

    const result = await llm.evaluateAdr(adrText, diff);

    evaluations.push({
      adrId: adr.id,
      adrTitle: adr.title,
      adrHash: adr.contentHash,
      result: result.result,
      enforcement: adr.enforcement,
      reason: result.reason,
    });

    if (result.result === "pass" || result.result === "violation") {
      anyRelevant = true;
    }
  }

  // Case C: if no ADR was relevant (all unrelated or skipped), detect new pattern
  const signals: CaseCSignal[] = [];
  if (!anyRelevant && adrs.length > 0 && changedFiles.length > 0) {
    log("No ADR covers these changes. Detecting new patterns...");
    const existingTitles = adrs.map(a => a.title);
    const signal = await llm.detectNewDecision(diff, changedFiles, existingTitles);
    if (signal) {
      signals.push(signal);
    }
  }

  return { evaluations, signals };
}
