# AWS Estate Onboarding (IAM Setup)

**Scope:** Set up cross-account read-only access for the AWS MCP runtime. Same model as the Kafka MCP server, except the AWS runtime additionally assumes a per-estate role in each monitored account to query AWS APIs on its behalf.

---

## Account Architecture

### AgentCore Account (runtime host)

| Name | Account ID |
|---|---|
| `eu-shared-services-prd` | `399987695868` |

### Monitored Accounts (read-only targets)

| Name | Account ID |
|---|---|
| `eu-oit-prd` | `762715229080` |
| `eu-ediservices-prd` | `523422062084` |
| `eu-mendix-platform-prd` | `654654584630` |
| `eu-b2becom-v2-prd` | `178531813197` |
| `eu-b2b-ecom-prd` | `105329690220` |
| `eu-b2bonboarding-prd` | `728412486223` |

### Trust + ExternalId

The shared `ExternalId` value is `devops-agent-prod-access`. The trust policy in every monitored account names `arn:aws:iam::399987695868:role/DevOpsAgentCoreRole` as the only allowed `Principal`, gated by that ExternalId.

---

## Part 1 — AgentCore Account (`399987695868`)

### 1.1 Create the execution role

**Role name:** `DevOpsAgentCoreRole`

**Trust policy** (who can assume the role) — Bedrock AgentCore service, scoped by `aws:SourceAccount`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "399987695868" }
      }
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name DevOpsAgentCoreRole \
  --assume-role-policy-document file://devops-agent-core-role-trust-policy.json \
  --description "AgentCore runtime execution role for AWS MCP server"
