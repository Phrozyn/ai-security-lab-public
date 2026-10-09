# Composition Function: Specification

Specification of the function that measures how far a set of events has progressed toward a capability, for the design in [`distributed-intent-detection.md`](distributed-intent-detection.md). Status: design, sixth revision. Nothing here is deployed. The example values are synthetic. An executable reference implementation is in [`intent/reference/`](../intent/reference/).

The primitive vocabulary, the bottleneck composition, the recipes and the forge-cost classes are design hypotheses with no published source. Established methods are cited in the References section with the level at which each citation was checked.

## Question

Given a set of individually mundane events, what makes their composition more dangerous than the sum of their labels?

The answer used here: an objective needs several capability primitives at once, so danger is a bottleneck over what the objective requires. A set is dangerous when it covers every requirement, and each event alone covers few. Summing labels over-counts repeated events and under-counts the one missing piece.

## Scope

- The function measures capability held toward a named objective. It does not classify content as harmful. Objectives and their recipes are an input from the operator, because a recipe encodes content policy.
- Capability is conditional on a candidate set. Whether the events belong together is a separate score. Linkage evidence controls candidate-set membership and may also gate cluster responses; it is never numerically folded into capability.
- The draft vocabulary is cyber-flavoured. Other domains are out of scope for the first version.

## Capability primitives

A primitive is an entry in a closed, versioned vocabulary. It names what an output adds to a capability. It does not name an adversary goal, because goals describe why an actor acts, and many benign roles share them.

| Primitive | What the output adds |
|-----------|----------------------|
| `access_acquisition` | a way into a system or an account |
| `credential_material` | secrets, tokens or the means to derive them |
| `execution_enablement` | the ability to run attacker-chosen code or commands |
| `persistence_enablement` | the ability to stay after the first access |
| `target_specificity` | detail that ties the capability to one victim or system |
| `operationalisation` | conversion of an idea into a working form |
| `evasion` | reduction of the chance of detection |
| `chaining` | the glue that lets separate pieces run in sequence |
| `automation` | repeatable execution at scale |

Harness runs use synthetic primitives `q1`, `q2` and `q3`, so no harmful content is needed.

Enrichment emits one level per primitive: `none`, `low`, `medium` or `high`. Each level maps to a number in [0, 1], increasing with the level, and `none` maps to 0. The mapping is calibrated on harness data. The event's uplift bucket is the maximum primitive level.

## Objectives

An objective has a domain and a recipe: for each required primitive p, a threshold `tau_p` above 0 and at most 1. The canary objective requires `q1`, `q2` and `q3`, each with a threshold of 1.

A recipe may list alternative requirement sets. Progress is then the maximum of `c` over the alternatives, and the leading indicator is the maximum of `g` over the alternatives, each taken per alternative. Parallel progress on several alternatives is a separate feature and is not folded into `g`. Recipes are versioned separately from the vocabulary, reviewed before use, and tested against incomplete variants. A domain without recipes is covered by the unmapped-volume monitor and the behavioural signals in the design, and a novel-domain holdout experiment measures how well.

## Contributions and held capability

A contribution is one primitive level that one distinct piece of content supplied.

- A contribution has a stable key, made of the reformulation signature and the primitive. When an artifact carries the contribution from a producing event to a consuming event, the consumer receives the same contribution with the same key, value and time. It is not a new contribution.
- Contributions with the same key are one contribution. A key can have several appearances, each a value and a time. Per key, the held value is the best decayed appearance, so adding an appearance can only raise it. A relay chain of events re-presents the original appearance and adds nothing beyond the first.
- A propagated copy keeps the original appearance, so propagation does not refresh the clock. A direct re-request is a new appearance with its own time and refreshes the key. Whether that refresh produces false positives for legitimate repeated use is checked in the harness.
- Each contribution has a near-duplicate class that is a function of its signature, assigned by near-duplicate clustering. Paraphrases of one idea share a class.
- Only delivered content counts. A refused request, or a request whose response was withheld, adds no capability and counts only as intent evidence. A request-based estimate is used before delivery, for the reservation only.

For primitive p at time `now`, let `z_i` be the value of each distinct contribution after decay. Three aggregators are specified:

- `noisy-or`: `h_p = 1 - product of (1 - z_i)`.
- `max`: `h_p = maximum of z_i`.
- `class-max-noisy-or`: take the maximum within each near-duplicate class, then noisy-or across classes.

Decay halves a contribution every half-life of primitive p. Half-lives are parameters.

