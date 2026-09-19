# Deploying the fleet (and why this page exists)

Written after SIO-1745, where a deploy that should have taken twenty minutes
took two hours. Every delay was a wrong assumption that a single command would
have settled. Read this before deploying; it is short on purpose.

## The rule

**Validate before acting.** Every mistake below came from acting on a belief
instead of checking it first. A `ls`, a `grep`, or one doc lookup is cheaper
than a failed apply against live infrastructure.

## 1. Gitignored deploy config lives in the MAIN checkout, not your worktree

`terraform.tfvars`, `backend.hcl` and `deploy/fleet.yaml` are gitignored, so
**a git worktree does not have them**. They exist only in the main checkout.

An `ls` in the worktree therefore "proves" the config is missing, which is
wrong and blocks the whole deploy. Check both:

```bash
ls ~/WebstormProjects/devops-incident-analyzer/packages/pi-coms/deploy/accounts/eu-oit-dev/
ls ~/WebstormProjects/devops-incident-analyzer/packages/pi-coms/deploy/fleet.yaml
```

To deploy from a worktree, copy them in (they stay gitignored, so they cannot
be committed by accident):

```bash
M=~/WebstormProjects/devops-incident-analyzer/packages/pi-coms
W=<your-worktree>/packages/pi-coms
cp "$M/deploy/fleet.yaml" "$W/deploy/fleet.yaml"
for d in "$M"/deploy/accounts/*/; do n=$(basename "$d")
  for f in terraform.tfvars backend.hcl; do
    [ -f "$d/$f" ] && cp "$d/$f" "$W/deploy/accounts/$n/$f"
  done
done
git -C "$W" status --porcelain packages/pi-coms/deploy   # must print nothing
```

You cannot `git checkout` the feature branch in the main checkout while a
worktree holds it -- git refuses. Copy the config to the worktree instead.

## 2. `publish-fleet.sh` does not need `fleet.yaml`

It takes the bucket and profile as positional arguments:

```bash
./packages/pi-coms/deploy/publish-fleet.sh pi-coms-dist-<hub-account-id> <aws-profile>
```

Only the `just fleet` wrapper reads `fleet.yaml`. A missing manifest is not a
reason to stop -- and publishing is **per hub bucket**, so the dev bucket
reaches dev hosts only.

## 3. Terraform IS installed -- it is just not on the sandboxed PATH

`command -v terraform` inside the sandbox finds nothing; the binary is at
`~/bin/terraform`. Always:

```bash
export PATH="$HOME/bin:$PATH"
```

Skipping this means shipping terraform changes that only CI can check, which
costs a push/wait/fail cycle per formatting error. Run the deploy-checks job
locally before pushing:

```bash
cd packages/pi-coms
bun build extensions/coms-net.ts --external '*' --outfile /dev/null
bash -n deploy/bootstrap/agent-bootstrap.sh
bash -n deploy/publish-fleet.sh
bash -n deploy/token-admin.sh
git ls-files 'deploy/**/*.tf' | xargs terraform fmt -check
```

Use `git ls-files` rather than `terraform fmt -recursive deploy/`: the latter
also formats the gitignored `.tfvars` you copied in, which CI never sees.

**`terraform fmt` gotcha:** a multi-line value changes the alignment group, so
the single-line keys beside it must lose their padding.

```hcl
Sid    = "MonitorStateCheckpoint"   # NOT Sid      = , once Resource is multi-line
Effect = "Allow"
Action = ["s3:PutObject"]
Resource = [
  "...",
]
```

## 4. Order: IAM first, then publish, then replace

A convergence restarts `pi-monitor`, which fires a shutdown checkpoint. If the
IAM grant is not in place, that write is denied -- non-fatal, but the feature
ships dead. Correct order:

| Step | Command | Replaces the instance? |
|---|---|---|
| 1. IAM / bucket policy | `terraform apply -target=module.agent.aws_iam_role_policy.agent_secrets` | No |
| 2. Publish | `./deploy/publish-fleet.sh <bucket> <profile>` | No |
| 3. Converge | `aws ssm send-command ... /usr/local/bin/pi-coms-update` | No |
| 4. Verify | checkpoint command, confirm the S3 object | No |
| 5. Replace | full `terraform apply` | **Yes** |

