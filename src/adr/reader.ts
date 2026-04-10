/**
 * Reads ADR files from the local filesystem (repo checkout).
 * Only returns ADRs with status: approved (skips proposed, superseded, rejected).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";

export interface LocalAdr {
  id: string;
  title: string;
  status: string;
  enforcement: "blocking" | "warning";
  scope: string[];
  supersedes: string | null;
  context: string;
  decision: string;
  consequences: string;
  contentHash: string;
  rawContent: string;
  filePath: string;
}

// Inline frontmatter parser (same logic as protocol, but gate is zero-dep)
function parseFrontmatter(content: string): { fm: Record<string, unknown>; body: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) return null;
  const end = trimmed.indexOf("---", 3);
  if (end === -1) return null;
  const yaml = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trim();
  const fm: Record<string, unknown> = {};
  let key = "";
  let arr: string[] | null = null;
  for (const line of yaml.split("\n")) {
    const ai = line.match(/^\s+-\s+(.+)$/);
    if (ai && key && arr) { arr.push(ai[1].trim()); continue; }
    if (arr && key) { fm[key] = arr; arr = null; }
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1]; const v = kv[2].trim();
      if (v === "" || v === "null") { arr = []; continue; }
      if (v.startsWith("[") && v.endsWith("]")) { fm[key] = v.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean); key = ""; continue; }
      fm[key] = v.replace(/^["']|["']$/g, ""); key = ""; continue;
    }
  }
  if (arr && key) fm[key] = arr.length > 0 ? arr : null;
  return { fm, body };
}

function parseSection(body: string, name: string): string {
  const re = new RegExp(`^##\\s+${name}\\s*$`, "im");
  const match = body.split("\n").findIndex(l => re.test(l));
  if (match === -1) return "";
  const lines: string[] = [];
  for (let i = match + 1; i < body.split("\n").length; i++) {
    const l = body.split("\n")[i];
    if (/^##\s+/.test(l)) break;
    lines.push(l);
  }
  return lines.join("\n").trim();
}

/**
 * Read all approved ADR files from the given directory.
 */
export function readAdrs(adrDir: string): LocalAdr[] {
  if (!existsSync(adrDir)) return [];
  const files = readdirSync(adrDir).filter(f => extname(f) === ".md");
  const adrs: LocalAdr[] = [];

  for (const file of files) {
    const filePath = join(adrDir, file);
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) continue;

    const { fm, body } = parsed;
    const id = typeof fm.id === "string" ? fm.id : null;
    const title = typeof fm.title === "string" ? fm.title : null;
    if (!id || !title) continue;

    const status = typeof fm.status === "string" ? fm.status.toLowerCase() : "proposed";
    if (status !== "approved") continue; // Only enforce approved ADRs

    const enforcement = fm.enforcement === "blocking" ? "blocking" as const : "warning" as const;
    const scope = Array.isArray(fm.scope) ? fm.scope.map(String) : [];
    const supersedes = typeof fm.supersedes === "string" && fm.supersedes !== "null" ? fm.supersedes : null;

    const contentHash = createHash("sha256").update(content, "utf-8").digest("hex");

    adrs.push({
      id, title, status, enforcement, scope, supersedes,
      context: parseSection(body, "Context"),
      decision: parseSection(body, "Decision"),
      consequences: parseSection(body, "Consequences"),
      contentHash, rawContent: content, filePath,
    });
  }

  return adrs;
}
