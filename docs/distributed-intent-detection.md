# Distributed Intent Detection: Design

Design for detecting malicious intent that is spread across time, prompts, accounts and intermediate outputs. This is a defensive design for an LLM gateway. It describes components, data and tests. It contains no prompt text, no thresholds, no starting values and no operational configuration. Deployment configuration and decision logic are outside this document, which summarises them at a high level only.

Status: design only. Nothing in this document is deployed. No Sigma rule from this design is in `detections/rules/`, because no rule has fixtures captured from a running stack yet.

## Problem

Distributed intent is a capability assembled by composition. A set of events E under a composition function C reaches a harm threshold H, so C(E) >= H, while every member stays below it, so C(e) < H for each event e. A per-event check measures C(e) and compares it to H, so it passes by construction.

Decomposition moves are described at mechanism level, along four axes:

| Axis | Mechanisms |
|------|-----------|
| Time | slow drip of small steps; reconnaissance, a quiet period, then use; a long benign history before the first step that matters |
| Prompts | one task split into routine sub-tasks; each turn building on the previous answer; a refused request restated in a narrower or reframed form |
| Accounts | one step per identity; roles split across identities; rented or borrowed high-trust identities |
| Intermediate outputs | an answer pasted into the next request or passed by an agent to the next tool call; a component kept under a harmless framing and assembled later; an artifact placed where another party's pipeline retrieves it |

Intent cannot be observed. It is inferred over a set of events. Three sub-problems follow: linkage (which events form a set), accumulation (what the set adds up to) and judgement (when that sum triggers a response).

## Scope and non-goals

- The design sits beside the per-message guardrail and does not replace it.
- Content policy is an input. The taxonomy below is a label set and does not define policy.
- Detection is not guaranteed. The design prices attacks and bounds the harm an identity can accumulate. Controls that depend on grouping events can be broken by a determined actor, so one control, the identity-bounded cap, bounds the capability accumulated per anchor whatever the linkage quality. Its effect across a whole system depends on the cost and integrity of anchor issuance.
- Deployment steps, host details and operational findings are out of scope for this document.

## Layers

| Layer | Role | Implemented as |
|-------|------|----------------|
| Capture and provenance | events, actors, infrastructure attributes, artifacts, trust labels | code |
| Enrichment | taxonomy tags, refusal flag, signatures, hashes | model call with a closed output schema |
| Linkage graph | typed, explained edges and clusters; conditional on scale | code, optional embeddings |
| Accumulation | per-key and per-cluster state, windows, sketches, artifact ledger | code |
| Detection | Sigma correlation rules, cumulative scoring, composition judge (conditional on scale) | code, model call for the judge |
| Response | ladder, trust-tier caps, feedback controls | code and human review |
| Evaluation | canary-objective harness, metrics, regression gate | code |

Properties:

- Data flows downward. Raw content exists in the capture layer and in a short-retention raw store. Accumulation and everything above it operate on derived data.
- Capture, linkage, accumulation, response and evaluation are deterministic code. Enrichment and the judge are model calls.
- Every model-calling layer has a closed output schema. Output outside the schema is rejected and counted.
- In predictive mode, only capture, the first, cheap stage of enrichment and the cap reservation run before the response is returned, and the added latency is held within a latency budget. Strict-mode policy also holds a response until the response classifier has run, which costs latency. The one inline control that depends on state is the cap reservation. Everything else runs asynchronously.

### Scale profiles

| Profile | Population | Layers in force |
|---------|-----------|-----------------|
| Small operator | a handful of keys, one operator | capture, enrichment, per-key accumulation, rules, caps and ladder, harness |
| Growth | many keys, cross-key traffic exists | adds primitive and uplift labels and a linkage graph used for prioritisation |
| Provider | large multi-tenant | all layers, with the graph as a prioritisation signal for human review |

The graph becomes informative when the number of distinct identities and the amount of cross-identity traffic exceed what the operator's own key list answers. The deployment enables cross-identity correlation only above activation conditions that are part of its private configuration. For a small operator the graph is the key list.

## Capture and provenance

### Event schema

