---
type: Runbook
title: "AWS CloudWatch Alarm Triage"
description: "Triage CloudWatch alarms in ALARM state and correlate them with the owning service."
status: stable
tags: [aws, cloudwatch, alarms]
generated:
  by: human:simon
  at: 2026-07-29
triggers:
  metrics:
    - alarm
    - cloudwatch
    - insufficient data
    - insufficient_data
  services:
    - cloudwatch
  match: any
tools:
  - aws_cloudwatch_describe_alarms
  - aws_cloudwatch_get_metric_data
  - aws_ec2_describe_instances
  - aws_ecs_describe_services
  - aws_lambda_get_function_configuration
  - aws_rds_describe_db_instances
  - aws_health_describe_events
---
# AWS CloudWatch Alarm Triage

Triage CloudWatch alarms in ALARM state and correlate them with the owning service.

## Symptoms
- One or more CloudWatch alarms in `ALARM` state
- Alarms flapping between `OK` and `ALARM` over short intervals
- Alarms stuck in `INSUFFICIENT_DATA` despite the underlying resource being live
- A service degradation reported by a user but no alarm fired (alarm-coverage gap)

## Investigation Steps

### 1. List alarms currently in non-OK states
Use `aws_cloudwatch_describe_alarms`. Filter by `StateValue: ALARM` or `StateValue: INSUFFICIENT_DATA` to scope the result. Sort by `StateUpdatedTimestamp` to see the most recent transitions first.

For each alarm, the fields that matter:
- `AlarmName`, `AlarmDescription` (operator intent)
- `Namespace`, `MetricName`, `Dimensions` (what the alarm is watching)
- `Statistic`, `Period`, `EvaluationPeriods`, `DatapointsToAlarm`, `TreatMissingData`, `Threshold`, `ComparisonOperator` (what triggers it)
- `StateValue`, `StateReason`, `StateReasonData` (current state plus the datapoint that triggered the transition; quote `StateReason` verbatim in any finding)
- `StateUpdatedTimestamp` (when the alarm last changed state — anchor the investigation window here, not at "now")

### 2. Interpret the alarm state
- **`ALARM`** — at least `DatapointsToAlarm` (M) of the last `EvaluationPeriods` (N) datapoints breached the threshold. These breaching datapoints do NOT need to be consecutive — only that at least M of the N most recent periods breached. If `DatapointsToAlarm` is unset/absent from `aws_cloudwatch_describe_alarms` output, CloudWatch defaults it to `EvaluationPeriods`, meaning all N periods (i.e., consecutive) must breach. Always check `DatapointsToAlarm` vs `EvaluationPeriods` before describing the alarm as "sustained" — an M-of-N alarm with M < N can fire on intermittent spikes. The alarm has fired and is currently active. Drill down on the underlying metric next.
- **`OK`** — the metric is within the configured bounds. If the user reports a problem despite all `OK` alarms, suspect a coverage gap (no alarm exists for the actual failure mode), not a false negative.
- **`INSUFFICIENT_DATA`** — the metric did not report enough datapoints in the evaluation window. This is NOT the same as `ALARM`. Note that this state only occurs when `TreatMissingData` is `missing` (the default) and all evaluated datapoints are absent; if the alarm's `TreatMissingData` is set to `breaching` or `notBreaching`, missing datapoints are instead counted toward the M-of-N evaluation and the alarm goes straight to `ALARM` or `OK` rather than `INSUFFICIENT_DATA`. If `TreatMissingData` is `ignore`, the alarm retains whatever state it held before data went missing (`ALARM`, `OK`, or `INSUFFICIENT_DATA`) and does not transition at all — check `TreatMissingData` before assuming a data gap will surface as this state. Common causes:
  - The resource being watched is stopped or terminated (e.g., alarm on an EC2 instance after the instance was deleted)
  - The metric is push-based and the producer is not emitting (custom CloudWatch metrics, Lambda invocations on an idle function)
  - The alarm period is shorter than the metric's emission cadence (e.g., 1-minute period on a metric that publishes every 5 minutes)