```

### 1.2 Attach the inline permissions policy

**Policy name:** `DevOpsAgentCoreAssumePolicy` (inline on the role above)

Covers four things the runtime needs:

1. **CloudWatch Logs** — emit runtime logs to `/aws/bedrock-agentcore/*` in account 399987695868.
2. **ECR Pull** — pull the runtime container image from the AgentCore account's ECR.
3. **Wildcard AssumeRole on `DevOpsAgentReadOnly`** — convenience grant for any account that follows the naming convention. Onboarding a new monitored account doesn't require updating this policy.
4. **Explicit per-account AssumeRole list** — defense-in-depth and audit clarity for the monitored accounts. This includes `399987695868` itself (SIO-837): the host/shared-services account is queried like any other estate via a **same-account AssumeRole** into its own `DevOpsAgentReadOnly` role. No credential-less special case.


```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:399987695868:log-group:/aws/bedrock-agentcore/*"
    },
    {
      "Sid": "ECRPull",
      "Effect": "Allow",
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AssumeDevOpsAgentReadOnlyWildcard",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/DevOpsAgentReadOnly"
    },
    {
      "Sid": "ExplicitAccountAssumeRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::762715229080:role/DevOpsAgentReadOnly",
        "arn:aws:iam::523422062084:role/DevOpsAgentReadOnly",
        "arn:aws:iam::654654584630:role/DevOpsAgentReadOnly",
        "arn:aws:iam::178531813197:role/DevOpsAgentReadOnly",
        "arn:aws:iam::105329690220:role/DevOpsAgentReadOnly",
        "arn:aws:iam::728412486223:role/DevOpsAgentReadOnly",
        "arn:aws:iam::399987695868:role/DevOpsAgentReadOnly"
      ]
    }
  ]
}
```

```bash
aws iam put-role-policy \
  --role-name DevOpsAgentCoreRole \
  --policy-name DevOpsAgentCoreAssumePolicy \
  --policy-document file://devops-agent-core-assume-policy.json
```

---

## Part 2 — Each Monitored Account (× 6)

Repeat the steps below in **each** of the 6 monitored accounts. The role name, trust policy, and permissions policy are identical across all 6.

**Role name:** `DevOpsAgentReadOnly`

### 2.1 Trust policy

Allows the AgentCore execution role (in `399987695868`) to assume `DevOpsAgentReadOnly` when it presents the matching `ExternalId`.


```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrustAgentCoreInSharedServices",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::399987695868:role/DevOpsAgentCoreRole"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "devops-agent-prod-access" }
      }
    }
  ]
}
```

### 2.2 Permissions policy

Read-only access across the AWS services the MCP server exposes (all 39 tools shipped in). Includes the 4 extra actions surfaced during review: `s3:GetBucketPolicyStatus`, `states:ListStateMachines`, `states:DescribeStateMachine`, `config:ListDiscoveredResources`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IdentityAndAccountDiscovery",
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    },
    {
      "Sid": "RegionalAndNetworkTopology",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeRegions",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeRouteTables",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeAddresses",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetHealth"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ComputeContainersAndServerlessRead",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeImages",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "ecs:ListClusters",
        "ecs:DescribeClusters",
        "ecs:ListServices",
        "ecs:DescribeServices",
        "ecs:ListTasks",
        "ecs:DescribeTasks",
        "ecs:ListContainerInstances",
        "ecs:DescribeContainerInstances",
        "eks:ListClusters",
        "eks:DescribeCluster",
        "lambda:ListFunctions",
        "lambda:GetFunctionConfiguration",
        "lambda:ListEventSourceMappings"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DatastoresAndStorageRead",
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances",
        "rds:DescribeDBClusters",
        "dynamodb:ListTables",
        "dynamodb:DescribeTable",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketEncryption",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:GetBucketPolicyStatus"
      ],
      "Resource": "*"
    },
    {
      "Sid": "MessagingAndIntegrationRead",
      "Effect": "Allow",
      "Action": [
        "sns:ListTopics",
        "sns:GetTopicAttributes",
        "sqs:ListQueues",
        "sqs:GetQueueAttributes",
        "events:ListEventBuses",
        "events:ListRules",
        "events:DescribeRule",
        "events:ListTargetsByRule",
        "states:ListStateMachines",
        "states:DescribeStateMachine"
      ],
      "Resource": "*"
    },
    {
      "Sid": "MetricsAlarmsAndDashboardsRead",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:ListMetrics",
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:DescribeAlarmsForMetric",
        "cloudwatch:GetDashboard",
        "cloudwatch:ListDashboards"
      ],
      "Resource": "*"
    },
    {
      "Sid": "LogsReadLimitedByName",
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:GetLogEvents",
        "logs:FilterLogEvents",
        "logs:StartQuery",
        "logs:GetQueryResults",
        "logs:StopQuery"
      ],
      "Resource": [
        "arn:aws:logs:*:*:log-group:/aws/*",
        "arn:aws:logs:*:*:log-group:/ecs/*",
        "arn:aws:logs:*:*:log-group:/app/*",
        "arn:aws:logs:*:*:log-group:/platform/*",
        "arn:aws:logs:*:*:log-group:/prod/*",
        "arn:aws:logs:*:*:log-group:/bedrock/*"
      ]
    },
    {
      "Sid": "TracingAndServiceMapRead",
      "Effect": "Allow",
      "Action": [
        "xray:GetServiceGraph",
        "xray:GetTraceSummaries",
        "xray:BatchGetTraces",
        "xray:GetGroups"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AwsHealthAndConfigRead",
      "Effect": "Allow",
      "Action": [
        "health:DescribeEvents",
        "health:DescribeEventDetails",
        "config:DescribeConfigRules",
        "config:DescribeComplianceByConfigRule",
        "config:ListDiscoveredResources"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudFormationAndDeploymentContext",
      "Effect": "Allow",
      "Action": [
        "cloudformation:ListStacks",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:GetTemplate",
        "cloudformation:ListStackResources",
        "tag:GetResources",
        "tag:GetTagKeys",
        "tag:GetTagValues"
      ],
      "Resource": "*"
    }
  ]
}
```

### 2.3 Apply via CLI

From a session authenticated **as the target monitored account** (not the AgentCore account):

```bash
# Create the role with the trust policy
aws iam create-role \
  --role-name DevOpsAgentReadOnly \
  --assume-role-policy-document file://devops-agent-readonly-trust-policy.json \
  --description "Read-only access for the AWS MCP runtime in eu-shared-services-prd"

# Attach the inline permissions policy
aws iam put-role-policy \
  --role-name DevOpsAgentReadOnly \
  --policy-name DevOpsAgentReadOnlyPolicy \
  --policy-document file://devops-agent-readonly-policy.json
```

### 2.4 Per-account checklist

For each of the 6 accounts:

- [ ] `762715229080` (eu-oit-prd) — role created, trust + permissions attached
- [ ] `523422062084` (eu-ediservices-prd) — role created, trust + permissions attached
- [ ] `654654584630` (eu-mendix-platform-prd) — role created, trust + permissions attached
- [ ] `178531813197` (eu-b2becom-v2-prd) — role created, trust + permissions attached
- [ ] `105329690220` (eu-b2b-ecom-prd) — role created, trust + permissions attached
- [ ] `728412486223` (eu-b2bonboarding-prd) — role created, trust + permissions attached

---

## Part 3 — Verification

### Manual `AssumeRole` from the AgentCore account

Run from a session authenticated as `DevOpsAgentCoreRole` in `399987695868` (e.g. by assuming the role with the AWS CLI):

```bash
# Replace <ACCOUNT_ID> with each monitored account ID and confirm success for all 6.
aws sts assume-role \
  --role-arn arn:aws:iam::<ACCOUNT_ID>:role/DevOpsAgentReadOnly \
  --role-session-name devops-agent-onboarding-check \
  --external-id devops-agent-prod-access
```

A successful call returns `Credentials.AccessKeyId`, `SecretAccessKey`, `SessionToken`, and `Expiration`. Any failure is one of:

| Error | Meaning |
|---|---|
| `AccessDenied` on the source role | The AgentCore role's `DevOpsAgentCoreAssumePolicy` is missing this target ARN |
| `AccessDenied` on the target role | The target's trust policy doesn't list the AgentCore role as a Principal |
| `AccessDenied: ExternalId condition` | The target's trust policy expects a different ExternalId than `devops-agent-prod-access` |
| `NoSuchEntity` | The target role hasn't been created yet (skip to Part 2 for that account) |

---

## Onboarding a new estate later

When a new monitored account is added:

1. **In the new account:** repeat Part 2 (create `DevOpsAgentReadOnly` with the trust + permissions JSON files unchanged — they're parameter-free).
2. **In the AgentCore account:** update `DevOpsAgentCoreAssumePolicy`'s `ExplicitAccountAssumeRoles` statement to include the new ARN. The wildcard statement (`arn:aws:iam::*:role/DevOpsAgentReadOnly`) already covers it, but the explicit list is kept for audit clarity. Use `aws iam put-role-policy` (overwrites the inline policy atomically).
3. **Verify:** run the manual `sts:assume-role` check for the new account.

### Host / shared-services account (SIO-837)

The AgentCore host account `399987695868` (`eu-shared-services-prd`) is onboarded the **same way** — it is simply an estate that happens to be the same account the runtime runs in:

1. **In `399987695868`:** create `DevOpsAgentReadOnly` with the unchanged trust + permissions JSON files. The trust policy already names `arn:aws:iam::399987695868:role/DevOpsAgentCoreRole` as the principal, so the same-account assume works without modification. ExternalId is `devops-agent-prod-access`, identical to every other estate.
2. **Execution-role policy:** `arn:aws:iam::399987695868:role/DevOpsAgentReadOnly` is already in the `ExplicitAccountAssumeRoles` list (and the wildcard covers it).
3. **`AWS_ESTATES`:** add a normal entry — `"eu-shared-services-prd":{"assumedRoleArn":"arn:aws:iam::399987695868:role/DevOpsAgentReadOnly","externalId":"devops-agent-prod-access"}`. No credential-less / ambient-credential special case; the MCP server treats it like any other estate.

---

## Updating `AWS_ESTATES` on the AgentCore runtime (console)

The deployed runtime carries its **own** copy of `AWS_ESTATES`, set on the AgentCore runtime — it does **not** read the repo `.env` and is **not** baked into the container image. The image is built/exported as a tarball (`scripts/agentcore/push-to-production-ecr.sh --package mcp-server-aws --export-tarball`) and loaded into AgentCore via the AWS console; runtime env vars are set there too.

The AWS MCP runtime has exactly **two** environment variables:

| Variable | Value |
|---|---|
| `AWS_REGION` | `eu-central-1` |
| `AWS_ESTATES` | the full estate JSON map |

Everything else (transport mode `agentcore`, port 8000, log level, tool-result cap) comes from the Zod schema defaults compiled into the image — not env. Per-estate AWS access is **not** in env either; it comes from the execution role assuming each `DevOpsAgentReadOnly`.

To add or change an estate (e.g. the SIO-837 host estate):

1. **Bedrock AgentCore console** -> the AWS MCP runtime -> **Environment variables**.
2. Edit **`AWS_ESTATES`** -> paste the complete JSON map (all estates, not just the new one — this value is a full replace). Leave `AWS_REGION` unchanged.
3. Save; the runtime restarts with the new value.

> **Estate-only changes need no new image.** Adding/editing an estate is a config + IAM change only — re-export and reload the tarball only when the MCP server **code** changes. SIO-837 added no code, so the existing image stands; only the `AWS_ESTATES` env value changes.

**Verify:** call `aws_list_estates` after restart — the new estate should show `ok: true` with an `assumed-role/DevOpsAgentReadOnly/...` caller ARN.

---