| Group | Fields |
|-------|--------|
| Identity | event id, idempotency key, user id, key id, organisation |
| Infrastructure | client address (raw tier only), address hash, network number when a source is configured, user agent (raw tier only), client fingerprint (keyed hash of the user agent) |
| Channel | session id, conversation id, parent event id |
| Time | timestamp, clock source, sequence number (monotonic per source) |
| Artifacts | hashes of artifacts produced and consumed |
| Provenance | origin, trust |
| Content | pointer into the raw store; derived response fields: SHA-256, MinHash sketch, length, finish reason, guard label (no response text) |
| Enrichment | filled by the enrichment layer |

Rules for the fields:

- The client address is the socket peer address of the connection to the capture proxy. Forwarded headers are honoured only from configured trusted proxies, because a client can send any value in them.
- The idempotency key is the client's request id when the client sends one. Otherwise it is a hash of the key id, a digest of the request body, the route and model, and a short arrival bucket. A retry is confirmed only when a client request id is present and the body digest matches, and it then updates one event. A fallback match is stored as a possible retry with a link and is not merged. The same request id with a different body digest is stored as two events and flagged.
- The network number comes from a configured offline database. When none is configured the field is null with a reason code and no value is guessed.
- Cross-source ordering uses the timestamp after skew correction, and the sequence number within a source. Late events are handled by a bounded rule. Every late event is stored, flagged and counted, and none is dropped silently. Temporal boundary conditions are exercised by the harness.
- State is a pure function of the event log. Replaying the same log twice gives identical state. Every enrichment label is persisted on the event and replay reads the stored labels without calling a model again. Lateness is classified once at ingest from the persisted ingest time and corrected event time, and the classification is stored on the event, so a replay never reclassifies an event by the time at which it runs. Determinism is scoped to one taxonomy version and one enrichment model version.

### Provenance and trust

Origin is one of `user`, `model`, `tool`, `retrieved`, `third-party`. Trust derives from origin. User input is attributed to the actor, model output to the model run, and tool, retrieved and third-party content to its source. Third-party content is not attributed to a user's intent by default: a document that carries an instruction and enters a context through retrieval raises the risk of the document and of the retrieving pipeline. When the same actor authored, uploaded or controls the source, the content is attributed to that actor. Every agent chain has an accountable principal, the key or organisation that started it.

### Capture component

- A capture proxy in TypeScript listens on the gateway's address and forwards to the gateway, which moves to an internal port. Clients keep the address they use.
- The proxy reads the request up to a size limit, scrubs secrets, seals the text, inserts the event row and forwards the request.
- In predictive mode the proxy streams the response through while computing the SHA-256 digest, the MinHash sketch, the length and token counts. In strict mode the proxy holds the response, or releases it in classified chunks, until it is classified.
- A bounded in-memory copy of the response goes to a response classifier and is then dropped. Every delivered label records how much of the response it covers, and the unclassified part of a response is counted at the predicted level, never below the classified part. The prediction does not bound the unclassified part, so in strict mode nothing beyond the classified part is released.
- Capture failure handling is a deployment setting. Every capture failure is counted and alerted on, and capture degradation is treated as possibly induced: while it lasts, caps are tightened, so an unobserved interval is bounded as well as counted. Stricter failure handling belongs to the enforcement phase and needs its own approval.
- The proxy enforces request and response size caps, upstream and total timeouts, and bounded memory for streams.
- A health gate sends a canary request through the full path after a cutover. A failed canary stops the proxy and restores the previous port. The rollback is rehearsed on a scratch stack before the first live cutover.

## Retention and privacy tiers

| Tier | Content | Retention |
|------|---------|-----------|
| Raw | request text, timestamp, user agent, client address, key and user ids, request id; no response text | shortest; a configured period with a hard maximum |
| Enriched | tags, flags, signatures, hashes, counters, derived response fields | a configured period |
| Sketch | per-key and per-cluster counters, held-capability vectors, embeddings of cluster summaries | a configured period |

