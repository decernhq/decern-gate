/**
 * Detects the current git repository identifier from the local checkout.
 *
 * Used by `decern init` and `decern adr sync` (which run on the developer's
 * machine, outside CI) to produce the same `repository_identifier` format that
 * `collectCiMetadata` produces inside CI: "<host>/<owner>/<repo>".
 *
 * Strategy: read `git config --get remote.origin.url` and normalize.
 * Examples:
 *   git@github.com:acme/api.git       → github.com/acme/api
 *   https://github.com/acme/api.git   → github.com/acme/api
 *   https://gitlab.com/acme/api       → gitlab.com/acme/api
 *   ssh://git@bitbucket.org/acme/api  → bitbucket.org/acme/api
 */

import { execSync } from "node:child_process";

export function detectRepositoryIdentifier(): string | null {
  let url: string;
  try {
    url = execSync("git config --get remote.origin.url", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }

  if (!url) return null;
  return normalizeRemoteUrl(url);
}

export function normalizeRemoteUrl(url: string): string | null {
  // SCP-style: git@github.com:owner/repo.git
  const scp = url.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) {
    const host = scp[1];
    const path = scp[2].replace(/\/$/, "");
    return `${host}/${path}`;
  }

  // URL-style: https://... or ssh://... or git://...
  try {
    const parsed = new URL(url);
    const host = parsed.host;
    // Order matters: strip leading slash, then trailing slash, then .git.
    const path = parsed.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "");
    if (!host || !path) return null;
    return `${host}/${path}`;
  } catch {
    return null;
  }
}
