// Mutation check for the capability cap in ce_reference.ts. Each mutant changes one line of a copy of the reference
// and must make the reference exit non-zero with the named property in its error. A mutant whose source line is not
// found exactly once throws, so a refactor cannot silently retire a mutant.
// Run: bun verify/cap_mutants.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "ce_reference.ts");
const base = readFileSync(SRC, "utf8");

type Mutant = { name: string; from: string; to: string; expect: string };
const MUTANTS: Mutant[] = [
  { name: "open reservations ignored", from: "filter((r) => r.levels.includes(lvl) && r.id !== skip)", to: "filter(() => false)", expect: "P12c" },
  { name: "own vector omitted", from: "stepAlt([...(snapshot?.get(lvl) ?? this.state(lvl, now, skip)), ev]", to: "stepAlt([...(snapshot?.get(lvl) ?? this.state(lvl, now, skip))]", expect: "P21" },
  { name: "first budget level only", from: "return [...levels].sort().every((lvl) =>", to: "return [...levels].sort().slice(0, 1).every((lvl) =>", expect: "P12d" },
  { name: "only objectives the prediction names", from: "Object.keys(this.objs(lvl)).sort().every((obj) =>", to: "Object.keys(this.objs(lvl)).sort().filter((n) => this.objs(lvl)[n].recipes.some((rc) => Object.keys(ev.x).some((p) => ev.x[p] > 0 && p in rc))).every((obj) =>", expect: "P20" },
  { name: "open cap removed", from: "levels.every((l) => this.openCount(l) < this.maxOpen) && ", to: "", expect: "P12" },
  { name: "raise always granted", from: "if (this.fits(r.levels, this.pseudo({ ...r, x: up }, now), now, id)) {", to: "if (true) {", expect: "P19" },
  { name: "withhold releases everything", from: "released[p] = Math.min(v, r.x[p] ?? 0);", to: "released[p] = v;", expect: "P19 strict reconcile" },
  { name: "raise checked at the reservation time", from: "if (this.fits(r.levels, this.pseudo({ ...r, x: up }, now), now, id)) {", to: "if (this.fits(r.levels, this.pseudo({ ...r, x: up }, -1e6), now, id)) {", expect: "P19" },
  { name: "delivery stamped at reservation time", from: "const ev: Ev = { id, t: now, sig: r.sig, cls: r.cls, x: { ...delivered } };", to: "const ev: Ev = { id, t: -1e6, sig: r.sig, cls: r.cls, x: { ...delivered } };", expect: "P14" },
  { name: "replay drops reserved vectors", from: "r!.x = { ...e.x }; break;", to: "break;", expect: "P14" },
  { name: "replay drops the last decision", from: "case \"deny\": decisions.push(`deny:${e.id}`); break;", to: "case \"deny\": break;", expect: "P14" },
  { name: "strict reconcile accepts excess", from: "if (mode === \"strict\" && under > 1e-12) throw", to: "if (false) throw", expect: "fail-loud" },
  { name: "medium-cost contradictions ignored", from: "const lowersScore = (e: Edge) => e.polarity === \"contradicts\" && e.origin === \"platform\" && e.forge !== \"low\";", to: "const lowersScore = (e: Edge) => e.polarity === \"contradicts\" && e.origin === \"platform\" && e.forge === \"high\";", expect: "P11c" },
  { name: "prediction-dominant partial label inflated", from: "label[p] = Math.max(prefix[p] ?? 0, predicted[p] ?? 0);", to: "label[p] = Math.max(prefix[p] ?? 0, predicted[p] ?? 0) + (p in prefix && p in predicted && predicted[p] > prefix[p] ? 0.01 : 0);", expect: "P13" },
  { name: "replay loses predictive mode", from: "open.set(e.id, { id: e.id, levels: [...e.levels], sig: e.sig, cls: e.cls, mode: e.mode, domain: e.domain, tenant: e.tenant, key: e.key, reservedAt: e.reservedAt, x: { ...e.x } });", to: "open.set(e.id, { id: e.id, levels: [...e.levels], sig: e.sig, cls: e.cls, mode: \"strict\", domain: e.domain, tenant: e.tenant, key: e.key, reservedAt: e.reservedAt, x: { ...e.x } });", expect: "P21" },
  { name: "replay rejects withholding", from: "case \"withhold\": {", to: "case \"withhold\": { throw new Error(\"withhold unsupported\");", expect: "P14" },
  { name: "alternative maximum inflated", from: "return { c: Math.max(...all.map((r) => r.c)), g: Math.max(...all.map((r) => r.g)) };", to: "return { c: Math.min(1, Math.max(...all.map((r) => r.c)) + (recipes.length > 1 ? 0.01 : 0)), g: Math.max(...all.map((r) => r.g)) };", expect: "P18" },
  { name: "withholding zeroes all primitives", from: "released[p] = Math.min(v, r.x[p] ?? 0);", to: "released[p] = 0;", expect: "P19" },
  { name: "excess checked only on q1", from: "for (const [p, v] of Object.entries(delivered)) under = Math.max(under, v - (r.x[p] ?? 0));", to: "for (const [p, v] of Object.entries(delivered)) if (p === \"q1\") under = Math.max(under, v - (r.x[p] ?? 0));", expect: "P19" },
  { name: "beyond-bound delivery skipped", from: "if (mode === \"strict\" && under > 1e-12) throw new Error(`P19 strict reconcile of ${id} delivers above its reservation; call raiseOrWithhold first`);", to: "if (mode === \"strict\" && under > 1e-12) throw new Error(`P19 strict reconcile of ${id} delivers above its reservation; call raiseOrWithhold first`); if (under > MAX_UNDER_PREDICTION + 1e-12) return { underPrediction: under, beyondBound: true, overCeiling: [] };", expect: "P20" },
  { name: "policy ignored", from: "const mode = effectiveMode(this.policy, domain, tenant, key);", to: "const mode = \"predictive\";", expect: "P21" },
  { name: "breach not recorded", from: "if (mode === \"predictive\" && floor === \"strict\") this.changePolicy", to: "if (false) this.changePolicy", expect: "P21" },
  { name: "mode change applied to open reservations", from: "const mode = r.mode;", to: "const mode = effectiveMode(this.policy, r.domain, r.tenant, r.key);", expect: "P21" },
  { name: "replay ignores policy events", from: "if (e.type === \"policy\") { applyPolicy(policy, e); continue; }", to: "if (e.type === \"policy\") { continue; }", expect: "P21" },
  { name: "lowering allowed", from: "if (before === \"strict\" && e.mode === \"predictive\") throw new Error(\"policy lowering\");", to: "", expect: "P21" },
  { name: "same setting logged again", from: "if (before === e.mode) return false;", to: "", expect: "P21" },
  { name: "breach ignored by resolver", from: "policy.breaches.get(key)?.get(domain));", to: "undefined);", expect: "P21" },
  { name: "strict reservations produce breaches", from: "if (mode === \"predictive\" && floor === \"strict\") this.changePolicy", to: "if (floor === \"strict\") this.changePolicy", expect: "P21" },
  { name: "replay skips mode validation", from: "if ((e.type === \"grant\" || e.type === \"deny\") && e.mode !== resolved) throw new Error(\"replay: mode differs from policy\");", to: "", expect: "fail-loud" },
  { name: "unknown policy scope accepted", from: "default: throw new Error(\"unknown policy scope\");", to: "default: return false;", expect: "fail-loud" },
  { name: "breach domain validation skipped", from: "if (domainFloor(policy, e.domain) !== \"strict\" || e.mode !== \"strict\") throw new Error(\"invalid breach policy\");", to: "", expect: "fail-loud" },
  { name: "policy mode validation skipped", from: "checkNow(e.t); checkMode(e.mode);", to: "checkNow(e.t);", expect: "fail-loud" },
  { name: "policy time validation skipped", from: "checkNow(e.t); checkMode(e.mode);", to: "checkMode(e.mode);", expect: "fail-loud" },
  { name: "negative ledger time accepted", from: "if (now < 0) throw new Error(\"negative ledger time\");", to: "", expect: "fail-loud" },
  { name: "tenant subject validation skipped", from: "case \"tenant\": checkName(e.tenant, \"tenant\");", to: "case \"tenant\":", expect: "fail-loud" },
  { name: "key subject validation skipped", from: "case \"key\": checkName(e.key, \"key\");", to: "case \"key\":", expect: "fail-loud" },
  { name: "floor subject validation skipped", from: "case \"floor\": checkName(e.domain, \"domain\");", to: "case \"floor\":", expect: "fail-loud" },
  { name: "breach subject validation skipped", from: "      checkName(e.key, \"key\");", to: "", expect: "fail-loud" },
  { name: "reservation names validation skipped", from: "checkName(tenant, \"tenant\"); checkName(key, \"key\");", to: "", expect: "fail-loud" },
  { name: "unknown reservation domain defaults", from: "if (floor === undefined) throw new Error(`unknown domain ${domain}`);", to: "if (floor === undefined) return \"predictive\";", expect: "fail-loud" },
  { name: "delivered domain validation skipped", from: "const floor = domainFloor(this.policy, deliveredDomain);", to: "const floor = this.policy.floors.get(deliveredDomain);", expect: "fail-loud" },
  { name: "empty floor configuration accepted", from: "checkKeys(Object.keys(floors));", to: "", expect: "fail-loud" },
  { name: "replay loses policy settings", from: "return { committed, open, decisions, policy };", to: "return { committed, open, decisions, policy: { ...policy, tenants: new Map(), keys: new Map(), breaches: new Map() } };", expect: "P21" },
  { name: "replay loses strict floors", from: "return { committed, open, decisions, policy };", to: "return { committed, open, decisions, policy: { ...policy, floors: new Map([...policy.floors.keys()].map((domain) => [domain, \"predictive\"])) } };", expect: "P21" },
  { name: "predictive raise accepted", from: "if (r.mode !== \"strict\") throw new Error(`raise on ${id}, which is a ${r.mode} reservation`);", to: "", expect: "P21" },
  { name: "breach raises every domain", from: "if (e.scope === \"breach\") policy.breaches.set(e.key, settings);", to: "if (e.scope === \"breach\") { policy.breaches.set(e.key, settings); policy.keys.set(e.key, \"strict\"); }", expect: "P21" },
  { name: "expire ignores releases", from: "      for (const l of r.levels) this.committed.set(l, [...(this.committed.get(l) ?? []), ev]);", to: "      void ev;", expect: "P15" },
  { name: "release after expiry accepted", from: "if (!r) throw new Error(`P15 release on ${id}, which is not open`);", to: "if (!r) return { id, levels: [], sig: \"x\", cls: \"x\", mode: \"predictive\", domain: \"x\", tenant: \"x\", key: \"x\", reservedAt: 0, x: {} };", expect: "P15" },
  { name: "release checked outside the lock", from: "if (this.atomic) return this.serial(() => write(check()));", to: "if (false) return this.serial(() => write(check()));", expect: "P15" },
  { name: "reconcile below released accepted", from: "if (rel) for (const [p, v] of Object.entries(rel.x)) if ((delivered[p] ?? 0) < v - 1e-12) throw new Error(`P15 reconcile of ${id} below its released vector`);", to: "", expect: "P15" },
  { name: "replay drops release events", from: "released.set(e.id, { x: { ...e.x }, t: e.t });", to: "", expect: "P15" },
  { name: "store retried twice", from: "export const STORE_ATTEMPTS = 3;", to: "export const STORE_ATTEMPTS = 2;", expect: "P22" },
  { name: "strict domain served unreserved", from: "if (mode === \"strict\") { this.alerts.push({ t, key, outcome: \"unavailable\" }); return { outcome: \"unavailable\", code: UNAVAILABLE_CODE, attempts }; }", to: "", expect: "P22" },
  { name: "outage limit ignored", from: "if (this.lockedOut.has(slot) || n >= this.outageUnreservedMax) {", to: "if (this.lockedOut.has(slot)) {", expect: "P22" },
  { name: "outage limit shared by every anchor", from: "const slot = key;", to: "const slot = \"all\";", expect: "P22" },
  { name: "unreserved request not held", from: "this.held.push({ id, levels: [...levels], sig, domain, tenant, key, x: null, t: now });", to: "", expect: "P22" },
  { name: "deterministic evidence ignored", from: "const confirmed = i.deterministic && i.trajectory;", to: "const confirmed = i.trajectory;", expect: "P16" },
  { name: "trajectory ignored", from: "const confirmed = i.deterministic && i.trajectory;", to: "const confirmed = i.deterministic;", expect: "P16" },
  { name: "review flag dropped", from: "if (i.c >= T.cQuarantine && linked) return { rung: 2, review: true };", to: "if (i.c >= T.cQuarantine && linked) return { rung: 2, review: false };", expect: "P16" },
  { name: "zero backoff", from: "export const STORE_BACKOFF_H = [100, 400, 1600].map((ms) => ms / 3.6e6);", to: "export const STORE_BACKOFF_H = [0, 0, 0].map((ms) => ms / 3.6e6);", expect: "P22" },
  { name: "cumulative release replaced by the last release", from: "for (const [p, v] of Object.entries(xs)) cum[p] = Math.max(cum[p] ?? 0, v);", to: "for (const [p, v] of Object.entries(xs)) cum[p] = v;", expect: "P15" },
  { name: "live expiry stamped at the expiry time", from: "const ev: Ev = { id, t: rel.t, sig: r.sig, cls: r.cls, x: { ...rel.x } };", to: "const ev: Ev = { id, t: now, sig: r.sig, cls: r.cls, x: { ...rel.x } };", expect: "P15" },
  { name: "replay expiry stamped at the expiry time", from: "if (e.type === \"expire\" && rel) commit(e, rel.x, rel.t);", to: "if (e.type === \"expire\" && rel) commit(e, rel.x, e.t);", expect: "P15" },
  { name: "duplicate held id admitted", from: "if (this.ledger.isOpen(id) || this.held.some((h) => h.id === id)) throw", to: "if (this.ledger.isOpen(id)) throw", expect: "P22" },
  { name: "flush clears only after full success", from: "      this.held.shift();", to: "", expect: "P22" },
  { name: "release reads the caller vector late", from: "const xs = ownVector(x, `released vector of ${id}`);", to: "checkVector(x, `released vector of ${id}`); const xs = x;", expect: "P15" },
  { name: "replay accepts closure before the last release", from: "if (rel && e.t < rel.t) throw new Error(`replay: ${e.type} of ${e.id} predates its last release`);", to: "", expect: "P15" },
  { name: "unreserved request raises no alert", from: "    this.alerts.push({ t, key, outcome: \"unreserved\" });", to: "", expect: "P22" },
];

