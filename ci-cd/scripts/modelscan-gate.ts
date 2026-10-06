// ModelScan gate with built-in controls. A scanner that exits 0 on everything
// is indistinguishable from a working one, so this proves the gate can fire:
//   - negative control: a pickle whose REDUCE calls os.system MUST be flagged
//   - positive control: a pickle holding just the integer 1 MUST pass
// Only then does it scan any paths passed on the command line.
//
//   bun ci-cd/scripts/modelscan-gate.ts [path ...]
//
// modelscan exit codes: 0 = clean, 1 = issues found, 2+ = error. Anything other
// than the expected code for a control is a hard failure, never a fallback.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scan(path: string): { code: number; out: string } {
  const p = Bun.spawnSync(["modelscan", "-p", path]);
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const dir = mkdtempSync(join(tmpdir(), "modelscan-gate-"));
const bad = join(dir, "malicious.pkl");
const good = join(dir, "benign.pkl");
// Protocol-0 pickles written by hand: no Python authored or executed here.
writeFileSync(bad, "cos\nsystem\n(S'echo pwned'\ntR.");
writeFileSync(good, "I1\n.");

const badRes = scan(bad);
if (badRes.code !== 1) {
  throw new Error(`negative control FAILED: modelscan exit ${badRes.code} on a malicious pickle (expected 1)\n${badRes.out}`);
}
console.log("control OK: malicious pickle flagged (exit 1)");

const goodRes = scan(good);
if (goodRes.code !== 0) {
  throw new Error(`positive control FAILED: modelscan exit ${goodRes.code} on a benign pickle (expected 0)\n${goodRes.out}`);
}
console.log("control OK: benign pickle passes (exit 0)");

let failed = false;
for (const path of process.argv.slice(2)) {
  const r = scan(path);
  console.log(`scan ${path}: exit ${r.code}`);
  if (r.code !== 0) { console.error(r.out); failed = true; }
}
if (failed) process.exit(1);
console.log("modelscan gate OK");
