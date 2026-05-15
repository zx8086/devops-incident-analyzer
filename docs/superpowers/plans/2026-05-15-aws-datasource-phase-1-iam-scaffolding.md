# AWS Datasource Phase 1: IAM Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `DevOpsAgentReadOnly` IAM role in AWS account `352896877281` with the 11-statement read-only inventory policy and a trust policy ready for the (not-yet-created) AWS MCP AgentCore execution role to assume — and prove the role chain works end-to-end via AWS CLI before any MCP code touches it.

**Architecture:** One idempotent bash script (`scripts/agentcore/setup-aws-readonly-role.sh`) creates the role, attaches the inline policy, and prints assumption-verification instructions. The trust policy is shaped for the eventual AgentCore execution role principal (`arn:aws:iam::352896877281:role/aws-mcp-server-agentcore-role`) but, for Phase 1 verification only, a temporary trust entry for the local IAM Identity Center / dev profile is layered on so manual CLI `assume-role` checks can run. The temporary entry is removed at end of Phase 1 — the AgentCore role doesn't exist yet, so the role will be assumable by nothing once Phase 1 completes, which is fine: Phase 3's `deploy.sh` extension creates the AgentCore role and the trust policy is already pointing at it.

**Tech Stack:** `aws iam` CLI, `aws sts` CLI, `jq`, bash. No code changes anywhere in `packages/`. No `bun` invocations needed — this phase is purely AWS-side.

**Spec:** `docs/superpowers/specs/2026-05-15-aws-datasource-design.md`

**Linear:** (issue to be created before Task 1 — see Task 0)

---

## File Structure

**New files:**
- `scripts/agentcore/setup-aws-readonly-role.sh` — idempotent role+policy creation script (~140 LOC)
- `scripts/agentcore/policies/devops-agent-readonly-policy.json` — the 11-statement read-only IAM policy document
- `scripts/agentcore/policies/devops-agent-readonly-trust-policy.json` — trust policy template (production-shape)
- `scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json` — trust policy with temporary dev-principal entry (Phase 1 verification only)

**No package.json changes. No new bun dependencies. No production code modified.**

**Why a separate script (not inline in deploy.sh):** Per the spec, this role's lifecycle is independent of any specific AgentCore runtime. The deploy script creates the execution role per server; this script creates the assume-target. Keeping them separate matches the spec's "clean separation" rationale and means Phase 1 can complete and be merged before Phase 2 or 3 exist.

---

## Task 0: Create the Linear issue

Per CLAUDE.md: every approved plan must produce a Linear issue before implementation begins.

**Files:** none (Linear-only)

- [ ] **Step 0.1: Create Linear issue in Siobytes team**

Use the Linear MCP to create an issue with:
- **Title:** `Phase 1: Create DevOpsAgentReadOnly IAM role for AWS datasource`
- **Project:** DevOps Incident Analyzer
- **Status:** Todo (NOT Done)
- **Description:** Include a link to `docs/superpowers/specs/2026-05-15-aws-datasource-design.md` and `docs/superpowers/plans/2026-05-15-aws-datasource-phase-1-iam-scaffolding.md`. State that this is Phase 1 of 5 in the AWS datasource rollout. Scope: create the `DevOpsAgentReadOnly` IAM role in account `352896877281`, attach the 11-statement read-only policy, and verify the role chain via CLI per the spec's Layer 4 testing.

- [ ] **Step 0.2: Record the issue ID**

Note the issue ID (e.g., `SIO-XXX`). Every commit message in this plan uses that prefix per CLAUDE.md.

---

## Task 1: Add the read-only IAM policy document

**Files:**
- Create: `scripts/agentcore/policies/devops-agent-readonly-policy.json`

- [ ] **Step 1.1: Create the policies directory**

Run from repo root:

```bash
mkdir -p scripts/agentcore/policies
```

- [ ] **Step 1.2: Write the policy JSON**

