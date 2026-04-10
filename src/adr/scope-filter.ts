/**
 * Scope pre-filter: checks if changed files match ADR scope patterns.
 * Gate-local implementation (no protocol dependency).
 */

export function scopeMatchesFiles(scope: string[], changedFiles: string[]): boolean {
  if (scope.length === 0) return true;
  return changedFiles.some(file => scope.some(pattern => globMatch(pattern, file)));
}

function globMatch(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = filePath.replace(/\\/g, "/");

  let regex = "^";
  let i = 0;
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") { regex += "(?:.*/)?"; i += 3; }
      else { regex += ".*"; i += 2; }
    } else if (p[i] === "*") { regex += "[^/]*"; i++; }
    else if (p[i] === "?") { regex += "[^/]"; i++; }
    else if (".+^${}()|[]\\".includes(p[i])) { regex += "\\" + p[i]; i++; }
    else { regex += p[i]; i++; }
  }
  if (!regex.endsWith(".*")) regex += "$";

  try { return new RegExp(regex).test(f); } catch { return false; }
}
