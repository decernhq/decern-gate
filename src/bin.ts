#!/usr/bin/env node

const subcommand = process.argv[2];

async function main(): Promise<number> {
  if (subcommand === "init") {
    const { runInit } = await import("./commands/init.js");
    return runInit();
  }

  if (subcommand === "adr" && process.argv[3] === "sync") {
    const { runAdrSync } = await import("./commands/adr-sync.js");
    return runAdrSync();
  }

  if (subcommand === "verify-evidence") {
    const bundlePath = process.argv[3];
    if (!bundlePath) {
      console.error("Usage: decern verify-evidence <bundle-path>");
      return 1;
    }
    const { runVerifyEvidence } = await import("./verify-evidence.js");
    return runVerifyEvidence(bundlePath);
  }

  // Default (no subcommand or "gate"): run the gate
  if (!subcommand || subcommand === "gate") {
    const { runGate } = await import("./commands/gate.js");
    return runGate();
  }

  console.error(`Unknown command: ${subcommand}`);
  console.error("Usage: decern [gate|init|adr sync|verify-evidence]");
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("decern: unexpected error");
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