Create `scripts/agentcore/policies/devops-agent-readonly-policy.json` with the full 11-statement read-only policy. Use this exact content:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IdentityAndAccountDiscovery",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "organizations:DescribeOrganization",
        "organizations:ListAccounts",
        "account:ListRegions"
      ],
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
        "ec2:DescribeNetworkAcls",
        "ec2:DescribeInternetGateways",
        "ec2:DescribeNatGateways",
        "ec2:DescribeVpcEndpoints",
        "ec2:DescribeVpcPeeringConnections",
        "ec2:DescribeTransitGateways",
        "ec2:DescribeTransitGatewayAttachments",
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
        "autoscaling:DescribePolicies",
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
        "lambda:GetPolicy",
        "lambda:ListEventSourceMappings",
        "apigateway:GET",
        "apigatewayv2:GetApis",
        "apigatewayv2:GetStages",
        "apigatewayv2:GetRoutes",
        "apigatewayv2:GetIntegrations"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DatastoresAndStorageRead",
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances",
        "rds:DescribeDBClusters",
        "rds:DescribeDBSubnetGroups",
        "rds:DescribeDBParameters",
        "rds:DescribeDBClusterParameters",
        "dynamodb:ListTables",
        "dynamodb:DescribeTable",
        "dynamodb:ListGlobalTables",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketEncryption",
        "s3:GetBucketPolicyStatus",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketLogging",
        "s3:GetBucketTagging",
        "s3:GetBucketNotification",
        "s3:ListBucket"
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
        "states:DescribeStateMachine",
        "states:ListExecutions",
        "states:DescribeExecution"
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
        "arn:aws:logs:*:*:log-group:/prod/*"
      ]
    },
    {
      "Sid": "TracingAndServiceMapRead",
      "Effect": "Allow",
      "Action": [
        "xray:GetServiceGraph",
        "xray:GetTraceSummaries",
        "xray:BatchGetTraces",
        "xray:GetGroups",
        "xray:GetGroup",
        "xray:GetInsightSummaries",
        "xray:GetInsight"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AwsHealthRead",
      "Effect": "Allow",
      "Action": [
        "health:DescribeEvents",
        "health:DescribeEventDetails",
        "health:DescribeAffectedEntities"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ConfigInventoryReadOptional",
      "Effect": "Allow",
      "Action": [
        "config:DescribeConfigRules",
        "config:DescribeComplianceByConfigRule",
        "config:GetResourceConfigHistory",
        "config:ListDiscoveredResources"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudFormationAndDeploymentContextRead",
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

- [ ] **Step 1.3: Validate JSON syntax**

Run from repo root:

```bash
jq '.' scripts/agentcore/policies/devops-agent-readonly-policy.json > /dev/null && echo "OK"
```

Expected output: `OK` (and exit 0). Any `jq` error means the JSON is malformed — fix and re-run.

- [ ] **Step 1.4: Confirm exactly 11 statements**

```bash
jq '.Statement | length' scripts/agentcore/policies/devops-agent-readonly-policy.json
```

Expected output: `11`

- [ ] **Step 1.5: Commit**

```bash
git add scripts/agentcore/policies/devops-agent-readonly-policy.json
git commit -m "SIO-XXX: add DevOpsAgentReadOnly IAM policy document"
```

Replace `SIO-XXX` with the actual issue ID from Task 0.

---

## Task 2: Add the production trust policy template

**Files:**
- Create: `scripts/agentcore/policies/devops-agent-readonly-trust-policy.json`

This is the trust policy that will be active at end of Phase 1. It points at the AgentCore execution role that **`deploy.sh` will create in Phase 3**. The role doesn't exist yet — that's fine, IAM allows trust policies to reference principals that don't yet exist. Once Phase 3 runs, the principal will resolve.

- [ ] **Step 2.1: Write the trust policy JSON**

Create `scripts/agentcore/policies/devops-agent-readonly-trust-policy.json` with:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAgentCoreExecutionRoleToAssume",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::352896877281:role/aws-mcp-server-agentcore-role"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "aws-mcp-readonly-2026"
        }
      }
    }
  ]
}
```

The principal `aws-mcp-server-agentcore-role` matches the role name that `scripts/agentcore/deploy.sh` will create when `MCP_SERVER=aws` is added in Phase 3 (the existing script's pattern is `${RUNTIME_NAME}-agentcore-role` where `RUNTIME_NAME=aws-mcp-server`).

- [ ] **Step 2.2: Validate JSON syntax**

```bash
jq '.' scripts/agentcore/policies/devops-agent-readonly-trust-policy.json > /dev/null && echo "OK"
```

Expected: `OK`.

- [ ] **Step 2.3: Commit**

```bash
git add scripts/agentcore/policies/devops-agent-readonly-trust-policy.json
git commit -m "SIO-XXX: add DevOpsAgentReadOnly trust policy template"
```

---

## Task 3: Add the Phase-1-only verification trust policy

This trust policy adds the local dev principal so the human running this plan can `aws sts assume-role` directly to test the role chain works. It's removed in Task 6.

**Files:**
- Create: `scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json`

- [ ] **Step 3.1: Determine the dev principal ARN**

Run:

```bash
aws sts get-caller-identity
```

Expected output: JSON with `UserId`, `Account`, and `Arn` fields. Copy the `Arn` value. It will be one of:
- `arn:aws:sts::352896877281:assumed-role/AWSReservedSSO_<role>_<hash>/<email>` (SSO)
- `arn:aws:iam::352896877281:user/<username>` (IAM user)
- `arn:aws:iam::352896877281:role/<role>` (assumed IAM role via another method)

If it's an SSO assumed-role ARN, you'll need the underlying role ARN, not the assumed-role ARN. Convert by taking the `assumed-role/<role>/<session>` shape and rewriting it as `role/aws-reserved/sso.amazonaws.com/<region>/<role>`. Easiest path: ask AWS Identity Center console for the exact permission set role ARN.

- [ ] **Step 3.2: Write the Phase-1 trust policy JSON**

Create `scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json`. Use this template, replacing `<DEV_PRINCIPAL_ARN>` with the value from Step 3.1:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAgentCoreExecutionRoleToAssume",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::352896877281:role/aws-mcp-server-agentcore-role"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "aws-mcp-readonly-2026"
        }
      }
    },
    {
      "Sid": "Phase1OnlyAllowDevPrincipal",
      "Effect": "Allow",
      "Principal": {
        "AWS": "<DEV_PRINCIPAL_ARN>"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "aws-mcp-readonly-2026"
        }
      }
    }
  ]
}
```