- Accumulation and above run on the enriched and sketch tiers and need no raw text. Raw text serves the enrichment worker, re-enrichment after a taxonomy change inside the retention window, recalibration and human inspection.
- Sealing. Each raw row is encrypted with a random per-row data key (AES-GCM, 256-bit). The data key is sealed to a public key. The capture proxy holds only the public key. The private key is held by the enrichment worker and the inspection tool and is not on the proxy, in CI or in repository secrets, so a compromised proxy does not expose stored history.
- Key epochs rotate on the schedule set by the key epoch parameter. Destroying a retired epoch's private key makes its rows unreadable (crypto-shred). The capture side refuses to seal to an epoch key past its usage period. The sealed record holds an algorithm and version tag, the nonce, the ciphertext, the authentication tag and the sealed data key. Each data key encrypts one message, so a nonce cannot repeat under one key. The data key is sealed with a standard hybrid public key encryption construction or an equivalent library sealed box, and no construction is invented. Persisted digests and MinHash sketches are derived sensitive metadata: low-entropy material can be dictionary-tested by a reader of the data, and a sketch exposes similarity structure.
- Secret scrubbing. Before sealing, credential shapes in request text are replaced by typed placeholders plus a keyed hash, so reuse of one secret stays visible. The placeholder names the version of the hashing key, so the key can rotate and a join across a rotation uses version and hash; the key is held as an encrypted service credential. The scrubber is pattern-based and misses some secrets, so encryption is the primary control.
- Access. No role can select the raw table directly. Reads go through a function that writes an access log with the reader, the event and the reason.
- Response handling. The response is processed in memory. Persisted fields are the SHA-256, the MinHash sketch, lengths, token counts, the finish reason and the classifier label. No table has a column for response text.
- Copies. The capture proxy logs event ids and sizes and never a body. Error logs and crash dumps exclude bodies, and core dumps are disabled for the capture and enrichment containers. The gateway's own prompt logging stays off.
- Backups are retained for no longer than the raw retention period. A restore proof checks row counts and checksums without decrypting.
- Purge. A daily job deletes raw rows older than the raw retention period, verifies the deletion by row count and fails on a mismatch. Each parameter that sets a retention has a hard maximum.
- The private key is backed up offline in two places. A counter of rows that fail to decrypt makes a lost or wrong key visible.
- Stored text is kept byte-exact inside the sealed blob. At log and display time control characters are neutralised so text cannot forge log lines or markup.
- Zero-retention mode sets the raw retention period to zero. Enrichment then runs on in-memory text and only derived fields persist. Re-enrichment and inspection are unavailable in this mode.
- When a cluster is actioned, an evidence digest of tags, edges, scores, rule hits and hashes is frozen at decision time.

## Enrichment

Each event receives:

- `domain` from the operator's taxonomy, with an `unmapped` bucket, and a level for each capability primitive in a closed, versioned vocabulary. Volume in `unmapped` has its own monitor, because a harm domain missing from the taxonomy never accumulates.
- An uplift bucket (`none`, `low`, `medium`, `high`). The bucket is the intrinsic contribution of one event, judged from its own text and response without any knowledge of the actor's other events. A question that names a sensitive topic and adds no capability scores `none`. The marginal capability a set gains from an event depends on what the actor holds, so accumulation computes it from the event and the held state.
- A refusal flag and a reformulation signature, a normalised fingerprint that lets a refusal followed by a restated request be matched.
- An artifact type and a MinHash sketch for each produced artifact, derived from the response in memory.
- A delivered label from a response classifier run in memory. Request-based labels measure what was asked for. The delivered label measures what was sent back, and caps use it where it exists. The label records how much of the response it covers, and the unclassified part is counted at the predicted level, never below the classified part.
- The taxonomy version.

Capability vocabulary. A primitive names what an output adds, such as access acquisition, credential material, execution enablement, persistence enablement, target specificity, operationalisation, evasion, chaining or automation. It does not name an adversary goal. Tactic coverage is a weak proxy for composition, because administrators, researchers and testers touch many tactics, so the design does not use an attack-framework tactic list as its stage vocabulary. An optional analyst-facing mapping to such a framework may exist in the review view, and no rule or cap reads it. The bucket above is the maximum primitive level of the event.

Vocabulary change. A new vocabulary version triggers a backfill: events with raw text inside retention are re-enriched, and the others are flagged `stale_taxonomy`. A change follows five steps: write the candidate vocabulary file with its checksum; list added, removed and renamed primitives against the current version; record each change in a reviewed mapping file; shadow-enrich a sample and compare label histograms; cut over and backfill.

