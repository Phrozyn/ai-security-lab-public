// Tests for check-technique-ids.ts. The MITRE data here is a small synthetic bundle, so the
// tests need no network; the pinned data is checked by the CLI run in CI.

import { describe, expect, test } from "bun:test";
import {
  type AtlasData,
  type AttackData,
  type RuleRef,
  checkRule,
  loadRules,
  parseAtlas,
  parseAttack,
  requirePinned,
  ruleDocs,
  sha256Hex,
} from "./check-technique-ids";

const pattern = (id: string, name: string, tactics: string[], extra: Record<string, unknown> = {}) => ({
  type: "attack-pattern",
  id: `attack-pattern--${id}`,
  name,
  external_references: [{ source_name: "mitre-attack", external_id: id }],
  kill_chain_phases: tactics.map((t) => ({ kill_chain_name: "mitre-attack", phase_name: t })),
  ...extra,
});
const tactic = (shortname: string, extra: Record<string, unknown> = {}) => ({ type: "x-mitre-tactic", id: `x-mitre-tactic--${shortname}`, x_mitre_shortname: shortname, ...extra });

const BUNDLE = JSON.stringify({
  objects: [
    tactic("credential-access"),
    tactic("persistence"),
    tactic("privilege-escalation"),
    tactic("defense-evasion", { x_mitre_deprecated: true }),
    pattern("T1110", "Brute Force", ["credential-access"]),
    pattern("T1098.001", "Additional Cloud Credentials", ["persistence", "privilege-escalation"]),
    pattern("T1027", "Obfuscated Files or Information", ["defense-evasion"], { revoked: true }),
  ],
});
const ATLAS_YAML = `techniques:
  AML.T0054:
    id: AML.T0054
    name: LLM Jailbreak
  AML.T0051.000:
    id: AML.T0051.000
    name: Direct
`;

const attack: AttackData = parseAttack(BUNDLE);
const atlas: AtlasData = parseAtlas(ATLAS_YAML);
const rule = (doc: Record<string, unknown>, needsTechnique = true): RuleRef => ({ source: "test.yml", title: "t", doc, needsTechnique });

describe("data parsing", () => {
  test("revoked and deprecated objects are dropped; IDs are lowercase keys", () => {
    expect([...attack.techniques.keys()].sort()).toEqual(["t1098.001", "t1110"]);
    expect(attack.tactics.has("defense-evasion")).toBe(false);
    expect(attack.techniques.get("t1098.001")!.tactics).toEqual(["persistence", "privilege-escalation"]);
    expect([...atlas.keys()]).toEqual(["AML.T0054", "AML.T0051.000"]);
  });

  test("a bundle with no objects, or no active technique, throws", () => {
    expect(() => parseAttack("{}")).toThrow("no objects list");
    expect(() => parseAttack(JSON.stringify({ objects: [tactic("persistence")] }))).toThrow("no active techniques");
    expect(() => parseAttack(JSON.stringify({ objects: [tactic("persistence"), pattern("T1", "x", [])] }))).toThrow("T1 has no tactic");
  });

  test("ATLAS data without a techniques map, or a technique without a name, throws", () => {
    expect(() => parseAtlas("techniques: []\n")).toThrow("no techniques map");
    expect(() => parseAtlas("techniques:\n  a:\n    id: AML.T0001\n")).toThrow("without id or name");
    expect(() => parseAtlas("techniques: {}\n")).toThrow("no techniques");
  });
});

describe("pinning", () => {
  test("bytes with the pinned SHA-256 pass; one changed byte fails", () => {
    const bytes = new TextEncoder().encode("pinned data");
    const pin = sha256Hex(bytes);
    expect(() => requirePinned(bytes, pin, "x")).not.toThrow();
    const changed = new TextEncoder().encode("pinned dataX");
    expect(() => requirePinned(changed, pin, "x")).toThrow(`is not the pinned ${pin}`);
  });
});

