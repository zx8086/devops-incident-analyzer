# AWS IAM Permission Troubleshooting

## When to Use This
Reach for this runbook when an AWS tool returns an `iam-permission-missing` error from the MCP server, or when a `ToolError` has `category: "iam"` with `advice` pointing at `DevOpsAgentReadOnlyPolicy`. The aws-agent should link to this runbook rather than re-raising the same IAM gap as a finding on every run.

## Symptoms
- A `ToolError` from any `aws_*` tool with `kind: iam-permission-missing` and `advice: 'Update DevOpsAgentReadOnlyPolicy to include "<action>", then re-run setup-aws-readonly-role.sh.'`
- An `assume-role-denied` error during initial connection from AgentCore (`sts:AssumeRole` against `DevOpsAgentReadOnly`)
- EC2 write-shaped denials that surface as `UnauthorizedOperation` rather than `AccessDenied` (these are intentional — the read-only policy denies EC2 mutation actions; see [[reference_aws_iam_gotchas]])
- The aws-agent's drill-down stops short because a sibling tool (e.g. `aws_ecs_describe_tasks` after `aws_ecs_describe_services`) returns IAM-denied for a separate action that the broader policy didn't include

## How the MCP server categorizes IAM errors

The error mapper in `packages/mcp-server-aws/src/tools/wrap.ts` distinguishes:

| AWS error name | MCP `kind` field | What to do |
|---|---|---|
| `AccessDenied`, `AccessDeniedException` | `iam-permission-missing` | Add the failing `Action` to the policy; re-run the setup script |
| `AccessDenied` with `Action: sts:AssumeRole*` | `assume-role-denied` | Fix the **trust** policy, not the permission policy. Check ExternalId and caller principal |
| `UnauthorizedOperation` (EC2-specific) | `iam-permission-missing` | EC2 write-action denial. Confirm whether the missing action *should* be added (likely not — read-only policy is intentionally narrow) |

The `advice` field on the `ToolError` quotes the exact action to add. Operators should copy that string verbatim rather than guessing the IAM action name.

## Investigation Steps

### 1. Identify the failing action
The `ToolError` from the failing tool call carries:
- `tool` (e.g., `aws_ecs_describe_tasks`)
- `category: "iam"`
- `kind: "iam-permission-missing"`
- `advice` containing the exact IAM action to add

If the advice field is empty, the underlying SDK error didn't include an `Action` — fall back to the AWS docs for the failing service to find the read-only action name (`<service>:Describe*`, `<service>:Get*`, `<service>:List*` patterns).

### 2. Confirm the role being used
The role is `DevOpsAgentReadOnly` in account `352896877281` (the AgentCore deployment account). The trust policy allows AgentCore to assume it via `sts:AssumeRole` with the ExternalId `aws-mcp-readonly-2026`.

If the failure is `assume-role-denied`, the policy edit below will NOT help — see [Trust-policy issues](#trust-policy-issues) instead.

### 3. Locate the policy definition
The canonical source is `scripts/agentcore/policies/devops-agent-readonly-policy.json`. It's a 12-statement read-only policy split by service group:

- IAM (read-only, ListRoles/ListPolicies/etc.)
- EC2 (Describe*, GetConsoleOutput, GetConsoleScreenshot)
- ECS (Describe*, List*)
- Lambda (Get*, List*)
- CloudFormation (Describe*, List*, Get*)
- CloudWatch (Describe*, Get*, List*)
- Logs (split: list-shaped + read-shaped — see [[reference_aws_iam_gotchas]] for why `logs:Describe*` cannot be prefix-restricted)
- DynamoDB (Describe*, List*)
- ElastiCache (Describe*)
- RDS (Describe*)
- S3 (list buckets + get-bucket-* metadata; not GetObject)
- Health, Config, Resource Groups Tagging (Describe*, Get*)

EventBridge, SNS, SQS, Step Functions, X-Ray are covered by the resourcegroupstaggingapi + service-specific Get/List actions in the catch-all `ReadOnlyAccess`-style statements at the end.

### 4. Add the missing action to the right statement
Find the statement whose `Sid` matches the failing service (e.g., `EcsReadOnly` for an `ecs:*` action). Add the new action to the `Action` array, preserving alphabetical order within the array.

**Do NOT add a wildcard (`ecs:*`) to fix a single missing action.** Read-only-by-design is the explicit posture; the next IAM audit will flag wildcards as a regression.

### 5. Re-deploy the policy
The setup script bundled with the policy file is `scripts/agentcore/setup-aws-readonly-role.sh`. It rewrites the role's inline policy from the JSON file. Run it after every policy change:

```bash
bash scripts/agentcore/setup-aws-readonly-role.sh
```

The script is idempotent. It uses `aws iam put-role-policy`, which overwrites the inline policy in place — no need to delete the old version first.

### 6. Verify the fix
- Re-run the originally-failing tool. The `iam-permission-missing` error should be gone.
- The MCP server caches IAM denial responses for the lifetime of a tool-call retry budget but does NOT cache across new tool-call requests, so a fresh aws-agent invocation will pick up the policy change immediately.
- If the error persists despite the policy update, check whether the role is being assumed from a different account or the policy update landed on a different role. Use `aws iam get-role-policy --role-name DevOpsAgentReadOnly --policy-name <name>` to inspect what AWS actually has attached.

## Trust-policy issues

For `assume-role-denied` errors, the fix is in `scripts/agentcore/policies/devops-agent-readonly-trust-policy.json`, not the permission policy.

Common causes:
- ExternalId mismatch — the trust policy enforces `sts:ExternalId == aws-mcp-readonly-2026`. The caller (AgentCore) passes the ExternalId in the AssumeRole call.
- Caller principal not in the trust policy's `Principal.AWS` array — re-run `setup-aws-readonly-role.sh` to update the trust policy when AgentCore is redeployed in a new account.

## Known gotchas (from [[reference_aws_iam_gotchas]])
- `logs:Describe*` cannot be prefix-restricted; the policy splits log actions into separate `list-shaped` and `read-shaped` statements. Don't try to consolidate them with `logs:Describe*` — IAM evaluates that as a wildcard and the audit will flag it.
- IAM-role principals in trust policies must exist at create time; if you're deploying to a fresh account, the trust policy fails on first apply until the AgentCore service-linked role is created. Re-run the setup script.
- EC2 write denials return `UnauthorizedOperation` not `AccessDenied`. The error mapper handles both, but the AWS error name in CloudTrail logs differs — search CloudTrail for both strings when diagnosing.

## Recovery Actions (Require Human Approval)
- Adding any `*:Update*`, `*:Put*`, `*:Create*`, `*:Delete*`, `*:Modify*`, or wildcard action to the read-only policy
- Changing the trust policy's ExternalId or expanding the allowed principal set
- Switching from the canonical inline policy to a managed AWS policy (e.g., `ReadOnlyAccess`) — broader scope than the current 12-statement design

## All Tools Used Are Read-Only
This runbook describes IAM-policy editing on the operator's side. No MCP tool calls. The verification step in (6) re-uses whichever `aws_*` tool surfaced the original failure.