Output contract. The enrichment model returns one JSON object with closed enums for domain, a level per primitive, uplift bucket, refusal flag and artifact type, plus a confidence value. Output that does not parse, contains a value outside an enum or carries extra free-text fields is rejected, stored as an `enrichment_rejected` event with the cause, and never defaulted to a benign label. The rejection rate per cluster is a detection feature. Event text reaches the model as data through the API message structure, and delimiters are never built by concatenating event text into a prompt string.

The closed schema protects the parser and does not contain the classifier. Text can still be written to steer the labels, so the enrichment layer is treated as an adversarially exposed sensor. The domain enum includes `uncertain`, which is counted per cluster, never read as benign and routed to deeper review. The model's confidence value is advisory until its calibration against harness truth is measured, and rules use deterministic features beside the labels. Label stability under equivalent rewrites is measured, and disagreement between cascade stages on one event is a per-cluster feature.

Cascade. Enrichment is staged: an inexpensive classifier on every event, and deeper model review on a subset chosen by the deployment's selection logic, together with a random sample drawn independently of that logic, so staying below a trigger does not guarantee skipping deeper review. A new enrichment model runs in shadow beside the live one and cuts over after a label-distribution check and an agreement check against a labelled set.

## Linkage and accumulation

The linkage graph connects events and identities with typed edges, each with an explanation, and groups them into clusters. It is used in the Growth and Provider profiles. In the small operator profile the key list is the graph. Each edge stores its type, evidence source, confidence, collision rate, directionality, an expiry and a forge cost class, which is the ordinal cost to an adversary of creating or avoiding the edge. Merge weight scales confidence by forge cost, so cheap edges move a cluster less. Matching an artifact hash has a low forge cost when the artifact is public. Edges have a polarity: a contradicting edge that the platform observed, and that is costly to forge, lowers the linkage evidence score, so the score can fall as well as rise. A contradiction the actor could produce sends a merge to human review and lowers nothing. Exact artifact hashes break under encoding and wrapper changes, so a transformed artifact can be linked by a similarity edge over its sketch, which is weaker evidence with its own forge cost and does not carry capability at full weight. The score is not a probability, because the families are separated by provenance root and are statistically dependent.

Composition is evaluated against objectives, and the function is specified in [`composition-function.md`](composition-function.md). An objective lists the capability primitives it requires and a level for each. Held capability per primitive is aggregated over the distinct contributions of a set, with decay, so repeated events add nothing. Capability is a function of the event set only and has no edge input. Progress against an objective is the minimum, over its required primitives, of the attained share. A set therefore scores high only when it covers every requirement, even when each event covers one, and the event that supplies the last untouched requirement is the first whose marginal uplift is positive; a later event that strengthens the weakest primitive can have a larger one. A separate figure, the linkage evidence score, says how strongly the events are one process. It is computed from the typed edges by signal family and never changes progress. The identity-bounded cap counts progress over the anchor's own events and reads no linkage.

Accumulation keeps per-key and per-cluster state over windows with decay, using sketches to bound storage. It tracks held capability, progress against objectives and the marginal composition uplift of each event over the set, trajectory features, and an artifact ledger that records which outputs feed later requests and carries taint along the lineage. A contribution has a stable identity, so a contribution that travels through an artifact carries its original value and clock, relay chains neither double count nor refresh decay, and a direct re-request is a new appearance. The aggregator over distinct contributions is a parameter chosen by an ablation, and its output is a saturating score and not a probability.

## Detection

Detection rules are Sigma correlation rules over normalised fields of the event schema. The field set includes event type, refusal flag, primitive levels, domain, uplift bucket, cluster id, template signature, consumed artifact hash, a cross-account lineage flag and a count of attained primitives.

- Rule syntax is checked with `pipx run sigma-cli check` at a pinned version. The validator checks syntax only and does not check that fields exist, so a separate CI step compares rule fields with the normalised field table.
- The repository's own rule validator supports event-count rules only, so correlation types beyond that need a local evaluator over fixtures. The external validator is the conformance authority.
- The rules in this design have no fixtures captured from a running stack yet. They are not in `detections/rules/` and are added there only together with fixtures captured from the running stack.
- An optional composition judge reads typed labels and numbers and returns a verdict within a closed schema. It runs only in profiles where the scale threshold is met.

