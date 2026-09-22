# LocalStack-first Terraform changes — how it was done (2026-09-08)

Rule: no Terraform change is proposed for a PVH landing-zone repo until it has been run against LocalStack, and the proposal states what LocalStack could and could not exercise.

## 1. Who runs what, where

| Step | Where it runs | Who |
|---|---|---|
| Write the change | Claude's cloud container, delivered to the Mac with `device_commit_files` | Claude |
| `terraform fmt -check` + `terraform validate` | Cloud container (terraform binary downloaded from releases.hashicorp.com into `/tmp`; `init` must run in a writable scratch dir, e.g. `/tmp/tfwork/root`, because `/mnt/user-data/outputs` refuses to exec provider binaries) | Claude |
| `tflocal init && tflocal apply` | Simon's Mac terminal (LocalStack Pro `localstack-main` container on `localhost:4566`; `tflocal` installed; `awslocal` is **not** on PATH) | Simon |
| Read back what was created | LocalStack MCP `localstack-aws-client` (has `awslocal`; talks to the same container) | Claude |
| Real-account read-only checks (`iam:SimulateCustomPolicy`, CloudTrail, `DescribeStacks`, …) | AWS MCP `aws___run_script` with a named profile | Claude |

`device_bash` runs in a Linux VM on the Mac with only the connected folders mounted: no `terraform`, no `tflocal`, no `localhost:4566`. Don't try to run LocalStack from there.

## 2. Two root patterns

### 2a. Repo copy (whole root)
Used for `aws-lz-finops`: `AWS Multi-Account Sandbox/cid-advanced-localstack/`.
- Copy of the root, provider pointed at `localhost:4566`.
- Things LocalStack can't do are replaced: QuickSight resources removed; `cid-cfn.yml` and `deploy-data-collection.yaml` replaced by stub templates in `ls_stubs.tf` (stub Lambda exporting `cid-CidExecArn`, stub bucket/Glue DB exporting `cid-DataCollection-*`); `cid-plugin.yml` kept real via `template_body = file("templates/cid-plugin.yml")`; `catalog_id` pinned on Glue resources; boundary ARN pointed at account `000000000000`.
- Apply the same edit to this copy that goes to the repo (usually a `python3 - <<'EOF'` in-place patch via `device_bash`, asserting the anchor text matches exactly once).
- When a file excluded from the copy has logic worth checking (e.g. the QuickSight folder map), mirror the local/expression in an `ls_*.tf` file with an `output` so the plan shows the computed value.
- Run: `terraform fmt -check -diff && tflocal validate && tflocal plan -var cid_quicksight_user=x -var <flags>` then `tflocal apply`. Pass flags explicitly; the copy's defaults may differ from the repo.
- Read the plan against the expected shape written before running (counts of add/change/destroy, named resources, outputs).

### 2b. Stand-in root (single module file)
Used for `aws-lz-account-creator` `modules/account-bootstrap/cid_data_collection.tf`: `LocalStackProjects/cid-dc-role-test/`.
- `main.tf` provides the module contract the file expects: provider alias (`aws.new_account`, endpoints → `localhost:4566`, `skip_credentials_validation`, `skip_requesting_account_id`), `data "aws_partition"`, the `_locals.tf` constants copied verbatim, `variable "account_id"` / `additional_tags`, a stub `module "aws_tagging"` (`tagging_stub/main.tf` outputs `resource_tags`), and any referenced resources (a stub permission-boundary policy if the file uses one).
- The module file itself is copied in **unchanged** (`cp cid_data_collection.tf .`), so what is tested is byte-identical to what goes in the MR.
- Outputs expose the things to assert (role ARN, policy names).
- Run: `tflocal init && tflocal apply -auto-approve`, then Claude reads back with the LocalStack MCP: `iam get-role --role-name … --query 'Role.AssumeRolePolicyDocument'`, `iam list-role-policies --role-name …`.

## 3. Pass criteria, written before the run
State them in the chat before Simon runs anything, e.g. "3 to add, 0 change, 0 destroy; trust = X with condition Y; policies A and B". Then compare the output to them, line by line. A plan that differs is a finding, not a note.

## 4. What LocalStack cannot exercise (say it every time)
- Custom-resource Lambdas with real logic (`cid-cmd` creating views/dashboards): stub accepts anything, so the v0.0.25 Compute Optimizer failure was invisible to LocalStack. Cover with real-AWS evidence (CloudTrail, CFN events, template parameter inspection).
- QuickSight, Organizations StackSet fan-out (`create-stack-instances` by OU throws an internal `'Accounts'` error in 2026.8.1), SCP evaluation, permission-boundary effects, `prevent_destroy` semantics on a real state.
- IAM policy *effects*: LocalStack stores policies, it doesn't evaluate them like AWS. Use `iam:SimulateCustomPolicy` against the real account for that.

## 5. Delivery after a pass
- Repo-bound files go to `AWS Multi-Account Sandbox/<change-name>/` (full files built from GitLab `main`, never partial diffs), with a `*.patch.md` for any lines to add to an existing file — and a reminder to actually apply the patch (a missing `_locals.tf` edit was caught by the platform team in MR !135).
- Git commands: branch, `cp` from the sandbox folder, `git diff --stat` expectation, commit, push (`feature/*` auto-opens the MR). Pre-commit tflint needs `terraform init -backend=false` inside the module; never `terraform init` at a root whose backend is the real S3 state.
- The MR text states the expected plan shape and what LocalStack did and did not cover.

## 6. Worked examples this week
| Change | Root | LocalStack result | Real result |
|---|---|---|---|
| Tier 2 dashboards, CO gated (finops v0.0.26) | 2a `cid-advanced-localstack` | validate OK; plan not completed (LocalStack was down, flag not passed) | main plan 9 add/0/0, apply success |
| CID read role in account-bootstrap (MR !135) | 2b `cid-dc-role-test` | apply 3 added; trust + `TAPolicy`, `InventoryCollectorPolicy` read back via MCP | branch plans `3 to add, 0 to change, 0 to destroy` per account |
| Read-role StackSet (v0.0.24, previous session) | LocalStack org + SERVICE_MANAGED StackSet | StackSet created; OU fan-out unsupported | 166 OK / 59 SCP-denied |
