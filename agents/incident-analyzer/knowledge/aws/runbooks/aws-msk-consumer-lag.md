---
type: Runbook
title: "AWS MSK Consumer Lag Investigation"
description: "Classify growing MSK consumer lag as broker-side, partition-skew, client-side, maintenance, or rebalance-storm using CloudWatch AWS/Kafka metrics and kafka-agent lag data."
status: stable
tags: [aws, msk, kafka, consumer-lag]
generated:
  by: human:simon
  at: 2026-09-05
triggers:
  metrics:
    - consumer lag
    - lag
    - offsetlag
    - sumoffsetlag
    - maxoffsetlag
    - estimatedmaxtimelag
    - rebalance
  services:
    - msk
    - kafka
  match: any
tools:
  - aws_cloudwatch_describe_alarms
  - aws_cloudwatch_get_metric_data
  - aws_cloudwatch_metrics_insights_query
  - aws_health_describe_events
  - kafka_get_consumer_group_lag
  - kafka_describe_consumer_group
  - kafka_describe_topic
---
# AWS MSK Consumer Lag Investigation

Classify growing consumer lag on an MSK Provisioned cluster (Standard or Express brokers)
into one of five causes, then drill into the one the metrics point at. The decision tree
and thresholds are adapted from the AWS Agent Toolkit skill `managing-amazon-msk`
(`references/troubleshoot-consumer-lag.md` and `references/monitor-and-alarm.md`,
github.com/aws/agent-toolkit-for-aws, Apache-2.0, Copyright Amazon.com, Inc. or its
affiliates), rewritten for this deployment's read-only tool surface.

## Quick checklist

1. Anchor the window on an alarm or on the first lag datapoint that departs from baseline.
2. Decide the lag PATTERN (all groups vs one group vs some partitions vs recovering).
3. Broker-side: check the five broker saturation metrics before blaming the client.
4. Partition skew: confirm with per-partition lag from kafka-agent.
5. Client-side: consumer count vs partition count, poll interval, fetch tuning.
6. Maintenance or rebalance storm: confirm with cluster-state metrics and Health events.
7. Report the pattern, the metric values that decided it, and what was NOT checked.

## Symptoms

- CloudWatch alarm on `SumOffsetLag`, `MaxOffsetLag`, or `EstimatedMaxTimeLag` in `ALARM`
- kafka-agent reports lag growing for one or more consumer groups (the
  `kafka-significant-lag` correlation rule fires and asks for AWS evidence)
- Downstream consumers (order processing, notifications, CDC sinks) fall behind their SLA
  while producers report normal throughput
- Lag that spikes and recovers on a schedule (patch windows) or on every deploy

## Investigation Steps

### 1. Establish the signal and the window

Use `aws_cloudwatch_describe_alarms` filtered to `StateValue: ALARM` and look for
`Namespace: AWS/Kafka`. A firing lag alarm anchors the window at `StateUpdatedTimestamp`.
If no alarm exists, anchor on the kafka-agent lag finding's timestamp instead. Do not use
"now" as the start of the window.

Every AWS/Kafka metric below lives in namespace `AWS/Kafka`. Consumer-lag metrics carry the
dimensions `Cluster Name`, `Consumer Group`, and `Topic` and never `Broker ID`. Read the
offset-lag family with the `Maximum` statistic: `Average` dilutes a single hot partition and
`Sum` over time double-counts. Do not invent metric names such as ConsumerLag, RecordLag, or
EstimatedMaximumLag; they do not exist.

### 2. Decide the lag pattern

If the consumer group is not yet known, find the worst offender with
`aws_cloudwatch_metrics_insights_query` (dimension names containing spaces are
double-quoted):

```text
SELECT MAX(SumOffsetLag) FROM SCHEMA("AWS/Kafka", "Cluster Name", "Consumer Group", Topic) GROUP BY "Consumer Group", Topic ORDER BY MAX() DESC LIMIT 10
```

Then pull the time series with `aws_cloudwatch_get_metric_data` for `SumOffsetLag` and
`EstimatedMaxTimeLag` on the named cluster, consumer group, and topic over the anchored
window. Compare across groups and topics:

| Pattern | Likely cause | Go to |
|---|---|---|
| Lag rising on ALL consumer groups and topics at once | Broker-side saturation | Step 3 |
| Lag rising on SOME partitions of one topic, others near zero | Hot keys / partition skew | Step 4 |
| Lag rising on ONE consumer group only, other groups on the same topic fine | Client-side consumer issue | Step 5 |
| Lag spiked then is recovering on its own | Maintenance or a rebalance | Steps 6 and 7 |

kafka-agent's `kafka_get_consumer_group_lag` gives the same answer from the client side,
per partition, and is the faster way to distinguish "some partitions" from "all
partitions". When kafka-agent cannot reach the MSK bootstrap brokers (a known state for
some estates), the CloudWatch metrics above are the ONLY lag source; say so in the report
rather than leaving the client-side view as an unexplained gap.