describe("rule checks", () => {
  test("a technique with a matching tactic and valid ATLAS IDs passes", () => {
    expect(checkRule(rule({ tags: ["attack.credential-access", "attack.t1110"], "x-atlas": ["AML.T0054"] }), attack, atlas)).toEqual([]);
    expect(checkRule(rule({ tags: ["attack.privilege-escalation", "attack.t1098.001"], "x-atlas": [] }), attack, atlas)).toEqual([]);
    expect(checkRule(rule({ "x-atlas": ["AML.T0051.000"] }), attack, atlas)).toEqual([]);
  });

  test("an unknown or revoked technique fails", () => {
    expect(checkRule(rule({ tags: ["attack.credential-access", "attack.t9999"], "x-atlas": [] }), attack, atlas)[0]).toContain("attack.t9999 is not an active technique");
    expect(checkRule(rule({ tags: ["attack.credential-access", "attack.t1027"], "x-atlas": [] }), attack, atlas)[0]).toContain("attack.t1027 is not an active technique");
  });

  test("a technique filed under none of the rule's tactics fails", () => {
    const errs = checkRule(rule({ tags: ["attack.persistence", "attack.t1110"], "x-atlas": [] }), attack, atlas);
    expect(errs).toEqual(["test.yml: t: attack.t1110 (Brute Force) is filed under credential-access; the rule tags none of them"]);
  });

  test("a deprecated or unknown tactic tag fails", () => {
    expect(checkRule(rule({ tags: ["attack.defense-evasion"], "x-atlas": ["AML.T0054"] }), attack, atlas)[0]).toContain("attack.defense-evasion is not an ATT&CK tactic");
  });

  test("a malformed, unknown or repeated ATLAS ID fails", () => {
    expect(checkRule(rule({ "x-atlas": ["aml.t0054"] }), attack, atlas)[0]).toContain('"aml.t0054" is not an AML.T ID');
    expect(checkRule(rule({ "x-atlas": ["AML.TA0004"] }), attack, atlas)[0]).toContain("is not an AML.T ID");
    expect(checkRule(rule({ "x-atlas": ["AML.T9999"] }), attack, atlas)[0]).toContain("AML.T9999 is not a technique in ATLAS");
    expect(checkRule(rule({ "x-atlas": ["AML.T0054", "AML.T0054"] }), attack, atlas)[0]).toContain("listed twice");
  });

  test("a missing or non-list x-atlas fails", () => {
    expect(checkRule(rule({ tags: ["attack.credential-access", "attack.t1110"] }), attack, atlas)[0]).toContain("no x-atlas key");
    expect(checkRule(rule({ "x-atlas": "AML.T0054" }), attack, atlas)[0]).toContain("x-atlas is not a list of strings");
    expect(checkRule(rule({ tags: "attack.t1110", "x-atlas": [] }), attack, atlas)[0]).toContain("tags is not a list of strings");
  });

  test("a rule in detections/rules/ with no technique fails; a rule in an optional directory may carry none", () => {
    expect(checkRule(rule({ tags: ["attack.credential-access"], "x-atlas": [] }), attack, atlas)[0]).toContain("no technique ID");
    expect(checkRule(rule({ tags: ["attack.credential-access"], "x-atlas": [] }, false), attack, atlas)).toEqual([]);
  });
});

describe("rule files", () => {
  test("multi-document files split; a document that is not a map throws", () => {
    expect(ruleDocs("title: a\n---\ntitle: b\n", "x.yml").map((d) => d.title)).toEqual(["a", "b"]);
    expect(ruleDocs("title: a\n", "x.yml")).toHaveLength(1);
    expect(() => ruleDocs("- a\n", "x.yml")).toThrow("x.yml: a document is not a map");
    expect(() => ruleDocs("title: a\n---\n- b\n", "x.yml")).toThrow("x.yml: a document is not a map");
  });

  test("positive control: the 8 gateway and RAG rules are loaded, each with an x-atlas key", () => {
    const rules = loadRules();
    expect(rules).toHaveLength(8);
    for (const r of rules) {
      expect(r.needsTechnique).toBe(true);
      expect(Object.hasOwn(r.doc, "x-atlas")).toBe(true);
    }
  });
});
