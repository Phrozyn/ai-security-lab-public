// Non-normative executable specification of C(E) from docs/composition-function.md. It is not a pipeline component.
// A passing run shows that the code matches the document, not that the function detects anything.
// Fails loud: any violated invariant or unhandled input throws.
// Run: bun verify/ce_reference.ts

export type Level = "none" | "low" | "medium" | "high";
export const LEVEL_VALUE: Record<Level, number> = { none: 0, low: 1 / 3, medium: 2 / 3, high: 1 };

// A contribution is the unit of capability: one primitive level that one distinct piece of content supplied.
// An appearance is (value, time). A key can appear many times. Propagation through an artifact re-presents the
// original appearance unchanged, so it neither adds a contribution nor refreshes a clock. A direct re-request is a
// new appearance with its own time.
export interface Contribution { key: string; cls: string; p: string; v: number; t: number }
export interface Ev {
  id: string;
  t: number; // hours
  sig: string; // reformulation signature
  cls?: string; // near-duplicate class: a function of the signature; defaults to the signature
  x: Record<string, number>; // primitive level values in [0, 1] produced by this event
  consumes?: Contribution[]; // original appearances of artifacts this event consumed (exact lineage)
  delivered?: boolean; // false for a refused request or a withheld response; default true
}
export interface Recipe { [primitive: string]: number } // required level tau in (0, 1]
export type Aggregator = "noisy-or" | "max" | "class-max-noisy-or";
export interface Opts { halfLifeH: Record<string, number> | null; agg: Aggregator }

function check01(v: number, what: string): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${what} out of [0,1]: ${v}`);
}
function checkTime(t: number, what: string): void {
  if (!Number.isFinite(t)) throw new Error(`${what} is not a finite time: ${t}`);
}

export function produced(e: Ev): Contribution[] {
  checkTime(e.t, `t of ${e.id}`);
  if (e.delivered === false) return []; // a refused or withheld response adds no capability
  return Object.entries(e.x).map(([p, v]) => {
    check01(v, `x[${p}] of ${e.id}`);
    return { key: `${e.sig}|${p}`, cls: `${e.cls ?? e.sig}|${p}`, p, v, t: e.t };
  });
}

// Appearances of each key. The class must be a function of the signature.
export function appearances(events: Ev[]): Map<string, Contribution[]> {
  const m = new Map<string, Contribution[]>();
  const sigClass = new Map<string, string>();
  for (const e of events) {
    if (e.delivered === false) continue;
    for (const c of [...produced(e), ...(e.consumes ?? [])]) {
      check01(c.v, `v of ${c.key}`);
      checkTime(c.t, `t of ${c.key}`);
      const sig = c.key.split("|")[0];
      const base = c.cls.split("|")[0];
      const seen = sigClass.get(sig);
      if (seen !== undefined && seen !== base) throw new Error(`signature ${sig} has two near-duplicate classes: ${seen} and ${base}`);
      sigClass.set(sig, base);
      const list = m.get(c.key) ?? [];
      list.push(c);
      m.set(c.key, list);
    }
  }
  return m;
}

export function held(events: Ev[], p: string, now: number, o: Opts): number {
  checkNow(now);
  const hlMap = o.halfLifeH;
  const zs: { cls: string; z: number }[] = [];
  for (const [, list] of appearances(events)) {
    if (list[0].p !== p) continue;
    // Per key, the best decayed appearance. Adding an appearance can only raise it.
    let best = 0;
    for (const c of list) {
      let decay = 1;
      if (hlMap) {
        const hl = hlMap[p];
        if (!Number.isFinite(hl) || !(hl > 0)) throw new Error(`no positive half-life for ${p}`);
        decay = Math.pow(2, -Math.max(0, now - c.t) / hl);
      }
      best = Math.max(best, c.v * decay);
    }
    zs.push({ cls: list[0].cls, z: best });
  }
  switch (o.agg) {
    case "max": return zs.reduce((m, y) => Math.max(m, y.z), 0);
    case "noisy-or": return 1 - zs.reduce((k, y) => k * (1 - y.z), 1);
    case "class-max-noisy-or": {
      const byCls = new Map<string, number>();
      for (const y of zs) byCls.set(y.cls, Math.max(byCls.get(y.cls) ?? 0, y.z));
      return 1 - [...byCls.values()].reduce((k, z) => k * (1 - z), 1);
    }
    default: throw new Error(`unknown aggregator ${o.agg}`);
  }
}

export function attain(events: Ev[], recipe: Recipe, now: number, o: Opts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [p, tau] of Object.entries(recipe)) {
    if (!(tau > 0 && tau <= 1)) throw new Error(`tau for ${p} must be in (0,1]`);
    out[p] = Math.min(1, held(events, p, now, o) / tau);
  }
  if (Object.keys(out).length === 0) throw new Error("empty recipe");
  return out;
}

export const progress = (a: Record<string, number>): number => Math.min(...Object.values(a));
export const leading = (a: Record<string, number>): number => { const v = Object.values(a); return v.reduce((s, y) => s + y, 0) / v.length; };

export function step(events: Ev[], recipe: Recipe, now: number, o: Opts): { c: number; g: number; a: Record<string, number> } {
  const a = attain(events, recipe, now, o);
  return { c: progress(a), g: leading(a), a };
}

// A recipe may list alternative requirement sets. Progress is the maximum over the alternatives.
// The leading indicator is also the maximum over the alternatives, taken per alternative and independently of c, so
// scrutiny follows the most advanced path even when another alternative holds the highest c.
export function stepAlt(events: Ev[], recipes: Recipe[], now: number, o: Opts): { c: number; g: number } {
  if (recipes.length === 0) throw new Error("no recipe alternatives");
  const all = recipes.map((r) => step(events, r, now, o));
  return { c: Math.max(...all.map((r) => r.c)), g: Math.max(...all.map((r) => r.g)) };
}

// Marginal uplift is defined at one fixed evaluation time for both terms.
export function delta(e: Ev, set: Ev[], recipe: Recipe, now: number, o: Opts): number {
  return step([...set, e], recipe, now, o).c - step(set, recipe, now, o).c;
}

// ---------- linkage evidence score (never changes capability) ----------
export type Family = "content" | "lineage" | "identity" | "network" | "trajectory" | "refusal" | "delivered" | "human";
export type Forge = "low" | "medium" | "high";
// origin: who produced the observation behind an edge. "platform" means the platform observed it (server clocks, the
// key issuer's ownership records) and the actor cannot set it; "actor" means the actor supplied or controls it.
// Required on a contradicting edge, because only platform-origin contradictions may lower the score.
export interface Edge { family: Family; conf: number; forge: Forge; polarity: "supports" | "contradicts"; origin?: "platform" | "actor" }
export const KAPPA: Record<Forge, number> = { low: 0.3, medium: 0.6, high: 1 }; // placeholders to be set from harness data
export const LOW_FORGE_CAP = 0.5; // placeholder: evidence of low forge cost alone cannot exceed this

// Exact artifact hash: the forge cost depends on whether the artifact is public.
export function hashForge(provenance: "public" | "private"): Forge {
  switch (provenance) {
    case "public": return "low";
    case "private": return "high";
    default: throw new Error(`unknown provenance ${provenance}`);
  }
}

export function checkEdge(e: Edge): void {
  switch (e.family) {
    case "content": case "lineage": case "identity": case "network": case "trajectory": case "refusal": case "delivered": case "human": break;
    default: throw new Error(`unknown edge family ${e.family}`);
  }
  check01(e.conf, "edge conf");
  switch (e.forge) {
    case "low": case "medium": case "high": break;
    default: throw new Error(`unknown forge class ${e.forge}`);
  }
  switch (e.polarity) {
    case "supports": case "contradicts": break;
    default: throw new Error(`unknown polarity ${e.polarity}`);
  }
  switch (e.origin) {
    case undefined: case "platform": case "actor": break;
    default: throw new Error(`unknown origin ${e.origin}`);
  }
  if (e.polarity === "contradicts" && e.origin !== "platform" && e.origin !== "actor") throw new Error(`contradicting edge without a known origin: ${e.origin}`);
}

// A contradiction that the actor could produce, or one of low forge cost, never lowers the score of an existing member
// and never blocks a merge: it sends the merge to human review. Blocking would let an actor plant contradictions on its
// own fragments to stay unlinked, and lowering the score would let it erase independent evidence. A contradiction may
// remove trust and never detection. Only a platform-origin contradiction of medium or high forge cost blocks a merge.
export function mergeDisposition(edges: Edge[]): "merge" | "review" | "block" {
  edges.forEach(checkEdge);
  const contra = edges.filter((e) => e.polarity === "contradicts" && e.conf > 0);
  if (contra.some(lowersScore)) return "block";
  return contra.length > 0 ? "review" : "merge";
}

// Support counts each family once, at its best edge: raw = 1 - prod_f (1 - z_f).
// The low-forge cap bounds what cheap evidence can add: capped = 1 - (1 - LOW_FORGE_CAP) * prod_f (1 - s_f), where
// s_f is the family's best medium- or high-cost edge. support = min(raw, capped). With no medium- or high-cost edge,
// support is at most LOW_FORGE_CAP. Both terms only rise when an edge is added, so support is monotone.
// An earlier version kept separate low and strong maps per family, so a family with one low and one strong edge was
// counted twice.
const lowersScore = (e: Edge) => e.polarity === "contradicts" && e.origin === "platform" && e.forge !== "low";
export function linkageEvidence(edges: Edge[]): number {
  edges.forEach(checkEdge);
  const best = new Map<Family, number>();
  const bestStrong = new Map<Family, number>();
  let contra = 0;
  for (const e of edges) {
    const z = e.conf * KAPPA[e.forge];
    if (e.polarity === "contradicts") { if (lowersScore(e)) contra = Math.max(contra, z); continue; }
    best.set(e.family, Math.max(best.get(e.family) ?? 0, z));
    if (e.forge !== "low") bestStrong.set(e.family, Math.max(bestStrong.get(e.family) ?? 0, z));
  }
  const raw = 1 - [...best.values()].reduce((k, z) => k * (1 - z), 1);
  const capped = 1 - (1 - LOW_FORGE_CAP) * [...bestStrong.values()].reduce((k, z) => k * (1 - z), 1);
  return Math.min(raw, capped) * (1 - contra);
}

// Placeholder thresholds, flagged: the working values are set from harness data. The point is the gate, not the numbers.
// deterministic: a canary returned, an exact known-bad artifact match, or a rule hit on evidence of high forge cost.
// trajectory: a corroborating trajectory feature. Both together confirm a case.
export interface RungInput { c: number; g: number; L: number; families: number; deterministic: boolean; trajectory: boolean }
export const PLACEHOLDER = { gScrutiny: 0.5, cFriction: 0.8, cQuarantine: 0.95, Lmin: 0.5, minFamilies: 2 };
// Cluster sets: friction and above need both c and the linkage evidence score. The per-anchor cap uses c alone.
// Quarantine is automatic only for a confirmed case. A quarantine-level case without confirmation stays at friction and
// is queued for a human decision (review: true).
export function clusterRung(i: RungInput): { rung: 0 | 1 | 2 | 3; review: boolean } {
  const T = PLACEHOLDER;
  check01(i.c, "rung c"); check01(i.g, "rung g"); check01(i.L, "rung L");
  if (!Number.isSafeInteger(i.families) || i.families < 0) throw new Error(`invalid family count ${i.families}`);
  if (typeof i.deterministic !== "boolean" || typeof i.trajectory !== "boolean") throw new Error("rung evidence flags must be boolean");
  const linked = i.L >= T.Lmin && i.families >= T.minFamilies;
  const confirmed = i.deterministic && i.trajectory;
  if (i.c >= T.cQuarantine && linked && confirmed) return { rung: 3, review: false };
  if (i.c >= T.cQuarantine && linked) return { rung: 2, review: true };
  if (i.c >= T.cFriction && linked) return { rung: 2, review: false };
  if (i.g >= T.gScrutiny || i.c >= T.cFriction) return { rung: 1, review: false };
  return { rung: 0, review: false };
}

// ---------- reservation ledger (cap) ----------
interface ScalarRes { id: string; keys: string[]; amount: number; reservedAt: number }
export type LedgerEvent = ScalarRes & { t: number } & (
  { type: "grant" | "deny" | "raise" | "withhold" } | { type: "reconcile"; delivered: number }
);
// Cap semantics. The prediction is an estimate and not an upper bound on what the model
// delivers. Two modes:
// - strict (pre-release classification, high-uplift domains): before a response is released, any classified amount
//   above the reservation is reserved with raise(); if the raise is denied the excess is withheld, so delivered totals
//   never exceed a ceiling.
// - predictive (elsewhere): the reservation is the prediction, and delivery may exceed it. The ceiling is soft by at
//   most maxOpen * MAX_UNDER_PREDICTION per budget key while every under-prediction stays within MAX_UNDER_PREDICTION.
//   A delivery beyond that is recorded, never refused (it has happened), and reported as beyondBound.
export const MAX_UNDER_PREDICTION = 0.1; // placeholder: the declared per-event under-prediction bound

// Mode selection. The operator's domain floor sets strict for high-uplift domains.
// A tenant (organisation) or a key may raise its mode to strict and may never lower it below the floor: the effective
// mode is the strictest of the floor and every setting that applies. An unset tenant or key setting inherits.
// A strict-domain breach (a predictive response delivered in a high-uplift domain) raises the anchor to strict for
// that domain; that also only raises.
export type CapMode = "strict" | "predictive";
export function resolveMode(floor: CapMode, ...settings: (CapMode | undefined)[]): CapMode {
  checkMode(floor);
  for (const m of settings) if (m !== undefined) checkMode(m);
  return [floor, ...settings].includes("strict") ? "strict" : "predictive";
}
function checkMode(mode: CapMode): void {
  switch (mode) {
    case "strict": case "predictive": return;
    default: throw new Error(`unknown cap mode ${mode}`);
  }
}
function checkName(value: string, what: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${what}`);
}
function checkKeys(keys: string[]): void {
  if (!Array.isArray(keys) || keys.length === 0 || new Set(keys).size !== keys.length) throw new Error("empty or duplicate keys");
  keys.forEach((k) => checkName(k, "key"));
}
function checkNow(now: number): void {
  checkTime(now, "now");
  if (now < 0) throw new Error("negative ledger time");
}
function checkAfter(now: number, reservedAt: number): void {
  checkNow(now);
  checkTime(reservedAt, "reservation time");
  if (now < reservedAt) throw new Error("transition predates reservation");
}
function checkOpenLimit(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid maxOpen");
}
export class Ledger {
  private reserved = new Map<string, number>();
  private open = new Map<string, ScalarRes>();
  private nextId = 0;
  readonly log: LedgerEvent[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private ceilings: Record<string, number>, private atomic: boolean, readonly maxOpen = Number.MAX_SAFE_INTEGER) {
    checkKeys(Object.keys(ceilings));
    for (const c of Object.values(ceilings)) check01(c, "ceiling");
    checkOpenLimit(maxOpen);
  }
  total(k: string): number { return this.reserved.get(k) ?? 0; }
  openCount(k: string): number { return [...this.open.values()].filter((r) => r.keys.includes(k)).length; }
  private ceil(k: string): number { const c = this.ceilings[k]; if (c === undefined) throw new Error(`no ceiling for ${k}`); return c; }
  private reservation(id: string, now: number): ScalarRes {
    checkName(id, "reservation id");
    const r = this.open.get(id);
    if (!r) throw new Error(`reservation ${id} is not open`);
    checkAfter(now, r.reservedAt);
    return r;
  }
  private serial<T>(fn: () => T): Promise<T> { const p = this.chain.then(fn); this.chain = p.catch(() => undefined); return p; }
  // A grant returns its reservation id; a denial returns false. Raises and reconciliation require that id.
  async reserveAll(keys: string[], amount: number, now: number): Promise<string | false> {
    checkKeys(keys);
    check01(amount, "reservation amount");
    if (amount === 0) throw new Error("reservation amount must be positive");
    checkNow(now);
    keys.forEach((k) => this.ceil(k));
    const savedKeys = [...keys];
    const decide = (seen: Map<string, number>): string | false => {
      const ok = savedKeys.every((k) => this.openCount(k) < this.maxOpen && (seen.get(k) ?? 0) + amount <= this.ceil(k) + 1e-12);
      const r: ScalarRes = { id: `r${++this.nextId}`, keys: savedKeys, amount, reservedAt: now };
      if (ok) {
        for (const k of savedKeys) this.reserved.set(k, this.total(k) + amount);
        this.open.set(r.id, r);
      }
      this.log.push({ ...r, keys: [...savedKeys], type: ok ? "grant" : "deny", t: now });
      return ok ? r.id : false;
    };
    if (this.atomic) return this.serial(() => decide(new Map(this.reserved)));
    const seen = new Map(this.reserved);
    await Promise.resolve();
    return decide(seen);
  }
  async raise(id: string, extra: number, now: number): Promise<boolean> {
    check01(extra, "raise amount");
    if (extra === 0) throw new Error("raise amount must be positive");
    return this.serial(() => {
      const r = this.reservation(id, now);
      check01(r.amount + extra, "raised amount");
      const ok = r.keys.every((k) => this.total(k) + extra <= this.ceil(k) + 1e-12);
      if (ok) {
        for (const k of r.keys) this.reserved.set(k, this.total(k) + extra);
        r.amount += extra;
      }
      this.log.push({ ...r, keys: [...r.keys], type: ok ? "raise" : "withhold", t: now });
      return ok;
    });
  }
  reconcile(id: string, delivered: number, now: number): { overCeiling: boolean; underPrediction: number; beyondBound: boolean } {
    check01(delivered, "delivered amount");
    const r = this.reservation(id, now);
    for (const k of r.keys) this.reserved.set(k, this.total(k) - r.amount + delivered);
    this.open.delete(id);
    this.log.push({ ...r, keys: [...r.keys], type: "reconcile", delivered, t: now });
    const underPrediction = Math.max(0, delivered - r.amount);
    return { overCeiling: r.keys.some((k) => this.total(k) > this.ceil(k) + 1e-12), underPrediction, beyondBound: underPrediction > MAX_UNDER_PREDICTION + 1e-12 };
  }
}
// Replay uses recorded reservation identities and amounts without re-evaluating ceilings.
export function replay(log: LedgerEvent[]): Map<string, number> {
  const t = new Map<string, number>();
  const open = new Map<string, ScalarRes>();
  const granted = new Set<string>();
  for (const e of log) {
    checkName(e.id, "event id");
    checkKeys(e.keys);
    check01(e.amount, "event amount");
    if (e.amount === 0) throw new Error("event amount must be positive");
    checkAfter(e.t, e.reservedAt);
    const r = open.get(e.id);
    if (e.type !== "grant" && e.type !== "deny") {
      if (!r) throw new Error(`replay: ${e.id} is not open`);
      if (JSON.stringify(r.keys) !== JSON.stringify(e.keys) || r.reservedAt !== e.reservedAt) throw new Error("replay: reservation metadata differs");
    }
    switch (e.type) {
      case "grant":
        if (granted.has(e.id)) throw new Error("replay: duplicate grant");
        if (e.t !== e.reservedAt) throw new Error("replay: grant time differs");
        granted.add(e.id);
        open.set(e.id, { ...e, keys: [...e.keys] });
        for (const k of e.keys) t.set(k, (t.get(k) ?? 0) + e.amount);
        break;
      case "deny": break;
      case "raise":
        if (e.amount < r!.amount) throw new Error("replay: raise lowered amount");
        for (const k of r!.keys) t.set(k, t.get(k)! + e.amount - r!.amount);
        r!.amount = e.amount;
        break;
      case "withhold":
        if (e.amount !== r!.amount) throw new Error("replay: withheld amount differs");
        break;
      case "reconcile":
        check01(e.delivered, "event delivery");
        if (e.amount !== r!.amount) throw new Error("replay: reserved amount differs");
        for (const k of r!.keys) t.set(k, t.get(k)! - r!.amount + e.delivered);
        open.delete(e.id);
        break;
      default: throw new Error("replay: unknown event type");
    }
  }
  return t;
}