**Do not commit this file with a real ARN.** It contains your personal/dev principal ARN. Instead:

- [ ] **Step 3.3: Add the file to .gitignore**

Edit `.gitignore` at repo root. Find an appropriate section (or add a new one) and add:

```
# Phase 1 IAM trust policy with developer-specific principal — do not commit
scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json
```

- [ ] **Step 3.4: Verify the file is ignored**

```bash
git check-ignore scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json
```

Expected output: the path itself (echoed back). Exit 0 means it's ignored.

- [ ] **Step 3.5: Validate JSON syntax with placeholder filled**

```bash
jq '.' scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json > /dev/null && echo "OK"
```

Expected: `OK`. If you see a parse error, the principal ARN substitution likely created malformed JSON — re-check the surrounding quotes.

- [ ] **Step 3.6: Commit the .gitignore change**

```bash
git add .gitignore
git commit -m "SIO-XXX: gitignore phase-1 trust policy with dev principal"
```

---

## Task 4: Add the setup script

**Files:**
- Create: `scripts/agentcore/setup-aws-readonly-role.sh`

- [ ] **Step 4.1: Write the script**

Create `scripts/agentcore/setup-aws-readonly-role.sh` with this exact content:

```bash
#!/usr/bin/env bash
# scripts/agentcore/setup-aws-readonly-role.sh
#
# Creates (or updates) the DevOpsAgentReadOnly IAM role in the current
# AWS account with the 11-statement read-only inventory policy attached.
# Idempotent: re-running updates the policy and trust document in place.
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials that can create IAM roles
#     and managed policies in the target account
#   - jq installed
#
# Usage:
#   # Production trust (AgentCore execution role only):
#   ./scripts/agentcore/setup-aws-readonly-role.sh
#
#   # Phase 1 verification trust (AgentCore role + dev principal):
#   TRUST_POLICY_FILE=scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json \
#     ./scripts/agentcore/setup-aws-readonly-role.sh
#
# Environment variables:
#   AWS_REGION         - AWS region for the aws cli calls (default: eu-central-1)
#   ROLE_NAME          - Role name (default: DevOpsAgentReadOnly)
#   POLICY_NAME        - Managed policy name (default: DevOpsAgentReadOnlyPolicy)
#   POLICY_FILE        - Path to the permissions policy document
#                        (default: scripts/agentcore/policies/devops-agent-readonly-policy.json)
#   TRUST_POLICY_FILE  - Path to the trust policy document
#                        (default: scripts/agentcore/policies/devops-agent-readonly-trust-policy.json)

set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-central-1}"
ROLE_NAME="${ROLE_NAME:-DevOpsAgentReadOnly}"
POLICY_NAME="${POLICY_NAME:-DevOpsAgentReadOnlyPolicy}"
POLICY_FILE="${POLICY_FILE:-scripts/agentcore/policies/devops-agent-readonly-policy.json}"
TRUST_POLICY_FILE="${TRUST_POLICY_FILE:-scripts/agentcore/policies/devops-agent-readonly-trust-policy.json}"

# -- Validation --
if [ ! -f "${POLICY_FILE}" ]; then
  echo "Error: permissions policy file not found at ${POLICY_FILE}"
  exit 1
fi
if [ ! -f "${TRUST_POLICY_FILE}" ]; then
  echo "Error: trust policy file not found at ${TRUST_POLICY_FILE}"
  exit 1
fi
if ! jq '.' "${POLICY_FILE}" >/dev/null 2>&1; then
  echo "Error: permissions policy at ${POLICY_FILE} is not valid JSON"
  exit 1
fi
if ! jq '.' "${TRUST_POLICY_FILE}" >/dev/null 2>&1; then
  echo "Error: trust policy at ${TRUST_POLICY_FILE} is not valid JSON"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "================================================================"
echo "  DevOpsAgentReadOnly IAM Setup"
echo "================================================================"
echo "  Account:       ${ACCOUNT_ID}"
echo "  Region:        ${AWS_REGION}"
echo "  Role name:     ${ROLE_NAME}"
echo "  Policy name:   ${POLICY_NAME}"
echo "  Policy file:   ${POLICY_FILE}"
echo "  Trust file:    ${TRUST_POLICY_FILE}"
echo "================================================================"
echo ""

# -- Step 1: Create or update the managed policy --
echo "[1/3] Permissions policy..."
if aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  echo "  Policy exists, creating new default version..."
  # Trim old non-default versions to stay under the 5-version IAM limit.
  OLD_VERSIONS=$(aws iam list-policy-versions \
    --policy-arn "${POLICY_ARN}" \
    --query 'Versions[?!IsDefaultVersion].VersionId' \
    --output text)
  for v in ${OLD_VERSIONS}; do
    aws iam delete-policy-version --policy-arn "${POLICY_ARN}" --version-id "${v}" >/dev/null 2>&1 || true
  done
  aws iam create-policy-version \
    --policy-arn "${POLICY_ARN}" \
    --policy-document "file://${POLICY_FILE}" \
    --set-as-default >/dev/null
  echo "  Policy updated: ${POLICY_ARN}"
else
  aws iam create-policy \
    --policy-name "${POLICY_NAME}" \
    --policy-document "file://${POLICY_FILE}" \
    --description "Read-only inventory access for the DevOps Incident Analyzer (see docs/superpowers/specs/2026-05-15-aws-datasource-design.md)" >/dev/null
  echo "  Policy created: ${POLICY_ARN}"
fi

# -- Step 2: Create or update the role --
echo ""
echo "[2/3] Role..."
if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "  Role exists, updating trust policy..."
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "file://${TRUST_POLICY_FILE}"
  echo "  Trust policy updated"
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "file://${TRUST_POLICY_FILE}" \
    --description "Read-only inventory role assumed by the AWS MCP AgentCore container (see docs/superpowers/specs/2026-05-15-aws-datasource-design.md)" >/dev/null
  echo "  Role created: ${ROLE_ARN}"
fi

# -- Step 3: Attach the policy --
echo ""
echo "[3/3] Attaching policy to role..."
aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "${POLICY_ARN}" 2>/dev/null || true
echo "  Policy attached"

# IAM is eventually consistent; new roles take a moment to be assumable.
echo ""
echo "  Waiting for IAM consistency (10s)..."
sleep 10

echo ""
echo "================================================================"
echo "  Setup complete"
echo "================================================================"
echo ""
echo "  Role ARN:   ${ROLE_ARN}"
echo "  Policy ARN: ${POLICY_ARN}"
echo ""
echo "  Verify with:"
echo "    aws sts assume-role \\"
echo "      --role-arn ${ROLE_ARN} \\"
echo "      --role-session-name verify-readonly \\"
echo "      --external-id aws-mcp-readonly-2026"
echo ""
echo "================================================================"
```

