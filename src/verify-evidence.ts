/**
 * decern-gate verify-evidence <bundle-path>
 *
 * Verifies an evidence export bundle offline:
 * 1. Parses the bundle JSON (from the export API response)
 * 2. Recomputes all hashes along the chain
 * 3. Verifies each signature against bundled public keys
 * 4. Exits 0 if valid, 1 with error details if not
 *
 * Self-contained: uses inline hash/verify logic to avoid protocol dependency
 * (gate CLI is zero-dependency by design).
 */

import { readFileSync } from "node:fs";
import { createHash, verify } from "node:crypto";

// ── Inline RFC 8785 canonicalize (minimal subset) ──────────────────

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .map((k) => {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) return null;
        return JSON.stringify(k) + ":" + canonicalize(v);
      })
      .filter((p): p is string => p !== null);
    return "{" + pairs.join(",") + "}";
  }
  throw new Error(`Unsupported type: ${typeof value}`);
}

// ── Inline hash + verify ───────────────────────────────────────────

interface EvidenceRecord {
  evidence_id: string;
  previous_evidence_hash: string | null;
  current_evidence_hash: string;
  signature: { algorithm: string; key_id: string; value: string };
  [key: string]: unknown;
}

const EXCLUDED_FROM_HASH = new Set(["current_evidence_hash", "signature"]);

function computeHash(record: Record<string, unknown>, previousHash: string | null): string {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!EXCLUDED_FROM_HASH.has(k)) fields[k] = v;
  }
  const input = canonicalize(fields) + (previousHash ?? "");
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function verifySignature(hashHex: string, sigBase64: string, pubKeyRaw: Uint8Array): boolean {
  const hashBytes = Buffer.from(hashHex, "hex");
  const sigBytes = Buffer.from(sigBase64, "base64");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const spkiDer = Buffer.concat([spkiPrefix, pubKeyRaw]);
  try {
    return verify(null, hashBytes, { key: spkiDer, format: "der", type: "spki" }, sigBytes);
  } catch {
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────────

export async function runVerifyEvidence(bundlePath: string): Promise<number> {
  console.log(`decern-gate verify-evidence — ${bundlePath}`);
  console.log("");

  let bundleRaw: string;
  try {
    bundleRaw = readFileSync(bundlePath, "utf-8");
  } catch {
    console.error(`Error: cannot read file: ${bundlePath}`);
    return 1;
  }

  let bundle: {
    manifest?: { workspace_id?: string; record_count?: number };
    records?: EvidenceRecord[];
    public_keys?: Record<string, string>;
  };
  try {
    bundle = JSON.parse(bundleRaw);
  } catch {
    console.error("Error: invalid JSON.");
    return 1;
  }

  const records = bundle.records ?? [];
  const publicKeys = bundle.public_keys ?? {};

  console.log(`Workspace: ${bundle.manifest?.workspace_id ?? "unknown"}`);
  console.log(`Records: ${records.length}`);
  console.log(`Public keys: ${Object.keys(publicKeys).length}`);
  console.log("");

  if (records.length === 0) {
    console.log("No records to verify.");
    return 0;
  }

  // Step 1: Verify hash chain
  console.log("Verifying hash chain...");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    // First record must have null previous hash
    if (i === 0 && record.previous_evidence_hash !== null) {
      console.error(`CHAIN BROKEN at ${record.evidence_id} (index 0): first record must have null previous_evidence_hash`);
      return 1;
    }

    // Chain link check
    if (i > 0) {
      const prev = records[i - 1];
      if (record.previous_evidence_hash !== prev.current_evidence_hash) {
        console.error(`CHAIN BROKEN at ${record.evidence_id} (index ${i}): previous_evidence_hash mismatch`);
        console.error(`  Expected: ${prev.current_evidence_hash}`);
        console.error(`  Actual:   ${record.previous_evidence_hash}`);
        return 1;
      }
    }

    // Hash recomputation
    const recomputed = computeHash(record as unknown as Record<string, unknown>, record.previous_evidence_hash);
    if (recomputed !== record.current_evidence_hash) {
      console.error(`HASH MISMATCH at ${record.evidence_id} (index ${i}): record may have been tampered with`);
      console.error(`  Expected: ${recomputed}`);
      console.error(`  Actual:   ${record.current_evidence_hash}`);
      return 1;
    }
  }
  console.log(`Hash chain: OK (${records.length} records)`);

  // Step 2: Verify signatures
  console.log("Verifying signatures...");
  let sigErrors = 0;
  for (const record of records) {
    const keyId = record.signature.key_id;
    const pubKeyBase64 = publicKeys[keyId];
    if (!pubKeyBase64) {
      console.error(`SIGNATURE ERROR: record ${record.evidence_id} — public key ${keyId} not found in bundle.`);
      sigErrors++;
      continue;
    }
    const pubKey = new Uint8Array(Buffer.from(pubKeyBase64, "base64"));
    if (!verifySignature(record.current_evidence_hash, record.signature.value, pubKey)) {
      console.error(`SIGNATURE INVALID: record ${record.evidence_id}`);
      sigErrors++;
    }
  }

  if (sigErrors > 0) {
    console.error(`\nSignatures: ${sigErrors} error(s) found.`);
    return 1;
  }
  console.log(`Signatures: OK (${records.length} verified)`);

  console.log("");
  console.log("Verification: PASSED");
  return 0;
}