### 3. Broker-side bottleneck

Pull these per-broker metrics (dimensions `Cluster Name` + `Broker ID`) with
`aws_cloudwatch_get_metric_data` over the anchored window. Thresholds are the MSK
best-practice alarm thresholds:

| Metric | Threshold | Meaning |
|---|---|---|
| `CpuUser` + `CpuSystem` | Average > 60% | Broker overloaded. Check client batch sizes before recommending a bigger broker. |
| `RequestHandlerAvgIdlePercent` | Average < 30% (0.3) | Request handler threads saturated; too many small requests. |
| `NetworkProcessorAvgIdlePercent` | Average < 30% (0.3) | Network threads saturated: connection storms, TLS overhead, tiny fetches. |
| `ProduceTotalTimeMsMean`, `FetchConsumerTotalTimeMsMean` | Elevated vs baseline | Produce or consumer-fetch latency is high at the broker, so consumers cannot keep up. |

Standard-broker-only checks (these metrics are NOT emitted by Express brokers; their
absence on an Express cluster is expected, not a gap):

| Metric | Threshold | Meaning |
|---|---|---|
| `BwInAllowanceExceeded`, `BwOutAllowanceExceeded` | Sum > 0 | EC2 network bandwidth exceeded, traffic shaping active. Check per-broker traffic for AZ skew. |
| `HeapMemoryAfterGC` | Average > 60% | Memory pressure: high connection count, many consumer groups, or many partitions. |
| `BurstBalance` | Dropping toward 0 | GP2 volume burst credits depleting under sustained I/O. |
| `VolumeQueueLength`, `VolumeTotalWriteTime` | Elevated | EBS throughput saturated. |
| `KafkaDataLogsDiskUsed` | Max > 85% | Disk pressure; at 100% the broker stops accepting writes. |

Express-broker-only checks: `ProduceThrottleTime` or `FetchThrottleTime` > 0 means the
per-broker throughput quota is exceeded.

If a broker health metric is missing for one broker only while peers report, that broker
may be mid-restart: go to Step 6 before concluding it is unhealthy. If every broker metric
is within threshold, the problem is client-side: go to Step 5.

To find the hottest broker without knowing its ID:

```text
SELECT AVG(CpuUser) FROM SCHEMA("AWS/Kafka", "Cluster Name", "Broker ID") GROUP BY "Broker ID" ORDER BY AVG() DESC LIMIT 10
```

### 4. Partition-level bottleneck (hot keys)

Confirm with kafka-agent: `kafka_get_consumer_group_lag` reports lag per partition and
`kafka_describe_consumer_group` shows which member owns each partition. If a few partitions
carry almost all the lag, the cause is either key skew (a few keys hash to the same
partitions) or one slow consumer instance that happens to own those partitions.
`kafka_describe_topic` gives the partition count so the report can state the consumer to
partition ratio.

Do not recommend adding partitions for key skew: every hot key still hashes to exactly one
partition, so the imbalance stays. The fix is a better key distribution or a faster consumer
for those partitions.

### 5. Client-side consumer issues

When the broker metrics are healthy and lag is isolated to one group, report the client-side
suspects with whatever the kafka-agent view supports:

- Fewer active members than partitions (`kafka_describe_consumer_group` member count vs
  `kafka_describe_topic` partition count): some consumers own several partitions and cannot
  keep up. Consumers beyond the partition count sit idle, so the ceiling is the partition
  count.
- Slow per-record processing (database writes, HTTP calls): the consumer exceeds
  `max.poll.interval.ms`, gets evicted, and triggers a rebalance. Recommend lowering
  `max.poll.records` before raising the interval.
- Fetch tuning: `fetch.min.bytes` at the default 1 byte generates a fetch per record.
  Recommend at least 1 KB and `fetch.max.wait.ms` around 1000 ms.
- Read-committed isolation with a hanging transaction: the consumer only reads up to the
  last stable offset, so lag grows indefinitely on the affected partitions even when the
  active producers are not transactional. Typical cause: a crashed Kafka Streams app with
  exactly-once processing or a decommissioned transactional producer. This is confirmed by
  the application team, not by any read-only tool here; report it as a hypothesis.

### 6. Maintenance-induced lag

MSK patches Standard brokers with rolling restarts. During the window, `UnderReplicatedPartitions`
spikes then decays, `ActiveControllerCount` changes on controller election, and one broker's
metrics disappear from CloudWatch for several minutes then resume. Express brokers stay
`ACTIVE` and emit no `UnderReplicatedPartitions`; on Express, `ProduceThrottleTime` or
`FetchThrottleTime` may spike briefly while the remaining brokers absorb load.

