/**
 * decern init — bootstrap command.
 *
 * Analyzes the codebase and proposes ADR drafts for the tech lead to review.
 * Writes approved ADRs to /docs/adr/ as markdown files.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { createInterface } from "node:readline";
import { createLlmClient } from "../llm/client.js";

function log(msg: string) { console.log(msg); }

export async function runInit(): Promise<number> {
  log("decern init — bootstrap architecture decisions");
  log("");

  const llmBaseUrl = process.env.DECERN_LLM_BASE_URL?.trim();
  const llmApiKey = process.env.DECERN_LLM_API_KEY?.trim();
  const llmModel = process.env.DECERN_LLM_MODEL?.trim();
  const adrDir = resolve(process.env.DECERN_ADR_DIR?.trim() || "docs/adr");

  if (!llmBaseUrl || !llmApiKey || !llmModel) {
    log("Error: DECERN_LLM_BASE_URL, DECERN_LLM_API_KEY, and DECERN_LLM_MODEL are required.");
    return 1;
  }

  // ── Gather codebase context ──
  log("Scanning codebase...");

  const context: string[] = [];

  // Directory tree (top 3 levels, excluding noise)
  try {
    const tree = execSync(
      `find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/coverage/*' | head -200`,
      { encoding: "utf-8", timeout: 10_000 }
    ).trim();
    context.push("## Directory structure (top 3 levels)\n```\n" + tree + "\n```");
  } catch { /* ignore */ }

  // Package manifests
  for (const manifest of ["package.json", "pyproject.toml", "pom.xml", "go.mod", "Cargo.toml", "Gemfile"]) {
    if (existsSync(manifest)) {
      const content = readFileSync(manifest, "utf-8").slice(0, 3000);
      context.push(`## ${manifest}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  // Git log (last 6 months, titles only)
  try {
    const gitLog = execSync('git log --oneline --since="6 months ago" | head -100', { encoding: "utf-8", timeout: 10_000 }).trim();
    context.push("## Recent commits (last 6 months)\n```\n" + gitLog + "\n```");
  } catch { /* ignore */ }

  // README
  if (existsSync("README.md")) {
    context.push("## README.md\n" + readFileSync("README.md", "utf-8").slice(0, 3000));
  }

  // Existing docs/adr
  if (existsSync(adrDir)) {
    const existing = readdirSync(adrDir).filter(f => extname(f) === ".md");
    if (existing.length > 0) {
      context.push(`## Existing ADRs (${existing.length} files)\n` + existing.join("\n"));
    }
  }

  // Sample key files (entry points, configs)
  for (const sample of ["src/index.ts", "src/main.ts", "src/app.ts", "app/layout.tsx", "next.config.mjs", "tsconfig.json"]) {
    if (existsSync(sample)) {
      context.push(`## ${sample}\n\`\`\`\n${readFileSync(sample, "utf-8").slice(0, 2000)}\n\`\`\``);
    }
  }

  log(`Context gathered: ${context.length} sections`);
  log("Analyzing with LLM...");

  // ── Call LLM ──
  const system = `You are an architecture analyst. Given the codebase context below, extract 15-25 implicit architectural decisions the team has clearly made but never written down.

For each decision, produce it in this exact YAML+markdown format:

---
id: ADR-NNN
title: [concise title]
status: proposed
enforcement: warning
scope:
  - [relevant file/directory patterns]
supersedes: null
date: ${new Date().toISOString().slice(0, 10)}
---

## Context
[why this decision exists — 2-3 sentences]

## Decision
[what the team decided — 1-2 sentences]

## Consequences
[impact — 1-2 sentences]

---

Separate each ADR with a line containing only "---ADR---".
Number them sequentially starting from ADR-001.
Focus on real, observable patterns — not hypotheticals.`;

  const userPrompt = context.join("\n\n");

  const llm = createLlmClient(llmBaseUrl, llmApiKey, llmModel);

  let rawResponse: string;
  try {
    // Use a longer chat for init
    const url = llmBaseUrl.replace(/\/+$/, "");
    const isAnthropic = new URL(url).hostname === "api.anthropic.com";

    if (isAnthropic) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": llmApiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: llmModel, max_tokens: 8192, system, messages: [{ role: "user", content: userPrompt }] }),
      });
      const data = await res.json() as { content?: { text?: string }[] };
      rawResponse = data.content?.[0]?.text ?? "";
    } else {
      const res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmApiKey}` },
        body: JSON.stringify({ model: llmModel, max_tokens: 8192, messages: [{ role: "system", content: system }, { role: "user", content: userPrompt }] }),
      });
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      rawResponse = data.choices?.[0]?.message?.content ?? "";
    }
  } catch (e) {
    log(`Error: LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (!rawResponse) {
    log("Error: LLM returned empty response.");
    return 1;
  }

  // ── Parse ADR drafts ──
  const drafts = rawResponse.split("---ADR---").map(s => s.trim()).filter(s => s.startsWith("---"));
  log(`\nProposed ${drafts.length} ADR drafts.\n`);

  if (drafts.length === 0) {
    log("No ADR drafts generated. Try with a different LLM model or more codebase context.");
    return 0;
  }

  // ── Interactive review ──
  mkdirSync(adrDir, { recursive: true });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  let approved = 0;
  let skipped = 0;

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const idMatch = draft.match(/^id:\s*(ADR-\d+)/m);
    const titleMatch = draft.match(/^title:\s*(.+)$/m);
    const id = idMatch?.[1] ?? `ADR-${String(i + 1).padStart(3, "0")}`;
    const title = titleMatch?.[1] ?? "Untitled";

    log(`\n────────────────────────────────────────`);
    log(`[${i + 1}/${drafts.length}] ${id}: ${title}`);
    log(`────────────────────────────────────────`);
    log(draft.slice(0, 500) + (draft.length > 500 ? "\n..." : ""));
    log("");

    const answer = await ask("[A]pprove  [S]kip  [Q]uit > ");
    const choice = answer.trim().toLowerCase();

    if (choice === "a" || choice === "approve") {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const filename = `${id.toLowerCase()}-${slug}.md`;
      const filePath = join(adrDir, filename);
      writeFileSync(filePath, draft + "\n");
      log(`  ✓ Written: ${filePath}`);
      approved++;
    } else if (choice === "q" || choice === "quit") {
      log("Quitting.");
      break;
    } else {
      log("  → Skipped");
      skipped++;
    }
  }

  rl.close();

  log(`\n${approved} ADR(s) approved, ${skipped} skipped.`);
  if (approved > 0) {
    log(`ADRs written to ${adrDir}/`);
    log("Next: review and commit the ADR files, then configure decern gate in your CI.");
  }

  return 0;
}
