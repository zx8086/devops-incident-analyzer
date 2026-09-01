# Estate Watch: Periodic AWS Self-Check Strategy

Operating doctrine for an autonomous read-only agent running inside an AWS account, holding the `DevOpsAgentReadOnly` permission surface (or a similar one), that must systematically verify on a periodic basis that everything is working. Distilled from the DevOps Incident Analyzer's runbooks, agent rules, and operational session memory. This is a design reference for another application potentially running in an AWS account, not a change to this codebase.

Sources: `docs/reference/devops-agent-readonly-iam.md`, `agents/incident-analyzer/agents/aws-agent/RULES.md` and `SOUL.md`, `agents/incident-analyzer/tools/aws-introspect.yaml`, `agents/incident-analyzer/knowledge/aws/runbooks/`, `docs/runbooks/aws-estate-onboarding.md`, the agent memory wiki, and project session memory (SIO-757/834/853/1079/1084/1120/1141/1149/1154/1161/1268 lineage).

## The premise shift: from incident-driven to standing watch

The incident analyzer is pull-triggered: a human describes a symptom, and the agent investigates from that anchor. A periodic watch inverts this -- there is no symptom, no focus service, no time window handed to you. That inversion changes three things:

- **You must manufacture your own anchors.** The incident agent's proven first move (SIO-834's "iteration 1 probe discipline") turns out to be exactly the right heartbeat: alarms, Health events, and core inventory before anything else. A standing watch is that discipline on a timer.
- **Absolute state is nearly worthless; deltas are everything.** "There are 28 alarms defined" means nothing. "Alarm `msk-broker-cpu-high` flipped to ALARM 40 minutes ago and was OK for the previous 30 days" is the finding. Every check needs a stored baseline to diff against.
- **Alert fatigue is the failure mode.** An incident report is read once; a periodic report is read hundreds of times. Known, accepted imperfections must live in a ledger so they are never re-raised as fresh findings -- the runbooks' "Known Configuration Gaps (don't re-flag)" sections exist for precisely this reason.

## What the permission surface affords -- and deliberately withholds

The role is two policies: a base read policy (topology, compute, datastores, messaging, CloudWatch, name-scoped log content, Health, Config, CloudFormation, CloudTrail/SecurityHub/GuardDuty) and a troubleshooting deep-dive policy (route tables, NAT/endpoints/NACLs/TGW, Reachability, Route53, MSK, KMS metadata, `cloudtrail:LookupEvents`, quotas, flow-log content). Together they cover everything a health watch needs. Just as important is what they withhold, because the watch must be designed around those walls, not surprised by them:

- **No writes, ever.** The agent observes and proposes; a human remediates. Every "recovery action" in every runbook is gated on human approval. A watch built on this surface is a smoke detector, not a sprinkler.
- **No secret values.** Secrets Manager and SSM are metadata-only. You can verify a secret exists and when it rotated -- never read it.
- **Log content is name-scoped** (`/aws/*`, `/ecs/*`, `/app/*`, `/platform/*`, `/prod/*`, `/bedrock/*`, flow logs under `/vpc/flow-logs/*`). A group outside those prefixes is listable but unreadable -- report it as a scoping fact, not a mystery.
- **No cost or billing reads.** Don't infer, don't guess -- it's simply not this datasource (see the wishlist below).

Field-proven IAM gotchas to design around:

- The list APIs `logs:DescribeLogGroups` / `DescribeLogStreams` **cannot be prefix-restricted** -- they must sit in their own unscoped statement or every log check dies with `AccessDeniedException`.
- When probing the write boundary, EC2 denies with `UnauthorizedOperation`, S3 with a bare `AccessDenied` (no "Exception" suffix). A denial-checker that greps only for `AccessDenied` passes EC2 mutations it should have caught.
- Probing a fake resource ID (e.g. `vpc-00000000`) returns `NotFound` before IAM evaluation and proves nothing about permissions -- use a real resource ID.

## The check ladder

Five tiers, cheapest and most urgent first. Each tier only earns its cost if the tier above it is green -- there is no point diffing CloudFormation drift while STS itself is failing. Cadences are starting points; tune to the estate's change rate.

### T0 -- Can I even see? (every run, first)