Controller-emitted cluster metrics (`ActiveControllerCount`, `OfflinePartitionsCount`,
`GlobalPartitionCount`, `PreferredReplicaImbalanceCount`) are reported by every broker but
only the active controller reports the real value; the others report 0. Read them with the
`Maximum` statistic, never `Average` (Average returns roughly 1/N of the true value on an
N-broker cluster).

Check `aws_health_describe_events` for `MSK_SCHEDULED_CHANGE` or
`MSK_OPERATIONAL_NOTIFICATION` in the window. A `SubscriptionRequiredException` means the
account is on Basic support; note the gap once and do not re-flag it.

Lag that is already recovering during a confirmed maintenance window is expected and
self-resolving. Do not recommend broker restarts or partition reassignment while
`UnderReplicatedPartitions` is non-zero.

### 7. Consumer group rebalance storms

Symptoms: the group alternates between Stable and PreparingRebalance
(`kafka_describe_consumer_group` state), lag grows during each cycle, and the client
`rebalance-latency-avg` metric is elevated. Common causes:

- Consumer crashes with the default eager assignor; every crash is a stop-the-world rebalance.
- `session.timeout.ms` at the 10 s default: GC pauses and network blips evict healthy members.
- Deploy-triggered cascades: all consumers restart at once.
- Too many consumer groups overloading the coordinator broker.
- Stuck rebalance on Kafka 2.6 and older (KAFKA-9752); not applicable to 3.x or Express.

Recommendations are configuration changes for the application team: the cooperative sticky
assignor (two rolling restarts are required to migrate; mixing eager and cooperative
protocols in one group raises an inconsistent-protocol error), a static `group.instance.id`,
`session.timeout.ms` of 45 to 60 s with `heartbeat.interval.ms` of 10 s, and a clean
consumer close on SIGTERM.

## Cross-Datasource Correlation

The Phase 5 (SIO-761) rule `kafka-significant-lag` requires a matching elastic-agent finding
and the sibling rule `aws-cloudwatch-anomaly-needs-kafka-lag` re-fans-out to kafka-agent when
an MSK alarm fires without Kafka evidence. Use both directions:

- MSK lag alarm + kafka-agent lag on ALL groups + broker CPU or idle-percent breached: broker
  saturation, capacity event.
- MSK lag alarm + kafka-agent lag on SOME partitions + broker metrics normal: key skew, an
  application-side fix.
- MSK lag alarm + one consumer group only + Elastic APM shows that service's latency or error
  rate climbing at the same time: slow consumer, application incident, not MSK.
- MSK lag alarm + `UnderReplicatedPartitions` spike + AWS Health MSK event in the window:
  maintenance, self-resolving; report and do not escalate.
- MSK lag alarm + GitLab deploy of the consumer service just before the spike: rebalance
  cascade from the rollout; correlate with the code-change runbook.
- Lag growing while kafka-agent cannot reach the bootstrap brokers at all: see
  [`aws-msk-broker-unreachable.md`](./aws-msk-broker-unreachable.md); connectivity, not lag,
  is the incident.

## Escalation Criteria

- Broker saturation on more than one broker with `OfflinePartitionsCount` > 0: page on-call.
- `KafkaDataLogsDiskUsed` above 85% on any Standard broker while lag grows: page on-call and
  open a capacity ticket.
- `EstimatedMaxTimeLag` beyond the consumer's SLA for more than 15 minutes outside a
  confirmed maintenance window: page the owning team.
- Rebalance storm or key skew with brokers healthy: application-team ticket, not a page.

## Known Configuration Gaps (don't re-flag as findings)

- Per-partition `OffsetLag` and `EstimatedTimeLag` exist only at the paid
  PER_TOPIC_PER_PARTITION monitoring level; `RequestHandlerAvgIdlePercent`,
  `NetworkProcessorAvgIdlePercent`, and the EBS volume metrics need PER_BROKER. A metric that
  returns no datapoints on an otherwise healthy cluster is a monitoring-level gap; report the
  level needed and fall back to the DEFAULT-level metrics (`SumOffsetLag`, `MaxOffsetLag`,
  `EstimatedMaxTimeLag`, CPU, disk, heap).
- The MSK control-plane API (cluster state, monitoring level, broker logging) is not on the
  read surface; cluster state during maintenance is inferred from metrics and Health events.
- Client-side settings (poll interval, fetch tuning, assignor, isolation level) are not
  readable from any tool here; report them as hypotheses for the application team to confirm.

## Recovery Actions (Require Human Approval)

- Scale broker size or add brokers (broker saturation)
- Change the consumer's partitioning key or processing logic (key skew)
- Tune consumer configuration and migrate to the cooperative sticky assignor (rebalance storm)
- Abort hanging transactions with the Kafka transactions CLI (read-committed stall)
- Raise the MSK monitoring level to PER_BROKER for production clusters
