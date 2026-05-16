---
triggers:
  metrics:
    - broker-timeout
    - broker-unreachable
    - msk-broker
    - kafka-broker
    - connection-refused
  services:
    - msk
    - kafka
  match: any
---
# AWS MSK Broker Unreachable Investigation

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
Use `aws_ec2_describe_security_groups` on the SGs attached to the MSK cluster's network interfaces. A common cause of "broker becomes unreachable" is an out-of-band SG-rule change that removed the agent's source CIDR or principal from the `kafka:Connect` permission set.

Compare the current `IpPermissions` to the expected list. If a rule was recently removed for the agent's egress source, the network team's audit log will have a corresponding CloudTrail entry — escalate the SG change as the root cause.

### 5. Pull CloudWatch Logs for the broker
MSK ships broker logs to a CloudWatch log group named `/aws/msk/<cluster-name>` (if logging is enabled at cluster-create time). Use `aws_logs_describe_log_groups` with the prefix to confirm the log group exists, then `aws_logs_start_query` + `aws_logs_get_query_results` with:

```
fields @timestamp, @message
| filter @timestamp >= now(-30m)
| filter @message like /ERROR|FATAL|Connection refused|timeout/
| sort @timestamp desc
| limit 50
```

Empty results mean MSK logging is not enabled at the cluster level — report as a coverage gap, not as a healthy broker.

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
- Single broker unreachable but cluster `ActiveControllerCount == 1`: monitor; MSK will auto-replace within ~15 minutes
- Disk-full broker (`KafkaDataLogsDiskUsed == 100%`): page on-call AND open a capacity-planning ticket (auto-scaling MSK storage may not be enabled)

## Known Configuration Gaps (don't re-flag as findings)
- IAM denial on `kafka:DescribeClusterV2` or `kafka:GetBootstrapBrokers` is a control-plane permission gap — link to [`msk-iam-permissions.md`](./msk-iam-permissions.md). The fix is an IAM policy update, not an MSK cluster issue.
- IAM denial on `aws_cloudwatch_describe_alarms` or `aws_ec2_describe_security_groups` from the AWS MCP server side — link to [`aws-iam-permission-troubleshooting.md`](./aws-iam-permission-troubleshooting.md). Different IAM role from the kafka-agent's.

## Recovery Actions (Require Human Approval)
- Trigger MSK broker reboot via the AWS console (not exposed as a read-only MCP tool)
- Resize the cluster's storage to recover from `KafkaDataLogsDiskUsed == 100%`
- Restore a removed security-group rule (coordinate with the network team's change log)

## All Tools Used Are Read-Only
aws_cloudwatch_describe_alarms, aws_cloudwatch_get_metric_data, aws_ec2_describe_instances, aws_ec2_describe_security_groups, aws_logs_describe_log_groups, aws_logs_start_query, aws_logs_get_query_results, aws_health_describe_events, kafka_describe_cluster
