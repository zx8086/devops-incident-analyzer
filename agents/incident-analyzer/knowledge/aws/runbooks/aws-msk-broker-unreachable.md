---
type: Runbook
title: "AWS MSK Broker Unreachable Investigation"
description: "Investigate MSK brokers that are unreachable or failing health checks."
status: stable
tags: [aws, msk, kafka]
generated:
  by: human:simon
  at: 2026-07-29
triggers:
  metrics:
    - broker
    - msk
    - unreachable
    - connection refused
  services:
    - msk
    - kafka
  match: any
tools:
  - aws_cloudwatch_describe_alarms
  - aws_cloudwatch_get_metric_data
  - aws_ec2_describe_instances
  - aws_ec2_describe_security_groups
  - aws_logs_describe_log_groups
  - aws_logs_start_query
  - aws_logs_get_query_results
  - aws_health_describe_events
  - kafka_describe_cluster
  - kafka_consume_messages
---
# AWS MSK Broker Unreachable Investigation

Investigate MSK brokers that are unreachable or failing health checks.

## Symptoms
- Kafka-agent tool calls (`kafka_describe_cluster`, `kafka_consume_messages`) timing out against MSK bootstrap brokers
- AWS CloudWatch alarms firing on MSK `KafkaDataLogsDiskUsed`, `ActiveControllerCount`, `OfflinePartitionsCount`, or `UnderReplicatedPartitions`
- A broker in the MSK cluster intermittently unreachable while peers respond
- Producers reporting `BROKER_NOT_AVAILABLE` or `NETWORK_EXCEPTION`

## Investigation Steps

### 1. Confirm there's a CloudWatch signal
Use `aws_cloudwatch_describe_alarms` filtered to alarms in `ALARM` state. Look for MSK-related alarms (`Namespace: AWS/Kafka`). The presence of a firing alarm anchors the investigation timeline at `StateUpdatedTimestamp`; the absence of one means the failure is sub-alarm-threshold or no alarm exists for the failure mode.

If multiple MSK alarms fire simultaneously across brokers, suspect a cluster-wide event (control-plane disruption, AZ-level issue) rather than a per-broker fault.

### 2. Pull recent MSK metric history
Use `aws_cloudwatch_get_metric_data` on the relevant MSK metrics for the cluster. The high-signal ones for unreachability:

- `BytesInPerSec` / `BytesOutPerSec` per broker — a broker that has dropped to 0 throughput while peers are still serving is the unreachable one
- `CPUUser` / `CPUSystem` per broker — sustained 100% CPU on a broker correlates with stuck request queues
- `KafkaDataLogsDiskUsed` per broker — at 100% the broker becomes read-only and fails writes; clients see this as broker-unreachable
- `OfflinePartitionsCount` cluster-wide — non-zero means leader-election failed on at least one partition

Window the query to start ~30 minutes before the alarm transition.

### 3. Identify the broker(s) backing the failure
The kafka-agent's `kafka_describe_cluster` call returns broker host/port/rack. Cross-reference the unreachable broker's host with EC2 instances:

```
host: b-1.<cluster-name>.<uuid>.<region>.amazonaws.com
```

The leading `b-N.` identifies the broker number. Use `aws_ec2_describe_instances` with a filter on the MSK ENI's private IP to find the underlying instance (MSK runs on EC2 under the hood, though the API treats brokers as managed nodes).

### 4. Check security groups for recent changes
Use `aws_ec2_describe_security_groups` on the SGs attached to the MSK cluster's network interfaces. A common cause of "broker becomes unreachable" is an out-of-band SG-rule change that removed the agent's source CIDR from the allowed ingress/egress rules — a network-layer failure, distinct from IAM authorization (the `kafka-cluster:Connect` action; see [`msk-iam-permissions.md`](./msk-iam-permissions.md)). SG changes affect whether the client can reach the broker's port at all; they have no effect on IAM policy evaluation, which happens only after network connectivity is established, during the TLS/SASL_IAM handshake.

Compare the current `IpPermissions` to the expected list. If a rule was recently removed for the agent's source CIDR, the network team's audit log will have a corresponding CloudTrail entry — escalate the SG change as the root cause. If instead the client connects but the handshake itself is rejected, that points to an IAM `kafka-cluster:Connect` denial, not a security-group issue — see [`msk-iam-permissions.md`](./msk-iam-permissions.md).