The result is a saturating score and not a probability. Noisy-or is a heuristic borrowed from probabilistic graphical models, where it rests on independent causal influence. The contributions here are not independent: they come from one model, adjacent prompts are causally related, and the labels come from one classifier. The aggregator is therefore a parameter that the harness chooses. For a single-requirement recipe, twenty paraphrases of one low idea score 1.000 under plain noisy-or, the same as one high event, while `class-max-noisy-or` scores them 0.333 and still gives three complementary low pieces 0.704.

## Progress, leading indicator and marginal uplift

- `a_p = min(1, h_p / tau_p)` is the attainment of each required primitive.
- `c(S, now) = minimum over required p of a_p` is the progress.
- `g(S, now) = mean over required p of a_p` is the leading indicator; for alternative requirement sets it is the maximum over the alternatives.
- `delta(e | S, now) = c(S + e, now) - c(S, now)` is the marginal composition uplift of event e, with both terms evaluated at the same time.

Reading the values:

- `c` is zero until every required primitive has some held capability. The first event with a positive `delta` is the one that first supplies the last untouched requirement. A later event that strengthens the current weakest primitive can have a larger `delta`.
- `g` shows approach and drives scrutiny, not enforcement. Recipes of different sizes dilute `g` differently, so `g` is thresholded per objective and is not comparable across objectives.
- `delta` depends on the state S, so enrichment cannot compute it from one event.

## Worked example

Synthetic canary objective with recipe `q1`, `q2`, `q3`, each with a threshold of 1. Event e1 gives `q1` high. Event e2 repeats e1 with the same signature. Event e3 gives `q2` high. Event e4 is benign. Event e5 gives `q3` high. The values come from a reference implementation.

| Event | Progress c | Leading g | Marginal uplift |
|-------|-----------|-----------|-----------------|
| e1 | 0.000 | 0.333 | 0.000 |
| e2 | 0.000 | 0.333 | 0.000 |
| e3 | 0.000 | 0.667 | 0.000 |
| e4 | 0.000 | 0.667 | 0.000 |
| e5 | 1.000 | 1.000 | 1.000 |

Each event alone scores 0 against the objective and the set scores 1. A per-event check sees nothing until e5, and `g` shows the approach from e3.

Duplicate test: an event that covers `q1` high, `q2` high and `q3` medium scores `c` of 0.667. Twenty same-signature copies still score 0.667, while the additive label score grows from 0.889 to 17.778. An additive rule ranks the padding twenty times higher, so it fails the case the design needs.

Aggregator ablation, recipe `q1` with a threshold of 1, progress c:

| Aggregator | 20 paraphrases of one low idea | 3 complementary low pieces | One high event |
|------------|-------------------------------|----------------------------|----------------|
| noisy-or | 1.000 | 0.704 | 1.000 |
| max | 0.333 | 0.333 | 1.000 |
| class-max-noisy-or | 0.333 | 0.704 | 1.000 |

## Linkage evidence score

Whether the events of a set belong to one process is a separate score.

- For each signal family f, `z_f` is the maximum over supporting edges of confidence times a factor for the forge-cost class. Two edges of one family count once.
- For each family f, `s_f` is the maximum over its supporting edges of medium or high forge cost of confidence times the factor, and 0 when it has none. `k_low` is the low-forge cap.
- Support is `min(1 - product over families of (1 - z_f), 1 - (1 - k_low) * product over families of (1 - s_f))`. Each family counts once, at its best edge. Without a medium- or high-cost edge the second term equals `k_low`, so evidence of low forge cost alone never exceeds it. Both terms only rise when an edge is added.
- A contradicting edge, such as impossible timing or mutually exclusive authenticated ownership, has an origin: the platform observed it, or the actor supplied or controls it. `m` is the maximum over contradicting edges of confidence times the same factor, taken over contradictions of platform origin and medium or high forge cost only. Any other contradiction sends a new merge to human review, does not block it and never lowers the score of an existing member, so an actor cannot erase evidence or stay unlinked with contradictions it makes. A contradiction may remove trust and never detection.
- The score is `support * (1 - m)`.

The score is a linkage evidence score and not a probability. The families are separated by provenance root, which is a rule against counting one observation twice. They are not statistically independent: content drives trajectory, refusal behaviour is content-derived, and identity correlates with infrastructure. Calibration to a probability needs labelled linkage cases from the harness. The score never changes `c`. An exact hash of a public artifact is an edge of low forge cost, and evidence of low forge cost alone, from one family or several, cannot raise the score above `k_low`.