- [ ] **Step 4.2: Make it executable**

```bash
chmod +x scripts/agentcore/setup-aws-readonly-role.sh
```

- [ ] **Step 4.3: Lint-check the script**

```bash
bash -n scripts/agentcore/setup-aws-readonly-role.sh && echo "OK"
```

Expected: `OK`. If shellcheck is available locally, also run:

```bash
shellcheck scripts/agentcore/setup-aws-readonly-role.sh
```

Expected: no errors. Warnings are acceptable but review them.

- [ ] **Step 4.4: Commit**

```bash
git add scripts/agentcore/setup-aws-readonly-role.sh
git commit -m "SIO-XXX: add idempotent setup-aws-readonly-role.sh script"
```

---

## Task 5: Run the script with Phase-1 trust and verify the role chain

**Files:** none modified — this task only exercises AWS APIs.

- [ ] **Step 5.1: Sanity-check current AWS identity and account**

```bash
aws sts get-caller-identity
```

Expected: the `Account` field shows `352896877281`. If not, switch profiles before continuing — running this in the wrong account creates an orphan role.

- [ ] **Step 5.2: Run the setup script with the Phase-1 trust policy**

```bash
TRUST_POLICY_FILE=scripts/agentcore/policies/devops-agent-readonly-trust-policy-phase1.json \
  AWS_REGION=eu-central-1 \
  ./scripts/agentcore/setup-aws-readonly-role.sh
```