## Response

The response ladder has six levels. Each level names the evidence it needs, and each level through quarantine is reversible.

| Level | Action | Evidence required |
|-------|--------|-------------------|
| Log | record only | any rule hit |
| Scrutiny | stronger classifier on later events, longer memory window | one rule hit or a score over a low threshold |
| Friction | step-up verification, lower uplift ceiling for the session | corroboration from independent evidence types |
| Quarantine | degrade or hold high-uplift responses for the key, human review queued | automatic when deterministic evidence is corroborated by the trajectory; otherwise a human decision, with friction holding while the case is queued |
| Suspension | suspend a key or account | human decision on an evidence package, with an appeal path |
| Cluster action | act on a cluster | human decision with per-member evidence, with an appeal path |

- Signal families. Two signals are independent only when their provenance roots differ. The families are content semantics, artifact lineage, authenticated identity, network infrastructure, behavioural trajectory, refusal and reformulation, delivered capability and human attribution. A derived signal carries the family of the observation it came from, so an address hash, a network number and a client fingerprint count as one network signal.
- Suspension and cluster action need a human decision with per-member evidence, because shared-egress populations such as a class or a team would otherwise be punished for one member.
- When a cluster is actioned, its past events are re-scored and earlier grants are revoked or sent for review, with the same per-member evidence requirement.
- The human review queue is sized by a review budget and a service-level target. When the queue is full, lower-severity items are dropped first. Reviewers see summaries and tags by default, and raw content is opt-in and audited.
- Appeals use a separate rate-limited channel handled by a human.
- Red-team and harness keys are tagged, logged and expire. They are excluded from automatic actions only; detection and alerting stay on for them.
- Every decision is appended to a hash-chained log in which each record carries the hash of the previous one. The chain detects accidental damage. It is tamper-evident against a writer who can rewrite the whole chain only when the chain head is checkpointed at a fixed interval to a store that writer cannot modify, such as a signed checkpoint file on a second host or object-lock storage.

Caps. Each key has a trust tier. Each tier has an uplift ceiling per domain per period, and new accounts start with a near-zero ceiling in high-uplift domains. The ceiling is counted per identity-cost anchor, the attribute a cap is counted against, chosen because creating a new one costs an adversary something. In a small deployment the anchor is the key owner recorded when the key is issued. A product can add a payment instrument or a verified organisation. Accounts behind one anchor share one budget. An actor who obtains many anchors holds many budgets, so anchor issuance is counted per source and anchor churn is tested in the harness. The cap check reserves the predicted capability vector before dispatch: under a lock per budget level and objective, it recomputes progress over the delivered and the open reserved vectors plus this one, and grants only if progress stays within the ceiling. After the response it records the delivered vector. A reservation of a single predicted number is unsafe, because two concurrent requests that supply complementary pieces each add nothing alone and complete the objective together. The prediction is an estimate, so the ceiling on delivered capability is strict where responses are classified before release and soft by a declared, measured bound elsewhere (see the cap flow in [`composition-function.md`](composition-function.md)). Account age or benign history alone cannot raise a ceiling in a high-uplift domain. The count-based part of a cap (aggregate rate and request budget per anchor) needs no model. An uplift cap uses the enrichment labels.

Feedback controls. Refusal text and timing do not vary with the reason or score. Enforcement is batched and delayed. The harness measures how much detector state leaks through observable outcomes, and a leakage budget is a regression gate.

## Evaluation

The canary-objective harness measures detection without generating harmful content. It defines proxy objectives that are harmless and forbidden inside the test environment, such as assembling a canary string whose parts are returned by separate benign-looking requests, or retrieving a planted marker document through a chain of steps.

