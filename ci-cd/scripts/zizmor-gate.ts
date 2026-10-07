// zizmor over this repository's workflows and Dependabot config, with controls.
// zizmor must be on PATH (pip install zizmor==<version>).
//
// zizmor exit codes: 0 = no findings, 11 to 14 = findings by severity, 1 = error, 3 = no inputs.
// The gate first proves the template-injection audit fires and that a clean file passes:
//   - negative control: fixtures/zizmor/template-injection.yml must exit with a findings code
//     (11 to 14) and report a finding from the template-injection audit (the `[template-injection]`
//     label of a finding, not the fixture's file name, which zizmor also prints);
//   - positive control: fixtures/zizmor/clean.yml must exit 0.
// Only then does it scan the repository (workflows and .github/dependabot.yml) and fail on any
// finding. In CI it also requires GH_TOKEN: without it zizmor runs offline and skips the audits
// that query the GitHub API (impostor commits, known-vulnerable actions, ref confusion).
//
//   bun ci-cd/scripts/zizmor-gate.ts
//   bun test ci-cd/scripts/zizmor-gate.test.ts

import { resolve } from "node:path";

const ANSI = /\x1b\[[0-9;]*m/g;

/** True when zizmor's plain output has a finding from `audit`: a line that starts with the
 * severity and the audit label, such as `error[template-injection]: ...`. The audit name also
 * appears in file paths and in the documentation URL, which do not count. */
export function hasFinding(out: string, audit: string): boolean {
  const label = new RegExp(`^(?:error|warning|info|note)\\[${audit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:`, "m");
  return label.test(out.replace(ANSI, ""));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const fixtures = resolve(import.meta.dir, "fixtures/zizmor");
  const FLAGS = ["--persona=regular", "--format=plain"];

  if (process.env.CI && !process.env.GH_TOKEN) {
    throw new Error("GH_TOKEN is empty in CI; zizmor would run offline and skip the audits that query the GitHub API");
  }

  const zizmor = (path: string): { code: number; out: string } => {
    const p = Bun.spawnSync(["zizmor", ...FLAGS, path], { cwd: root });
    return { code: p.exitCode ?? -1, out: `${p.stdout}${p.stderr}` };
  };

  const bad = zizmor(resolve(fixtures, "template-injection.yml"));
  if (bad.code < 11 || bad.code > 14 || !hasFinding(bad.out, "template-injection")) {
    throw new Error(`negative control FAILED: zizmor exit ${bad.code} on a workflow with template injection (expected 11 to 14 and a template-injection finding)\n${bad.out}`);
  }
  console.log(`negative control: flagged (exit ${bad.code})`);

  const good = zizmor(resolve(fixtures, "clean.yml"));
  if (good.code !== 0) {
    throw new Error(`positive control FAILED: zizmor exit ${good.code} on a clean workflow (expected 0)\n${good.out}`);
  }
  console.log("positive control: clean (exit 0)");

  const repo = zizmor(".");
  console.log(repo.out);
  if (repo.code !== 0) {
    console.error(`zizmor reported findings in the repository (exit ${repo.code})`);
    process.exit(1);
  }
  console.log("zizmor: no findings in the repository");
}