## Cap flow: reservation and reconciliation

The inline cap check and the delivered label are different quantities.

- Predicted uplift is an estimate from the request-based label, available before delivery. It is not an upper bound on what the model delivers.
- Delivered uplift comes from the delivered label, available after the response.

The flow is: request, atomic reservation of the predicted primitive vector against the ceiling on `c` of every objective at every budget level the request touches, generation, delivered classification, and reconciliation that records the delivered vector and closes the reservation.

- The reservation is a vector. `c` is not additive: two requests that each add nothing to `c` alone can complete an objective together. A reservation of predicted marginal uplift therefore reserves 0 for each of two concurrent complementary requests and admits both. Instead, under one lock, the reservation builds the prospective state from the delivered vectors, every open reserved vector and this vector, composed by the same aggregation as delivered contributions, recomputes `c` for every objective at every budget level the request touches, such as key, organisation and anchor, and grants only if each stays within its ceiling. Every objective is checked, and not only those the prediction names, because a delivery can add capability the prediction did not name, and those additions would otherwise accumulate on an objective that no reservation checks. Locks are taken per budget level and objective in a fixed order. A reserved vector has not been delivered and is evaluated at the evaluation time; a delivery is a new appearance at its own time. Each grant records its mode, and replay restores the open reservations with their vectors. In the reference, two concurrent requests that supply the two halves of a two-primitive recipe are admitted together by a marginal-uplift ledger and by a read-then-write vector ledger, and reach `c` 1 against a ceiling below 1; the atomic vector ledger admits one. Sent one after the other, the marginal-uplift ledger denies the second, so the gap is specific to concurrency.
- Count budgets, such as requests per period, are additive and use a scalar reservation with the same atomicity. In the reference, of ten concurrent requests a read-then-write ledger grants all ten and the atomic ledger grants only the three that fit; the same holds across five sibling keys under one organisation.
- Grants, denials, raises, withholds, reconciliations and expiries are events in the log. Replay reads those records and does not re-evaluate a ceiling, so `c` stays a pure function of the log.
- Reconciliation records what was delivered. An aborted stream keeps the delivered part. An expired reservation records what was released under it and nothing more.
- The ceiling has two modes. Strict: the response is classified before release, the reservation is raised to the classified delivery before release, and the excess is withheld if the raised vector does not fit, so classified `c` never exceeds the ceiling at a budget level where every key that draws on it runs strict. A key set to strict inside a tenant that is not gives the key a hard ceiling and the tenant none. Predictive: delivery may exceed the reservation. With at most `maxOpen` open reservations at a budget level, counted over every actor that shares the level, and a declared bound `u` on how far a delivered primitive level exceeds its prediction, `c` stays within the ceiling plus `maxOpen * u / min(tau)`, where `min(tau)` is the smallest required level of the affected recipes: a contribution raised by `u` raises a held level by at most `u` under each aggregator, the attained share by at most `u / tau`, and the minimum by at most the largest change of its arguments. Without the `1 / min(tau)` factor the bound is wrong; in the reference it is exceeded when `tau` is below 1. A delivery beyond `u` is recorded and flagged and never refused. The prediction can be steered low, so harm is judged against the ceiling plus this overshoot. Which domains run strict, and how a response is routed between modes, is policy. Strict mode can also be enabled for a whole tenant or account; a setting can raise the mode to strict and never lower it below the operator's floor.
- Reservations have a time limit and a cap on concurrent reservations per actor, so slow streams cannot hold a shared budget.
- Release is fenced. Bytes are sent only after a release record commits in the same transaction that confirms the reservation is open. Expiry and release take the same lock, so an expired reservation releases nothing further, and what was released before expiry is recorded as delivered. A transaction keeps the ledger consistent; it cannot recall bytes once they are sent, so the record comes first.
- When the reservation store does not answer, the request is retried a small number of times with backoff. In high-uplift domains it then fails closed with a generic service-unavailable response that names no internal component. Elsewhere the request is served, held in memory and charged to the budget of its actor at its delivered level when the store answers, up to a per-actor limit per hour; past that limit the actor fails closed in every domain until the store answers.
- When only a prefix of a response was classified, the unclassified tail is counted at the reserved vector and never lower than the classified prefix. That is conservative only as far as the prediction covers the tail, so strict mode does not release content beyond the classified bytes.

## Use in the response