| Axis | Scenario |
|------|----------|
| Time | one fragment per day, including a delay longer than the taint half-life |
| Prompts | fragments split across turns, with a scripted restatement after a scripted refusal |
| Accounts | each key holds one fragment and a coordinator joins them |
| Intermediate outputs | the output of one step is the input of the next across two keys |
| Adaptive probing | a scripted adversary observes enforcement outcomes and adjusts timing and splitting |
| Intermediate outputs | the actor plants a marker document and retrieves it through its own pipeline |
| Prompts | fragments of one canary split across two taxonomy domains |
| Time | temporal boundary conditions are exercised for each temporal parameter |
| Accounts | the same canary assembled under many independently budgeted anchors, including newly issued and borrowed ones |
| Accounts | benign events attached to a malicious cluster and malicious events attached to benign clusters, to measure susceptibility to graph poisoning |
| Time | many concurrent requests against one anchor's pre-update state, asserting that progress over delivered and reserved capability stays within the ceiling |
| Time | concurrent requests that each add nothing alone and supply complementary missing pieces, asserting that together they cannot exceed the ceiling; the same requests one after another; aborted and expired reservations |
| Outputs | all but one requirement supplied here and the last one external |
| Outputs | an artifact passed on with encoding, whitespace or wrapper changes |
| Prompts | many paraphrases of one capability against complementary pieces, comparing the aggregators |
| Prompts | a recipe with a missing requirement |
| Prompts | two alternative requirement sets advanced in parallel, each kept below its bound |
| Accounts | contradicting evidence planted by the actor on its own fragments |
| Outputs | delivered capability above the prediction, in each cap mode |

Capture tests assert idempotency in both directions: distinct requests are never collapsed into one event, and a reused request id with a different body is flagged. Over-deduplication hides evidence and under-deduplication inflates accumulation.

Novel-domain holdout: one capability family is excluded from the taxonomy and from tuning, and the harness checks whether the `unmapped` monitor and behavioural composition still surface it. This separates a detector from a taxonomy recognizer.

Each scenario has an obfuscated variant (language switch, encoding change). A label-poisoning set measures how often judge verdicts flip when text is shaped to steer the enricher.

A detector tuned on harmless proxies may not transfer to production distributions, and the harness cannot measure that gap. Two checks bound it: periodic expert review of flagged production cases, and comparison of proxy-scenario feature distributions with those of flagged clusters.

Metrics:

| Metric | Definition |
|--------|-----------|
| Canary uplift before containment | uplift reached in a scenario before the first quarantine action, per axis |
| Queries to evasion | probes the adaptive adversary needs to reach a fixed share of the canary objective undetected |
| Recall at fixed false-positive rate | share of scenarios detected at a rate fixed on benign replay |
| Time to detect | events and wall-clock time from the first fragment to the first scrutiny action |
| Cluster purity and merge error | share of members in the true set; share of true sets split or falsely merged |
| Judge calibration | expected calibration error and Brier score against harness truth |
| Bits leaked per probe | plug-in estimate of mutual information between probe parameters and enforcement outcome, with a bootstrap interval; reported, and gated only after the estimator, the discretisation and the minimum sample size are specified |
| Cascade miss rate | share of cascade-skipped clusters that a full-judge audit flags, from a periodic sample |
| Linkage-off ablation | detection and containment with the graph disabled and only caps active |
| Enrichment rejection rate | rejected events per thousand |
| Label stability | share of events whose labels are unchanged under semantically equivalent rewrites |
| Response coverage | share of delivered responses classified in full |
| Signal-family ablation | detection and containment with one signal family removed at a time |
| Graph-poisoning susceptibility | change in cluster purity and in rung reached under the counterfactual linkage scenario |
| Novel-domain detection | share of holdout-family scenarios surfaced by the `unmapped` monitor or behavioural composition |
| Anchor integrity | measured cost and time to obtain a new usable anchor, and anchors issued per source |
| Under-prediction | share of responses whose delivered capability exceeds the reservation, and the size of the excess |

Labelling. Benign replay is the operator's own traffic, labelled benign by default and reviewed on every flag. Flag review sees only the detector-selected tail, so error rates measured from it are circular. A random sample of unflagged events, drawn independently of any detector score, is reviewed by a human and rates are computed from that sample. Harness truth is known by construction. Flagged production cases are labelled by a human reviewer, with a second reviewer on disputed cases.

Regression gate. Thresholds are parameters in the parameters file. The harness and the rule check run on every change to rules, taxonomy or the enrichment model, and a replay determinism test replays one event log twice and requires an empty diff. Go/no-go thresholds for linkage recall and false-merge rate are set from measured data before any build that depends on the graph.