Expected output ends with:

```
================================================================
  Setup complete
================================================================

  Role ARN:   arn:aws:iam::352896877281:role/DevOpsAgentReadOnly
  Policy ARN: arn:aws:iam::352896877281:policy/DevOpsAgentReadOnlyPolicy
  ...
```

If the script errors, fix it (re-edit, re-commit, re-run). The script is idempotent so re-running is safe.

- [ ] **Step 5.3: Assume the role from the dev principal**

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::352896877281:role/DevOpsAgentReadOnly \
  --role-session-name verify-readonly \
  --external-id aws-mcp-readonly-2026 \
  > /tmp/devops-agent-readonly-creds.json
```

Expected: exit 0, `/tmp/devops-agent-readonly-creds.json` contains a `Credentials` object with `AccessKeyId`, `SecretAccessKey`, `SessionToken`, `Expiration`.

**If this fails with `AccessDenied`**: the trust policy doesn't accept your dev principal. Re-check Task 3 Step 3.1 (did you use the correct principal ARN shape?) and Step 3.2 (is `<DEV_PRINCIPAL_ARN>` substituted correctly?). Re-run the setup script with the corrected file, then retry.

- [ ] **Step 5.4: Export the temporary credentials**

```bash
export AWS_ACCESS_KEY_ID=$(jq -r '.Credentials.AccessKeyId' /tmp/devops-agent-readonly-creds.json)
export AWS_SECRET_ACCESS_KEY=$(jq -r '.Credentials.SecretAccessKey' /tmp/devops-agent-readonly-creds.json)
export AWS_SESSION_TOKEN=$(jq -r '.Credentials.SessionToken' /tmp/devops-agent-readonly-creds.json)
```

- [ ] **Step 5.5: Verify caller identity shows the assumed role**

```bash
aws sts get-caller-identity
```

Expected: `Arn` contains `assumed-role/DevOpsAgentReadOnly/verify-readonly`.

- [ ] **Step 5.6: Verify each policy block grants the expected access**

Run each of the following. Every one must exit 0 (results may be empty if there are no resources of that kind — that's fine; what we're verifying is that the API call is **allowed**, not that there's data).

```bash
# Block 1: IdentityAndAccountDiscovery
aws sts get-caller-identity

# Block 2: RegionalAndNetworkTopology
aws ec2 describe-vpcs --region eu-central-1 > /dev/null

# Block 3: ComputeContainersAndServerlessRead
aws ecs list-clusters --region eu-central-1 > /dev/null
aws lambda list-functions --region eu-central-1 > /dev/null

# Block 4: DatastoresAndStorageRead
aws s3api list-buckets > /dev/null
aws dynamodb list-tables --region eu-central-1 > /dev/null

# Block 5: MessagingAndIntegrationRead
aws sns list-topics --region eu-central-1 > /dev/null
aws sqs list-queues --region eu-central-1 > /dev/null

# Block 6: MetricsAlarmsAndDashboardsRead
aws cloudwatch describe-alarms --region eu-central-1 > /dev/null

# Block 7: LogsReadLimitedByName
aws logs describe-log-groups --region eu-central-1 > /dev/null

# Block 8: TracingAndServiceMapRead
aws xray get-service-graph \
  --start-time "$(date -u -v-1H '+%Y-%m-%dT%H:%M:%S')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%S')" \
  --region eu-central-1 > /dev/null