// Partial response: the unclassified tail is counted at the reserved (predicted) vector, never lower than the prefix.
// A prefix above the prediction means the prediction was not an upper bound; that is reported.
export function partialLabel(prefix: Record<string, number>, predicted: Record<string, number>): { label: Record<string, number>; underPredicted: boolean } {
  checkVector(prefix, "prefix", true);
  checkVector(predicted, "prediction", true);
  const label: Record<string, number> = {};
  let underPredicted = false;
  for (const p of new Set([...Object.keys(prefix), ...Object.keys(predicted)])) {
    label[p] = Math.max(prefix[p] ?? 0, predicted[p] ?? 0);
    if ((prefix[p] ?? 0) > (predicted[p] ?? 0) + 1e-12) underPredicted = true;
  }
  return { label, underPredicted };
}

// ---------- capability cap: vector reservation ----------
// The Ledger above is additive and fits count budgets (requests per anchor). The capability cap is a ceiling on c, which
// is not additive: two requests that each add nothing to c alone can complete an objective together. A scalar
// reservation of predicted marginal uplift therefore reserves 0 for each of two concurrent complementary requests, and
// both pass. The cap reserves the predicted primitive vector instead. Under one lock it builds the prospective state
// (committed delivered events, every open reserved vector, and this vector, composed by the same aggregation, signature
// and class deduplication as the commit path) and grants only when c of that state stays within the ceiling for every
// objective at every budget level the request touches, taken in a fixed (sorted) order. Every objective is checked, not
// only those the prediction names, because a delivery may add up to u on a primitive the prediction did not name; once
// an objective is over its ceiling, no further reservation at that level is granted, which is what bounds the
// predictive overshoot.
// Times: a reserved vector has not been delivered, so it is evaluated at the evaluation time (no decay); a delivery is
// a new appearance at the delivery time.
export interface Objective { recipes: Recipe[]; ceiling: number }
export interface CapPolicy {
  floors: Map<string, CapMode>; tenants: Map<string, CapMode>; keys: Map<string, CapMode>; breaches: Map<string, Map<string, CapMode>>;
}
export type PolicyEvent = { type: "policy"; t: number; mode: CapMode } & (
  { scope: "floor"; domain: string } | { scope: "tenant"; tenant: string } |
  { scope: "key"; key: string } | { scope: "breach"; key: string; domain: string }
);
interface OpenRes { id: string; levels: string[]; sig: string; cls: string; mode: CapMode; domain: string; tenant: string; key: string; reservedAt: number; x: Record<string, number> }
// release: the cumulative released vector of an open reservation. unreserved: a delivery served while the
// reservation store was down, written when the store answers; it opens no reservation.
export type ReservationEvent = OpenRes & { type: "grant" | "deny" | "raise" | "withhold" | "release" | "reconcile" | "expire" | "unreserved"; t: number };
export type CapEvent = PolicyEvent | ReservationEvent;
function emptyPolicy(): CapPolicy { return { floors: new Map(), tenants: new Map(), keys: new Map(), breaches: new Map() }; }
function domainFloor(policy: CapPolicy, domain: string): CapMode {
  checkName(domain, "domain");
  const floor = policy.floors.get(domain);
  if (floor === undefined) throw new Error(`unknown domain ${domain}`);
  checkMode(floor);
  return floor;
}
export function effectiveMode(policy: CapPolicy, domain: string, tenant: string, key: string): CapMode {
  checkName(tenant, "tenant"); checkName(key, "key");
  return resolveMode(domainFloor(policy, domain), policy.tenants.get(tenant), policy.keys.get(key), policy.breaches.get(key)?.get(domain));
}
// Log order defines policy order; timestamps are finite and nonnegative, with no global monotonicity requirement.
// Repeating a setting is a no-op without an event. Settings can only rise within their scope; effective mode takes the maximum.
function applyPolicy(policy: CapPolicy, e: PolicyEvent): boolean {
  checkNow(e.t); checkMode(e.mode);
  let settings: Map<string, CapMode>, subject: string;
  switch (e.scope) {
    case "floor": checkName(e.domain, "domain"); settings = policy.floors; subject = e.domain; break;
    case "tenant": checkName(e.tenant, "tenant"); settings = policy.tenants; subject = e.tenant; break;
    case "key": checkName(e.key, "key"); settings = policy.keys; subject = e.key; break;
    case "breach":
      checkName(e.key, "key");
      if (domainFloor(policy, e.domain) !== "strict" || e.mode !== "strict") throw new Error("invalid breach policy");
      settings = policy.breaches.get(e.key) ?? new Map<string, CapMode>(); subject = e.domain;
      break;
    default: throw new Error("unknown policy scope");
  }
  const before = settings.get(subject);
  if (before === "strict" && e.mode === "predictive") throw new Error("policy lowering");
  if (before === e.mode) return false;
  settings.set(subject, e.mode);
  if (e.scope === "breach") policy.breaches.set(e.key, settings);
  return true;
}

// Copies a caller vector, then validates the copy. Asynchronous entry points use only the copy, so a change the caller
// makes after the call cannot reach the ledger.
function ownVector(x: Record<string, number>, what: string, allowEmpty = false): Record<string, number> {
  if (x === null || typeof x !== "object" || Array.isArray(x)) throw new Error(`${what}: invalid vector`);
  const copy = { ...x };
  checkVector(copy, what, allowEmpty);
  return copy;
}
function checkVector(x: Record<string, number>, what: string, allowEmpty = false): void {
  if (x === null || typeof x !== "object" || Array.isArray(x)) throw new Error(`${what}: invalid vector`);
  if (!allowEmpty && Object.keys(x).length === 0) throw new Error(`${what}: empty vector`);
  for (const [p, v] of Object.entries(x)) check01(v, `${what}[${p}]`);
}