Self-check before estate-check. A watch that silently loses access reports "all quiet" forever -- the most dangerous failure of all.

- `sts:GetCallerIdentity` per estate (the AssumeRole chain itself). Verify identity by STS, never by config labels -- credential files and even their own header comments have carried wrong account IDs three separate times in this project's history.
- Capability parity: does the live tool/action surface match the expected canary? The incident stack watches the MCP boot `toolCount` because a stale deployed image silently drops capabilities (observed twice: 55-vs-61, then 61-vs-63). Your equivalent: a fixed probe-set whose pass-count is a version canary.
- One denial probe per policy family against a real resource ID.

### T1 -- Signal sweep (every 5-15 minutes)

The direct descendant of the incident agent's iteration-1 probes -- run in parallel, before anything else:

- `cloudwatch:DescribeAlarms` -- anything in ALARM (report state, threshold, metric, last-state-change) and anything newly INSUFFICIENT_DATA (a dying feed looks like silence).
- `health:DescribeEvents` -- open or upcoming account-level events, as their own section.
- The heartbeat of whatever the account's core workload is. For these estates that is RDS inventory/status; for your application it is the one describe call that proves your primary workload process exists and is in its expected state.

The alarm sweep is your leverage: you did not build the thresholds, the platform team did. Ride their work; add your own alarms only where the sweep and T2 repeatedly find gaps.

### T2 -- Fleet triage (hourly)

Find the outlier without enumerating resources one by one. Metrics Insights top-N SQL (rides `cloudwatch:GetMetricData`, zero extra IAM) names the culprit in one call:

```sql
SELECT MAX(CPUUtilization) FROM SCHEMA("AWS/EC2", InstanceId)
  GROUP BY InstanceId ORDER BY MAX() DESC LIMIT 10

SELECT SUM(Errors) FROM SCHEMA("AWS/Lambda", FunctionName)
  GROUP BY FunctionName ORDER BY SUM() DESC LIMIT 10

SELECT SUM(IncomingLogEvents) FROM SCHEMA("AWS/Logs", LogGroupName)
  GROUP BY LogGroupName ORDER BY SUM() DESC LIMIT 10

SELECT MAX(ApproximateNumberOfMessagesVisible) FROM SCHEMA("AWS/SQS", QueueName)
  GROUP BY QueueName ORDER BY MAX() DESC LIMIT 10
```

Keep these verbatim in a library and substitute only values: the grammar is unforgiving (single quotes, only `=`/`!=`/`AND`, LIMIT <= 500, 14-day window) and errors surface as a bare `ValidationError`. The log-volume query doubles as an ingestion heartbeat: a service whose `IncomingLogEvents` drops to zero has stopped logging or stopped running. Add per-hour: ALB `DescribeTargetHealth` for known ingress paths, and SQS oldest-message age for known queues.

### T3 -- Baseline and drift (daily)

- `config:GetDiscoveredResourceCounts` -- whole-account inventory in one call; diff against yesterday. Appearing/disappearing resource types are the cheapest change detector there is.
- `cloudformation:DescribeStacks` for non-COMPLETE states; `DescribeStackResourceDrifts` for drifted stacks.
- ECS desired-vs-running per service; stopped-task reasons from the last day.
- `cloudtrail:GetTrailStatus` -- `IsLogging` true and no `LatestDeliveryError`. An audit trail that silently stopped is a critical finding even when nothing else is wrong.
- GuardDuty and Security Hub findings at HIGH/CRITICAL, new since last run only.
- `servicequotas:GetServiceQuota` vs current usage for the quotas that have actually bitten (ENIs, rules per SG, Lambda concurrency).
- `cloudtrail:LookupEvents` for a small watchlist of scary write events: `DeleteTrail`, `StopLogging`, `PutBucketPolicy`, security-group ingress changes, IAM policy edits.

### T4 -- Deep audit (weekly)

