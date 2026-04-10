/**
 * Reports gate results to the Decern cloud.
 * The cloud uses these to: write evidence records, comment on PRs.
 */

import type { AdrEvalResult, CaseCSignal } from "../adr/evaluator.js";
import type { CiMetadata } from "../ci-metadata.js";

export interface GateReport {
  verdictCase: "A" | "B" | "C";
  exitCode: 0 | 1;
  evaluations: AdrEvalResult[];
  signals: CaseCSignal[];
  diffHash: string;
  diffSizeBytes: number;
  changedFiles: string[];
  ciMetadata: CiMetadata;
  prTitle?: string;
  prUrl?: string;
  baseSha: string;
  headSha: string;
}

export async function reportToCloud(
  cloudUrl: string,
  ciToken: string,
  report: GateReport,
): Promise<void> {
  const url = `${cloudUrl.replace(/\/+$/, "")}/api/gate/report`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ciToken}`,
    },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloud report failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}