`INSUFFICIENT_DATA` should be reported as a **coverage gap**, not as the underlying resource being healthy.

#### Cause tables

Symptom-to-cause tables adapted from the AWS Agent Toolkit `aws-observability` skill
(`references/troubleshooting.md`, github.com/aws/agent-toolkit-for-aws, Apache-2.0,
Copyright Amazon.com, Inc. or its affiliates). Use them to name the cause in the finding
instead of stopping at the state.

`INSUFFICIENT_DATA`:

| Symptom | Cause | What to check |
|---|---|---|
| Alarm went to INSUFFICIENT_DATA as soon as it was created and never left | Wrong namespace or dimension names (namespaces are case-sensitive: `AWS/Lambda`, not `aws/lambda`) | Compare `Namespace` and `Dimensions` from step 1 against a metric that returns datapoints in step 3 |
| Alarm worked, then went to INSUFFICIENT_DATA | The metric stopped being published: resource stopped, deleted, or scaled to zero | Step 5 resource check |
| Alarm stays in INSUFFICIENT_DATA although the resource is live | No datapoints in the evaluation window: emission cadence longer than `Period`, or an idle push-based metric | `aws_cloudwatch_get_metric_data` at the alarm's period; if datapoints exist only at a coarser cadence, the alarm period is wrong |
| Brand-new alarm in INSUFFICIENT_DATA | Normal until one full evaluation period of data arrives | Wait; not a finding |

Alarm did not trigger although the metric breached:

| Symptom | Cause | What to check |
|---|---|---|
| Metric breaching but alarm stays `OK` | M-of-N not met: only some of the last N datapoints breached | `DatapointsToAlarm` vs `EvaluationPeriods` (step 2) against the datapoints in step 3 |
| Metric breaching but alarm in INSUFFICIENT_DATA | `TreatMissingData` is `missing` (the default) and the metric is sparse | `TreatMissingData`; for error-count metrics `notBreaching` is the usual fix |
| Multi-day alarm fires hours late | Total window (`EvaluationPeriods` x `Period`) exceeds one day; such alarms are evaluated once per hour | Report the delay as expected behaviour, not a lost signal |
| Alarm fires then returns to `OK` immediately | Single spike with M = N = 1 | Recommend M-of-N (2 of 3) if the spike was noise |
| Metric-math alarm did not stop or recover an EC2 instance | Metric math alarms cannot perform EC2 actions | Recommend a plain metric alarm with the `InstanceId` dimension |

Flapping (`OK` to `ALARM` to `OK` in quick succession):

| Cause | What to check or recommend |
|---|---|
| Threshold sits inside the metric's normal range | Step 3 datapoints hover around `Threshold`; recommend a higher threshold or anomaly detection |
| M = N = 1 catches transient spikes | Recommend M-of-N (2 of 3 or 3 of 5) |
| Metric is naturally spiky (latency) | Recommend `p90`/`p99` instead of `Maximum`; for CPU-style metrics `Average` is acceptable |

### 3. Pull the underlying metric datapoints
Use `aws_cloudwatch_get_metric_data` for the namespace + metric + dimensions identified in step 1. Window the query to start ~30 minutes before `StateUpdatedTimestamp` and end at "now". Use a `Statistic` that matches the alarm's (`Average`, `Sum`, `Minimum`, `Maximum`, etc.) — comparing the wrong statistic against the alarm's threshold produces misleading findings.

The metric values around the transition point reveal whether the alarm fired on a sustained shift (real signal) or a single spike that exceeded the threshold for the minimum evaluation count (noise).