## Privacy and governance

| Layer | Minimisation |
|-------|-------------|
| Capture | raw text, address and user agent only in the sealed raw tier; keyed hashes elsewhere; no responses |
| Enrichment | closed set of labels; no free text stored |
| Linkage | edges store types, confidences and ids; embeddings expire with the sketch tier |
| Accumulation | counters and vectors only |
| Detection | the judge sees typed labels and numbers |
| Response | reviewers see summaries by default; raw access is opt-in, role-gated and logged |

- Retention periods and the legal basis for retaining raw text and for cross-account linking need review by counsel and vary by jurisdiction. This document asserts neither.
- Transparency. The terms of service or privacy notice states that usage is monitored for misuse across sessions and, where permitted, across linked accounts, and that requests are retained for the stated raw retention period for misuse detection only. The notice covers every person whose requests are stored, collaborators included, and is published before the first capture deploy.
- Every read of the raw store or a cluster view requires a named role and is logged with a reason.
- A deletion request for an actor propagates to tags, sketches, edges and cluster membership within a stated deletion lag. Frozen evidence digests are retained under a stated legal-hold rule. Deletion requests are a counted signal per anchor. Anchor-level budget counters hold no personal content.
- Membership and score features are checked for disparate effect on groups such as shared-egress users, region and language. A feature that flags a population without a link to uplift is removed.
- Aggregate dashboards suppress clusters with fewer than a minimum number of distinct users.

## Infrastructure as code and CI/CD

Everything is declared in the repository and applied through CI/CD.

- Parameters. All tunables live in one parameters file validated by a JSON schema in CI. Each retention and budget parameter has a hard maximum, enforced by a database CHECK constraint on the stored policy table, a CI policy test and CODEOWNERS approval on the file. No threshold is a literal in code.
- Database. The component uses its own database with its own roles. Migrations are forward-only, checksummed, idempotent and follow expand-then-contract. Roles are defined in SQL: capture (insert only), enricher (reads raw only through the logging function), accumulator, viewer (views only), purge (delete on raw by age), drift (system catalog, plus one function that returns the migration and parameter digests) and inspector (raw only through the logging function, a separate reader from the enricher). Denial probes assert the exact SQLSTATE and each has a positive control.
- Secrets. No secret is in the repository. Compose files use the `${VAR:?set VAR}` pattern so a missing secret fails the start. The sealing key pair is generated on the enrichment host, and only the public key is distributed.
- Scheduled jobs are declared in a jobs file: purge, coverage snapshot, baseline recompute and key epoch rotation. Scheduled workflows run the nightly canary harness with a tagged test key, a weekly backup with restore proof and a daily drift check.
- Images are pinned by digest, GitHub Actions by commit SHA, and tools run with bunx at an exact version.

CI jobs:

| Job | Pass condition |
|-----|----------------|
| unit tests | capture, scrubber, sealing and enrichment contract pass; a canary secret never appears in stored text |
| parameters | schema valid; every value within its hard maximum |
| migrations | applied twice to an ephemeral Postgres with no change on the second run; denial probes return the exact SQLSTATE; no column stores response text |
| detections | validator reports no errors; each rule passes true-positive, true-negative and boundary fixtures; every rule field is in the normalised table |
| harness | scenarios run against a fake upstream and a deterministic fake labeller; metrics meet the thresholds in the parameters file |
| determinism | two replays of one log give an empty state diff |
| dashboards | datasource healthy; every dashboard loads; every panel query runs; no panel references a raw column |
| privacy lint | a canary marker sent through the stack is absent from logs, dashboards, SQL views and CI artifacts |
| docs lint | no banned words, em dashes or numeric thresholds in this document |

The stack runs in CI against an ephemeral Postgres and a fake upstream, so a run is deterministic and needs no model host. A new job starts as a non-required check and becomes required after a run of stable results.

Deploy workflow. The workflow lives in the private repository only and is excluded from the public output. It runs from the main branch, uses an environment with a required reviewer, and handles only the public sealing key and no database secret. Steps: confirm the commit is the one CI passed; back up the database with a restore proof; apply migrations; bring up changed services by digest; run health endpoints, role-denial probes and a canary request through the full path; write a deployment record. A failed health gate rolls back to the previous digests and port. A scheduled read-only drift workflow compares running digests, compose configuration, migration version, role grants and the parameters hash with the repository.