# Block 9: AwsHealthRead
aws health describe-events --region us-east-1 > /dev/null 2>&1 || \
  echo "    Note: Health API requires Business/Enterprise support — AccessDenied here is acceptable"

# Block 10: ConfigInventoryReadOptional
aws configservice describe-config-rules --region eu-central-1 > /dev/null 2>&1 || \
  echo "    Note: Config may not be enabled in this account — AccessDenied here is acceptable"

# Block 11: CloudFormationAndDeploymentContextRead
aws cloudformation list-stacks --region eu-central-1 > /dev/null
aws resourcegroupstaggingapi get-resources --region eu-central-1 > /dev/null
```

Expected: every command exits 0 (or, for Blocks 9/10, prints the explicit "acceptable" note).

If any non-Block-9/10 command returns `AccessDeniedException`, the policy is missing that action — re-check Task 1 Step 1.2 against the AWS error message and add the missing action.

- [ ] **Step 5.7: Verify write actions are denied**

This is the safety check. The role must NOT be able to mutate anything. Run:

```bash
# Should fail with AccessDenied:
aws ec2 create-tags --resources vpc-xxxxxxxx --tags Key=test,Value=test --region eu-central-1 2>&1 | grep -q "AccessDenied" && echo "  PASS: ec2:CreateTags denied"
aws s3api create-bucket --bucket devops-agent-readonly-write-test-$(date +%s) --region eu-central-1 2>&1 | grep -q "AccessDenied" && echo "  PASS: s3:CreateBucket denied"
aws iam create-user --user-name devops-agent-readonly-write-test 2>&1 | grep -q "AccessDenied" && echo "  PASS: iam:CreateUser denied"
```

Expected: three `PASS:` lines. If any of these succeeded (i.e., didn't print `PASS:`), the policy is broken — there should be no `Allow` entries for write actions. Re-check Task 1 Step 1.2.

- [ ] **Step 5.8: Clean up environment**

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
rm -f /tmp/devops-agent-readonly-creds.json
```

- [ ] **Step 5.9: No commit — this task is verification only**

Nothing changed in the repo during Task 5. Move on.

---

## Task 6: Switch to the production trust policy and confirm dev principal is locked out

**Files:** none modified.

- [ ] **Step 6.1: Re-run the setup script with the default (production) trust policy**

```bash
./scripts/agentcore/setup-aws-readonly-role.sh
```

This invocation uses the default `TRUST_POLICY_FILE` (the production template from Task 2) and updates the trust policy in place. The script is idempotent.

Expected output ends with `Setup complete`.

- [ ] **Step 6.2: Confirm the dev principal can no longer assume**

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::352896877281:role/DevOpsAgentReadOnly \
  --role-session-name should-fail \
  --external-id aws-mcp-readonly-2026 2>&1 | grep -q "AccessDenied" && echo "  PASS: dev principal can no longer assume"
```

Expected: `PASS: dev principal can no longer assume`.

If this **doesn't** print PASS — i.e., the assume-role succeeded — the trust policy is wrong (it still includes the dev principal). Inspect with:

```bash
aws iam get-role --role-name DevOpsAgentReadOnly --query 'Role.AssumeRolePolicyDocument' > /tmp/current-trust.json
cat /tmp/current-trust.json
```

The policy should have exactly one statement (Sid `AllowAgentCoreExecutionRoleToAssume`). If `Phase1OnlyAllowDevPrincipal` is still present, re-check that you actually re-ran the script with the production trust file (no `TRUST_POLICY_FILE=` override).

- [ ] **Step 6.3: Verify the role still exists and is intact**

```bash
aws iam get-role --role-name DevOpsAgentReadOnly --query 'Role.[RoleName,Arn]' --output text
aws iam list-attached-role-policies --role-name DevOpsAgentReadOnly --query 'AttachedPolicies[].PolicyName' --output text
```

Expected:
- First command: `DevOpsAgentReadOnly  arn:aws:iam::352896877281:role/DevOpsAgentReadOnly`
- Second command: `DevOpsAgentReadOnlyPolicy`

- [ ] **Step 6.4: No commit — this task is verification only**

---

## Task 7: Document the verification result

**Files:**
- Modify: `docs/superpowers/specs/2026-05-15-aws-datasource-design.md` (append a verification note to the end)

- [ ] **Step 7.1: Append a verification appendix to the spec**

Open `docs/superpowers/specs/2026-05-15-aws-datasource-design.md`. After the final `## References` section, append this new section:

```markdown

---

## Appendix A: Phase 1 Verification Record

**Date verified:** <YYYY-MM-DD>
**Verified by:** <name>
**Linear issue:** SIO-XXX

- `DevOpsAgentReadOnly` role created in account `352896877281` (ARN: `arn:aws:iam::352896877281:role/DevOpsAgentReadOnly`)
- `DevOpsAgentReadOnlyPolicy` managed policy created (ARN: `arn:aws:iam::352896877281:policy/DevOpsAgentReadOnlyPolicy`)
- All 11 statement blocks verified via CLI per the plan's Task 5 Step 5.6
- Write-action denial verified via the plan's Task 5 Step 5.7
- Trust policy switched to production-only at end of Phase 1; dev-principal lockout verified per the plan's Task 6 Step 6.2
- Role is currently assumable by **nothing** (the AgentCore execution role does not yet exist; created in Phase 3 by `MCP_SERVER=aws ./scripts/agentcore/deploy.sh`)
```

Fill in the placeholders (`<YYYY-MM-DD>`, `<name>`, `SIO-XXX`) with real values.

- [ ] **Step 7.2: Commit**

```bash
git add docs/superpowers/specs/2026-05-15-aws-datasource-design.md
git commit -m "SIO-XXX: record Phase 1 IAM verification result in spec"
```

---

## Task 8: Update Linear issue status and push the branch

**Files:** none modified.

- [ ] **Step 8.1: Push the branch**

```bash
git push -u origin HEAD
```

Expected: branch is pushed to remote. Note the branch URL for the PR.

- [ ] **Step 8.2: Open a draft PR**

Use `gh pr create --draft` per CLAUDE.md PR workflow. Title: `SIO-XXX: Phase 1 — DevOpsAgentReadOnly IAM scaffolding`. Body includes:
- Link to the spec
- Link to this plan
- Bullet list of files added/modified
- Note that this is Phase 1 of 5 and the role is currently assumable by nothing (intentional — Phase 3 enables the AgentCore execution role)

- [ ] **Step 8.3: Update the Linear issue**

Move the Linear issue from `Todo` to `In Review`. Add a comment with the PR URL. **Do not move it to `Done`** — that requires explicit user approval per CLAUDE.md.

---

## Self-Review

Running this against the spec:

**Spec coverage:**
- Spec "IAM Design" section: `DevOpsAgentReadOnly` role, account `352896877281`, 11-statement policy, ExternalId `aws-mcp-readonly-2026`, trust by `aws-mcp-server-agentcore-role` — Tasks 1, 2 cover.
- Spec "Rollout Phase 1" gates: Layer 4 manual checks pass; temporary dev trust removed before moving on — Tasks 5, 6 cover both gates explicitly.
- Spec "Why this shape" rationale (clean separation, future cross-account, policy can be tightened independently) — implicit in the script's separate file (Task 4) and separate policy doc (Task 1).
- Out-of-spec: the script-level idempotence pattern (delete old non-default policy versions to stay under 5-version IAM limit) is plumbing the spec doesn't dictate but the engineer needs to know about. Documented in Task 4 Step 4.1's inline script.

**Placeholder scan:**
- `SIO-XXX` appears in every commit/PR step intentionally — Task 0 instructs replacing it with the real issue ID. This is a real placeholder, but the task that resolves it precedes every use. Acceptable.
- `<DEV_PRINCIPAL_ARN>` in Task 3 Step 3.2 — same pattern, immediately preceded by Step 3.1 which explains how to obtain the value.
- `<YYYY-MM-DD>`, `<name>` in Task 7 Step 7.1 — engineer-fillable on the day of execution. Acceptable.
- No "TBD", "implement later", "handle appropriately" — clean.

**Type/name consistency:**
- Role name `DevOpsAgentReadOnly` consistent across Tasks 1, 2, 4, 5, 6, 7.
- Policy name `DevOpsAgentReadOnlyPolicy` consistent in Tasks 4, 6.
- ExternalId `aws-mcp-readonly-2026` consistent in Tasks 2, 3, 5, 6.
- Principal `arn:aws:iam::352896877281:role/aws-mcp-server-agentcore-role` consistent in Tasks 2, 3.
- Region `eu-central-1` consistent (matches Kafka pattern per memory).

No gaps found. Plan is complete.