### 4. Walk the alarm hierarchy
If the alarm is a composite alarm, `AlarmRule` is a Boolean expression string, not a list of ARNs — e.g. `ALARM("cpu-high") AND ALARM("disk-high")` or `ALARM("child1") OR ALARM("child2")`. Each referenced alarm is wrapped in a state function (`ALARM(...)`, `OK(...)`, or `INSUFFICIENT_DATA(...)`) naming the child alarm by name or ARN, combined with `AND`/`OR`/`NOT` and optional parentheses for grouping. To walk the hierarchy: extract every alarm name/ARN token that appears inside an `ALARM(...)`, `OK(...)`, or `INSUFFICIENT_DATA(...)` call in the expression, then look each one up via `aws_cloudwatch_describe_alarms` (repeating recursively if a referenced alarm is itself composite) to find the leaf alarm(s) that actually fired.

### 5. Correlate with the resource state
The alarm's `Dimensions` field identifies the resource:
- `InstanceId` → use `aws_ec2_describe_instances` to confirm the instance is running
- `ServiceName`/`ClusterName` → use `aws_ecs_describe_services` to confirm task counts
- `FunctionName` → use `aws_lambda_get_function_configuration` to confirm the function exists and has not been recently updated
- `DBInstanceIdentifier` → use `aws_rds_describe_db_instances` to confirm the database is in the expected state

A resource that has been stopped/deleted explains `INSUFFICIENT_DATA`; a resource that is healthy but metric-degraded explains `ALARM`.

### 6. Escalate to AWS Health for service-wide issues
If multiple alarms across unrelated resources fire simultaneously, the underlying cause may be an AWS service event (e.g., an EC2 control-plane disruption in the region). Use `aws_health_describe_events` to check for active AWS Health events. If the account is on Basic support, this call returns `SubscriptionRequiredException` — note the gap and escalate manually to the AWS Personal Health Dashboard.

## Cross-Datasource Correlation

The Phase 5 (SIO-761) correlation rule `aws-cloudwatch-anomaly-needs-kafka-lag` fires when the AWS findings mention an MSK- or Kafka-related CloudWatch alarm and Kafka findings are not part of the answer. The supervisor re-fans-out to kafka-agent to pull consumer-group lag and broker metadata so the alarm can be correlated to actual lag growth (or ruled out as a transient metric blip).

- CloudWatch alarm on MSK `KafkaDataLogsDiskUsed` + kafka-agent reports broker-level disk pressure → real capacity event
- CloudWatch alarm on Lambda `Errors` + Elastic APM error traces from the same function → application-side bug, not infrastructure
- CloudWatch alarm on ECS `CPUUtilization` + ECS task failures (see [`aws-ecs-task-failures.md`](./aws-ecs-task-failures.md)) → autoscaling lag or capacity ceiling
- All alarms `OK` but user reports incident → coverage gap; recommend new alarm rather than treating as resolved

## Escalation Criteria
- Multi-resource `ALARM` storm correlated to an AWS Health event: notify on-call with the Health event ID
- Single critical alarm in `ALARM` for > 30 minutes without remediation: page the resource owner
- `INSUFFICIENT_DATA` on alarms watching production resources: file a follow-up to either fix metric emission or re-tune the alarm period (not a paging event)

## Known Configuration Gaps (don't re-flag as findings)
- `aws_cloudwatch_describe_alarms` returns at most 100 alarms per call by default; if pagination is needed and the page-token plumbing returns `AccessDenied`, link to [`aws-iam-permission-troubleshooting.md`](./aws-iam-permission-troubleshooting.md).
- `aws_health_describe_events` returning `SubscriptionRequiredException` is a Basic-support-tier limitation, not an IAM gap. Report once per run, don't re-flag.

## Recovery Actions (Require Human Approval)
- Acknowledge / silence alarms during planned maintenance
- Adjust thresholds or evaluation periods
- Create new alarms to close coverage gaps

## All Tools Used Are Read-Only
aws_cloudwatch_describe_alarms, aws_cloudwatch_get_metric_data, aws_ec2_describe_instances, aws_ecs_describe_services, aws_lambda_get_function_configuration, aws_rds_describe_db_instances, aws_health_describe_events