## Validation window

A read-only dashboard tool (Grafana OSS) with datasources, dashboards and alert rules provisioned from the repository, reading through the viewer role. The role can select views of enriched, sketch and harness data and never raw text. The tool binds to loopback or a private network, anonymous access is off, and the admin credential comes from a secret.

| View | Shows |
|------|-------|
| Event timeline | per key, user and address, labels only |
| Cluster explorer | members and the edges that justify them |
| Rule hits | hits with the matching events |
| Harness runs | runs against ground truth |
| Pipeline health | capture drops, enrichment lag and rejection rate, decrypt failures |
| Review queue | queue age and shedding |
| Calibration | calibration error and Brier score |
| Retention proof | purge counts and backup age |

Raw text is read only through a command-line tool that requires a reason, decrypts in memory with the private key on the enrichment host, neutralises control characters and writes the access log. No dashboard shows raw text.

A claim is validated when the matching view and the harness results agree: rule hits against harness truth, a cluster's explanation against its members, capture loss before any other result is trusted, and retention proof against the purge.

## Phases

| Phase | Scope | Live change |
|-------|-------|-------------|
| Offline build | capture proxy, sealing, scrubber, migrations and roles, enrichment worker with a fake labeller, accumulation jobs, rules with fixtures, harness with a fake upstream, dashboards as code, CI jobs, deploy workflow rehearsed on a scratch database | none |
| Shadow capture | database, roles and capture proxy in front of the gateway, fail-open, no enforcement; validation window live; user notice published | yes, behind approval |
| Shadow enrichment and rules | enrichment and rules on live traffic; nightly harness with a tagged key; thresholds fixed from data | yes, behind approval |
| Enforcement | caps and the response ladder; stricter capture failure handling if chosen | yes, separate approval |
| Graph and judge | only when the scale threshold is met | yes, behind approval |

## Configuration

A deployment is governed by named parameters held in one parameters file in a private repository. Their names, units and values, the selection logic of the cascade, the activation conditions of the graph and the capture failure settings are not published. At a high level the configuration covers:

| Group | Governs |
|-------|---------|
| Retention and privacy | how long each data tier is kept, sealing key rotation, deletion propagation and the minimum group size of aggregate views; each retention has a hard maximum |
| Capture | size and latency limits, trusted network peers, request de-duplication and capture failure handling |
| Ordering | how late and out-of-order events are handled |
| Enrichment | the vocabulary version, the cascade and its sampling, and the agreement a new model must reach before cut-over |
| Linkage and accumulation | when cross-identity correlation is enabled, merge behaviour, windows and decay |
| Response | review capacity and service levels, the decision log checkpoint interval and per-tier uplift ceilings |
| Evaluation | go/no-go thresholds for linkage, the leakage budget and audit sampling |

Values are set from measurements in the offline build and shadow phases and are recorded privately. Before the first live deployment the deployed predicates and activation conditions are re-derived, so the live configuration differs from any reference values.

## Sources

- Sigma correlation rules: validated with sigma-cli (pySigma). Specification: https://sigmahq.io/sigma-specification/specification/sigma-correlation-rules-specification.html
- Trusted forwarding headers: OWASP Cross-Site Request Forgery Prevention Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- MinHash: A. Z. Broder, On the resemblance and containment of documents, SEQUENCES 1997.
- Authenticated encryption: NIST SP 800-38D, https://csrc.nist.gov/pubs/sp/800/38/d/final. Hybrid public key encryption: RFC 9180, https://www.rfc-editor.org/rfc/rfc9180. Cryptographic erase: NIST SP 800-88 Rev. 2, https://csrc.nist.gov/pubs/sp/800/88/r2/final.
- Information estimates: L. Paninski, Estimation of entropy and mutual information, Neural Computation 15, 2003. Calibration error: R. Rossellini et al., COLT 2025, https://proceedings.mlr.press/v291/rossellini25a.html
- The composition function, its references and the verification level of each are in [`composition-function.md`](composition-function.md).
