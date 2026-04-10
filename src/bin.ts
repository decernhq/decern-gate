#!/usr/bin/env node

import { run } from "./main.js";

const subcommand = process.argv[2];

async function main(): Promise<number> {
  if (subcommand === "verify-evidence") {
    const bundlePath = process.argv[3];
    if (!bundlePath) {
      console.error("Usage: decern-gate verify-evidence <bundle-path>");
      return 1;
    }
    const { runVerifyEvidence } = await import("./verify-evidence.js");
    return runVerifyEvidence(bundlePath);
  }

  // Default: run the gate
  return run();
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("decern-gate: unexpected error");
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