| Use | Reads | Linkage needed |
|-----|-------|----------------|
| Per-anchor cap | `c` over the anchor's own events, with the reservation | none |
| Scrutiny | `g` over a low bound, or a rule hit | none or low |
| Friction | `c` over a bound plus corroboration from independent evidence types | yes, for cluster sets |
| Quarantine, automatic | `c` over a bound, linked, and confirmed by deterministic evidence with a corroborating trajectory | yes |
| Quarantine, reviewed | `c` over a bound and linked, without that confirmation: queued for a human decision while friction holds | yes |
| Suspension and cluster action | human decision with per-member `c` and the linkage evidence score | yes |

Cluster actions use capability, linkage quality and corroborating evidence according to policy. The per-anchor cap and scrutiny read no linkage. A response rung is the highest rung whose row is satisfied. Thresholds on `c`, `g` and the linkage evidence score are parameters set from harness data. The composition judge reads these values as inputs and contributes to scrutiny; the rungs above scrutiny need the evidence named in their rows.

Membership changes. `c` is recomputed from the current member set whenever membership changes, with no stored residue, so a split rebuilds each part from the event log alone. A false merge adds the other party's contributions in full, which is a deliberate trade: admission needs independent evidence families, responses that need linkage read the linkage evidence score, and the per-anchor cap holds without linkage. A fragment just below the merge bound adds nothing to the cluster, which is a recall cliff that a linkage-off ablation bounds.

## Properties

Each property holds under frozen inputs: fixed recipe, primitive labels, signature classes, candidate set and evaluation time. Late-event re-derivation, backfill after a vocabulary change and recomputed cluster membership change the inputs and are outside these statements. The reference implementation, [`intent/reference/ce_reference.ts`](../intent/reference/ce_reference.ts), checks them on random cases and has negative controls. [`intent/reference/cap_mutants.ts`](../intent/reference/cap_mutants.ts) applies one-line mutants to a copy of it, and each mutant must fail a named property.

| Id | Property |
|----|----------|
| P1 | Adding an event never lowers progress, and `delta` is never negative, with and without decay |
| P2 | An event that repeats an existing contribution at no higher level and no later time changes nothing, with and without decay |
| P3 | The order of events does not change the result, under random permutations, with and without decay |
| P4 | If a required primitive has no held capability, `c` is 0; this follows from the minimum and is kept as a regression guard |
| P5 | Chained relay events that only pass existing appearances along change nothing, with and without decay |
| P6 | The same events give the same result |
| P7 | `c` is a function of the event set only, and no edge input exists |
| P8 | Later evaluation with decay never raises `c` for a fixed set |
| P9 | Propagation through an artifact does not reset a contribution's clock |
| P10 | max is at most class-max-noisy-or, which is at most noisy-or |
| P11 | Two edges of one family count once, an independent family raises the linkage evidence score, adding a supporting edge never lowers it, evidence of low forge cost alone stays within the low-forge cap, a contradicting edge never raises it, a contradiction of low forge cost or of actor origin leaves it unchanged and sends a merge to review, and it stays between 0 and 1 |
| P12 | Concurrent reservations cannot take `c` over delivered and open reserved vectors above the ceiling of any objective at any budget level; a count budget's concurrent reservations cannot exceed its ceiling |
| P12c | Concurrent complementary requests that each add nothing alone cannot together take `c` above the ceiling |
| P19 | Strict mode: with a raise to the classified delivery or withholding of the excess, classified `c` never exceeds the ceiling |
| P20 | Predictive mode: `c` stays within the ceiling plus `maxOpen * u / min(tau)` while each delivered primitive stays within `u` of its prediction |
| P13 | A partial label is the elementwise maximum of the classified prefix and the prediction |
| P14 | Replay of the recorded decisions gives the live grant and deny sequence and the live `c`, without re-evaluating a ceiling |
| P15 | An aborted stream records what was delivered, an expired reservation records what was released under it, a release after expiry is refused, and neither leaves a reservation open |
| P16 | High `c` with a low linkage evidence score, or with a single evidence type, does not reach friction; quarantine is automatic only with deterministic evidence corroborated by the trajectory, and otherwise the case stays at friction and is queued for review |
| P17 | A refused or withheld event adds nothing |
| P18 | With alternative requirement sets, progress and the leading indicator are each the maximum over the alternatives |
| P22 | When the reservation store does not answer after the retries, a strict request is refused with a generic response, other requests are served unreserved up to a per-actor limit, and unreserved deliveries are recorded when the store answers |

A passing check shows that the implementation matches this document. It does not show that the function detects anything.

## Hypotheses and falsifiers

