# AWS Estate Onboarding (IAM Setup)

**Scope:** Set up cross-account read-only access for the AWS MCP runtime. Same model as the Kafka MCP server, except the AWS runtime additionally assumes a per-estate role in each monitored account to query AWS APIs on its behalf.

The AgentCore host account is **also a monitored target**: `DevOpsAgentReadOnly` is created in `399987695868` as well, and the explicit assume-role list on `DevOpsAgentCoreRole` includes the host ARN. **7 accounts total (1 host + 6 estates), 7 monitored targets** — the host monitors itself via a same-account `sts:AssumeRole`, which keeps the runtime code path uniform across all estates.

---

## Account Architecture

### AgentCore Account (runtime host — and self-monitored target)

| Name | Account ID |
|---|---|
| `eu-shared-services-prd` | `399987695868` |

### Monitored Accounts (read-only targets — 6 external + 1 self)

| Name | Account ID |
|---|---|
| `eu-oit-prd` | `762715229080` |
| `eu-ediservices-prd` | `523422062084` |
| `eu-mendix-platform-prd` | `654654584630` |
| `eu-b2becom-v2-prd` | `178531813197` |
| `eu-b2b-ecom-prd` | `105329690220` |
| `eu-b2bonboarding-prd` | `728412486223` |
| `eu-shared-services-prd` (self) | `399987695868` |

### Trust + ExternalId

The shared `ExternalId` value is `devops-agent-prod-access`. The trust policy in every monitored account (including the host) names `arn:aws:iam::399987695868:role/DevOpsAgentCoreRole` as the only allowed `Principal`, gated by that ExternalId. The self-loop (host monitoring itself) is a same-account `sts:AssumeRole` with the same ExternalId gating — IAM allows this and it keeps the runtime code path uniform across all 7 estates.

---

## Part 1 — AgentCore Account (`399987695868`)

`DevOpsAgentCoreRole` already exists in this account. Part 1 **tightens its trust** and **adds the host self-ARN to its assume-role policy** — it does not recreate the role.

### 1.1 Verify and tighten the execution-role trust

**Role name:** `DevOpsAgentCoreRole`

The role's trust must scope the Bedrock AgentCore service principal by `aws:SourceAccount`. An existing role may be missing this condition; `update-assume-role-policy` corrects it in place.

**Trust policy:**

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
# Tightens trust on the existing role — does not recreate it.
aws iam update-assume-role-policy \
  --role-name DevOpsAgentCoreRole \
  --policy-document file://scripts/agentcore/policies/devops-agent-core-role-trust-policy.json