Use `-target` for step 1. A bare `terraform apply` on a branch that touched
`agent-bootstrap.sh` will ALSO replace the instance, because the userdata hash
changes -- see `plan` output: `user_data ... # forces replacement`.

**Always read the plan before applying.** `Plan: 1 to add, 2 to change, 1 to
destroy` is the signal: something is being replaced. Confirm that is what you
intended.

Shipping a feature gated on a NEW userdata variable splits this into two
separately schedulable deploys, and carries a cross-account tfvar trap that
produces a green apply and a silently disabled feature. See
[deployment.md](deployment.md#shipping-a-feature-that-needs-a-new-userdata-variable-sio-1821).

## 5. Cross-account S3 needs BOTH an identity grant and a bucket policy

The spokes live in their own accounts; the dist bucket lives in
shared-services. Granting `s3:PutObject` on the spoke's instance role is **not
enough**. The error is explicit:

```
not authorized to perform: s3:PutObject ... because no resource-based
policy allows the s3:PutObject action
```

"no resource-based policy allows" means the BUCKET policy is missing the
Allow, not that the caller's IAM is wrong. Cross-account access requires both.

## 6. `aws:PrincipalArn` is the ROLE arn, never the session arn

The denial message names the caller as
`arn:aws:sts::123:assumed-role/pi-agent-agent/i-0abc`. Writing a condition
against that pattern **never matches**. Per the AWS docs:

> For IAM roles, the request context returns the ARN of the role, not the ARN
> of the user that assumed the role. [...] Do not specify the assumed role
> session ARN as a value for this condition key.

So the value is `arn:aws:iam::123:role/pi-agent-agent`. Correct form:

```hcl
ArnLike = { "aws:PrincipalArn" = "arn:aws:iam::*:role/*-agent" }
```

Two further traps in the same key:

- **Use `ArnLike` / `ArnNotLike`**, which AWS recommends for ARN comparisons.
- **Never `ForAllValues:`** on it. `aws:PrincipalArn` is single-valued, and
  `ForAllValues` is *vacuously true when the key is absent* -- as the sole
  exception to a `Deny` that silently denies nothing at all.

This one is doubly dangerous in a Deny: a non-matching exception pattern means
the Deny applies to everyone, including the principal you meant to exempt.

## 7. Verify policy logic before applying it

Do not apply a policy to find out whether the condition matches. Evaluate the
patterns against the documented context value first -- a few lines of script
covering the principal you want allowed and several you want denied. Applying
an IAM change to live infrastructure as an experiment is how a session burns an
hour on three failed rounds.

## Reference: full dev deploy

```bash
export PATH="$HOME/bin:$PATH"
just fleet preflight eu-oit-dev eu-shared-services-dev

cd packages/pi-coms/deploy/accounts/eu-oit-dev
AWS_PROFILE=eu-oit-dev terraform init -backend-config=backend.hcl -reconfigure
AWS_PROFILE=eu-oit-dev terraform plan            # READ IT
AWS_PROFILE=eu-oit-dev terraform apply -target=module.agent.aws_iam_role_policy.agent_secrets -auto-approve

cd ../eu-shared-services-dev
AWS_PROFILE=eu-shared-services-dev terraform init -backend-config=backend.hcl -reconfigure
AWS_PROFILE=eu-shared-services-dev terraform apply -auto-approve \
  -target=module.agent.aws_iam_role_policy.agent_secrets \
  -target=aws_s3_bucket_policy.dist_org_read \
  -target=aws_s3_bucket_lifecycle_configuration.dist_state

cd <repo-root>
./packages/pi-coms/deploy/publish-fleet.sh pi-coms-dist-352896877281 eu-shared-services-dev
aws ssm send-command --profile eu-oit-dev --region eu-central-1 \
  --targets Key=tag:Project,Values=pi-coms-net \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/bin/pi-coms-update"]'
```

Hosts are in **eu-central-1**, not eu-west-1. Check with
`aws ec2 describe-instances --profile <p> --region eu-central-1` before
concluding a spoke does not exist.
