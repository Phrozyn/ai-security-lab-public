# Detection metrics: rule performance and subject risk

This document describes how the distributed-intent component measures its detection rules and orders subjects for human review, which quantities it stores for that, and which measurements are planned but not built. The design is in `distributed-intent-detection.md` and the composition function in `composition-function.md`. The tables, views and functions named here, and the loader, profile and harness code it refers to, are part of the implementation, which is not published in this repository.

Status: the tables, functions and views exist and are tested against an ephemeral Postgres with synthetic data. No service writes rule fires, no job recomputes profiles, runs the audit draw or purges aged rows on a schedule, and no metric below has been computed on captured traffic.

## Two units of measurement

| Unit | Question | Stored in | Reported by |
|------|----------|-----------|-------------|
| Rule | Does this rule produce fires that an analyst can act on? | `intent.rule_fire`, `intent.finding_disposition` | `intent_view.rule_performance()` |
| Subject (a user, or an API key without a user) | Which subjects does a human review first, and was the review right? | `intent.user_profile`, `intent.user_profile_history`, `intent.review_outcome`, `intent.audit_draw` | `intent_view.review_queue` |

The two are kept apart. A rule fire is a statement about one group of events. A subject outcome is a statement about one account after a human looked at its whole profile. Neither table is derived from the other, and a fire row names an event and a group key, not a subject.

## Rule performance

### What is recorded

Every fire of a reported rule becomes one OCSF Detection Finding (class 2004) in the emitter's output. A loader reads that output and records each fire in `intent.rule_fire` through `intent.record_fire()`: the finding uid, rule id, title, kind and severity, the group key, the episode number, the firing event id and its time, the fire time and, for a correlation rule, the uid of the repeated-fire parent. No event text is stored. Recording is idempotent: a replay of a stream with the same values is counted and skipped, and a repeat of a finding uid with other values fails the run.

An analyst records a decision on a fire in `intent.finding_disposition`: `actionable` or `not_actionable`. The server sets the reviewer and the time. Rows are append-only, and the latest row of a finding counts, so a changed decision is a new row and the earlier one stays. A disposition has no free text.

`intent_view.finding_queue` lists fires without a disposition, most recent first.

### What is reported

`intent_view.rule_performance()` returns one row per rule that fired within the enriched-tier retention period, counted by fire time:

| Column | Meaning |
|--------|---------|
| `rule_id`, `rule_title` | the rule, and its title at its latest fire |
| `fires` | Detection Findings of the rule in the period |
| `group_keys` | distinct group keys among them; 0 for a single-event rule, which has no group key |
| `actionable`, `not_actionable` | fires whose latest disposition is that value |
| `undispositioned` | fires with no disposition |
| `actionable_share` | `actionable` divided by the dispositioned fires, to four places; null when no fire is dispositioned |
| `first_fire`, `last_fire` | earliest and latest fire time in the period |

Rows are ordered by rule id. The function fails when `intent.policy` has no row.

### How to read it

- `actionable_share` is a precision measure over the fires an analyst looked at. It is not a precision measure over all fires unless every fire is dispositioned, or the dispositioned fires are a random sample of them. When analysts disposition the fires they consider interesting first, the share is biased in the direction of that selection.
- `fires` against `group_keys` separates a rule that fires on many groups from one that fires repeatedly on a few. A rule with many fires on few group keys is a candidate for a recurring benign source. The grouping harness shows that the repeated-fire grouping acts on timing alone and cannot tell a daily benign job from a recurring attack.
- A rule with no fire in the period has no row. The table cannot show a rule that misses attacks. Missed detections are to be measured with the planned canary harness and with the subject audit draw (below), not here.
- Repeated-fire parents are not stored. Escalations of a parent are visible in the emitter output and in the harness report, not in this table.
- Recall is not reported per rule. A fire table holds positives the rule produced. The negatives a rule failed to produce exist only where a labelled stream or a reviewed audit draw supplies them.

### Use

- Tuning: a rule with a low `actionable_share` over enough dispositioned fires is a candidate for a narrower selection, a higher threshold or a longer timespan. The rule's fixture cases must still pass after a change, and the boundary cases record the edge being moved.
- Retirement: a rule that stays without fires over several periods while the canary harness (planned) shows that its pattern still reaches the stream adds no detection and can be reviewed for removal.
- Analyst load: `undispositioned` against `fires` shows the share of a rule's output that no one reviewed.

## Subject risk and review order

### What a profile holds

The profile code computes one profile per subject from its event rows. The fields fall into two groups.

Descriptive fields, which are not risk inputs: usage (events, active days, sessions), rhythm (events per hour of the week, inferred UTC offset, inter-arrival variation), categories, network and client counts, and sophistication. Time zone, the diurnal gap, country, ASN, concurrent ASNs and egress class trip on shift workers, shared keys and phones moving between networks, so none of them raises a subject in the queue. Sophistication is the mean of those of five components that have data (operate share, artifact reuse, detect-modify cycles, reformulation after refusal, named targets) and measures how operator-like the requests are. A skilled benign user scores high on it, and a low-skill subject with risk evidence must still surface, so it is not part of the rank.