### 5. Pull CloudWatch Logs for the broker
MSK broker logs are delivered to CloudWatch only if broker logging was explicitly enabled on the cluster (`LoggingInfo.BrokerLogs.CloudWatchLogs.Enabled`), and the destination log group name (`LoggingInfo.BrokerLogs.CloudWatchLogs.LogGroup`) is an arbitrary string chosen at cluster-create or update-monitoring time — there is no fixed naming convention, so do not assume a path like `/aws/msk/<cluster-name>`. No MCP tool in this deployment surfaces the MSK control-plane `LoggingInfo` directly (`kafka_describe_cluster` only returns Kafka-protocol broker metadata, not AWS-side logging config), so use `aws_logs_describe_log_groups` without a fixed prefix assumption — search broadly (e.g. by the cluster or service name). **The tools available here cannot actually confirm a found log group is wired to this specific cluster** (that confirmation requires reading `LoggingInfo`, which nothing in this deployment exposes) — if a plausibly-named group is found, report the CloudWatch association itself as unverified rather than asserting it's correct, and note that MSK may instead (or additionally) route logs to S3 or Firehose, which this runbook has no way to check at all. Then use `aws_logs_start_query` + `aws_logs_get_query_results` with:

```
fields @timestamp, @message
| filter @timestamp >= now(-30m)
| filter @message like /ERROR|FATAL|Connection refused|timeout/
| sort @timestamp desc
| limit 50
```

Empty results are consistent with MSK logging being disabled at the cluster level, but can equally mean the log group was never located (wrong name guessed), the association to this cluster is unverified, or logging routes to S3/Firehose instead of CloudWatch. In all of these cases, report broker-log coverage as an unverified gap, not as a healthy broker or confirmed-disabled logging.

### 6. Check AWS Health for cluster-level events
Use `aws_health_describe_events`. AWS Health surfaces MSK-specific events (`MSK_OPERATIONAL_NOTIFICATION`, `MSK_SCHEDULED_CHANGE`) that explain symptoms the metrics alone cannot. `SubscriptionRequiredException` on Basic support means this check is unavailable — note the gap.

### 7. Confirm the bootstrap-broker list is fresh
A stale `MSK_BOOTSTRAP_BROKERS` env var in the kafka-agent's config can cause the symptom "broker N unreachable" even though the broker has been replaced (MSK rotates host names on broker replacement). If the symptom is persistent and the brokers in `aws_ec2_describe_instances` don't match the host names the kafka-agent is targeting, the bootstrap list needs refreshing via `kafka:GetBootstrapBrokers`. See [`msk-iam-permissions.md`](./msk-iam-permissions.md) if the GetBootstrapBrokers call is itself denied.

## Cross-Datasource Correlation

The Phase 5 (SIO-761) correlation rule `kafka-broker-timeout-needs-aws-metrics` fires when kafka-agent reports a broker timeout and AWS findings are not part of the answer. The supervisor re-fans-out to aws-agent to pull CloudWatch metrics and security-group state so the timeout can be attributed to a real broker-side cause rather than left as an unexplained client-side gap.

- Kafka broker timeout + MSK CloudWatch alarm on `OfflinePartitionsCount` > 0 → real broker failure
- Kafka broker timeout + AWS Health MSK operational event → AWS-side maintenance, not the agent's fault
- Kafka broker timeout + recent security-group rule removal → connectivity loss, not broker fault — escalate the SG change
- Kafka broker timeout + all MSK CloudWatch metrics normal + no SG changes → suspect the client-side bootstrap-broker list or DNS resolution; not an MSK incident

## Escalation Criteria
- Multiple brokers unreachable simultaneously with `OfflinePartitionsCount > 0`: page on-call
- Single broker unreachable but cluster `ActiveControllerCount == 1`: monitor `aws_health_describe_events` and CloudWatch `OfflinePartitionsCount`/broker state; MSK does not publish a guaranteed replacement SLA (the MSK SLA covers only 99.9% monthly uptime), so escalate to on-call if the broker has not rejoined the cluster within your environment's own escalation-policy window rather than waiting on a fixed duration
- Disk-full broker (`KafkaDataLogsDiskUsed == 100%`): page on-call AND open a capacity-planning ticket (auto-scaling MSK storage may not be enabled)

## Known Configuration Gaps (don't re-flag as findings)
- IAM denial on `kafka:DescribeClusterV2` or `kafka:GetBootstrapBrokers` is a control-plane permission gap — link to [`msk-iam-permissions.md`](./msk-iam-permissions.md). The fix is an IAM policy update, not an MSK cluster issue.
- IAM denial on `aws_cloudwatch_describe_alarms` or `aws_ec2_describe_security_groups` from the AWS MCP server side — link to [`aws-iam-permission-troubleshooting.md`](./aws-iam-permission-troubleshooting.md). Different IAM role from the kafka-agent's.

## Recovery Actions (Require Human Approval)
- Trigger MSK broker reboot via the AWS console (not exposed as a read-only MCP tool)
- Resize the cluster's storage to recover from `KafkaDataLogsDiskUsed == 100%`
- Restore a removed security-group rule (coordinate with the network team's change log)

## All Tools Used Are Read-Only
aws_cloudwatch_describe_alarms, aws_cloudwatch_get_metric_data, aws_ec2_describe_instances, aws_ec2_describe_security_groups, aws_logs_describe_log_groups, aws_logs_start_query, aws_logs_get_query_results, aws_health_describe_events, kafka_describe_cluster, kafka_consume_messages