- Network-path validation for the critical dependency paths, walked in the deterministic order the incident runbooks encode: ENI -> subnet -> route table (remembering an empty subnet-filter result means the subnet uses the VPC main table, not "no route table") -> NAT/endpoint/TGW state -> SG and NACL both directions -> flow-log config present and CloudWatch-backed.
- Ingress mirror: Route53 record -> ALB DNS (normalize trailing dots) -> listener -> target group -> target health, for each public entry point.
- Retention and lifecycle posture: log-group retention set (not "never expire" by accident), S3 versioning/encryption/public-access-block on critical buckets, KMS rotation status.
- IAM parity: re-run the T0 probe-set exhaustively and diff against the committed policy JSON -- deployed policy drift (an estate running last quarter's policy) is one of the three recurring gap causes (see the gap taxonomy: stale deployed IAM vs missing tool capability vs guidance gap).

## Routine checks at a glance

| Check | Tier | Primary reads | Healthy | Escalate when |
|-------|------|---------------|---------|---------------|
| AssumeRole / identity | T0 | `sts:GetCallerIdentity` | expected account ID | denied or wrong account |
| Capability canary | T0 | fixed probe-set | count matches | count drifted (stale deploy) |
| Alarm states | T1 | `DescribeAlarms` | no ALARM, no new INSUFFICIENT_DATA | new ALARM on critical metric |
| AWS Health | T1 | `health:DescribeEvents` | no open events | open/upcoming affecting used services |
| Core workload heartbeat | T1 | service-specific describe | status available/running | missing or degraded state |
| Fleet outliers | T2 | Metrics Insights top-N | no new name at top | unfamiliar leader or step change |
| Log ingestion heartbeat | T2 | `AWS/Logs IncomingLogEvents` | all expected groups > 0 | known-chatty group at 0 |
| Ingress target health | T2 | `DescribeTargetHealth` | all healthy | unhealthy targets on prod LB |
| Inventory delta | T3 | `GetDiscoveredResourceCounts` | delta explained | unexplained appearance/loss |
| ECS desired vs running | T3 | `DescribeServices` | equal, no crash-loop events | sustained shortfall |
| Audit trail alive | T3 | `GetTrailStatus` | IsLogging, no delivery error | logging stopped |
| New security findings | T3 | GuardDuty / Security Hub | none new >= HIGH | new CRITICAL |
| Quota headroom | T3 | `servicequotas` + usage | < 80% of limit | >= 80% |
| Change watchlist | T3 | `LookupEvents` | no watchlist hits | StopLogging, SG open-to-world, IAM edit |
| Network paths | T4 | route/NAT/SG/NACL walk | every hop available | hop missing or blackholed |
| IAM / policy parity | T4 | probe-set vs committed policy | parity | deployed policy stale |

## Memory is the other half of the system

The incident analyzer's most transferable idea is not any single check -- it is that durable, human-readable memory turns a stateless checker into a watch. Its live-memory layout maps directly onto what a periodic agent needs:

- **A baseline document** (its `memory/wiki/` + topology pages): what normal looks like -- expected services, alarm inventory, log groups, top-N leaders, quota usage. Every run diffs against this and proposes updates to it; a human (or a high-confidence rule) accepts them.
- **A known-gap ledger** (the runbooks' "Known Configuration Gaps -- don't re-flag"): accepted imperfections with owner and date. Findings matching the ledger are suppressed to a one-line footnote. This is the single most effective anti-fatigue device in the codebase.
- **A daily log and key-decisions file** (its `runtime/dailylog.md`, `key-decisions.md`): what was observed, what was escalated, why. When a human asks "why did you page me?", the answer is already written.
- **Runbooks as skills**: each escalatable condition gets a written investigation sequence (symptoms -> ordered steps -> correlation -> escalation criteria -> human-gated recovery actions). The periodic check detects; the runbook governs the drill-down the detection triggers.

## Field rules that keep the watch honest

These are the rules the project learned the hard way -- each one exists because its absence produced a false report. They matter more on a periodic watch, where a bad habit repeats every interval.

### Grounded claims only

(Learned from a hallucinated IAM-gap report.) Never report "not permitted", "expired", or "absent" unless a call in this run returned the error that proves it, naming the same action. The role's read surface is broad -- when unsure, call the tool and let the error answer. The honest phrasing for something you didn't check is "not inspected", never "not available". The project enforces this per-action in code (`detectUngroundedBlockers`); a periodic agent should too, because an ungrounded "X is broken" repeated every 15 minutes is worse than no watch at all.

### Paginate before you conclude

(Learned from partial-page miscounts.) No claim about counts, completeness, or "all X" until every continuation token is walked -- and know the two truncation cases: a token present means fetch the next page; a size-truncation marker with no token means re-issuing unchanged loops forever -- tighten a filter or shrink the page instead.

### Relative time windows, deterministic guards

(Learned from the year-drift incident, twice.) An LLM computing absolute epochs will eventually send last year's date, and CloudWatch's error for that reads exactly like "logs expired past retention". Always query with relative windows (`now-3h`, `now-30d`). Where a model must produce a timestamp, put a deterministic correction guard in the tool layer -- prompt reminders reduce drift, code eliminates it. And remember the twin: a `MalformedQueryException` can also be a query-syntax error -- work the sequence (relative window -> minimal query -> only then report "could not be constructed") before declaring a gap.

### Empty is not absent -- and absent is a finding

(Learned from governance-account false alarms.) Zero compute results do not mean a broken estate: confirm with a one-call inventory (`GetDiscoveredResourceCounts`) and, if only baseline resources exist, report "governance account, no workloads by design". Conversely, a verified absence after complete enumeration is real data -- state it definitively and stop; do not burn cycles "double-checking" a settled negative with log queries that cannot distinguish absence from a bad window.

### Budget every retry, change something each time

(Learned from a 7-iteration retry loop.) Bounded attempts per check per run; re-issuing an identical failed call is always wrong -- each retry must change the window, the filter, or the query. Throttling means the SDK already retried; narrow scope before trying again. A periodic agent that loops burns its own next interval.

### Know where your telemetry actually lives

(Learned from three account-mislabel incidents and the X-Ray dead end.) Encode the observability topology as explicit knowledge, not assumption. In these estates, application logs dual-ship to CloudWatch and Elasticsearch, and traces live only in Elastic APM -- so "no X-Ray data" is topology, not an outage, and a CloudWatch log gap defers to the other system rather than reporting loss. Your account will have its own equivalents; write them down where the agent reads them every run.

## Reporting discipline

- **Three verdict classes, never blurred:** findings (evidence in hand), gaps (checked, couldn't determine -- with the observed error), and not-inspected (out of scope this run). The incident pipeline caps its confidence score when checks are degraded; a watch should do the same -- a green report produced while three checks errored is a lie.
- **Delta-first layout:** what changed since last run, then what is red, then the one-line "all else nominal". Nobody reads a full inventory hourly.
- **Escalation is the product.** A read-only agent's output is a well-formed handoff: the evidence chain (every hop and state, not just the conclusion), the matching runbook, and the proposed -- human-gated -- remediation. Every runbook here ends with "Recovery Actions (Require Human Approval)"; keep that covenant.

## If you can ask for more IAM

Additions that materially extend a health watch, in rough value order -- all read-only:

- `ce:GetCostAndUsage` / `ce:GetAnomalies` -- cost anomalies are often the first visible symptom of a runaway loop or a leak; this surface deliberately lacks them today.
- `acm:ListCertificates` / `DescribeCertificate` -- certificate expiry is a fully predictable outage; a weekly check makes it a non-event.
- `support:DescribeTrustedAdvisorChecks` -- free posture findings (needs a support plan).
- `backup:ListBackupJobs` / `ListRecoveryPoints` -- "are backups actually completing" is a T3 check this role can't currently answer.
- `synthetics:DescribeCanaries` + last-run results -- ride existing canaries the way T1 rides existing alarms.
- What NOT to ask for: writes. Self-healing sounds attractive and destroys the trust model; the moment a system-state change is evidence-supported, the correct move is a proposal, not an action.

## First steps, in order

1. **Stand up T0 + T1 only.** Identity, capability canary, alarms, Health, workload heartbeat. Run it for a week; do not add checks yet.
2. **Write the baseline document** from what those runs observed, and seed the known-gap ledger with every "yes, we know" a human gives you.
3. **Add T2, verbatim query library included.** Tune the top-N leaders into the baseline so only leadership changes report.
4. **Add T3 as a daily diff** against the baseline; wire the CloudTrail watchlist.
5. **Write a runbook for each escalation that actually fired.** Detection without a drill-down sequence just moves the confusion downstream.
6. **Only then consider T4 and extra IAM** -- by now the false-positive rate tells you whether the watch has earned more surface.
