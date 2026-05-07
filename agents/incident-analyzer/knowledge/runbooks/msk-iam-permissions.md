# MSK IAM Permissions for Read-Only Introspection

## When to Use This
Reach for this runbook when a Kafka tool returns a permission error (e.g. `AccessDeniedException`, `kafka:DescribeClusterV2 not authorized`) or when `kafka_describe_cluster` succeeds but reports incomplete broker metadata against an MSK cluster. The kafka-agent should link to this runbook instead of re-raising the IAM gap as a finding on every run.

## Symptoms
- `kafka_describe_cluster` reports `0 brokers` or omits `controllerId` despite the cluster being reachable on its bootstrap address.
- AWS CloudTrail shows `AccessDenied` for `kafka:DescribeClusterV2`, `kafka:GetBootstrapBrokers`, or `kafka-cluster:Describe*` from the role used by the MCP server (e.g., `kafka-mcp-agentcore-role-dev`).
- The agent infers broker count from MSK canary group names (`__amazon_msk_canary_state_<id>`) instead of the actual cluster metadata.

## Minimum Read-Only IAM Actions

Two service principals are involved and both need permissions:

**`kafka:*`** — control-plane actions on the MSK cluster resource itself:
- `kafka:DescribeClusterV2` (broker count, controller ID, version)
- `kafka:GetBootstrapBrokers` (bootstrap address discovery)
- `kafka:ListClusters` (multi-cluster discovery)
- `kafka:ListNodes` (per-broker host/port/rack)
- `kafka:DescribeConfiguration` (cluster-level config — useful for correlating broker version with client API negotiation)

**`kafka-cluster:*`** — data-plane actions on cluster-internal resources (topics, groups, transactional IDs):
- `kafka-cluster:Connect` (TLS / SASL_IAM handshake — required before any other data-plane action)
- `kafka-cluster:DescribeCluster`
- `kafka-cluster:DescribeClusterDynamicConfiguration`
- `kafka-cluster:DescribeTopic`
- `kafka-cluster:DescribeTopicDynamicConfiguration`
- `kafka-cluster:DescribeGroup`
- `kafka-cluster:DescribeTransactionalId`
- `kafka-cluster:ReadData` (consumer group inspection requires reading offsets)

Excluded by design (write actions — must require explicit human approval): `kafka-cluster:WriteData`, `*Topic*` mutations, `AlterCluster*`, `*Group*` resets.

## Example Policy Snippet

Attach to the role the MCP server runs under (e.g., `kafka-mcp-agentcore-role-dev`). Replace `${REGION}`, `${ACCOUNT_ID}`, `${CLUSTER_NAME}`, `${CLUSTER_UUID}` with the values for your MSK cluster.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "MskControlPlaneReadOnly",
      "Effect": "Allow",
      "Action": [
        "kafka:DescribeClusterV2",
        "kafka:GetBootstrapBrokers",
        "kafka:ListClusters",
        "kafka:ListNodes",
        "kafka:DescribeConfiguration"
      ],
      "Resource": "*"
    },
    {
      "Sid": "MskDataPlaneReadOnly",
      "Effect": "Allow",
      "Action": [
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeCluster",
        "kafka-cluster:DescribeClusterDynamicConfiguration"
      ],
      "Resource": "arn:aws:kafka:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}/${CLUSTER_UUID}"
    },
    {
      "Sid": "MskTopicReadOnly",
      "Effect": "Allow",
      "Action": [
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:DescribeTopicDynamicConfiguration",
        "kafka-cluster:ReadData"
      ],
      "Resource": "arn:aws:kafka:${REGION}:${ACCOUNT_ID}:topic/${CLUSTER_NAME}/${CLUSTER_UUID}/*"
    },
    {
      "Sid": "MskGroupReadOnly",
      "Effect": "Allow",
      "Action": [
        "kafka-cluster:DescribeGroup"
      ],
      "Resource": "arn:aws:kafka:${REGION}:${ACCOUNT_ID}:group/${CLUSTER_NAME}/${CLUSTER_UUID}/*"
    },
    {
      "Sid": "MskTransactionalIdReadOnly",
      "Effect": "Allow",
      "Action": [
        "kafka-cluster:DescribeTransactionalId"
      ],
      "Resource": "arn:aws:kafka:${REGION}:${ACCOUNT_ID}:transactional-id/${CLUSTER_NAME}/${CLUSTER_UUID}/*"
    }
  ]
}
```

## Verification

After attaching the policy:

1. Run `kafka_describe_cluster` from the MCP server. Expect a non-empty `brokers` array with `host`, `port`, and `controllerId` populated. Empty result means the cluster connection succeeded but the IAM principal still lacks `kafka:DescribeClusterV2`.
2. Run `kafka_describe_consumer_group` against any consumer group on the cluster. Expect `state`, `protocolType`, and `members` fields populated. `Group authorization failed` means `kafka-cluster:DescribeGroup` is missing.
3. Run `kafka_consume_messages` against a low-volume topic with `maxMessages: 1`. Expect a message body or empty result (not `Topic authorization failed`). A topic-authorization error means `kafka-cluster:DescribeTopic` or `kafka-cluster:ReadData` is missing.
4. Re-run the kafka-agent against the same incident snapshot. The "Tool Errors" table in the report should no longer list `kafka:DescribeClusterV2 IAM permission missing`, and the cluster topology section should report the actual broker count rather than inferring from canary group names.

## Notes

- MSK uses the `kafka-cluster:` prefix only for IAM-auth (SASL/IAM) clusters. If the cluster uses SASL/SCRAM or mTLS auth, the data-plane permissions are enforced inside Kafka via ACLs instead — apply the equivalent ACLs (`Cluster:Describe`, `Topic:Describe`, `Topic:Read`, `Group:Describe`) via `kafka-acls.sh` rather than IAM.
- `*` on `kafka:` (control-plane) actions is acceptable because those operate at AWS-account scope and cannot leak data. Resource-scope the `kafka-cluster:` actions to a single cluster ARN to limit blast radius.
- This is a read-only policy. Any add of `kafka-cluster:WriteData`, `kafka-cluster:AlterCluster`, `kafka-cluster:CreateTopic`, or `kafka:Update*` requires explicit human approval and is out of scope for the kafka-agent.
