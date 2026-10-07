import { describe, expect, test } from "bun:test";
import { hasFinding } from "./zizmor-gate";

// Shapes taken from zizmor 1.30.1 plain output for ci-cd/scripts/fixtures/zizmor/template-injection.yml.
const FINDING = [
  "error[template-injection]: code injection via template expansion",
  "  --> ci-cd/scripts/fixtures/zizmor/template-injection.yml:10:24",
  "   = help: audit documentation → https://docs.zizmor.sh/audits/#template-injection",
].join("\n");

// An unrelated finding on the same fixture: the file name and the footer still say template-injection.
const UNRELATED = [
  "warning[dependabot-cooldown]: insufficient cooldown in Dependabot updates",
  "  --> ci-cd/scripts/fixtures/zizmor/template-injection.yml:5:5",
  "   = help: audit documentation → https://docs.zizmor.sh/audits/#dependabot-cooldown",
  " INFO audit: zizmor: completed ci-cd/scripts/fixtures/zizmor/template-injection.yml",
].join("\n");

describe("hasFinding", () => {
  test("a finding header from the audit counts", () => {
    expect(hasFinding(FINDING, "template-injection")).toBe(true);
  });

  test("every severity prefix counts", () => {
    for (const level of ["error", "warning", "info", "note"]) {
      expect(hasFinding(`${level}[template-injection]: x`, "template-injection")).toBe(true);
    }
  });

  test("a finding wrapped in color codes counts", () => {
    expect(hasFinding("\x1b[1m\x1b[91merror[template-injection]\x1b[0m: x", "template-injection")).toBe(true);
    expect(hasFinding("\x1b[1m\x1b[91merror[template-injection]:\x1b[0m x", "template-injection")).toBe(true);
    expect(hasFinding("\x1b[1merror\x1b[0m[template-injection]: x", "template-injection")).toBe(true);
  });

  test("the audit name in a file path, a URL or an INFO line does not count", () => {
    expect(hasFinding(UNRELATED, "template-injection")).toBe(false);
    expect(hasFinding("  --> a/template-injection.yml:1:1", "template-injection")).toBe(false);
    expect(hasFinding(" INFO audit: zizmor: completed template-injection.yml", "template-injection")).toBe(false);
  });

  test("another audit's finding does not count", () => {
    expect(hasFinding("error[unpinned-uses]: x\n   = help: https://docs.zizmor.sh/audits/#unpinned-uses", "template-injection")).toBe(false);
  });

  test("the label must start the line", () => {
    expect(hasFinding("see error[template-injection]: x", "template-injection")).toBe(false);
  });

  test("empty output and a clean run do not count", () => {
    expect(hasFinding("", "template-injection")).toBe(false);
    expect(hasFinding("No findings to report. Good job! (2 suppressed)", "template-injection")).toBe(false);
  });
});
