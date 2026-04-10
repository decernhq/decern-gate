/**
 * LLM client for BYO LLM. Supports OpenAI-compatible and Anthropic native APIs.
 */

import type { CaseCSignal } from "../adr/evaluator.js";

export interface LlmEvalResult {
  result: "pass" | "violation" | "unrelated";
  reason: string;
}

export interface LlmClient {
  evaluateAdr(adrText: string, diff: string): Promise<LlmEvalResult>;
  detectNewDecision(diff: string, files: string[], existingTitles: string[]): Promise<CaseCSignal | null>;
}

const ANTHROPIC_HOST = "api.anthropic.com";

function isAnthropic(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname.toLowerCase() === ANTHROPIC_HOST; } catch { return false; }
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
    // Try to extract JSON from markdown code blocks
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
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
- "reason": one sentence explaining the verdict

Only respond with the JSON object, no other text.`;

      const user = `## ADR\n${adrText}\n\n## Diff\n\`\`\`\n${diff.slice(0, 100000)}\n\`\`\``;

      try {
        const raw = await chat(system, user);
        const parsed = parseJson(raw);
        const result = parsed.result as string;
        const reason = (parsed.reason as string) ?? "";
        if (result === "pass" || result === "violation" || result === "unrelated") {
          return { result, reason };
        }
        return { result: "unrelated", reason: reason || "Could not determine relevance" };
      } catch (e) {
        return { result: "unrelated", reason: `LLM error: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async detectNewDecision(diff: string, files: string[], existingTitles: string[]): Promise<CaseCSignal | null> {
      const system = `You analyze a code diff to detect if it introduces a new architectural decision not covered by existing ADRs.

Existing ADR titles:
${existingTitles.map(t => `- ${t}`).join("\n")}

If the diff introduces something architecturally significant not covered by any existing ADR, respond with JSON:
{"detected": true, "description": "...", "suggested_title": "..."}

If the diff is routine and doesn't introduce a new architectural decision, respond:
{"detected": false}

Only respond with the JSON object.`;

      const user = `Files changed: ${files.join(", ")}\n\nDiff:\n\`\`\`\n${diff.slice(0, 80000)}\n\`\`\``;

      try {
        const raw = await chat(system, user);
        const parsed = parseJson(raw);
        if (parsed.detected === true) {
          return {
            description: (parsed.description as string) ?? "New architectural decision detected",
            filesInvolved: files,
            suggestedAdrTitle: (parsed.suggested_title as string) ?? "Untitled decision",
          };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