export class CapLedger {
  private policy: CapPolicy = emptyPolicy();
  private committed = new Map<string, Ev[]>();
  private open = new Map<string, OpenRes>();
  // Cumulative released vector and last release time per open reservation.
  private released = new Map<string, { x: Record<string, number>; t: number }>();
  readonly log: CapEvent[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  // objectives per budget level; atomic=false is the read-then-write negative control. maxOpen applies per budget
  // level: at a shared level (organisation, anchor) it bounds the open reservations of every actor that shares it.
  constructor(private objectives: Record<string, Record<string, Objective>>, private o: Opts, floors: Record<string, CapMode>, private atomic = true, readonly maxOpen = Number.MAX_SAFE_INTEGER) {
    checkKeys(Object.keys(floors));
    for (const [domain, mode] of Object.entries(floors)) this.setDomainFloor(domain, mode, 0);
    checkOpenLimit(maxOpen);
    checkKeys(Object.keys(objectives));
    held([], "", 0, o);
    if (o.halfLifeH) for (const hl of Object.values(o.halfLifeH)) if (!Number.isFinite(hl) || hl <= 0) throw new Error("invalid half-life");
    for (const objs of Object.values(objectives)) if (Object.keys(objs).length === 0) throw new Error("level has no objectives");
    for (const [lvl, objs] of Object.entries(objectives)) for (const [name, ob] of Object.entries(objs)) {
      if (ob.recipes.length === 0) throw new Error(`objective ${lvl}/${name} has no recipe`);
      check01(ob.ceiling, `ceiling of ${lvl}/${name}`);
      for (const recipe of ob.recipes) {
        attain([], recipe, 0, o);
        if (o.halfLifeH) for (const p of Object.keys(recipe)) if (!(o.halfLifeH[p] > 0)) throw new Error(`no positive half-life for ${p}`);
      }
    }
  }
  private changePolicy(e: PolicyEvent): void {
    if (applyPolicy(this.policy, e)) this.log.push({ ...e });
  }
  setDomainFloor(domain: string, mode: CapMode, now: number): void { this.changePolicy({ type: "policy", scope: "floor", domain, mode, t: now }); }
  setTenantMode(tenant: string, mode: CapMode, now: number): void { this.changePolicy({ type: "policy", scope: "tenant", tenant, mode, t: now }); }
  setKeyMode(key: string, mode: CapMode, now: number): void { this.changePolicy({ type: "policy", scope: "key", key, mode, t: now }); }
  policyState(): CapPolicy { return { floors: new Map(this.policy.floors), tenants: new Map(this.policy.tenants), keys: new Map(this.policy.keys), breaches: new Map([...this.policy.breaches].map(([k, v]) => [k, new Map(v)])) }; }
  private objs(lvl: string) { const m = this.objectives[lvl]; if (!m) throw new Error(`no objectives for budget level ${lvl}`); return m; }
  openCount(lvl: string) { let n = 0; for (const r of this.open.values()) if (r.levels.includes(lvl)) n++; return n; }
  reservations(): OpenRes[] { return [...this.open.values()].map((r) => ({ ...r, levels: [...r.levels], x: { ...r.x } })); }
  private pseudo(r: { id: string; sig: string; cls: string; x: Record<string, number> }, now: number): Ev { return { id: `res:${r.id}`, t: now, sig: r.sig, cls: r.cls, x: r.x }; }
  private state(lvl: string, now: number, skip?: string): Ev[] {
    const res = [...this.open.values()].filter((r) => r.levels.includes(lvl) && r.id !== skip).map((r) => this.pseudo(r, now));
    return [...(this.committed.get(lvl) ?? []), ...res];
  }
  // c per objective at a level, over committed events only (what was delivered).
  c(lvl: string, obj: string, now: number): number { return stepAlt(this.committed.get(lvl) ?? [], this.objs(lvl)[obj].recipes, now, this.o).c; }
  // c per objective over committed plus open reservations (what is promised).
  cProspective(lvl: string, obj: string, now: number): number { return stepAlt(this.state(lvl, now), this.objs(lvl)[obj].recipes, now, this.o).c; }
  private fits(levels: string[], ev: Ev, now: number, skip?: string, snapshot?: Map<string, Ev[]>): boolean {
    return [...levels].sort().every((lvl) => Object.keys(this.objs(lvl)).sort().every((obj) =>
      stepAlt([...(snapshot?.get(lvl) ?? this.state(lvl, now, skip)), ev], this.objs(lvl)[obj].recipes, now, this.o).c <= this.objs(lvl)[obj].ceiling + 1e-12));
  }
  private serial<T>(fn: () => T): Promise<T> { const p = this.chain.then(fn); this.chain = p.catch(() => undefined); return p; }
  private record(type: ReservationEvent["type"], r: OpenRes, t: number, x: Record<string, number>): void {
    this.log.push({ type, id: r.id, levels: [...r.levels], sig: r.sig, cls: r.cls, mode: r.mode, domain: r.domain, tenant: r.tenant, key: r.key, reservedAt: r.reservedAt, t, x: { ...x } });
  }

  async reserve(id: string, levels: string[], sig: string, x: Record<string, number>, now: number, domain: string, tenant: string, key: string, cls: string = sig): Promise<boolean> {
    x = ownVector(x, `predicted vector of ${id}`);
    if (!Array.isArray(levels)) throw new Error("levels must be an array");
    levels = [...levels];
    checkNow(now);
    effectiveMode(this.policy, domain, tenant, key);
    checkName(id, "reservation id");
    checkName(sig, "signature");
    checkName(cls, "class");
    checkKeys(levels);
    if (this.o.halfLifeH) for (const p of Object.keys(x)) if (!(this.o.halfLifeH[p] > 0)) throw new Error(`no positive half-life for ${p}`);
    for (const l of levels) this.objs(l);
    const decide = (snapshot?: Map<string, Ev[]>): boolean => {
      const mode = effectiveMode(this.policy, domain, tenant, key);
      const r: OpenRes = { id, levels: [...levels], sig, cls, mode, domain, tenant, key, reservedAt: now, x: { ...x } };
      if (this.open.has(id)) throw new Error(`reservation ${id} is already open`);
      const ok = levels.every((l) => this.openCount(l) < this.maxOpen) && this.fits(levels, this.pseudo(r, now), now, undefined, snapshot);
      if (ok) this.open.set(id, r);
      this.record(ok ? "grant" : "deny", r, now, x);
      return ok;
    };
    if (this.atomic) return this.serial(() => decide());
    const snapshot = new Map(levels.map((l) => [l, this.state(l, now)] as const)); // read
    await Promise.resolve(); // yield: other requests read the same state
    return decide(snapshot); // write
  }
  // Strict mode, before release: try to raise the reservation to the elementwise maximum of the prediction and the
  // classified delivery. If that does not fit, the excess is withheld: the released vector is the elementwise minimum.
  // An empty classified delivery releases nothing.
  async raiseOrWithhold(id: string, delivered: Record<string, number>, now: number): Promise<Record<string, number>> {
    delivered = ownVector(delivered, `delivered vector of ${id}`, true);
    checkNow(now);
    return this.serial(() => {
      const r = this.open.get(id);
      if (!r) throw new Error(`raise on ${id}, which is not open`);
      checkAfter(now, r.reservedAt);
      if (r.mode !== "strict") throw new Error(`raise on ${id}, which is a ${r.mode} reservation`);
      const up: Record<string, number> = { ...r.x };
      for (const [p, v] of Object.entries(delivered)) up[p] = Math.max(up[p] ?? 0, v);
      if (this.fits(r.levels, this.pseudo({ ...r, x: up }, now), now, id)) {
        r.x = up;
        this.record("raise", r, now, up);
        return { ...delivered };
      }
      const released: Record<string, number> = {};
      for (const [p, v] of Object.entries(delivered)) released[p] = Math.min(v, r.x[p] ?? 0);
      this.record("withhold", r, now, released);
      return released;
    });
  }
  // Reconciliation commits what was delivered, at the delivery time, and closes the reservation. An aborted stream
  // commits its delivered part. In strict mode the delivery must not exceed the (raised) reservation on any primitive,
  // so a caller that skipped raiseOrWithhold fails loud. In predictive mode a delivery above the prediction is an
  // under-prediction; it is recorded and reported, never refused.
  reconcile(id: string, delivered: Record<string, number>, now: number, deliveredDomain: string): { underPrediction: number; beyondBound: boolean; overCeiling: string[] } {
    checkVector(delivered, `delivered vector of ${id}`, true);
    checkNow(now);
    const r = this.open.get(id);
    if (!r) throw new Error(`reconcile of ${id}, which was never reserved or is already closed`);
    checkAfter(now, r.reservedAt);
    const floor = domainFloor(this.policy, deliveredDomain);
    const mode = r.mode;
    const rel = this.released.get(id);
    if (rel && now < rel.t) throw new Error(`reconcile of ${id} predates its last release`);
    if (rel) for (const [p, v] of Object.entries(rel.x)) if ((delivered[p] ?? 0) < v - 1e-12) throw new Error(`P15 reconcile of ${id} below its released vector`);
    let under = 0;
    for (const [p, v] of Object.entries(delivered)) under = Math.max(under, v - (r.x[p] ?? 0));
    if (mode === "strict" && under > 1e-12) throw new Error(`P19 strict reconcile of ${id} delivers above its reservation; call raiseOrWithhold first`);
    const ev: Ev = { id, t: now, sig: r.sig, cls: r.cls, x: { ...delivered } };
    const overCeiling: string[] = [];
    for (const l of r.levels) for (const [n, ob] of Object.entries(this.objs(l))) {
      const events = [...(this.committed.get(l) ?? []), ev];
      if (stepAlt(events, ob.recipes, now, this.o).c > ob.ceiling + 1e-12) overCeiling.push(`${l}/${n}`);
    }
    this.open.delete(id);
    this.released.delete(id);
    if (Object.keys(delivered).length > 0) for (const l of r.levels) this.committed.set(l, [...(this.committed.get(l) ?? []), ev]);
    this.record("reconcile", r, now, delivered);
    // Strict reservations cannot exceed their reserved vector and produce no breach.
    if (mode === "predictive" && floor === "strict") this.changePolicy({ type: "policy", scope: "breach", key: r.key, domain: deliveredDomain, mode: "strict", t: now });
    return { underPrediction: under, beyondBound: under > MAX_UNDER_PREDICTION + 1e-12, overCeiling };
  }
  // Release fence. The proxy sends bytes only after this resolves. Under the lock it confirms that the
  // reservation is open, records the cumulative released vector (elementwise maximum of every release so far) and
  // returns it, so the record precedes the send. In strict mode a release above the (raised) reservation throws.
  // atomic=false is the negative control: it checks, yields and writes, so an expiry between the check and the write
  // leaves released bytes uncommitted.
  async release(id: string, x: Record<string, number>, now: number): Promise<Record<string, number>> {
    const xs = ownVector(x, `released vector of ${id}`);
    checkNow(now);
    const check = (): OpenRes => {
      const r = this.open.get(id);
      if (!r) throw new Error(`P15 release on ${id}, which is not open`);
      checkAfter(now, r.reservedAt);
      const last = this.released.get(id);
      if (last && now < last.t) throw new Error(`release on ${id} predates its last release`);
      if (r.mode === "strict") for (const [p, v] of Object.entries(xs)) if (v > (r.x[p] ?? 0) + 1e-12) throw new Error(`strict release of ${id} above its reservation`);
      return r;
    };
    const write = (r: OpenRes): Record<string, number> => {
      const cum: Record<string, number> = { ...(this.released.get(id)?.x ?? {}) };
      for (const [p, v] of Object.entries(xs)) cum[p] = Math.max(cum[p] ?? 0, v);
      this.released.set(id, { x: cum, t: now });
      this.record("release", r, now, cum);
      return { ...cum };
    };
    if (this.atomic) return this.serial(() => write(check()));
    const r = check(); // read
    await Promise.resolve(); // yield: an expiry can run here
    return write(r); // write
  }
  // A reservation past its time limit is closed. It runs to completion between serial steps, so it takes the same lock
  // as release. With release records it commits the cumulative released vector as delivered at the last release time
  // (the latest release time decays least, so this is the conservative choice); with none it commits nothing. A
  // release, raise or reconcile after expiry throws because the reservation is not open.
  expire(id: string, now: number): void {
    const r = this.open.get(id);
    if (!r) throw new Error(`expire of ${id}, which is not open`);
    checkAfter(now, r.reservedAt);
    const rel = this.released.get(id);
    if (rel && now < rel.t) throw new Error(`expire of ${id} predates its last release`);
    if (rel) {
      const ev: Ev = { id, t: rel.t, sig: r.sig, cls: r.cls, x: { ...rel.x } };
      for (const l of r.levels) this.committed.set(l, [...(this.committed.get(l) ?? []), ev]);
    }
    this.open.delete(id);
    this.released.delete(id);
    this.record("expire", r, now, rel ? rel.x : {});
  }
  // Store failure: a delivery served unreserved while the store was down, written when it answers. It is
  // committed like a predictive delivery at its delivery time and opens no reservation.
  commitUnreserved(id: string, levels: string[], sig: string, x: Record<string, number>, deliveredAt: number, domain: string, tenant: string, key: string, cls: string = sig): void {
    checkVector(x, `unreserved delivery of ${id}`, true);
    checkNow(deliveredAt);
    checkName(id, "reservation id"); checkName(sig, "signature"); checkName(cls, "class");
    checkKeys(levels);
    for (const l of levels) this.objs(l);
    effectiveMode(this.policy, domain, tenant, key);
    if (this.open.has(id)) throw new Error(`unreserved delivery ${id} collides with an open reservation`);
    const r: OpenRes = { id, levels: [...levels], sig, cls, mode: "predictive", domain, tenant, key, reservedAt: deliveredAt, x: {} };
    if (Object.keys(x).length > 0) {
      const ev: Ev = { id, t: deliveredAt, sig, cls, x: { ...x } };
      for (const l of levels) this.committed.set(l, [...(this.committed.get(l) ?? []), ev]);
    }
    this.record("unreserved", r, deliveredAt, x);
  }
  modeFor(domain: string, tenant: string, key: string): CapMode { return effectiveMode(this.policy, domain, tenant, key); }
  isOpen(id: string): boolean { return this.open.has(id); }
  checkLevels(levels: string[]): void { checkKeys(levels); for (const l of levels) this.objs(l); }
}

// Store failure. The proxy retries a reservation STORE_ATTEMPTS times with increasing backoff (model
// time in hours, no sleep). After the last failure a request whose effective mode is strict (a high-uplift domain floor,
// or a tenant or key that opted up) is refused with a generic outcome that names no component. Other requests are
// served unreserved and counted per anchor per hour in proxy memory, because the store is what is down; an anchor past
// outageUnreservedMax in the current hour is refused in every domain until the store answers. When the store answers,
// the held unreserved deliveries are written to the ledger in order.
export const STORE_ATTEMPTS = 3;
export const STORE_BACKOFF_H = [100, 400, 1600].map((ms) => ms / 3.6e6);
export const UNAVAILABLE_CODE = "E_SERVICE_UNAVAILABLE";
export type ProxyOutcome = { outcome: "granted" | "denied" | "unreserved"; attempts: number } | { outcome: "unavailable"; code: string; attempts: number };
interface HeldDelivery { id: string; levels: string[]; sig: string; domain: string; tenant: string; key: string; x: Record<string, number> | null; t: number }
export class ReservationProxy {
  private counts = new Map<string, { hour: number; n: number }>();
  private lockedOut = new Set<string>();
  private held: HeldDelivery[] = [];
  // One alert per request that exhausted its store attempts.
  readonly alerts: { t: number; key: string; outcome: "unavailable" | "unreserved" }[] = [];
  constructor(private ledger: CapLedger, private storeUp: (attempt: number, t: number) => boolean, readonly outageUnreservedMax: number) {
    if (!Number.isSafeInteger(outageUnreservedMax) || outageUnreservedMax < 0) throw new Error("invalid outageUnreservedMax");
  }
  lockedOutAnchors(): string[] { return [...this.lockedOut].sort(); }
  private flush(): void {
    for (const h of [...this.held]) {
      if (h.x === null) throw new Error(`P22 unreserved request ${h.id} has no reported delivery`);
      this.ledger.commitUnreserved(h.id, h.levels, h.sig, h.x, h.t, h.domain, h.tenant, h.key);
      this.held.shift();
    }
    this.lockedOut.clear();
  }
  async reserve(id: string, levels: string[], sig: string, x: Record<string, number>, now: number, domain: string, tenant: string, key: string): Promise<ProxyOutcome> {
    x = ownVector(x, `predicted vector of ${id}`);
    if (!Array.isArray(levels)) throw new Error("levels must be an array");
    levels = [...levels];
    checkNow(now);
    checkName(id, "reservation id"); checkName(sig, "signature");
    this.ledger.checkLevels(levels);
    this.ledger.modeFor(domain, tenant, key);
    if (this.ledger.isOpen(id) || this.held.some((h) => h.id === id)) throw new Error(`P22 request id ${id} is already open or held`);
    let t = now, attempts = 0;
    for (let i = 0; i < STORE_ATTEMPTS; i++) {
      attempts++;
      const up = this.storeUp(i, t);
      if (typeof up !== "boolean") throw new Error("store probe must return a boolean");
      if (up) {
        this.flush();
        return { outcome: (await this.ledger.reserve(id, levels, sig, x, now, domain, tenant, key)) ? "granted" : "denied", attempts };
      }
      t += STORE_BACKOFF_H[i];
    }
    const mode = this.ledger.modeFor(domain, tenant, key);
    if (mode === "strict") { this.alerts.push({ t, key, outcome: "unavailable" }); return { outcome: "unavailable", code: UNAVAILABLE_CODE, attempts }; }
    const slot = key;
    const hour = Math.floor(now);
    const c = this.counts.get(slot);
    const n = c && c.hour === hour ? c.n : 0;
    if (this.lockedOut.has(slot) || n >= this.outageUnreservedMax) {
      this.lockedOut.add(slot);
      this.alerts.push({ t, key, outcome: "unavailable" });
      return { outcome: "unavailable", code: UNAVAILABLE_CODE, attempts };
    }
    this.counts.set(slot, { hour, n: n + 1 });
    this.held.push({ id, levels: [...levels], sig, domain, tenant, key, x: null, t: now });
    this.alerts.push({ t, key, outcome: "unreserved" });
    return { outcome: "unreserved", attempts };
  }
  // The delivered vector of an unreserved request, reported after the response.
  deliverUnreserved(id: string, x: Record<string, number>, t: number): void {
    checkVector(x, `unreserved delivery of ${id}`, true);
    checkNow(t);
    const h = this.held.find((d) => d.id === id);
    if (!h) throw new Error(`P22 delivery for ${id}, which was not served unreserved`);
    if (h.x !== null) throw new Error(`P22 second delivery for ${id}`);
    if (t < h.t) throw new Error(`P22 delivery for ${id} predates its request`);
    h.x = { ...x }; h.t = t;
  }
}
// Replay reads the recorded decisions and never re-evaluates a ceiling. It rebuilds the committed events from reconcile
// records and the open reservations, with their reserved vectors and modes, from grant and raise records not yet
// closed, so a log cut at any point restores the prospective state.
export function replayCap(log: CapEvent[]): { committed: Map<string, Ev[]>; open: Map<string, OpenRes>; decisions: string[]; policy: CapPolicy } {
  const policy = emptyPolicy();
  const committed = new Map<string, Ev[]>();
  const open = new Map<string, OpenRes>();
  const released = new Map<string, { x: Record<string, number>; t: number }>();
  const decisions: string[] = [];
  const commit = (e: { id: string; sig: string; cls: string; levels: string[] }, x: Record<string, number>, t: number) => {
    for (const l of e.levels) committed.set(l, [...(committed.get(l) ?? []), { id: e.id, t, sig: e.sig, cls: e.cls, x: { ...x } }]);
  };
  for (const e of log) {
    if (e.type === "policy") { applyPolicy(policy, e); continue; }
    checkName(e.id, "event id");
    checkName(e.sig, "event signature");
    checkName(e.cls, "event class");
    checkKeys(e.levels);
    checkMode(e.mode);
    const resolved = effectiveMode(policy, e.domain, e.tenant, e.key);
    if ((e.type === "grant" || e.type === "deny") && e.mode !== resolved) throw new Error("replay: mode differs from policy");
    checkVector(e.x, "event vector", e.type === "withhold" || e.type === "reconcile" || e.type === "expire" || e.type === "unreserved");
    checkAfter(e.t, e.reservedAt);
    const r = open.get(e.id);
    if (e.type !== "grant" && e.type !== "deny" && e.type !== "unreserved") {
      if (!r) throw new Error(`replay: ${e.type} on ${e.id}, which is not open`);
      if (r.domain !== e.domain || r.tenant !== e.tenant || r.key !== e.key || r.reservedAt !== e.reservedAt || r.mode !== e.mode || r.sig !== e.sig || r.cls !== e.cls || JSON.stringify(r.levels) !== JSON.stringify(e.levels)) throw new Error("replay: reservation metadata differs");
    }
    switch (e.type) {
      case "grant": {
        if (open.has(e.id)) throw new Error("replay: duplicate open grant");
        if (e.t !== e.reservedAt) throw new Error("replay: grant time differs");
        open.set(e.id, { id: e.id, levels: [...e.levels], sig: e.sig, cls: e.cls, mode: e.mode, domain: e.domain, tenant: e.tenant, key: e.key, reservedAt: e.reservedAt, x: { ...e.x } });
        decisions.push(`grant:${e.id}`);
        break;
      }
      case "deny": decisions.push(`deny:${e.id}`); break;
      case "raise": {
        if (r!.mode !== "strict" || Object.entries(r!.x).some(([p, v]) => !(e.x[p] >= v))) throw new Error("replay: invalid raise");
        r!.x = { ...e.x }; break;
      }
      case "withhold": {
        if (r!.mode !== "strict" || Object.entries(e.x).some(([p, v]) => v > (r!.x[p] ?? 0))) throw new Error("replay: invalid withhold");
        break;
      }
      case "release": {
        const prev = released.get(e.id);
        if (prev && (e.t < prev.t || Object.entries(prev.x).some(([p, v]) => !((e.x[p] ?? 0) >= v)))) throw new Error("replay: release is not cumulative");
        if (r!.mode === "strict" && Object.entries(e.x).some(([p, v]) => v > (r!.x[p] ?? 0) + 1e-12)) throw new Error("replay: strict release above reservation");
        released.set(e.id, { x: { ...e.x }, t: e.t });
        break;
      }
      case "reconcile": case "expire": {
        const rel = released.get(e.id);
        if (rel && e.t < rel.t) throw new Error(`replay: ${e.type} of ${e.id} predates its last release`);
        if (e.type === "expire" && !same(e.x, rel?.x ?? {})) throw new Error("replay: expiry differs from the released vector");
        if (e.type === "reconcile" && rel && Object.entries(rel.x).some(([p, v]) => (e.x[p] ?? 0) < v - 1e-12)) throw new Error("replay: reconcile below released");
        if (e.type === "reconcile" && r!.mode === "strict" && Object.entries(e.x).some(([p, v]) => v > (r!.x[p] ?? 0) + 1e-12)) throw new Error("replay: strict excess");
        open.delete(e.id);
        released.delete(e.id);
        if (e.type === "reconcile" && Object.keys(e.x).length > 0) commit(e, e.x, e.t);
        if (e.type === "expire" && rel) commit(e, rel.x, rel.t);
        break;
      }
      case "unreserved": {
        if (open.has(e.id)) throw new Error("replay: unreserved delivery collides with an open reservation");
        if (e.mode !== "predictive" || e.t !== e.reservedAt) throw new Error("replay: invalid unreserved record");
        if (Object.keys(e.x).length > 0) commit(e, e.x, e.t);
        break;
      }
      default: throw new Error("replay: unknown event type");
    }
  }
  return { committed, open, decisions, policy };
}

// ---------- worked canary example ----------
const R: Recipe = { q1: 1, q2: 1, q3: 1 };
const NOISY: Opts = { halfLifeH: null, agg: "noisy-or" };
const canary: Ev[] = [
  { id: "e1", t: 0, sig: "s1", x: { q1: LEVEL_VALUE.high } },
  { id: "e2", t: 24, sig: "s1", x: { q1: LEVEL_VALUE.high } }, // same signature as e1
  { id: "e3", t: 48, sig: "s3", x: { q2: LEVEL_VALUE.high } },
  { id: "e4", t: 72, sig: "s4", x: {} }, // benign
  { id: "e5", t: 96, sig: "s5", x: { q3: LEVEL_VALUE.high } },
];
function fmt(n: number) { return n.toFixed(3); }

export function workedExample(): string[] {
  const rows: string[] = [];
  for (let i = 0; i < canary.length; i++) {
    const e = canary[i], prior = canary.slice(0, i);
    const r = step([...prior, e], R, e.t, NOISY);
    rows.push(`| ${e.id} | ${fmt(r.c)} | ${fmt(r.g)} | ${fmt(delta(e, prior, R, e.t, NOISY))} |`);
  }
  return rows;
}

// ---------- invariants ----------
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const PRIMS = ["q1", "q2", "q3", "q4"];
function randomEv(r: () => number, i: number, pool: Contribution[]): Ev {
  const x: Record<string, number> = {};
  for (const p of PRIMS) if (r() < 0.4) x[p] = [1 / 3, 2 / 3, 1][Math.floor(r() * 3)];
  const consumes = pool.length && r() < 0.5 ? [pool[Math.floor(r() * pool.length)]] : undefined;
  const sig = `s${Math.floor(r() * 6)}`;
  return { id: `r${i}`, t: Math.floor(r() * 100), sig, cls: `c${Number(sig.slice(1)) % 3}`, x, consumes };
}
function shuffle<T>(r: () => number, a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
const RECIPES: Recipe[] = [{ q1: 1, q2: 1 }, { q1: 0.6, q2: 1, q3: 0.8 }, { q4: 1 }];
const AGGS: Aggregator[] = ["noisy-or", "max", "class-max-noisy-or"];
const HL = { q1: 24, q2: 24, q3: 24, q4: 24 };

const propertyCounts = new Map<string, number>();
function must(cond: boolean, msg: string): void {
  const property = msg.match(/^P\d+[a-z]?\b/)?.[0];
  if (property) propertyCounts.set(property, (propertyCounts.get(property) ?? 0) + 1);
  if (!cond) throw new Error(`invariant violated: ${msg}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;

export function runInvariants(): { cases: number } {
  const r = rng(20261008);
  let cases = 0;
  for (let k = 0; k < 300; k++) {
    const n = 1 + Math.floor(r() * 8);
    const evs: Ev[] = [];
    for (let i = 0; i < n; i++) evs.push(randomEv(r, i, evs.flatMap(produced)));
    const extra = randomEv(r, 99, evs.flatMap(produced));
    for (const rec of RECIPES) for (const agg of AGGS) for (const decay of [false, true]) {
      cases++;
      const O: Opts = { halfLifeH: decay ? HL : null, agg };
      const now = 100;
      const base = step(evs, rec, now, O);
      must(base.c >= 0 && base.c <= 1 && base.g >= 0 && base.g <= 1, "bounds");
      // P1 monotone with fixed inputs, with and without decay
      must(delta(extra, evs, rec, now, O) >= -1e-12, `P1 negative marginal uplift (decay ${decay})`);
      // P2 an event that repeats an existing contribution at no higher level and no later time changes nothing
      const lower: Ev = { ...evs[0], id: "dup", consumes: undefined, t: Math.min(evs[0].t, Math.floor(r() * 100)), x: Object.fromEntries(Object.entries(evs[0].x).map(([p, v]) => [p, v / 2])) };
      must(near(step([...evs, lower], rec, now, O).c, base.c), `P2 a lower, no-later duplicate changed progress (decay ${decay})`);
      // P3 order invariance under random permutations, with and without decay
      must(near(step(shuffle(r, evs), rec, now, O).c, base.c), `P3 order changed progress (decay ${decay})`);
      must(step(evs, { ...rec, missing: 1 }, now, O).c === 0, "P4 a missing required primitive must force zero progress");
      // P5 lineage idempotence: chained relays that only pass existing appearances along change nothing, with and without decay
      const carried = evs.flatMap(produced);
      const chain: Ev[] = [...evs];
      let prevConsumes = carried;
      for (let h = 0; h < 3; h++) {
        const relay: Ev = { id: `relay${h}`, t: 100 + h, sig: `relay${h}`, x: {}, consumes: prevConsumes };
        chain.push(relay);
        prevConsumes = [...relay.consumes!];
      }
      must(near(step(chain, rec, now, O).c, base.c), `P5 a relay chain changed progress (decay ${decay})`);
      // P6 determinism
      must(step(evs, rec, now, O).c === step(evs, rec, now, O).c, "P6 non-deterministic");
    }
    // P8 decay: later evaluation never raises c for a fixed set
    for (const rec of RECIPES) for (const agg of AGGS) {
      const D: Opts = { halfLifeH: HL, agg };
      must(step(evs, rec, 200, D).c <= step(evs, rec, 100, D).c + 1e-12, "P8 decay raised progress");
      // P9 propagation does not reset the clock
      const e1 = evs[0];
      const relayLate: Ev = { id: "late", t: Math.max(e1.t, 90) + 1, sig: "late", x: {}, consumes: produced(e1) };
      must(near(step([e1, relayLate], rec, 120, D).c, step([e1], rec, 120, D).c), "P9 propagation reset decay");
      // P17 refused or withheld events add nothing
      const refused: Ev = { ...randomEv(r, 77, []), delivered: false };
      must(near(step([...evs, refused], rec, 100, D).c, step(evs, rec, 100, D).c), "P17 a refused event changed progress");
    }
    // P10 aggregator order: max <= class-max-noisy-or <= noisy-or
    for (const rec of RECIPES) {
      const c = AGGS.map((agg) => step(evs, rec, 100, { halfLifeH: null, agg }).c);
      must(c[1] <= c[2] + 1e-12 && c[2] <= c[0] + 1e-12, "P10 aggregator order");
    }
    // P18 alternative requirement sets: progress is the maximum over the alternatives
    const alt = stepAlt(evs, RECIPES, 100, { halfLifeH: null, agg: "noisy-or" });
    for (const rec of RECIPES) must(alt.c + 1e-12 >= step(evs, rec, 100, { halfLifeH: null, agg: "noisy-or" }).c, "P18 alternatives lowered progress");
    must(near(alt.c, Math.max(...RECIPES.map((rec) => step(evs, rec, 100, NOISY).c))), "P18 progress must equal the maximum alternative");
    // P18b the leading indicator for alternatives is the maximum of each alternative's own g
    must(near(alt.g, Math.max(...RECIPES.map((rec) => step(evs, rec, 100, { halfLifeH: null, agg: "noisy-or" }).g))), "P18b g over alternatives is not the maximum of each alternative's g");
  }
  return { cases };
}

export function runNegativeControls(): void {
  // P9 control: a relay that re-stamps the clock raises progress under decay.
  const o: Opts = { halfLifeH: { q1: 24 }, agg: "noisy-or" };
  const e1: Ev = { id: "m1", t: 0, sig: "m1", x: { q1: LEVEL_VALUE.medium } };
  const restamped: Ev = { id: "rs", t: 96, sig: "rs", x: {}, consumes: produced(e1).map((c) => ({ ...c, t: 96 })) };
  const keepsClock: Ev = { id: "kc", t: 96, sig: "kc", x: {}, consumes: produced(e1) };
  const single0: Recipe = { q1: 1 };
  must(near(step([e1, keepsClock], single0, 100, o).c, step([e1], single0, 100, o).c), "P9 keeping the clock must not change progress");
  must(step([e1, restamped], single0, 100, o).c > step([e1], single0, 100, o).c, "negative control: a re-stamped relay should raise progress");
  const rekeyed: Ev = { id: "rk", t: 0, sig: "rk", x: {}, consumes: produced(e1).map((c) => ({ ...c, key: `relay|${c.p}`, cls: `relay|${c.p}` })) };
  must(step([e1, rekeyed], single0, 0, NOISY).c > step([e1], single0, 0, NOISY).c, "P5 negative control: a re-keyed relay must inflate progress");
  // P1 control: the earlier merge rule (highest value with the earliest time) fell from 0.749 to 0.056.
  const strong: Ev = { id: "a", t: 90, sig: "s1", x: { q1: 1 } };
  const weakEarlier: Ev = { id: "b", t: 0, sig: "s1", x: { q1: 1 / 3 } };
  const before = step([strong], single0, 100, o).c, after = step([strong, weakEarlier], single0, 100, o).c;
  must(after >= before - 1e-12, "P1 adding a weaker, earlier duplicate lowered progress under decay");
  // Fail-loud inputs.
  const bad = (f: () => void, what: string) => { let threw = false; try { f(); } catch { threw = true; } must(threw, `fail-loud: ${what} must throw`); };
  bad(() => step([{ id: "n", t: NaN, sig: "n", x: { q1: 0.5 } }], single0, 100, o), "a NaN timestamp");
  bad(() => step([strong], single0, NaN, o), "a NaN evaluation time");
  bad(() => linkageEvidence([{ family: "network", conf: 0.5, forge: "unknown" as unknown as Forge, polarity: "supports" }]), "an unknown forge class");
  bad(() => linkageEvidence([{ family: "network", conf: 0.5, forge: "low", polarity: "maybe" as unknown as Edge["polarity"] }]), "an unknown polarity");
  bad(() => linkageEvidence([{ family: "identity", conf: 0.5, forge: "high", polarity: "contradicts" }]), "a contradicting edge without an origin");
  bad(() => step([{ id: "c1", t: 0, sig: "z", cls: "A", x: { q1: 0.5 } }, { id: "c2", t: 1, sig: "z", cls: "B", x: { q1: 0.5 } }], single0, 100, o), "one signature with two classes");
  const l = new Ledger({ k: 1 }, true);
  bad(() => l.reconcile("missing", 0.2, 0), "a reconcile of an amount never reserved");
  bad(() => hashForge("secret" as unknown as "public"), "an unknown provenance");
}

export function runLinkageChecks(): void {
  const s1: Edge = { family: "network", conf: 0.8, forge: "low", polarity: "supports" };
  const s2: Edge = { family: "network", conf: 0.9, forge: "low", polarity: "supports" };
  const s3: Edge = { family: "lineage", conf: 1, forge: "high", polarity: "supports" };
  const x1: Edge = { family: "identity", conf: 1, forge: "high", polarity: "contradicts", origin: "platform" };
  const medium: Edge = { ...x1, forge: "medium" };
  must(near(linkageEvidence([s3, medium]), 1 - KAPPA.medium), "P11c medium-cost platform contradiction must lower the score");
  must(mergeDisposition([medium]) === "block", "P11g medium-cost platform contradiction must block a merge");
  const cheap: Edge = { family: "network", conf: 1, forge: "low", polarity: "contradicts", origin: "platform" };
  const actorX: Edge = { family: "identity", conf: 1, forge: "high", polarity: "contradicts", origin: "actor" };
  must(linkageEvidence([]) === 0, "P11 L of no edges must be 0");
  must(Math.abs(linkageEvidence([s1, s2]) - linkageEvidence([s2])) < 1e-12, "P11a two edges of one family count once");
  must(linkageEvidence([s1, s3]) > linkageEvidence([s1]), "P11b an independent family raises L");
  must(linkageEvidence([s1, s3, x1]) <= linkageEvidence([s1, s3]) + 1e-12, "P11c contradicting evidence never raises L");
  must(linkageEvidence([s1, s3, x1]) === 0, "P11d a full-confidence high-cost contradiction removes L");
  must(linkageEvidence([s1, s3, cheap]) === linkageEvidence([s1, s3]), "P11f a cheap contradiction must not lower the score of existing members");
  must(mergeDisposition([cheap]) === "review" && mergeDisposition([s1]) === "merge" && mergeDisposition([x1]) === "block", "P11g a cheap contradiction sends a merge to review, a platform contradiction of high cost blocks it");
  const cheapFamilies: Edge[] = (["network", "content", "trajectory", "refusal", "delivered"] as Family[]).map((family) => ({ family, conf: 1, forge: "low", polarity: "supports" }));
  must(linkageEvidence(cheapFamilies) <= LOW_FORGE_CAP + 1e-12, "P11h evidence of low forge cost alone must not exceed the cap");
  must(linkageEvidence([...cheapFamilies, s3]) > LOW_FORGE_CAP, "P11i a high-cost edge can lift the score past the low-cost cap");
  must(hashForge("public") === "low" && hashForge("private") === "high", "P11j a public artifact hash has low forge cost");
  must(linkageEvidence([{ family: "lineage", conf: 1, forge: hashForge("public"), polarity: "supports" }]) <= LOW_FORGE_CAP + 1e-12, "P11k a public hash alone cannot make the score high");
  must(linkageEvidence([s1, s3, actorX]) === linkageEvidence([s1, s3]) && mergeDisposition([s1, s3, actorX]) === "review", "P11l an actor-origin contradiction must not lower the score or block a merge; it sends the merge to review");
  // P11m one family with a low and a strong edge counts once, at its best edge (the earlier version counted it twice)
  const mixedLow: Edge = { family: "content", conf: 1, forge: "low", polarity: "supports" };
  const mixedStrong: Edge = { family: "content", conf: 0.3, forge: "high", polarity: "supports" };
  must(near(linkageEvidence([mixedLow, mixedStrong]), Math.max(KAPPA.low, 0.3)), "P11m a family with a low and a strong edge must count once");
  // P11n random: adding a supporting edge never lowers the score, low-cost support alone never exceeds the cap, bounds hold
  const r = rng(11);
  const FAMS: Family[] = ["content", "lineage", "identity", "network", "trajectory", "refusal", "delivered", "human"];
  const FORGES: Forge[] = ["low", "medium", "high"];
  const randEdge = (): Edge => ({ family: FAMS[Math.floor(r() * FAMS.length)], conf: r(), forge: FORGES[Math.floor(r() * 3)], polarity: "supports" });
  for (let k = 0; k < 900; k++) {
    const es = Array.from({ length: Math.floor(r() * 6) }, randEdge);
    const add = randEdge();
    must(linkageEvidence([...es, add]) + 1e-12 >= linkageEvidence(es), "P11n adding a supporting edge lowered the score");
    const lows = es.map((e) => ({ ...e, forge: "low" as Forge }));
    must(linkageEvidence(lows) <= LOW_FORGE_CAP + 1e-12, "P11n low-cost support alone exceeded the cap");
    const v = linkageEvidence([...es, add]);
    must(v >= 0 && v <= 1, "P11n bounds");
  }
  const all = [s1, s2, s3, x1];
  must(linkageEvidence(all) >= 0 && linkageEvidence(all) <= 1, "P11e bounds");
  const conf = { deterministic: true, trajectory: true };
  must(clusterRung({ c: 1, g: 1, L: 0.1, families: 3, ...conf }).rung <= 1, "P16 high c with low L must not reach friction or above");
  must(clusterRung({ c: 1, g: 1, L: 0.9, families: 1, ...conf }).rung <= 1, "P16 one signal family must not reach friction");
  must(same(clusterRung({ c: 0.85, g: 1, L: 0.9, families: 2, deterministic: false, trajectory: false }), { rung: 2, review: false }), "P16 high c with high L and two families reaches friction");
  must(same(clusterRung({ c: 1, g: 1, L: 0.9, families: 2, ...conf }), { rung: 3, review: false }), "P16 a confirmed case quarantines automatically");
  for (const [deterministic, trajectory] of [[false, false], [true, false], [false, true]]) {
    must(same(clusterRung({ c: 1, g: 1, L: 0.9, families: 2, deterministic, trajectory }), { rung: 2, review: true }), "P16 an unconfirmed quarantine-level case stays at friction and queues review");
  }
  for (const L of [0.1, 0.9]) must(clusterRung({ c: 1, g: 1, L, families: L < 0.5 ? 2 : 1, ...conf }).rung <= 1, "P16 an unlinked confirmed case never reaches friction");
  for (const badInput of [{ deterministic: undefined }, { trajectory: "yes" }, { families: 1.5 }, { c: NaN }]) {
    let threw = false;
    try { clusterRung({ c: 1, g: 1, L: 0.9, families: 2, ...conf, ...badInput } as unknown as RungInput); } catch { threw = true; }
    must(threw, "P16 malformed rung input must throw");
  }
}

export async function runReservationChecks(): Promise<{ atomicGranted: number; racyGranted: number; orgAtomic: number; orgRacy: number }> {
  const n = 10, amount = 0.3;
  const atomic = new Ledger({ "anchor|obj": 1 }, true), racy = new Ledger({ "anchor|obj": 1 }, false);
  const a = await Promise.all(Array.from({ length: n }, () => atomic.reserveAll(["anchor|obj"], amount, 0)));
  const b = await Promise.all(Array.from({ length: n }, () => racy.reserveAll(["anchor|obj"], amount, 0)));
  const atomicGranted = a.filter(Boolean).length, racyGranted = b.filter(Boolean).length;
  must(atomic.total("anchor|obj") <= 1 + 1e-12, "P12a atomic reservations exceeded the ceiling");
  must(atomicGranted === 3, `P12a atomic ledger granted ${atomicGranted}, expected 3`);
  must(racy.total("anchor|obj") > 1, "negative control: the racy ledger should overshoot the ceiling");

  const ceil: Record<string, number> = { org: 1 };
  for (let i = 0; i < 5; i++) ceil["key" + i] = 1;
  const orgAtomic = new Ledger(ceil, true), orgRacy = new Ledger(ceil, false);
  const oa = await Promise.all(Array.from({ length: n }, (_, i) => orgAtomic.reserveAll(["key" + (i % 5), "org"], amount, 0)));
  const orr = await Promise.all(Array.from({ length: n }, (_, i) => orgRacy.reserveAll(["key" + (i % 5), "org"], amount, 0)));
  must(orgAtomic.total("org") <= 1 + 1e-12, "P12b the organisation ceiling was exceeded under sibling keys");
  must(oa.filter(Boolean).length === 3, "P12b atomic grants across sibling keys should be 3");
  must(orgRacy.total("org") > 1, "negative control: the racy ledger should overshoot the organisation ceiling");

  // P14: replay of the recorded decisions gives the live totals without re-racing.
  const pre = orgAtomic.log.length;
  const rc = orgAtomic.reconcile(oa[0] as string, 0.2, 0);
  must(!rc.overCeiling, "reconcile with a smaller delivery must not exceed a ceiling");
  must(orgAtomic.log.length === pre + 1, "reconcile must be written to the log");
  const re = replay(orgAtomic.log);
  for (const k of Object.keys(ceil)) must(Math.abs((re.get(k) ?? 0) - orgAtomic.total(k)) < 1e-9, "P14 replay differs from the live totals for " + k);

  // P15: an aborted stream keeps the delivered part.
  const ab = new Ledger({ k: 1 }, true);
  const abId = await ab.reserveAll(["k"], 0.3, 0);
  ab.reconcile(abId as string, 0.2, 0);
  must(Math.abs(ab.total("k") - 0.2) < 1e-9, "P15 an abort must charge what was delivered");

  // Predictive mode: an under-prediction is recorded and reported, never refused, and flagged beyondBound past the bound.
  const od = new Ledger({ k: 0.35 }, true);
  const odId = await od.reserveAll(["k"], 0.3, 0);
  const over = od.reconcile(odId as string, 0.4, 0);
  must(over.overCeiling && near(over.underPrediction, 0.1) && !over.beyondBound, "an under-prediction inside the bound must be recorded and reported against the ceiling");
  const od2 = new Ledger({ k: 1 }, true);
  const od2Id = await od2.reserveAll(["k"], 0.1, 0);
  const far = od2.reconcile(od2Id as string, 0.9, 0);
  must(far.beyondBound && near(od2.total("k"), 0.9), "P20b a delivery beyond the declared bound must be recorded and flagged, not refused");

  // P19 strict mode: with pre-release raises, delivered totals never exceed the ceiling, whatever the under-prediction.
  // P20 predictive mode: with maxOpen open reservations and under-predictions within the bound, the overshoot is at most
  // maxOpen * MAX_UNDER_PREDICTION; the negative control without the open cap overshoots further.
  const rr = rng(19);
  for (let k = 0; k < 200; k++) {
    const strict = new Ledger({ a: 1 }, true);
    const reqs = Array.from({ length: 2 + Math.floor(rr() * 8) }, () => ({ pred: 0.05 + rr() * 0.3, actual: rr() * 0.6 }));
    const granted = await Promise.all(reqs.map((q) => strict.reserveAll(["a"], q.pred, 0)));
    for (let i = 0; i < reqs.length; i++) {
      if (!granted[i]) continue;
      const q = reqs[i];
      let delivered = q.actual;
      const id = granted[i] as string;
      if (q.actual > q.pred && !await strict.raise(id, q.actual - q.pred, 0)) delivered = q.pred;
      strict.reconcile(id, delivered, 0);
    }
    must(strict.total("a") <= 1 + 1e-9, "P19 strict mode exceeded the ceiling");
    const pr = new Ledger({ a: 1 }, true, 3);
    const g2 = await Promise.all(reqs.map((q) => pr.reserveAll(["a"], q.pred, 0)));
    must(g2.filter(Boolean).length <= 3, "P20 more open reservations than maxOpen");
    for (let i = 0; i < reqs.length; i++) if (g2[i]) pr.reconcile(g2[i] as string, reqs[i].pred + Math.min(MAX_UNDER_PREDICTION, reqs[i].actual), 0);
    must(pr.total("a") <= 1 + 3 * MAX_UNDER_PREDICTION + 1e-9, "P20 predictive overshoot beyond maxOpen times the bound");
  }
  const noCap = new Ledger({ a: 1 }, true);
  const small = await Promise.all(Array.from({ length: 10 }, () => noCap.reserveAll(["a"], 0.1, 0)));
  small.forEach((g) => { if (g) noCap.reconcile(g, 0.1 + MAX_UNDER_PREDICTION, 0); });
  must(noCap.total("a") > 1 + 3 * MAX_UNDER_PREDICTION, "negative control: without the open cap the predictive overshoot exceeds the capped bound");

  // P13 partial label is never below the prediction or the classified prefix
  const pl = partialLabel({ q1: 0.33, q2: 0 }, { q1: 0.1, q3: 1 });
  must(pl.label.q1 === 0.33 && pl.label.q2 === 0 && pl.label.q3 === 1, "P13 partial label must be the elementwise maximum");
  must(pl.underPredicted, "P13 a prefix above the prediction must be reported as an under-prediction");
  must(!partialLabel({ q1: 0.1 }, { q1: 0.3 }).underPredicted, "P13 a prediction above the prefix is not an under-prediction");
  for (const [prefix, predicted, expected] of [
    [{ q1: 0.1, q2: 0.2 }, { q1: 0.3, q3: 0.4 }, { q1: 0.3, q2: 0.2, q3: 0.4 }],
    [{ q1: 0.3, q2: 0.4 }, { q1: 0.1, q3: 0.2 }, { q1: 0.3, q2: 0.4, q3: 0.2 }],
  ] as [Record<string, number>, Record<string, number>, Record<string, number>][]) {
    must(same(partialLabel(prefix, predicted).label, expected), "P13 exact elementwise maximum in both dominance directions and absent primitives");
  }
  // P21 mode selection: exhaustive over floor, tenant and key settings. Strict at any level wins, and no setting
  // lowers the floor. Negative control: a "most specific setting wins" resolver lets a key opt down.
  const M: (CapMode | undefined)[] = ["strict", "predictive", undefined];
  const specificWins = (floor: CapMode, org?: CapMode, key?: CapMode): CapMode => key ?? org ?? floor;
  let optDown = 0;
  for (const floor of ["strict", "predictive"] as CapMode[]) for (const org of M) for (const key of M) {
    const m = resolveMode(floor, org, key);
    must(!(floor === "strict" && m !== "strict"), "P21 a setting lowered the strict floor");
    must(!((org === "strict" || key === "strict") && m !== "strict"), "P21 a strict tenant or key setting was ignored");
    must(!(floor === "predictive" && org !== "strict" && key !== "strict" && m !== "predictive"), "P21 strict applied with no strict source");
    if (floor === "strict" && specificWins(floor, org, key) === "predictive") optDown++;
  }
  must(optDown > 0, "negative control: the specific-wins resolver should let a setting lower the floor");
  let threw = false; try { resolveMode("strict", "lenient" as unknown as CapMode); } catch { threw = true; }
  must(threw, "fail-loud: an unknown cap mode must throw");
  await runPolicyChecks();
  return { atomicGranted, racyGranted, orgAtomic: oa.filter(Boolean).length, orgRacy: orr.filter(Boolean).length };
}


export async function runPolicyChecks(): Promise<void> {
  const make = (): CapLedger => new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY, { general: "predictive", other: "predictive", sensitive: "strict" });
  const reserve = (L: CapLedger, id: string, domain = "general", tenant = "tenant", key = "anchor"): Promise<boolean> => L.reserve(id, ["a"], id, { q1: 0.01 }, 1, domain, tenant, key);
  const mode = (L: CapLedger, id: string): CapMode | undefined => L.reservations().find((r) => r.id === id)?.mode;
  const cut = async (L: CapLedger): Promise<void> => {
    let rp: ReturnType<typeof replayCap>;
    try { rp = replayCap(L.log); } catch (error) { throw new Error(`invariant violated: P21 policy replay failed: ${error}`); }
    const live = L.policyState();
    must(same([...rp.policy.floors], [...live.floors]) && same([...rp.policy.tenants], [...live.tenants]) && same([...rp.policy.keys], [...live.keys]) && same([...rp.policy.breaches].map(([k, v]) => [k, [...v]]), [...live.breaches].map(([k, v]) => [k, [...v]])), "P21 replay restores every policy scope");
    for (const domain of live.floors.keys()) for (const tenant of ["tenant", "sibling"]) for (const key of ["anchor", "another"]) {
      must(effectiveMode(rp.policy, domain, tenant, key) === effectiveMode(live, domain, tenant, key), "P21 policy cut restores probe mode");
    }
  };
  for (const scope of ["tenant", "key"] as const) {
    const L = make();
    await reserve(L, "open");
    if (scope === "tenant") L.setTenantMode("tenant", "strict", 2); else L.setKeyMode("anchor", "strict", 2);
    await cut(L);
    await reserve(L, "new"); await reserve(L, "sibling", "general", "tenant", "another");
    must(mode(L, "open") === "predictive" && mode(L, "new") === "strict" && mode(L, "sibling") === (scope === "tenant" ? "strict" : "predictive"), `P21 ${scope} opt-up preserves open modes and resolves new and sibling requests`);
    let completed = false;
    try { L.reconcile("open", { q1: 0.02 }, 3, "general"); completed = true; } catch { /* Assertion below reports the property. */ }
    must(completed && L.log.some((e) => e.type === "reconcile" && e.id === "open" && e.mode === "predictive"), `P21 ${scope} opt-up preserves predictive reconciliation`);
    if (scope === "key") await rejects(() => L.raiseOrWithhold("sibling", {}, 3), "P21 key opt-up leaves sibling raise predictive");
  }
  const L = make();
  for (let i = 1; i <= 3; i++) await cutLog(L.log.slice(0, i));
  async function cutLog(log: CapEvent[]): Promise<void> {
    const rp = replayCap(log);
    const floors = log.filter((e): e is PolicyEvent & { scope: "floor" } => e.type === "policy" && e.scope === "floor");
    must(same([...rp.policy.floors], floors.map((e) => [e.domain, e.mode])), "P21 constructor policy cuts restore floors");
  }
  await reserve(L, "floor-open"); L.setDomainFloor("general", "strict", 4); await cut(L);
  L.setTenantMode("tenant", "predictive", 3); await cut(L);
  L.setKeyMode("anchor", "predictive", 2); await cut(L);
  await reserve(L, "floor-new");
  must(mode(L, "floor-open") === "predictive" && mode(L, "floor-new") === "strict", "P21 strict floor overrides predictive settings and preserves open mode");
  const granted = await L.reserve("floor-domain", ["a"], "denied", { q1: 0.01 }, 4, "sensitive", "tenant", "anchor");
  must(granted && mode(L, "floor-domain") === "strict", "P21 strict floor applies across domains");
  for (const scope of ["floor", "tenant", "key"] as const) {
    const set = (m: CapMode, t: number): void => scope === "floor" ? L.setDomainFloor("general", m, t) : scope === "tenant" ? L.setTenantMode("tenant", m, t) : L.setKeyMode("anchor", m, t);
    set("strict", 5); await cut(L);
    const before = JSON.stringify(L.log);
    set("strict", 1);
    must(JSON.stringify(L.log) === before, `P21 repeated ${scope} setting has no event`);
    await rejects(() => set("predictive", 6), `P21 ${scope} lowering must throw`);
    must(JSON.stringify(L.log) === before, `P21 rejected ${scope} lowering preserves log`);
  }
  const B = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY, { general: "predictive", other: "predictive", sensitive: "predictive" });
  await reserve(B, "breach");
  // A second prediction in the delivered domain stays open across its floor opt-up and breach.
  await reserve(B, "pending", "sensitive"); B.setDomainFloor("sensitive", "strict", 2); await cut(B);
  await reserve(B, "still-open", "sensitive", "tenant", "another");
  B.reconcile("breach", { q1: 0.02 }, 3, "sensitive"); await cut(B);
  const breach = B.log.at(-1);
  must(breach?.type === "policy" && breach.scope === "breach" && breach.key === "anchor" && breach.domain === "sensitive" && breach.mode === "strict" && breach.t === 3, "P21 predictive strict-domain delivery records its anchor breach");
  await reserve(B, "later", "sensitive"); await reserve(B, "other-domain", "other"); await reserve(B, "other-key", "other", "tenant", "another");
  must(mode(B, "later") === "strict" && mode(B, "other-domain") === "predictive" && mode(B, "other-key") === "predictive" && mode(B, "pending") === "predictive", "P21 breach preserves open modes and isolates later requests");
  const isolated = B.policyState(); isolated.floors.set("sensitive", "predictive");
  must(effectiveMode(isolated, "sensitive", "tenant", "anchor") === "strict" && effectiveMode(isolated, "sensitive", "tenant", "another") === "predictive" && effectiveMode(isolated, "other", "tenant", "anchor") === "predictive", "P21 breach policy is scoped to one anchor and domain");
  let completed = false;
  try { B.reconcile("pending", { q1: 0.02 }, 4, "sensitive"); completed = true; } catch { /* Assertion below reports the property. */ }
  must(completed && B.log.filter((e) => e.type === "policy" && e.scope === "breach").length === 1, "P21 repeated breach is a no-op and open prediction stays predictive");
  const beforeStrict = B.log.filter((e) => e.type === "policy").length;
  B.reconcile("still-open", { q1: 0.01 }, 4, "sensitive");
  must(B.log.filter((e) => e.type === "policy").length === beforeStrict && !B.policyState().breaches.has("another"), "P21 strict reservation produces no breach");
  const D = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 0 } } }, NOISY, { general: "strict" });
  must(!await reserve(D, "deny") && D.log.at(-1)?.mode === "strict", "P21 denied reservation records resolved mode");
  await cut(D);
  await runPolicyInputChecks(make, reserve);
}

async function runPolicyInputChecks(make: () => CapLedger, reserve: (L: CapLedger, id: string, domain?: string, tenant?: string, key?: string) => Promise<boolean>): Promise<void> {
  const L = make(); await reserve(L, "open");
  const invalid = "invalid" as unknown as CapMode;
  const policy = L.log.filter((e): e is PolicyEvent => e.type === "policy");
  const grant = L.log.find((e): e is ReservationEvent => e.type === "grant")!;
  const badPolicies: unknown[] = [
    { type: "policy", scope: "unknown", mode: "strict", t: 0 },
    ...["floor", "tenant", "key", "breach"].map((scope) => ({ type: "policy", scope, mode: "strict", t: 0 })),
    ...["floor", "tenant", "key", "breach"].flatMap((scope) => [
      { type: "policy", scope, domain: "sensitive", tenant: "tenant", key: "anchor", mode: invalid, t: 0 },
      ...[NaN, -1].map((t) => ({ type: "policy", scope, domain: "sensitive", tenant: "tenant", key: "anchor", mode: "strict", t })),
    ]),
    ...[undefined, ""].map((key) => ({ type: "policy", scope: "breach", key, domain: "sensitive", mode: "strict", t: 0 })),
    { type: "policy", scope: "breach", key: "anchor", domain: "missing", mode: "strict", t: 0 },
    { type: "policy", scope: "breach", key: "anchor", domain: "general", mode: "strict", t: 0 },
    { type: "policy", scope: "breach", key: "anchor", domain: "sensitive", mode: "predictive", t: 0 },
  ];
  for (const e of badPolicies) await rejects(() => replayCap([...policy, e as PolicyEvent]), "fail-loud malformed policy replay throws");
  for (const e of [
    { type: "policy", scope: "floor", domain: "sensitive", mode: "strict", t: 1 },
    { type: "policy", scope: "tenant", tenant: "tenant", mode: "strict", t: 1 },
    { type: "policy", scope: "key", key: "anchor", mode: "strict", t: 1 },
  ] as PolicyEvent[]) await rejects(() => replayCap([...policy, e, { ...e, mode: "predictive" }]), "fail-loud replay policy lowering throws");
  for (const e of [
    { ...grant, mode: "strict" }, { ...grant, type: "deny", mode: "strict" }, { ...grant, type: "unknown" },
    ...["domain", "tenant", "key"].map((field) => ({ ...grant, [field]: "" })),
    { ...grant, domain: "missing" },
  ]) await rejects(() => replayCap([...policy, e as CapEvent]), "fail-loud invalid reservation policy replay throws");
  const before = JSON.stringify(L.log);
  for (const name of ["", "missing"]) {
    await rejects(() => reserve(L, "bad", name), "fail-loud unknown reservation domain throws");
    await rejects(() => L.reconcile("open", {}, 1, name), "fail-loud unknown delivered domain throws");
  }
  for (const scope of ["floor", "tenant", "key"] as const) {
    const set = (name: string, m: CapMode, t: number): void => scope === "floor" ? L.setDomainFloor(name, m, t) : scope === "tenant" ? L.setTenantMode(name, m, t) : L.setKeyMode(name, m, t);
    await rejects(() => set("", "strict", 1), "fail-loud empty policy subject throws");
    await rejects(() => set("general", invalid, 1), "fail-loud invalid policy mode throws");
    for (const t of [NaN, -1]) await rejects(() => set("general", "strict", t), "fail-loud invalid policy time throws");
  }
  await rejects(() => reserve(L, "bad-tenant", "general", ""), "fail-loud empty tenant throws");
  await rejects(() => reserve(L, "bad-key", "general", "tenant", ""), "fail-loud empty key throws");
  for (const floors of [{ general: invalid }, { "": "strict" }, {}] as Record<string, CapMode>[]) await rejects(() => new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY, floors), "fail-loud invalid constructor floors throw");
  must(JSON.stringify(L.log) === before && L.openCount("a") === 1, "P21 invalid policy inputs preserve state");
}

// Scalar marginal reservation, kept only as the negative control for P12c: each request reserves delta c against
// the committed state; a request with delta 0 is admitted without a reservation.
async function scalarMarginal(reqs: { sig: string; x: Record<string, number> }[], recipe: Recipe, ceiling: number, concurrent: boolean): Promise<{ granted: boolean[]; c: number }> {
  const committed: Ev[] = [];
  let reserved = 0;
  const one = (q: { sig: string; x: Record<string, number> }, i: number, base: Ev[]) => {
    const ev: Ev = { id: `s${i}`, t: 0, sig: q.sig, x: q.x };
    const d = delta(ev, base, recipe, 0, NOISY_CAP);
    const ok = reserved + d <= ceiling + 1e-12;
    if (ok) reserved += d;
    return { ok, ev };
  };
  const granted: boolean[] = [];
  if (concurrent) {
    const base = [...committed];
    const r = reqs.map((q, i) => one(q, i, base));
    for (const x of r) { granted.push(x.ok); if (x.ok) committed.push(x.ev); }
  } else {
    reqs.forEach((q, i) => { const x = one(q, i, committed); granted.push(x.ok); if (x.ok) { committed.push(x.ev); reserved = 0; } });
  }
  return { granted, c: step(committed, recipe, 0, NOISY_CAP).c };
}
const NOISY_CAP: Opts = { halfLifeH: null, agg: "noisy-or" };

export async function runCapChecks(): Promise<{ cases: number; worstOld: number; worstNew: number }> {
  let cases = 0;
  const two: Recipe = { q1: 1, q2: 1 };
  const A = { q1: 1 }, B = { q2: 1 };

  // P12c: two concurrent complementary requests, each with marginal uplift 0 alone, complete the objective together.
  const vec = new CapLedger({ anchor: { o: { recipes: [two], ceiling: 0.5 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" });
  const g = await Promise.all([vec.reserve("a", ["anchor"], "sa", A, 0, "general", "tenant", "a"), vec.reserve("b", ["anchor"], "sb", B, 0, "general", "tenant", "b")]);
  must(g[0] && !g[1], `P12c the vector ledger must grant A and deny B, got ${g}`);
  vec.reconcile("a", A, 0, "general");
  must(vec.c("anchor", "o", 0) <= 0.5, "P12c committed c above the ceiling");
  const sc = await scalarMarginal([{ sig: "sa", x: A }, { sig: "sb", x: B }], two, 0.5, true);
  must(sc.granted.every(Boolean) && sc.c > 0.5, "negative control: concurrent scalar marginal reservation should admit both and exceed the ceiling");
  const ss = await scalarMarginal([{ sig: "sa", x: A }, { sig: "sb", x: B }], two, 0.5, false);
  must(ss.granted[0] && !ss.granted[1] && ss.c <= 0.5, "P12c sequential scalar marginal denies the second request: the gap is concurrency only");
  const racy = new CapLedger({ anchor: { o: { recipes: [two], ceiling: 0.5 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" }, false);
  const gr = await Promise.all([racy.reserve("a", ["anchor"], "sa", A, 0, "general", "tenant", "a"), racy.reserve("b", ["anchor"], "sb", B, 0, "general", "tenant", "b")]);
  must(gr.every(Boolean) && racy.cProspective("anchor", "o", 0) > 0.5, "negative control: a read-then-write vector ledger should admit both");

  // P12d: sibling keys under one organisation. Each key alone is within its ceiling; the organisation level must deny
  // the second complementary request.
  const sib = new CapLedger({ keyA: { o: { recipes: [two], ceiling: 1 } }, keyB: { o: { recipes: [two], ceiling: 1 } }, org: { o: { recipes: [two], ceiling: 0.5 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" });
  const gs2 = await Promise.all([sib.reserve("a", ["keyA", "org"], "sa", A, 0, "general", "tenant", "a"), sib.reserve("b", ["keyB", "org"], "sb", B, 0, "general", "tenant", "b")]);
  must(gs2[0] && !gs2[1] && sib.cProspective("org", "o", 0) <= 0.5, `P12d the organisation level must deny the second sibling request, got ${gs2}`);

  // P12 (vector): random concurrent requests from two sibling keys under one organisation with different ceilings,
  // alternative recipes, near-duplicate classes that differ from signatures, three aggregators, with and without decay,
  // deliveries one hour after the reservation. After every batch the prospective c and the committed c stay within
  // every ceiling at every level; replay reproduces every decision and, cut after the grants, the prospective state.
  const r = rng(12);
  for (const o of [NOISY_CAP, { halfLifeH: HL, agg: "class-max-noisy-or" } as Opts, { halfLifeH: null, agg: "max" } as Opts]) {
    for (let k = 0; k < 60; k++) {
      const mk = (lo: number) => ({ o1: { recipes: [{ q1: 1, q2: 1 }, { q3: 0.6, q4: 1 }], ceiling: lo + r() * 0.5 }, o2: { recipes: [{ q2: 0.5, q3: 1 }], ceiling: lo + r() * 0.5 } });
      const objs: Record<string, Record<string, Objective>> = { keyA: mk(0.5), keyB: mk(0.5), org: mk(0.3) };
      const L = new CapLedger(objs, o, { general: "predictive", sensitive: "strict" }, true, 4);
      const reqs = Array.from({ length: 12 }, (_, i) => {
        const x: Record<string, number> = {};
        for (const p of PRIMS) if (r() < 0.4) x[p] = Math.round(r() * 3) / 3;
        if (Object.keys(x).length === 0) x.q1 = 1 / 3;
        const s = Math.floor(r() * 8);
        return { id: `r${k}-${i}`, x, sig: `s${s}`, cls: `c${s % 3}`, key: r() < 0.5 ? "keyA" : "keyB" };
      });
      const now = 10 * k;
      const res = await Promise.all(reqs.map((q) => L.reserve(q.id, [q.key, "org"], q.sig, q.x, now, "general", "tenant", q.id, q.cls)));
      const lvls = ["keyA", "keyB", "org"];
      const within = (fn: (l: string, n: string) => number, what: string) => { for (const l of lvls) for (const [n, ob] of Object.entries(objs[l])) must(fn(l, n) <= ob.ceiling + 1e-9, `${what} above the ceiling at ${l}/${n}`); };
      within((l, n) => L.cProspective(l, n, now), "P12 prospective c");
      must(L.openCount("org") <= 4, "P12 more open reservations than maxOpen at the shared level");
      // P14 mid-log: replay of the log so far rebuilds the open reservations with their vectors.
      const mid = replayCap(L.log);
      must(same([...mid.open.values()], L.reservations()), "P14 complete open reservations must preserve vector mode levels and time");
      for (const l of lvls) for (const [n, ob] of Object.entries(objs[l])) {
        const st = [...(mid.committed.get(l) ?? []), ...[...mid.open.values()].filter((x) => x.levels.includes(l)).map((x) => ({ id: `res:${x.id}`, t: now, sig: x.sig, cls: x.cls, x: x.x }))];
        must(near(stepAlt(st, ob.recipes, now, o).c, L.cProspective(l, n, now)), `P14 mid-log replay prospective c differs at ${l}/${n}`);
      }
      reqs.forEach((q, i) => { if (res[i]) (r() < 0.2 ? L.expire(q.id, now + 1) : L.reconcile(q.id, q.x, now + 1, "general")); });
      within((l, n) => L.c(l, n, now + 1), "P12 committed c");
      must(L.openCount("org") === 0, "P15 a reservation leaked after reconcile or expiry");
      const rp = replayCap(L.log);
      must(rp.open.size === 0, "P14 replay left a reservation open");
      const live = reqs.map((q, i) => `${res[i] ? "grant" : "deny"}:${q.id}`).join(",");
      must(rp.decisions.join(",") === live, "P14 replay decisions differ from the live results");
      for (const l of lvls) for (const [n, ob] of Object.entries(objs[l])) must(near(stepAlt(rp.committed.get(l) ?? [], ob.recipes, now + 1, o).c, L.c(l, n, now + 1)), `P14 replay c differs at ${l}/${n}`);
      cases++;
    }
  }

  // maxOpen: requests beyond the open cap are denied even when they would fit.
  const mo = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" }, true, 2);
  const gm = await Promise.all(Array.from({ length: 5 }, (_, i) => mo.reserve(`m${i}`, ["a"], `s${i}`, { q1: 0.01 }, 0, "general", "tenant", `m${i}`)));
  must(gm.filter(Boolean).length === 2, "P12 the open cap must deny the third and later concurrent requests");

  // P15: an abort commits the delivered part only; an expiry commits nothing; neither leaks the reservation.
  const ab = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" });
  await ab.reserve("x", ["a"], "sx", { q1: 0.6 }, 0, "general", "tenant", "x");
  ab.reconcile("x", { q1: 0.2 }, 0, "general");
  must(near(ab.c("a", "o", 0), 0.2) && ab.openCount("a") === 0, "P15 an abort must commit the delivered part and close the reservation");
  await ab.reserve("y", ["a"], "sy", { q1: 0.5 }, 0, "general", "tenant", "y");
  ab.expire("y", 1);
  must(near(ab.c("a", "o", 0), 0.2) && ab.openCount("a") === 0, "P15 an expired reservation must commit nothing and close");
  const fails = async (fn: () => unknown | Promise<unknown>, what: string) => { let t = false; try { await fn(); } catch { t = true; } must(t, `fail-loud: ${what}`); };
  await fails(() => ab.reconcile("y", { q1: 0.1 }, 1, "general"), "reconcile of an expired reservation must throw");
  await fails(() => ab.reserve("z", ["a"], "sz", {}, 0, "general", "tenant", "z"), "an empty predicted vector must throw");
  await fails(() => ab.setKeyMode("z", "lenient" as unknown as CapMode, 0), "an unknown cap mode must throw");

  // P19 (vector, strict): raise or withhold before release; committed c never exceeds the ceiling, with decay and
  // deliveries later than the reservation. A strict reconcile above the reservation without a raise throws.
  const rs = rng(19);
  for (const agg of AGGS) for (const decay of [false, true]) {
    const DEC: Opts = { halfLifeH: decay ? HL : null, agg };
    for (let k = 0; k < 100; k++) {
      const objectives = { o: { recipes: [{ q1: 1, q2: 0.5 }], ceiling: 0.6 } };
      const L = new CapLedger({ a: objectives, org: objectives }, DEC, { general: "predictive", sensitive: "strict" });
      const reqs = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, pred: { q1: rs() * 0.4, q2: rs() * 0.4 }, act: { q1: rs() * 0.8, q2: rs() * 0.8 }, at: rs() * 48 }));
      const gs = await Promise.all(reqs.map((q) => L.reserve(q.id, ["a", "org"], q.id, q.pred, 0, "sensitive", "tenant", q.id)));
      // Deliveries happen in time order; c is evaluated at each delivery time and later (evaluation before a delivery is
      // not meaningful, because a future-stamped event does not decay).
      const order = reqs.map((q, i) => i).filter((i) => gs[i]).sort((x, y) => reqs[x].at - reqs[y].at);
      for (const i of order) {
        L.reconcile(reqs[i].id, await L.raiseOrWithhold(reqs[i].id, reqs[i].act, reqs[i].at), reqs[i].at, "general");
        for (const l of ["a", "org"]) for (const t of [reqs[i].at, reqs[i].at + 24]) must(L.c(l, "o", t) <= 0.6 + 1e-9, "P19 strict mode let committed c exceed the ceiling");
      }
      cases++;
    }
  }
  // P19b: a late delivery is evaluated at its own time. Reserved at 0, delivered at 240 with decay: the full delivery
  // would take c to 1, so the excess is withheld.
  for (const agg of AGGS) {
    const late = new CapLedger({ a: { o: { recipes: [two], ceiling: 0.5 } } }, { halfLifeH: { q1: 24, q2: 24 }, agg }, { general: "predictive", sensitive: "strict" });
    await late.reserve("e", ["a"], "e", { q1: 0.01 }, 0, "sensitive", "tenant", "e");
    const rel = await late.raiseOrWithhold("e", { q1: 1, q2: 1 }, 240);
    late.reconcile("e", rel, 240, "general");
    must(late.c("a", "o", 240) <= 0.5 + 1e-9, `P19b a late delivery must be checked at its own time, c=${late.c("a", "o", 240)}`);
  }
  // P14 strict mid-log: replay of a log cut after a raise restores the raised vector of the open reservation.
  const cut = new CapLedger({ a: { o: { recipes: [two], ceiling: 1 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" });
  await cut.reserve("k", ["a"], "k", { q1: 0.1 }, 0, "sensitive", "tenant", "k");
  await cut.raiseOrWithhold("k", { q1: 0.7, q2: 0.4 }, 0);
  const ro = replayCap(cut.log).open.get("k");
  must(ro !== undefined && near(ro.x.q1, 0.7) && near(ro.x.q2, 0.4) && ro.mode === "strict", "P14 replay of a log cut after a raise must restore the raised vector and the mode");
  cut.reconcile("k", { q1: 0.7, q2: 0.4 }, 0, "general");
  const empty = new CapLedger({ a: { o: { recipes: [two], ceiling: 0.5 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" });
  await empty.reserve("e", ["a"], "e", { q1: 0.2 }, 0, "sensitive", "tenant", "e");
  const none = await empty.raiseOrWithhold("e", {}, 0);
  must(Object.keys(none).length === 0, "P19 an empty classified delivery releases nothing");
  empty.reconcile("e", none, 0, "general");
  const skip = new CapLedger({ a: { o: { recipes: [two], ceiling: 0.5 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" });
  await skip.reserve("s", ["a"], "s", { q1: 0.2 }, 0, "sensitive", "tenant", "s");
  await fails(() => skip.reconcile("s", { q1: 0.9 }, 0, "general"), "a strict reconcile above the reservation without a raise must throw");
  await skip.reserve("p", ["a"], "p", { q1: 0.1 }, 0, "general", "tenant", "p").then(() => fails(() => skip.raiseOrWithhold("p", { q1: 0.2 }, 0), "a raise on a predictive reservation must throw"));
  must(skip.log.every((e) => e.mode === "strict" || e.mode === "predictive"), "P19 every cap event records its mode");

  // P20 (vector, predictive): with at most maxOpen open reservations per level and every delivered primitive at most u
  // above its prediction (a primitive absent from the prediction counts from 0), committed c exceeds the ceiling by at
  // most maxOpen * u / min(tau). Cases: one objective at tau 1 and 0.5; and two objectives where deliveries add an
  // unpredicted primitive to an objective the prediction does not name. The form without 1/min(tau) fails at tau 0.5.
  const rp = rng(20);
  let worstNew = 0, worstOld = 0;
  for (const agg of AGGS) for (const decay of [false, true]) {
    const predictiveOpts: Opts = { halfLifeH: decay ? HL : null, agg };
    for (const recipe of [{ q1: 1, q2: 1 }, { q1: 0.5, q2: 1 }] as Recipe[]) {
      const minTau = Math.min(...Object.values(recipe));
      for (let k = 0; k < 300; k++) {
        const objectives = { o: { recipes: [recipe], ceiling: 0.5 } };
        const L = new CapLedger({ a: objectives, org: objectives }, predictiveOpts, { general: "predictive", sensitive: "strict" }, true, 3);
        await L.reserve("base", ["a", "org"], "base", { q2: 1 }, 0, "general", "tenant", "base");
        L.reconcile("base", { q2: 1 }, 0, "general");
        const reqs = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, pred: { q1: rp() * 0.15 } }));
        const gp = await Promise.all(reqs.map((q) => L.reserve(q.id, ["a", "org"], q.id, q.pred, 1, "general", "tenant", q.id)));
        reqs.forEach((q, i) => { if (gp[i]) { const res = L.reconcile(q.id, { q1: Math.min(1, q.pred.q1 + MAX_UNDER_PREDICTION) }, 2, "general"); must(!res.beyondBound, "P20 delivery inside u flagged beyond the bound"); } });
        const over = Math.max(0, ...["a", "org"].map((l) => L.c(l, "o", 2) - 0.5));
        must(over <= (3 * MAX_UNDER_PREDICTION) / minTau + 1e-9, "P20 shared-level predictive overshoot exceeds bound");
        worstNew = Math.max(worstNew, over / ((3 * MAX_UNDER_PREDICTION) / minTau));
        if (minTau < 1) worstOld = Math.max(worstOld, over / (3 * MAX_UNDER_PREDICTION));
        cases++;
      }
    }
    for (const maxOpen of [1, 3]) {
      const L = new CapLedger({ a: { o1: { recipes: [{ q1: 1 }], ceiling: 1 }, o2: { recipes: [{ q3: 1 }], ceiling: 0.5 } } }, predictiveOpts, { general: "predictive", sensitive: "strict" }, true, maxOpen);
      for (let round = 0; round < 40; round += maxOpen) {
        const ids = Array.from({ length: maxOpen }, (_, j) => `u${round + j}`);
        const gp = await Promise.all(ids.map((id) => L.reserve(id, ["a"], id, { q1: 0.01 }, 0, "general", "tenant", id)));
        ids.forEach((id, j) => { if (gp[j]) L.reconcile(id, { q1: 0.01, q3: MAX_UNDER_PREDICTION }, 0, "general"); });
      }
      const over = Math.max(0, L.c("a", "o2", 0) - 0.5);
      worstNew = Math.max(worstNew, over / (maxOpen * MAX_UNDER_PREDICTION));
      cases++;
    }
  }
  must(worstNew <= 1 + 1e-9, `P20 overshoot above maxOpen * u / min(tau): ${worstNew}`);
  must(worstOld > 1, "regression: with tau 0.5 the bound maxOpen * u without the 1/min(tau) factor must fail");
  const fb = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY_CAP, { general: "predictive", sensitive: "strict" });
  await fb.reserve("f", ["a"], "f", { q1: 0.1 }, 0, "general", "tenant", "f");
  must(fb.reconcile("f", { q1: 0.9 }, 0, "general").beyondBound, "P20b a delivery beyond u must be flagged, not refused");
  return { cases, worstOld, worstNew };
}

function same(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
async function rejects(fn: () => unknown | Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  must(threw, message);
}
export const reviewChecks: { name: string; run: () => Promise<void> }[] = [
  { name: "F1/F2 scalar ownership and validation", run: async () => {
    const L = new Ledger({ k: 1, z: 1 }, true);
    const id = await L.reserveAll(["k", "z"], 0.4, 10);
    const other = await L.reserveAll(["k"], 0.4, 10);
    must(typeof id === "string" && typeof other === "string", "P12a scalar grants must issue reservation ids");
    const snapshot = () => [L.total("k"), L.total("z"), L.openCount("k"), L.openCount("z"), L.log];
    const unchanged = async (fn: () => unknown | Promise<unknown>, reason: string) => {
      const before = JSON.stringify(snapshot());
      await rejects(fn, `P12a ${reason} must throw`);
      must(JSON.stringify(snapshot()) === before, `P12a ${reason} changed state`);
    };
    for (const keys of [[], ["k", "k"], ["k", "missing"]]) await unchanged(() => L.reserveAll(keys, 0.1, 0), "invalid keys");
    for (const n of [NaN, Infinity, -0.1, 1.1]) {
      await unchanged(() => L.reserveAll(["k"], n, 0), "invalid reserve amount");
      await unchanged(() => L.raise(id as string, n, 10), "invalid raise amount");
      await unchanged(() => L.reconcile(id as string, n, 10), "invalid delivery");
    }
    await unchanged(() => L.reserveAll(["k"], 0.1, NaN), "invalid reserve time");
    for (const t of [0, NaN, Infinity]) {
      await unchanged(() => L.raise(id as string, 0.1, t), "invalid raise time");
      await unchanged(() => L.reconcile(id as string, 0.1, t), "invalid reconcile time");
    }
    await unchanged(() => L.raise("missing", 0.1, 10), "unknown raise id");
    await unchanged(() => L.reconcile("missing", 0, 10), "unknown reconcile id");
    await unchanged(() => L.reconcile(["k", "k"] as unknown as string, 0, 10), "malformed reconciliation id");
    must(await L.raise(id as string, 0.1, 10), "P19 scalar raise must attach to its reservation");
    must(!await L.raise(other as string, 0.2, 10), "P19 scalar raise must withhold excess");
    L.reconcile(id as string, 0.1, 11);
    must(near(L.total("k"), 0.5) && near(L.total("z"), 0.1) && L.openCount("k") === 1, "P15 reconcile must release only its stored reservation");
    await unchanged(() => L.reconcile(id as string, 0, 11), "closed reconcile id");
    await unchanged(() => L.raise(id as string, 0.1, 11), "closed raise id");
    must(near(replay(L.log).get("k")!, L.total("k")), "P14 scalar replay follows raises and identities");
    for (const field of ["id", "keys", "amount", "reservedAt", "t"] as const) {
      await rejects(() => replay([{ ...L.log[0], [field]: undefined } as unknown as LedgerEvent]), `P14 missing scalar event ${field} must throw`);
    }
    for (const log of [
      [...L.log, L.log[0]],
      [...L.log, L.log.at(-1)!],
      [{ ...L.log[0], type: "unknown" }],
      [{ ...L.log[0], amount: undefined }],
      [L.log[0], { ...L.log.at(-1)!, delivered: undefined }],
      [L.log[0], { ...L.log.at(-1)!, amount: 0.8 }],
      [L.log[0], { ...L.log.at(-1)!, keys: ["z"] }],
    ]) await rejects(() => replay(log as unknown as LedgerEvent[]), "P14 malformed scalar replay must throw");
  } },
  { name: "F4 reservation clock", run: async () => {
    const o: Opts = { halfLifeH: { q1: 1 }, agg: "noisy-or" };
    const L = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 0.5 } } }, o, { general: "predictive", sensitive: "strict" });
    await L.reserve("old", ["a"], "old", { q1: 0.4 }, 0, "sensitive", "tenant", "old");
    L.reconcile("old", { q1: 0.4 }, 0, "general");
    must(await L.reserve("new", ["a"], "new", { q1: 0.4 }, 100, "sensitive", "tenant", "new"), "P19 decayed history permits later reservation");
    const snap = () => JSON.stringify([L.log, L.cProspective("a", "o", 100), L.openCount("a")]);
    for (const fn of [
      () => L.reconcile("new", { q1: 0.4 }, 0, "general"),
      () => L.raiseOrWithhold("new", { q1: 0.45 }, 0),
      () => L.raiseOrWithhold("new", { q1: 0.9 }, 0),
      () => L.expire("new", 0),
      () => L.expire("new", NaN),
    ]) {
      const before = snap();
      await rejects(fn, "P19 backdated or invalid transition must throw");
      must(before === snap(), "P19 rejected transition must preserve state");
    }
    const grant = L.log.at(-1)!;
    await rejects(() => replayCap([...L.log, { ...grant, type: "reconcile", t: 0 } as CapEvent]), "P14 replay rejects a backdated transition");
  } },
  { name: "F5 unhandled inputs", run: async () => {
    const malformed = [
      () => held([], "q1", 0, { halfLifeH: null, agg: "unknown" as unknown as Aggregator }),
      () => checkEdge({ family: "invented", conf: 0.7, forge: "high", polarity: "supports" } as unknown as Edge),
      () => resolveMode(undefined as unknown as CapMode),
      () => new CapLedger({ a: {} }, NOISY, { general: "predictive", sensitive: "strict" }),
      () => replay([{ type: "unknown", keys: ["k"], amount: 1 } as unknown as LedgerEvent]),
    ];
    for (const fn of malformed) await rejects(fn, "P14 unhandled input must throw");
    const L = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY, { general: "predictive", sensitive: "strict" });
    await L.reserve("r", ["a"], "r", { q1: 0.1 }, 0, "general", "tenant", "r");
    const snapshot = () => JSON.stringify([L.log, L.reservations(), L.cProspective("a", "o", 0)]);
    for (const fn of [
      () => L.reserve("bad", ["a", "a"], "bad", { q1: 0.1 }, 0, "general", "tenant", "bad"),
      () => L.reserve("bad", [], "bad", { q1: 0.1 }, 0, "general", "tenant", "bad"),
      ...[NaN, Infinity, -0.1, 1.1].flatMap((v) => [
        () => L.reserve("bad", ["a"], "bad", { q1: v }, 0, "general", "tenant", "bad"),
        () => L.raiseOrWithhold("r", { q1: v }, 0),
        () => L.reconcile("r", { q1: v }, 0, "general"),
      ]),
    ]) {
      const state = snapshot();
      await rejects(fn, "P12 invalid capability input must throw");
      must(state === snapshot(), "P12 invalid capability input must preserve state");
    }
    const before = JSON.stringify(L.log);
    await rejects(() => L.expire("r", NaN), "P15 expiry requires finite time");
    must(JSON.stringify(L.log) === before && L.openCount("a") === 1, "P15 rejected expiry preserves state");
    await rejects(() => replayCap([...L.log, L.log.at(-1)!]), "P14 duplicate open grant must throw");
    for (const field of ["id", "levels", "sig", "cls", "mode", "domain", "tenant", "key", "x", "t", "reservedAt"] as const) {
      await rejects(() => replayCap([...L.log.slice(0, -1), { ...L.log.at(-1)!, [field]: undefined } as unknown as CapEvent]), `P14 missing event ${field} must throw`);
    }
  } },
  { name: "F6 lineage-bearing refusals", run: async () => {
    for (const agg of AGGS) for (const decay of [false, true]) {
      const o: Opts = { halfLifeH: decay ? HL : null, agg };
      const refused: Ev = { id: "refused", t: 10, sig: "refused", x: { q1: 1 }, delivered: false, consumes: [{ key: "source|q1", cls: "source|q1", p: "q1", v: 1, t: 0 }] };
      must(step([refused], { q1: 1 }, 24, o).c === 0, "P17 lineage-bearing refusal must contribute zero with or without decay");
      const base: Ev = { id: "base", sig: "base", t: 0, x: { q1: 0.2 } };
      must(near(step([base, refused], { q1: 1 }, 24, o).c, step([base], { q1: 1 }, 24, o).c), "P17 refusal must preserve existing capability");
    }
  } },
  { name: "F7 complete replay cuts and exact releases", run: async () => {
    for (const agg of AGGS) for (const decay of [false, true]) {
      const o: Opts = { halfLifeH: decay ? HL : null, agg };
      const L = new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } }, org: { o: { recipes: [{ q1: 1 }], ceiling: 0.5 } } }, o, { general: "predictive", sensitive: "strict" });
      const cut = () => {
        let rp: ReturnType<typeof replayCap>;
        try { rp = replayCap(L.log); } catch (error) { throw new Error(`invariant violated: P14 replay must handle every event type: ${error}`); }
        must(same([...rp.open.values()], L.reservations()), "P14 complete open reservations must preserve vector mode levels and time");
        must(same(rp.decisions, L.log.filter((e) => e.type === "grant" || e.type === "deny").map((e) => `${e.type}:${e.id}`)), "P14 replay must retain every decision");
        for (const l of ["a", "org"]) {
          const deliveries = L.log.filter((e): e is ReservationEvent => e.type === "reconcile" && e.levels.includes(l) && Object.keys(e.x).length > 0).map((e) => ({ id: e.id, t: e.t, sig: e.sig, cls: e.cls, x: e.x }));
          must(same(rp.committed.get(l) ?? [], deliveries), "P14 complete committed deliveries must survive each log cut");
          must(near(step(deliveries, { q1: 1 }, 12, o).c, L.c(l, "o", 12)), "P14 live and replayed committed capability must agree");
        }
      };
      await L.reserve("s", ["a", "org"], "s", { q1: 0.1, q2: 0.1 }, 10, "sensitive", "tenant", "s"); cut();
      await L.reserve("p", ["a", "org"], "p", { q1: 0.1 }, 10, "general", "tenant", "p"); cut();
      await L.reserve("deny", ["a", "org"], "deny", { q1: 0.9 }, 10, "general", "tenant", "deny"); cut();
      const raised = await L.raiseOrWithhold("s", { q1: 0.2, q2: 0.05, q3: 0.1 }, 11);
      must(same(raised, { q1: 0.2, q2: 0.05, q3: 0.1 }), "P19 granted raise must release the exact delivery"); cut();
      const withheld = await L.raiseOrWithhold("s", { q1: 0.9, q2: 0.05, q4: 0.4 }, 11);
      must(same(withheld, { q1: 0.2, q2: 0.05, q4: 0 }), "P19 denied raise must release the exact elementwise minimum"); cut();
      L.reconcile("s", withheld, 12, "general"); cut();
      L.expire("p", 12); cut();
    }
  } },
  { name: "F7 excess on every primitive and committed beyond-bound delivery", run: async () => {
    for (const agg of AGGS) for (const decay of [false, true]) for (const p of PRIMS) for (const absent of [false, true]) {
      const o: Opts = { halfLifeH: decay ? HL : null, agg };
      const config = { a: { o: { recipes: [{ [p]: 1 }], ceiling: 1 } }, org: { o: { recipes: [{ [p]: 1 }], ceiling: 1 } } };
      const pred = { [absent ? "other" : p]: 0.1 };
      const D: Opts = { ...o, halfLifeH: decay ? { ...HL, other: 24 } : null };
      const S = new CapLedger(config, D, { general: "predictive", sensitive: "strict" });
      await S.reserve("s", ["a", "org"], "s", pred, 10, "sensitive", "tenant", "s");
      const before = JSON.stringify(S.log);
      await rejects(() => S.reconcile("s", { [p]: 0.9 }, 11, "general"), "P19 strict excess must throw on every primitive including absent predictions");
      must(JSON.stringify(S.log) === before && S.openCount("org") === 1, "P19 rejected excess preserves state");
      const L = new CapLedger(config, D, { general: "predictive", sensitive: "strict" });
      await L.reserve("p", ["a", "org"], "p", pred, 10, "general", "tenant", "p");
      const result = L.reconcile("p", { [p]: 0.9 }, 11, "general");
      must(result.beyondBound && near(result.underPrediction, absent ? 0.9 : 0.8), "P20 excess must be measured on every primitive including absent predictions");
      must(L.openCount("org") === 0 && L.log.length === 4 && L.log[3].type === "reconcile" && same(L.log[3].x, { [p]: 0.9 }), "P20 beyond-bound delivery must be logged and close the reservation");
      const rp = replayCap(L.log);
      for (const l of ["a", "org"]) must(near(L.c(l, "o", 11), 0.9) && near(step(rp.committed.get(l) ?? [], { [p]: 1 }, 11, D).c, 0.9) && rp.open.size === 0, "P20 beyond-bound delivery must be committed and replayed");
    }
  } },
  { name: "F3 release fence", run: async () => {
    const FLOORS: Record<string, CapMode> = { general: "predictive", sensitive: "strict" };
    const make = (atomic = true) => new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY_CAP, FLOORS, atomic);
    const replayC = (L: CapLedger, now: number): number => {
      try { return stepAlt(replayCap(L.log).committed.get("a") ?? [], [{ q1: 1 }], now, NOISY_CAP).c; } catch (err) { throw new Error(`P15 replay failed: ${(err as Error).message}`); }
    };
    // Release, release, then expiry: the cumulative released vector is committed at the last release time.
    const A = make();
    await A.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    must(same(await A.release("r", { q1: 0.2 }, 1), { q1: 0.2 }), "P15 a release returns the cumulative released vector");
    must(same(await A.release("r", { q1: 0.5 }, 2), { q1: 0.5 }), "P15 a later release raises the cumulative released vector");
    A.expire("r", 5);
    must(near(A.c("a", "o", 5), 0.5), "P15 expiry commits the released vector as delivered");
    must(same(A.log[A.log.length - 1].x, { q1: 0.5 }) && A.log[A.log.length - 1].type === "expire", "P15 the expiry record carries the released vector");
    must(near(replayC(A, 5), 0.5), "P15 replay commits the released vector of an expired reservation");
    await rejects(() => A.release("r", { q1: 0.1 }, 6), "P15 a release after expiry must throw");
    await rejects(() => A.reconcile("r", { q1: 0.5 }, 6, "general"), "P15 a late reconcile after expiry must throw");
    // Expiry without a release commits nothing.
    const B = make();
    await B.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    B.expire("r", 5);
    must(B.c("a", "o", 5) === 0 && same(B.log[B.log.length - 1].x, {}), "P15 expiry with no release commits nothing");
    // Concurrent release and expiry: the expiry runs first, so the release is refused and nothing is sent.
    const C = make();
    await C.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    const pending = C.release("r", { q1: 0.3 }, 1);
    C.expire("r", 1);
    await rejects(() => pending, "P15 a release that loses the race with expiry must be refused");
    must(!C.log.some((e) => e.type === "release") && C.c("a", "o", 1) === 0, "P15 a refused release leaves no release record");
    // Negative control: a read-then-write release succeeds after the expiry and leaves released bytes uncommitted.
    const N = make(false);
    await N.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    const racy = N.release("r", { q1: 0.3 }, 1);
    N.expire("r", 1);
    let raced = false;
    try { await racy; raced = N.c("a", "o", 1) === 0; } catch { raced = false; }
    must(raced, "P15 negative control: a read-then-write release after expiry leaves released bytes uncommitted");
    // Reconcile must cover the released vector; an abort that delivered exactly the released part is accepted.
    const D2 = make();
    await D2.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    await D2.release("r", { q1: 0.4 }, 1);
    await rejects(() => D2.reconcile("r", { q1: 0.2 }, 2, "general"), "P15 a reconcile below the released vector must throw");
    D2.reconcile("r", { q1: 0.4 }, 2, "general");
    must(near(D2.c("a", "o", 2), 0.4) && near(replayC(D2, 2), 0.4), "P15 an aborted stream commits its released part");
    // Strict: a release above the raised reservation throws; a release within it is accepted after a raise.
    const S = make();
    await S.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "sensitive", "t", "k");
    await rejects(() => S.release("r", { q1: 0.5 }, 1), "P15 a strict release above its reservation must throw");
    const ok = await S.raiseOrWithhold("r", { q1: 0.5 }, 1);
    must(same(await S.release("r", ok, 1), { q1: 0.5 }), "P15 a strict release within the raised reservation is accepted");
    S.reconcile("r", { q1: 0.5 }, 2, "sensitive");
    must(near(replayC(S, 2), 0.5), "P15 replay of a strict raise, release and reconcile restores the committed state");
    // Malformed releases throw.
    const M = make();
    await M.reserve("r", ["a"], "s", { q1: 0.3 }, 5, "general", "t", "k");
    for (const [x, t] of [[{}, 6], [{ q1: NaN }, 6], [{ q1: 0.1 }, 4]] as [Record<string, number>, number][]) await rejects(() => M.release("r", x, t), "P15 a malformed or backdated release must throw");
  } },
  { name: "F10a store failure", run: async () => {
    const FLOORS: Record<string, CapMode> = { general: "predictive", other: "predictive", sensitive: "strict" };
    const make = () => new CapLedger({ a: { o: { recipes: [{ q1: 1 }], ceiling: 1 } } }, NOISY_CAP, FLOORS);
    let up = false, probes = 0;
    const L = make();
    const P = new ReservationProxy(L, () => { probes++; return up; }, 2);
    const strict = await P.reserve("s1", ["a"], "s1", { q1: 0.2 }, 0, "sensitive", "t", "k1");
    must(probes === 3 && same(strict, { outcome: "unavailable", code: UNAVAILABLE_CODE, attempts: 3 }), "P22 a strict-domain request is refused after exactly three attempts");
    must(!JSON.stringify(strict).toLowerCase().includes("store"), "P22 the refusal names no internal component");
    L.setKeyMode("k3", "strict", 0);
    must((await P.reserve("s3", ["a"], "s3", { q1: 0.2 }, 0, "general", "t", "k3")).outcome === "unavailable", "P22 a key that opted up to strict is refused");
    for (const id of ["u1", "u2"]) must((await P.reserve(id, ["a"], id, { q1: 0.2 }, 0.1, "general", "t", "k1")).outcome === "unreserved", "P22 a request outside the strict domains is served unreserved");
    must((await P.reserve("u3", ["a"], "u3", { q1: 0.2 }, 0.2, "other", "t", "k1")).outcome === "unavailable", "P22 an anchor past the outage limit is refused in every domain");
    must((await P.reserve("v1", ["a"], "v1", { q1: 0.2 }, 0.2, "general", "t", "k2")).outcome === "unreserved", "P22 the outage limit applies to one anchor only");
    must((await P.reserve("u4", ["a"], "u4", { q1: 0.2 }, 1.5, "general", "t", "k1")).outcome === "unavailable", "P22 a locked-out anchor stays refused until the store answers");
    must((await P.reserve("v2", ["a"], "v2", { q1: 0.2 }, 1.5, "general", "t", "k2")).outcome === "unreserved" && (await P.reserve("v3", ["a"], "v3", { q1: 0.2 }, 1.6, "general", "t", "k2")).outcome === "unreserved", "P22 the per-anchor count resets each hour");
    must(same(P.lockedOutAnchors(), ["k1"]), "P22 only the anchor over its limit is locked out");
    for (const [id, v] of [["u1", 0.3], ["u2", 0.1], ["v1", 0.2], ["v2", 0.1], ["v3", 0.1]] as [string, number][]) P.deliverUnreserved(id, { q1: v }, 2);
    must(L.log.filter((e) => e.type === "unreserved").length === 0, "P22 unreserved deliveries are held until the store answers");
    up = true;
    const back = await P.reserve("g1", ["a"], "g1", { q1: 0.1 }, 3, "general", "t", "k1");
    must(back.outcome === "granted" && back.attempts === 1, "P22 the anchor is served again when the store answers");
    const unres = L.log.filter((e) => e.type === "unreserved").map((e) => e.id);
    must(same(unres, ["u1", "u2", "v1", "v2", "v3"]), "P22 every unreserved delivery is written to the log in order");
    const expectC = 1 - [0.3, 0.1, 0.2, 0.1, 0.1].reduce((k, v) => k * (1 - v), 1);
    must(near(L.c("a", "o", 3), expectC), "P22 unreserved deliveries commit like predictive deliveries");
    must(near(stepAlt(replayCap(L.log).committed.get("a") ?? [], [{ q1: 1 }], 3, NOISY_CAP).c, expectC), "P22 replay includes unreserved deliveries");
    must(same(P.lockedOutAnchors(), []), "P22 the lockout clears when the store answers");
    // A request whose delivery was never reported blocks the flush loudly.
    const L2 = make();
    let up2 = false;
    const P2 = new ReservationProxy(L2, () => up2, 1);
    await P2.reserve("x", ["a"], "x", { q1: 0.1 }, 0, "general", "t", "k");
    up2 = true;
    await rejects(() => P2.reserve("y", ["a"], "y", { q1: 0.1 }, 1, "general", "t", "k"), "P22 an unreported unreserved delivery must throw at the flush");
    for (const bad of [-1, 1.5, NaN]) await rejects(() => new ReservationProxy(make(), () => false, bad), "P22 an invalid outage limit must throw");
    await rejects(() => new ReservationProxy(make(), () => "yes" as unknown as boolean, 1).reserve("z", ["a"], "z", { q1: 0.1 }, 0, "general", "t", "k"), "P22 a store probe that is not boolean must throw");
  } },
  { name: "release, outage and replay regressions", run: async () => {
    const FLOORS: Record<string, CapMode> = { general: "predictive", sensitive: "strict" };
    const make = (o: Opts = NOISY_CAP) => new CapLedger({ a: { o: { recipes: [{ q1: 1 }, { q2: 1 }], ceiling: 1 } } }, o, FLOORS);
    // Backoff: the store is probed at the request time and after each backoff step.
    const times: number[] = [];
    const P0 = new ReservationProxy(make(), (_i, t) => { times.push(t); return false; }, 5);
    await P0.reserve("b", ["a"], "b", { q1: 0.1 }, 2, "general", "t", "k");
    must(times.length === 3 && near(times[0], 2) && near(times[1], 2 + 100 / 3.6e6) && near(times[2], 2 + 500 / 3.6e6), "P22 store attempts follow the increasing backoff");
    must(P0.alerts.length === 1 && P0.alerts[0].outcome === "unreserved" && P0.alerts[0].key === "k", "P22 a request that exhausted its attempts raises one alert");
    // Admission validates first: a duplicate id or an unknown level is refused before any byte is served.
    await rejects(() => P0.reserve("b", ["a"], "b", { q1: 0.1 }, 2, "general", "t", "k"), "P22 a duplicate held id must throw before admission");
    await rejects(() => P0.reserve("c", ["missing"], "c", { q1: 0.1 }, 2, "general", "t", "k"), "P22 an unknown level must throw before admission");
    must(P0.alerts.length === 1, "P22 a refused admission raises no alert");
    // Tenant opt-up is refused during an outage.
    const T = make();
    T.setTenantMode("t2", "strict", 0);
    must((await new ReservationProxy(T, () => false, 5).reserve("x", ["a"], "x", { q1: 0.1 }, 0, "general", "t2", "k")).outcome === "unavailable", "P22 a tenant that opted up to strict is refused");
    // A failure midway through the flush leaves committed entries out of the queue.
    const L = make();
    let up = false;
    const P = new ReservationProxy(L, () => up, 5);
    for (const id of ["A", "B"]) await P.reserve(id, ["a"], id, { q1: 0.1 }, 0, "general", "t", "k");
    P.deliverUnreserved("A", { q1: 0.2 }, 1);
    up = true;
    await rejects(() => P.reserve("C", ["a"], "C", { q1: 0.1 }, 2, "general", "t", "k"), "P22 a flush with an unreported delivery must throw");
    P.deliverUnreserved("B", { q1: 0.2 }, 1);
    await P.reserve("D", ["a"], "D", { q1: 0.1 }, 3, "general", "t", "k");
    must(same(L.log.filter((e) => e.type === "unreserved").map((e) => e.id), ["A", "B"]), "P22 a retried flush commits each held delivery once");
    // A caller that changes its vector after the call cannot change the record.
    const M = make();
    await M.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    const x = { q1: 0.2 };
    const pending = M.release("r", x, 1);
    x.q1 = NaN;
    await pending;
    must(same(M.log[M.log.length - 1].x, { q1: 0.2 }), "P15 a release records the vector as it was at the call");
    // Cumulative release over decreasing and disjoint components.
    must(same(await M.release("r", { q1: 0.1, q2: 0.4 }, 2), { q1: 0.2, q2: 0.4 }), "P15 the cumulative release keeps the maximum of every component");
    // Raise after expiry throws.
    const S = make();
    await S.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "sensitive", "t", "k");
    S.expire("r", 1);
    await rejects(() => S.raiseOrWithhold("r", { q1: 0.3 }, 2), "P15 a raise after expiry must throw");
    // With decay, an expired reservation commits its released vector at the last release time, live and in replay.
    const DEC: Opts = { halfLifeH: { q1: 24, q2: 24 }, agg: "noisy-or" };
    const E = make(DEC);
    await E.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    await E.release("r", { q1: 0.8 }, 0);
    E.expire("r", 48);
    must(near(E.c("a", "o", 48), 0.2), "P15 expiry commits the released vector at the last release time");
    must(near(stepAlt(replayCap(E.log).committed.get("a") ?? [], [{ q1: 1 }, { q2: 1 }], 48, DEC).c, 0.2), "P15 replay commits the released vector at the last release time");
    // Replay rejects a reconcile or expiry dated before the last release.
    const R = make();
    await R.reserve("r", ["a"], "s", { q1: 0.3 }, 0, "general", "t", "k");
    await R.release("r", { q1: 0.2 }, 10);
    R.reconcile("r", { q1: 0.2 }, 11, "general");
    const tampered = R.log.map((e) => ({ ...e }));
    (tampered[tampered.length - 1] as ReservationEvent).t = 1;
    await rejects(() => replayCap(tampered), "P15 replay of a reconcile before the last release must throw");
  } },
];
function additiveScore(events: Ev[], recipe: Recipe): number {
  const prims = Object.keys(recipe);
  return events.reduce((s, e) => s + prims.reduce((t, p) => t + (e.x[p] ?? 0), 0), 0) / prims.length;
}

if (import.meta.main) {
  console.log("| event | progress c | leading g | marginal uplift |");
  console.log("|-------|-----------|-----------|-----------------|");
  for (const row of workedExample()) console.log(row);
  const { cases } = runInvariants();
  console.log(`invariants P1-P3, P5, P6, P8-P10, P17, P18, P18b and bounds, with and without decay: ${cases} cases pass`);
  runNegativeControls();
  console.log("negative controls and fail-loud inputs: pass (a re-stamped relay raises progress; the earlier merge rule is not in use; NaN, unknown classes and unreserved reconciles throw)");
  runLinkageChecks();
  console.log("linkage evidence, forge-cost cap, origin rule and rung gate checks P11a-P11n, P16: pass");
  const res = await runReservationChecks();
  console.log(`count budget ledger P12a, P12b, P13-P15, P21 mode selection: pass; of 10 concurrent requests the atomic ledger granted ${res.atomicGranted} and the racy ledger granted ${res.racyGranted}; across five sibling keys under one organisation the atomic ledger granted ${res.orgAtomic} and the racy ledger granted ${res.orgRacy}`);
  const cap = await runCapChecks();
  for (const check of reviewChecks) await check.run();
  console.log(`capability cap (vector reservation) P12, P12c, P14, P15, P19, P20: ${cap.cases} cases pass; concurrent complementary requests: vector ledger grants 1 of 2, scalar marginal and read-then-write controls grant 2 of 2 and exceed the ceiling; P20 worst overshoot ${cap.worstNew.toFixed(3)} of maxOpen * u / min(tau); the form without 1/min(tau) reaches ${cap.worstOld.toFixed(3)} of its bound at tau 0.5`);

  // Duplicate test: same-signature copies of an event that covers all three requirements.
  const full: Ev = { id: "f", t: 0, sig: "full", x: { q1: LEVEL_VALUE.high, q2: LEVEL_VALUE.high, q3: LEVEL_VALUE.medium } };
  const copies: Ev[] = Array.from({ length: 20 }, (_, i) => ({ ...full, id: "f" + i }));
  const cOne = step([full], R, 100, NOISY).c, cMany = step(copies, R, 100, NOISY).c;
  must(near(cOne, cMany), "twenty same-signature copies must not change progress");
  console.log(`duplicate test: one event c=${fmt(cOne)}, twenty same-signature copies c=${fmt(cMany)}; additive score one=${fmt(additiveScore([full], R))}, twenty copies=${fmt(additiveScore(copies, R))}`);
  must(additiveScore(copies, R) > additiveScore([full], R) * 10, "negative control: the additive score should grow with the copies");

  // Complementary fragments versus a padded single fragment (the covered requirements differ).
  const distinct3 = canary.filter((e) => e.id === "e1" || e.id === "e3" || e.id === "e5");
  console.log(`complementary fragments: three distinct pieces c=${fmt(step(distinct3, R, 96, NOISY).c)}`);

  // Aggregator ablation on a single-requirement recipe.
  const single: Recipe = { q1: 1 };
  const paraphrases: Ev[] = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, t: i, sig: `para${i}`, cls: "one-idea", x: { q1: LEVEL_VALUE.low } }));
  const oneHigh: Ev[] = [{ id: "h", t: 0, sig: "h", x: { q1: LEVEL_VALUE.high } }];
  const refine: Ev[] = [
    { id: "r1", t: 0, sig: "r1", cls: "design", x: { q1: LEVEL_VALUE.low } },
    { id: "r2", t: 1, sig: "r2", cls: "impl", x: { q1: LEVEL_VALUE.low } },
    { id: "r3", t: 2, sig: "r3", cls: "test", x: { q1: LEVEL_VALUE.low } },
  ];
  console.log("aggregator ablation, recipe {q1: 1}: progress c");
  console.log("| aggregator | 20 paraphrases of one low idea | 3 complementary low pieces | one high event |");
  console.log("|------------|-------------------------------|----------------------------|----------------|");
  for (const agg of AGGS) {
    const o: Opts = { halfLifeH: null, agg };
    console.log(`| ${agg} | ${fmt(step(paraphrases, single, 100, o).c)} | ${fmt(step(refine, single, 100, o).c)} | ${fmt(step(oneHigh, single, 100, o).c)} |`);
  }
  const CM: Opts = { halfLifeH: null, agg: "class-max-noisy-or" };
  must(step(paraphrases, single, 100, NOISY).c > 0.99, "noisy-or saturates on paraphrases (the documented weakness)");
  must(step(paraphrases, single, 100, CM).c < 0.4, "class-max keeps paraphrases flat");
  must(step(refine, single, 100, CM).c > step(paraphrases, single, 100, CM).c, "class-max separates complementary pieces from paraphrases");
  console.log("property cases (executed assertions):");
  for (let n = 1; n <= 22; n++) {
    const root = `P${n}`;
    const names = [...new Set([root, ...[...propertyCounts.keys()].filter((p) => new RegExp(`^P${n}[a-z]?$`).test(p))])].sort();
    for (const name of names) console.log(`${name}: ${propertyCounts.get(name) ?? 0}${name === "P7" ? " (structural: no edge input)" : ""}`);
  }
}