const dir = mkdtempSync(join(tmpdir(), "cap-mutants-"));
let killed = 0;
try {
  for (const m of MUTANTS) {
    if (m.from.includes("\n") || m.to.includes("\n")) throw new Error(`mutant "${m.name}" must replace one line`);
    const n = base.split(m.from).length - 1;
    if (n !== 1) throw new Error(`mutant "${m.name}": source line found ${n} times`);
    const f = join(dir, "ce_reference.ts");
    writeFileSync(f, base.replace(m.from, m.to));
    const r = spawnSync("bun", [f], { encoding: "utf8", timeout: 120_000 });
    // A mutant that hangs is reported as a timeout and counts as survived: a hang names no property.
    const err = r.error ? `timeout or spawn failure: ${r.error.message}` : (r.stderr + r.stdout).split("\n").find((l) => l.startsWith("error: ")) ?? "";
    const ok = r.status !== 0 && err.includes(m.expect);
    console.log(`${ok ? "killed " : "SURVIVED"} ${m.name}: ${err || `exit ${r.status}`}`);
    if (ok) killed++;
  }
} finally {
  rmSync(dir, { recursive: true });
}
console.log(`mutants killed: ${killed} of ${MUTANTS.length}`);
if (killed !== MUTANTS.length) process.exit(1);