| Hypothesis | Rule | Rejected when |
|------------|------|---------------|
| H1 | bottleneck: the minimum over required primitives | on canary runs, redundant events raise detection as much as complementary ones |
| H2 | additive over all events | it is rejected as a detector when padding with redundant events raises its score without adding capability |
| H3 | progress follows the artifact lineage graph only | complementary fragments with no lineage still assemble the canary and H3 misses them |
| A1 | held capability by maximum | iterative refinement of one primitive never reaches its threshold when it should |
| A2 | plain noisy-or | paraphrases of one idea saturate it |
| A3 | class-max-noisy-or | a genuine slow build inside one near-duplicate class is blocked |

The harness runs the aggregator ablation against exact duplicates, paraphrases, complementary fragments and legitimate iterative refinement before the aggregator is fixed. The padding scenario separates H1 from H2. The unlinked-fragments scenario separates H1 from H3 and needs the harness.

## Known weaknesses

- An actor who obtains one required primitive off-platform keeps `c` at 0 whatever else the platform supplies. The function bounds only what this platform supplies. Alternative requirement sets and `g` mitigate it, and the harness runs an all-but-one scenario.
- No recipe means no progress, and a wrong recipe misses harmful composition or flags legitimate work.
- Contributions are correlated, so the aggregators are scores.
- The near-duplicate class is only as good as the clustering that assigns it.
- The level-to-number mapping is a placeholder.
- The prediction used for a reservation is not an upper bound. In predictive mode the ceiling is soft by up to `maxOpen * u / min(tau)`, and that bound holds only while the classifier's under-prediction stays within `u`, which the harness measures.
- Vector reservation recomputes `c` for every objective at every budget level under a lock on each request, which costs inline latency, and once one objective is over its ceiling every further reservation at that level is denied.
- The near-duplicate class is a security boundary: redundant pieces can be shaped to land in different classes, and complementary refinements can be collapsed into one.
- A contradiction observed by the platform that an actor can still induce, for example through timing it arranges, lowers the linkage evidence score. Per-anchor caps bound what that gains.

## Open questions

- Calibration of the level mapping, the forge-cost factors and the per-event bound on labelled harness data.
- Whether the refresh from a direct re-request produces false positives for legitimate repeated use.
- The units of the cap budget.
- A generalised mean in place of the hard minimum.
- Whether `target_specificity` should be a primitive or a join key.
- Who writes recipes beyond the canaries, and how they are reviewed.
- Half-lives per primitive, and whether a long-lived floor is needed against sleeper accumulation.
- How the near-duplicate class is computed, and its error rate.

## References

Levels: re-fetched means the page text was read for this document; agent-read means a research agent read it.

1. J. Pearl, Probabilistic Reasoning in Intelligent Systems, Morgan Kaufmann, 1988. The book itself was not read. The causal-independence assumption was read in Zhang and Poole, Exploiting Causal Independence in Bayesian Network Inference, JAIR 1996: https://www.alphaxiv.org/abs/cs/9612101 (re-fetched). It names the noisy OR-gate as the well-known example and states that each effect variable is conditionally independent of the other causes given its own cause.
2. A. Z. Broder, On the resemblance and containment of documents, SEQUENCES 1997: https://paperswelove.org/papers/on-the-resemblance-and-containment-of-documents-973f823a/ (re-fetched).
3. M. Dworkin, NIST SP 800-38D, Galois/Counter Mode and GMAC, 2007: https://csrc.nist.gov/pubs/sp/800/38/d/final (re-fetched, abstract only).
4. R. Chandramouli and E. Hibbard, NIST SP 800-88 Rev. 2, Guidelines for Media Sanitization, 2025: https://csrc.nist.gov/pubs/sp/800/88/r2/final (re-fetched, abstract page).
5. Sigma Correlation Rules Specification v2.1.0: https://sigmahq.io/sigma-specification/specification/sigma-correlation-rules-specification.html (re-fetched).
6. OWASP Cross-Site Request Forgery Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html (re-fetched).
7. L. Paninski, Estimation of entropy and mutual information, Neural Computation 15, 2003: https://www.cns.nyu.edu/~lcv/pubs/makeAbs.php?loc=Paninski03 (re-fetched).
8. R. Rossellini et al., Can a calibration metric be both testable and actionable?, COLT 2025: https://proceedings.mlr.press/v291/rossellini25a.html (re-fetched).
9. R. Barnes et al., RFC 9180, Hybrid Public Key Encryption, 2022: https://www.rfc-editor.org/rfc/rfc9180 (re-fetched).
