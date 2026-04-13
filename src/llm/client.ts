/**
 * LLM client for BYO LLM. Supports OpenAI-compatible and Anthropic native APIs.
 */

import type { CaseCSignal } from "../adr/evaluator.js";

export interface LlmEvalResult {
  result: "pass" | "violation" | "unrelated" | "error";
  confidence: number;
  reason: string;
}

export interface LlmClient {
  evaluateAdr(adrText: string, diff: string): Promise<LlmEvalResult>;
  detectNewDecisions(diff: string, files: string[], existingAdrs: Array<{ title: string; decision: string }>): Promise<CaseCSignal[]>;
}

const ANTHROPIC_HOST = "api.anthropic.com";

/**
 * Models tested and recommended for production use with Decern gate.
 * Smaller models work but produce significantly more false negatives.
 * See https://docs.decern.dev/models
 */
const RECOMMENDED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-sonnet-4-5-20250514",
  "claude-opus-4-5-20250514",
  "gpt-4o",
  "gpt-4o-2024-11-20",
  "gpt-4.1",
  "gpt-5",
  "gemini-2.5-pro",
  "gemini-2.5-pro-preview-05-06",
]);

function isAnthropic(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname.toLowerCase() === ANTHROPIC_HOST; } catch { return false; }
}

export function checkModelRecommendation(model: string): { recommended: boolean } {
  return { recommended: RECOMMENDED_MODELS.has(model) };
}

export function createLlmClient(baseUrl: string, apiKey: string, model: string): LlmClient {
  const useAnthropic = isAnthropic(baseUrl);

  async function chat(system: string, user: string): Promise<string> {
    if (useAnthropic) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
      const data = await res.json() as { content?: { text?: string }[] };
      return data.content?.[0]?.text?.trim() ?? "";
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`LLM API error: ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  function parseJson(raw: string): Record<string, unknown> {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/) || raw.match(/(\[[\s\S]*\])/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1]); } catch { /* fall through */ }
    }
    try { return JSON.parse(raw); } catch { return {}; }
  }

  return {
    async evaluateAdr(adrText: string, diff: string): Promise<LlmEvalResult> {
      const system = `You evaluate if a code diff respects, violates, or is unrelated to an architecture decision (ADR).

Respond with a JSON object:
- "result": "pass" if the diff respects the ADR, "violation" if it violates the ADR, "unrelated" if the ADR is not relevant to this diff
- "confidence": a number between 0 and 1 representing how confident you are in the verdict. Use 0.95 if you are very sure, 0.7-0.8 if it is likely but not certain, 0.5-0.6 if it is ambiguous or borderline. Be honest — a low confidence on a violation is more useful than a fake high confidence.
- "reason": one sentence explaining the verdict

Only respond with the JSON object, no other text.`;

      const user = `## ADR\n${adrText}\n\n## Diff\n\`\`\`\n${diff.slice(0, 100000)}\n\`\`\``;

      try {
        const raw = await chat(system, user);
        const parsed = parseJson(raw);
        const result = parsed.result as string;
        const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
        const reason = (parsed.reason as string) ?? "";
        if (result === "pass" || result === "violation" || result === "unrelated") {
          return { result, confidence, reason };
        }
        return { result: "error", confidence: 0, reason: reason || "LLM returned unparseable result" };
      } catch (e) {
        return { result: "error", confidence: 0, reason: `LLM error: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async detectNewDecisions(
      diff: string,
      files: string[],
      existingAdrs: Array<{ title: string; decision: string }>,
    ): Promise<CaseCSignal[]> {
      const existingBlock = existingAdrs.length > 0
        ? `Existing ADRs (these are already covered — do NOT report them again):\n${existingAdrs.map(a => `- ${a.title}: ${a.decision}`).join("\n")}`
        : "No existing ADRs.";

      const system = `You analyze a code diff to detect NEW architectural decisions that are NOT covered by any existing ADR. This is independent of whether the diff respects or violates existing ADRs — focus only on what is NEW and not formalized.

${existingBlock}

What counts as a new architectural decision:
- Introducing a new external dependency (new library, framework, service)
- Creating a new structural pattern (new layer, new abstraction boundary, new module system)
- Adopting a new technology (first use of gRPC, GraphQL, message queue, containerization, IaC)
- Establishing a new convention not covered by existing ADRs (error handling strategy, API versioning scheme, data access pattern)

What does NOT count (do not report these):
- Bug fixes, refactors, renames, style changes
- Patch version updates of existing dependencies
- Adding tests, documentation, comments
- Routine feature work that follows existing patterns
- Changes that are already covered by the existing ADR titles listed above

Respond with a JSON object:
{"decisions": [{"description": "...", "suggested_title": "...", "files": ["..."]}]}

Return the decisions that are truly architecturally significant — typically 0, rarely 1, never more than 3. An empty array is the correct answer for most routine PRs.

Only respond with the JSON object.`;

      const user = `Files changed: ${files.join(", ")}\n\nDiff:\n\`\`\`\n${diff.slice(0, 80000)}\n\`\`\``;

      try {
        const raw = await chat(system, user);
        const parsed = parseJson(raw);
        const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
        return decisions
          .filter((d: unknown): d is Record<string, unknown> =>
            typeof d === "object" && d !== null && typeof (d as Record<string, unknown>).description === "string"
          )
          .slice(0, 3)
          .map((d) => ({
            description: (d.description as string) ?? "New architectural decision detected",
            filesInvolved: Array.isArray(d.files) ? (d.files as string[]) : files,
            suggestedAdrTitle: (d.suggested_title as string) ?? "Untitled decision",
          }));
      } catch {
        return [];
      }
    },
  };
}
