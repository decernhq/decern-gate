/**
 * decern adr sync — push local ADR index to the Decern cloud.
 *
 * Reads every ADR in docs/adr/, sends id/title/status/enforcement/scope/contentHash
 * plus the detected repository_identifier to POST /api/adr/sync. The cloud upserts
 * them into adr_cache, keyed by (workspace_id, repository_identifier, id), so the
 * dashboard can show ADRs grouped per repo.
 *
 * Cloud-only (the evidence chain runs through /api/gate/report, this is just the index).
 */

import { resolve } from "node:path";
import { readAdrs } from "../adr/reader.js";
import { detectRepositoryIdentifier } from "../git-info.js";

function log(msg: string) { console.log(msg); }

function argFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : undefined;
}

export async function runAdrSync(): Promise<number> {
  log("decern adr sync — push ADR index to cloud");
  log("");

  const cloudUrl = process.env.DECERN_BASE_URL?.trim();
  const ciToken = process.env.DECERN_CI_TOKEN?.trim();
  const adrDir = resolve(process.env.DECERN_ADR_DIR?.trim() || "docs/adr");

  if (!cloudUrl || !ciToken) {
    log("Error: DECERN_BASE_URL and DECERN_CI_TOKEN are required.");
    return 1;
  }

  // Detect or accept --repo override
  const repoOverride = argFlag("repo");
  const repositoryIdentifier = repoOverride ?? detectRepositoryIdentifier();
  if (!repositoryIdentifier) {
    log("Error: could not detect git remote. Pass --repo <host/owner/repo> or run inside a git checkout with an origin remote.");
    return 1;
  }

  log(`Repository: ${repositoryIdentifier}`);

  const adrs = readAdrs(adrDir);
  log(`ADRs: found ${adrs.length} approved in ${adrDir}`);

  const payload = {
    repositoryIdentifier,
    adrs: adrs.map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      enforcement: a.enforcement,
      scope: a.scope,
      contentHash: a.contentHash,
    })),
  };

  const url = `${cloudUrl.replace(/\/+$/, "")}/api/adr/sync`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ciToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`Error: sync failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return 1;
    }
    const data = (await res.json().catch(() => ({}))) as { synced?: number; deleted?: number };
    log(`Synced: ${data.synced ?? 0} upserted, ${data.deleted ?? 0} removed.`);
    return 0;
  } catch (e) {
    log(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