Risk fields: the families of independent evidence a subject shows, and the provenance roots behind them.

| Family | Evidence | Provenance root |
|--------|----------|-----------------|
| behavioural trajectory | machine cadence: regular inter-arrival gaps inside sessions | L0 timing |
| behavioural trajectory | learning-to-operating shift, counted only when the subject shows other risk evidence | L1 labels |
| refusal and reformulation | a request reformulated after a refusal | L1 labels |
| artifact lineage | an artifact produced by another subject and consumed by this one | L0 artifact hashes |
| artifact lineage | a detected control verdict followed within a window by a modify or debug request that consumes an artifact | L1 labels |
| content semantics | enough requests naming a third-party target | L1 labels |

### Review rank

`review_rank` is `risk_sources`: the number of distinct provenance roots behind the subject's families, from 1 to 3, and null when the subject shows no family. Several labels from the one L1 tagger count once, because they share one source of error. In the queue, subjects with an open audit draw come first (see "Audit draw"); the rest are ordered by rank, highest first, then by the most recent risk evidence (`last_risk_evidence`), then by subject. The rank orders human review only. No response step or cap reads it.

The rank is a count of independent evidence and not a weighted sum, for these reasons:

- Most candidate risk metrics read one label series. Maximum risk, recent risk, the number of high-risk events, the rate of increase and the order of event types are all computed from the per-event labels of one L1 tagger. In a weighted sum, correlated indicators give their shared dimension the sum of their weights, and the composite-indicator handbook [S7] advises dropping or down-weighting them. Event density and time between events share the L0 timing root in the same way.
- The strongest single term in a published evaluation of risk-based alert scoring was the number of distinct detection types per entity in a window [S1]. The rank is that count, taken per provenance root.
- Without outcome labels, fitted weights cannot be estimated, and equal or fixed weights on a few non-redundant terms perform comparably to fitted ones [S8, S1].
- An additive score grows with repetition. The composition function's progress measure is a bottleneck over the required primitives, and twenty copies of one event do not move it. A sum of per-event scores grows twentyfold on the same input.

A learned score can be added later as a tie-break inside one rank, or as a separate column. It replaces the family count only if confirmed outcomes show that it finds more confirmed malicious subjects within the review budget (see "Acceptance gate").

## Review outcomes

A reviewer records one row per review in `intent.review_outcome`. Dispositions:

| Disposition | Use as a label |
|-------------|----------------|
| `malicious_confirmed` | positive |
| `benign_confirmed`, `cleared` | negative; both carry a clearance period |
| `escalated`, `needs_more_data` | unlabelled |

Subjects that were never reviewed are unlabelled, not negative [S30].

The outcome row records what the reviewer saw: the server copies the profile version, rank, sources, families and last risk evidence from the stored profile named by `profile_computed_at`, and refuses the insert, with one error for every reason, when the subject has no profile, the stored profile has a different `computed_at` (recomputed since the queue was read), or the subject has no risk family and no open audit draw. Every stored profile is also copied into `intent.user_profile_history`, so the full profile behind an outcome can be read back until the history row ages out.

A clearance takes a subject out of the queue until it expires, unless the subject shows a new family or more provenance sources than at the review, has newer risk evidence of its own, or shares an IP address with another subject that used it after the review and has risk evidence after the review.

## Audit draw

Outcomes exist only where the queue sent a subject to review, so labels from the queue alone are a biased sample: the selective-labels problem [S26]. In a fraud-detection study, reweighting reviewed cases by their chance of review lowered alert precision, because the cases most likely to be fraud were the most likely to be reviewed [S2].

`intent.draw_audit_sample()` draws at most once per UTC day; a second call on the same day draws nothing and returns null. Each subject with a profile and no open draw is drawn independently of its profile values with a fixed probability, the audit rate in `intent.policy`. The run records the day, the rate, the population that could be drawn and the number drawn. Drawn subjects head the review queue, earlier draw days first and in a random order within a day, whether or not they show a family or hold an unexpired clearance. An outcome for a drawn subject closes the draw and records the draw day and probability on the outcome row.

Within one run, every subject of the population had the same known probability of being drawn, so a Horvitz-Thompson estimate over that run's population weights each reviewed draw by the inverse of the rate [S27]. This holds when every draw of the run is reviewed. With unreviewed draws the estimate assumes they are missing at random. The probability of being drawn at least once over several days is not the per-run rate.

## Acceptance gate for any change to the order

A change to the review order (a new tie-break term, a fitted score, a different rank) is accepted only through this gate:

- Metric: recall within the daily review budget, the share of confirmed malicious subjects that appear in the top of the queue that reviewers can work through in a day [S32], and precision among those [S2, S3]. Area under the ROC curve ignores the budget [S2], and precision-recall is more informative than ROC on imbalanced data [S33].
- Estimation: recall measured on reviewed queue subjects only is biased upward. It is measured on the audit draw with inverse-probability weights, and on labelled harness streams before production.
- Baselines at equal budget: the current rank alone; the current rank with a random tie-break; first in, first out; severity alone. A candidate passes only if it beats all four.
- Fairness: recall per cohort (equal opportunity [S36]), xAUC for ranking scores [S37] and the share of review attention per cohort [S38], for time zone, country, ASN, egress class and sophistication quartile, with intervals, because positives per cohort will be few. A candidate may not raise the review rate of benign subjects in any cohort.

## Fitting weights

Fitting waits for labels:

- Sample size: at five to ten positives per estimated weight [S18, S19], a score with seven weights needs on the order of 35 to 70 confirmed malicious subjects. The events-per-variable rule has no firm rationale [S20], and sample-size criteria computed per model [S21] replace it where they can be applied.
- Model: a penalised model or equal weights. Firth's correction handles separation [S23]. Penalised models are unstable at small samples, because the penalty is itself estimated with large uncertainty [S22].
- Terms: at most one term per provenance root, each scaled to the range 0 to 1 before any combination, starting with equal weights. Candidates are recipe progress or its rate of increase for the L1 labels, and inter-arrival regularity for timing.
- Labels: confirmed outcomes, weighted by the audit draw, plus canary streams whose labels are known by construction.

## Retention and deletion

| Data | Deleted by | When |
|------|-----------|------|
| rule fires and their dispositions | `intent.purge_aged()` | fire time or record time older than the enriched-tier retention period |
| review reason text | `intent.purge_aged()` sets it to null | after the reason retention period; the disposition and snapshot stay |
| profile history | `intent.purge_aged()` | after the history retention period |
| audit draw runs without a reviewed draw | `intent.purge_aged()` | after the history retention period; a run with a reviewed draw is kept for its rate and population |
| a subject's profile, `user_infra` rows, outcomes, history, draws and draw reviews | `intent.forget_subject()` | on request; the subject is recorded in `intent.forgotten_subject` and a later profile for it is refused |

`forget_subject` does not delete rule fires, because a fire row holds an event id and a group key and no subject. A group key can hold identifying values until the fire's retention deletes it.

## Not built

- A service that writes fires as the emitter runs; the loader reads stream files.
- Scheduled jobs for the profile recompute, the audit draw and the purge.
- An enrichment worker that writes the L1 labels the risk families read.
- Any risk score beyond the family count, and any fit of weights.
- Computation of the acceptance gate and the fairness report.
- The canary harness, and per-rule recall from it.

## Sources

- S1 Uetz et al. 2026, Can Risk-Based Alerting Mitigate Cybersecurity Alert Fatigue? https://arxiv.org/abs/2609.02465
- S2 Dal Pozzolo et al. 2017, credit card fraud detection with alert-feedback interaction: https://boracchi.faculty.polimi.it/docs/2017_FraudsTNNLS.pdf
- S3 Fraud detection handbook, top-k metrics: https://fraud-detection-handbook.github.io/fraud-detection-handbook/Chapter_4_PerformanceMetrics/TopKBased.html
- S7 OECD and JRC, Handbook on Constructing Composite Indicators: https://knowledge-for-policy.ec.europa.eu/sites/default/files/jrc47008_handbook_final.pdf
- S8 Dawes 1979, The robust beauty of improper linear models: https://www.cmu.edu/dietrich/sds/docs/dawes/the-robust-beauty-of-improper-linear-models-in-decision-making.pdf
- S18 Peduzzi et al. 1996: https://pubmed.ncbi.nlm.nih.gov/8970487/
- S19 Vittinghoff and McCulloch 2007: https://pubmed.ncbi.nlm.nih.gov/17182981/
- S20 van Smeden et al. 2016: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5122171/
- S21 Riley et al. 2020: https://pubmed.ncbi.nlm.nih.gov/32188600/
- S22 Riley et al. 2021, penalisation at small samples: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8026952/
- S23 Firth 1993, bias reduction of maximum likelihood estimates: DOI 10.1093/biomet/80.1.27
- S26 Lakkaraju et al. 2017, selective labels: https://www.cs.cornell.edu/home/kleinber/kdd17-selective.pdf
- S27 Horvitz and Thompson 1952: DOI 10.1080/01621459.1952.10483446
- S30 Elkan and Noto 2008, learning from positive and unlabeled data: DOI 10.1145/1401890.1401920
- S32 Tuor et al. 2017, insider threat detection: https://arxiv.org/abs/1710.00811
- S33 Saito and Rehmsmeier 2015: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4349800/
- S36 Hardt et al. 2016, equality of opportunity: https://arxiv.org/abs/1610.02413
- S37 Kallus and Zhou 2019, xAUC: https://arxiv.org/abs/1902.05826
- S38 Singh and Joachims 2018, fairness of exposure: https://arxiv.org/abs/1802.07281
