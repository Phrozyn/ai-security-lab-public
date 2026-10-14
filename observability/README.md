# Observability

The distributed-intent detection component writes its output as OCSF 1.9.0 objects, one JSON object per line. A SIEM, log store or event viewer that ingests JSON lines can read it, and one that maps OCSF classes can use the standard attributes below. Attributes that OCSF does not define are in `unmapped` and need a mapping of their own.

## Classes

| Class | Name | Written for | Activities |
|-------|------|-------------|------------|
| 2004 | Detection Finding | each fire of a reported rule, and the repeated-fire parent of a correlation group | Create for a fire; Create, Update and Close for a parent |
| 6008 | Application Error | each late rejection, forced late rejection or pending overflow | activity 1, the cause in `unmapped.health_event` |
| 6002 | Application Lifecycle | start, stop and restart of the emitter | Start, Stop, Restart |

Every object carries `class_uid`, `activity_id`, `severity_id`, `time`, `metadata.version` (`1.9.0`) and `metadata.product`. A Detection Finding carries the rule in `finding_info.analytic` (uid and name) and its finding id in `finding_info.uid`; the rule kind, group key and episode are in `unmapped`. An Application Error carries the rule id, group key and event id in `unmapped`.

## Content

No event text enters an object. An object carries rule ids and titles, group keys, event ids and times, severities and fixed messages.

In the lab's CI, the emitter's reference output and a set of mutated negative controls are checked against the compiled OCSF 1.9.0 schema with ocsf-toolkit, the OCSF project's validator. That job is not part of this repository.

## Not in this repository

The emitter uses the private parameter names of the detection design and is not published. The collector, log store and dashboard configuration of the lab deployment name the lab's hosts and are not published. The design of the component is in [`docs/distributed-intent-detection.md`](../docs/distributed-intent-detection.md), and the metrics computed from the findings are in [`docs/detection-metrics.md`](../docs/detection-metrics.md).

OCSF schema: https://schema.ocsf.io/1.9.0/