```

### 1.2 Update the assume-role permissions policy (add host ARN)

**Policy name:** `DevOpsAgentCoreAssumePolicy`

> **Managed vs inline.** This policy is deployed as a **customer-managed** policy (`arn:aws:iam::399987695868:policy/DevOpsAgentCoreAssumePolicy`), not as an inline role policy. Update it with `create-policy-version --set-as-default` so the managed policy stays the single source of truth. Do **not** add a same-named inline policy alongside it — that leaves two policies of the same name attached and is ambiguous. (If you must use the inline path, detach the managed policy afterwards — see the alternative below.)

Covers four things the runtime needs:

1. **CloudWatch Logs** — emit runtime logs to `/aws/bedrock-agentcore/*` in account 399987695868.
2. **ECR Pull** — pull the runtime container image from the AgentCore account's ECR.
3. **Wildcard AssumeRole on `DevOpsAgentReadOnly`** — convenience grant for any account that follows the naming convention. Onboarding a new monitored account doesn't require updating this policy.
4. **Explicit per-account AssumeRole list** — defense-in-depth and audit clarity. Lists **7 ARNs**: the 6 external estates plus the host self-loop `399987695868`.

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

**Apply — preferred path (update the managed policy in place):**

```bash
aws iam create-policy-version \
  --policy-arn arn:aws:iam::399987695868:policy/DevOpsAgentCoreAssumePolicy \
  --policy-document file://scripts/agentcore/policies/devops-agent-core-assume-policy.json \
  --set-as-default

# If you hit the 5-version cap, list and delete the oldest non-default version first:
aws iam list-policy-versions \
  --policy-arn arn:aws:iam::399987695868:policy/DevOpsAgentCoreAssumePolicy
```

**Alternative — inline (creates a name collision with the managed policy; requires a detach afterwards):**

```bash
aws iam put-role-policy \
  --role-name DevOpsAgentCoreRole \
  --policy-name DevOpsAgentCoreAssumePolicy \
  --policy-document file://scripts/agentcore/policies/devops-agent-core-assume-policy.json

# Then remove the now-duplicate managed policy so only one remains attached:
aws iam detach-role-policy \
  --role-name DevOpsAgentCoreRole \
  --policy-arn arn:aws:iam::399987695868:policy/DevOpsAgentCoreAssumePolicy
```

---

## Part 2 — Each Monitored Account (× 7)

Repeat the steps below in **each** of the 7 target accounts (6 external + 1 self). The role name, trust policy, and permissions policy are identical across all 7. For the host self-loop, "the target account" is still `399987695868`.

**Role name:** `DevOpsAgentReadOnly`

### 2.1 Trust policy

Allows the AgentCore execution role (in `399987695868`) to assume `DevOpsAgentReadOnly` when it presents the matching `ExternalId`. For the host self-loop this is a same-account assume — IAM permits it and the trust JSON is unchanged.

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

Read-only access across the AWS services the MCP server exposes (all 39 tools shipped in SIO-828). Includes the 4 extra actions surfaced during review: `s3:GetBucketPolicyStatus`, `states:ListStateMachines`, `states:DescribeStateMachine`, `config:ListDiscoveredResources`.

> **Keep in sync with new tools.** Whenever the AWS MCP server gains tools that call new AWS APIs, this policy must grow to match. SIO-841 (governance/security-baseline tools — CloudTrail, Security Hub, GuardDuty) is the next such change: when it lands it will add actions like `cloudtrail:LookupEvents`, `securityhub:GetFindings`, and `guardduty:ListFindings` here, and re-running `setup-aws-readonly-role.sh` (or `create-policy-version`) is required across all 7 accounts.

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

From a session authenticated **as the target account** (for the host self-loop, that's still `399987695868`):

```bash
# Create the role with the trust policy
aws iam create-role \
  --role-name DevOpsAgentReadOnly \
  --assume-role-policy-document file://scripts/agentcore/policies/devops-agent-readonly-trust-policy.json \
  --description "Read-only access for the AWS MCP runtime in eu-shared-services-prd"

# Attach the inline permissions policy
aws iam put-role-policy \
  --role-name DevOpsAgentReadOnly \
  --policy-name DevOpsAgentReadOnlyPolicy \
  --policy-document file://scripts/agentcore/policies/devops-agent-readonly-policy.json
```

Or use the idempotent wrapper, which handles create-or-update for both the trust and permissions policies:

```bash
./scripts/agentcore/setup-aws-readonly-role.sh
```

### 2.4 Per-account checklist

For each of the 7 accounts:

- [ ] `762715229080` (eu-oit-prd) — role created, trust + permissions attached
- [ ] `523422062084` (eu-ediservices-prd) — role created, trust + permissions attached
- [ ] `654654584630` (eu-mendix-platform-prd) — role created, trust + permissions attached
- [ ] `178531813197` (eu-b2becom-v2-prd) — role created, trust + permissions attached
- [ ] `105329690220` (eu-b2b-ecom-prd) — role created, trust + permissions attached
- [ ] `728412486223` (eu-b2bonboarding-prd) — role created, trust + permissions attached
- [ ] `399987695868` (eu-shared-services-prd — self-loop) — role created, trust + permissions attached

---

## Part 3 — Verification

### Verify the assume chain

Every `DevOpsAgentReadOnly` target trusts **only** `DevOpsAgentCoreRole` as its Principal. An SSO admin session therefore **cannot** directly `assume-role` into a target — the trust will reject it. Verify one of two ways.

**Simulate (no STS call, no role-chaining — works from your SSO session):**

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::399987695868:role/DevOpsAgentCoreRole \
  --action-names sts:AssumeRole \
  --resource-arns \
    arn:aws:iam::762715229080:role/DevOpsAgentReadOnly \
    arn:aws:iam::523422062084:role/DevOpsAgentReadOnly \
    arn:aws:iam::654654584630:role/DevOpsAgentReadOnly \
    arn:aws:iam::178531813197:role/DevOpsAgentReadOnly \
    arn:aws:iam::105329690220:role/DevOpsAgentReadOnly \
    arn:aws:iam::728412486223:role/DevOpsAgentReadOnly \
    arn:aws:iam::399987695868:role/DevOpsAgentReadOnly
```

**End-to-end (from inside the AgentCore runtime — the actual chain):**

```bash
# Inside the AgentCore runtime container, with DevOpsAgentCoreRole attached.
# Replace <ACCOUNT_ID> with each target and confirm success for all 7.
aws sts assume-role \
  --role-arn arn:aws:iam::<ACCOUNT_ID>:role/DevOpsAgentReadOnly \
  --role-session-name devops-agent-onboarding-check \
  --external-id devops-agent-prod-access
```

A successful `assume-role` returns `Credentials.AccessKeyId`, `SecretAccessKey`, `SessionToken`, and `Expiration`. Common failures:

| Error | Meaning |
|---|---|
| `AccessDenied` on the source role | `DevOpsAgentCoreAssumePolicy` is missing this target ARN — re-apply Part 1.2 |
| `AccessDenied` on the target role | The target's trust policy doesn't list `DevOpsAgentCoreRole` as a Principal |
| `AccessDenied: ExternalId condition` | The target's trust policy expects a different ExternalId than `devops-agent-prod-access` |
| `NoSuchEntity` | The target role hasn't been created yet — see Part 2 for that account |

---

## Part 4 — Update the AgentCore runtime `AWS_ESTATES`

Once Parts 1-3 are green, update the `aws_mcp_server` AgentCore runtime to include the host estate in `AWS_ESTATES`. Edit via the Bedrock AgentCore console or the `update-agent-runtime` CLI. Add this entry to the existing JSON map (the value is a **full replace** — paste all estates, not just the new one):

```json
"eu-shared-services-prd": {
  "assumedRoleArn": "arn:aws:iam::399987695868:role/DevOpsAgentReadOnly",
  "externalId": "devops-agent-prod-access"
}
```

> **Region (SIO-835).** `eu-central-1` is the single home region for all estates; SIO-835 removed the former `eu-west-1` override on `eu-b2bonboarding-prd`. Estate entries therefore omit a `region` field and inherit the runtime's `AWS_REGION`. Only add a per-estate `"region": "<id>"` key if an estate's workloads genuinely live elsewhere — do not re-introduce one speculatively.

The deployed runtime carries its **own** copy of `AWS_ESTATES`, set on the AgentCore runtime — it does **not** read the repo `.env` and is **not** baked into the container image. The AWS MCP runtime has exactly **two** environment variables:

| Variable | Value |
|---|---|
| `AWS_REGION` | `eu-central-1` |
| `AWS_ESTATES` | the full estate JSON map |

Everything else (transport mode `agentcore`, port 8000, log level, tool-result cap) comes from the Zod schema defaults compiled into the image — not env. Per-estate AWS access is **not** in env either; it comes from the execution role assuming each `DevOpsAgentReadOnly`.

> **Estate-only changes need no new image.** Adding/editing an estate is a config + IAM change only — re-export and reload the tarball only when the MCP server **code** changes.

> **Ordering matters.** Do Parts 1-2 *before* adding the host entry to the runtime's `AWS_ESTATES`. If the runtime gets the estate before the role exists, the host estate boots DEGRADED (boot-time STS validation fails) until the role is in place.

Saving creates a new runtime version. **Verify:** wait for the runtime status to return to `READY`, then call `aws_list_estates` — `eu-shared-services-prd` should show `ok: true` with an `assumed-role/DevOpsAgentReadOnly/...` caller ARN.

---

## Onboarding a new estate later

When a new monitored account is added:

1. **In the new account:** repeat Part 2 (create `DevOpsAgentReadOnly` with the trust + permissions JSON files unchanged — they're parameter-free), or run `./scripts/agentcore/setup-aws-readonly-role.sh` from a session in that account.
2. **In the AgentCore account:** update `DevOpsAgentCoreAssumePolicy`'s `ExplicitAccountAssumeRoles` statement to include the new ARN. The wildcard (`arn:aws:iam::*:role/DevOpsAgentReadOnly`) already covers it, but the explicit list is kept for audit clarity. Use `aws iam create-policy-version --set-as-default` (preferred) — see Part 1.2.
3. **Update the runtime:** add the new estate to `AWS_ESTATES` on the `aws_mcp_server` runtime (Part 4).
4. **Verify:** run `simulate-principal-policy` for the new ARN (Part 3), then end-to-end via the runtime.

---
