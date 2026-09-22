---
type: Stack
title: aws-lz-finops
description: Cloud Intelligence Dashboards — Athena, Glue and QuickSight foundation plus the CID CloudFormation stacks, consuming CUR data replicated by aws-lz-monitoring.
resource: aws-lz-finops
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, finops, cid, athena, glue, quicksight, cloudformation]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: dashboards
    resource: aws-lz-finops/cid_dashboards.tf
    title: CID dashboards as CloudFormation stacks
---

# When this applies

A CID dashboard, Athena workgroup, Glue table or crawler, QuickSight
configuration, or the CID CloudFormation stack version changes.

# Surface

**Edit:** `cid_athena.tf`, `cid_glue.tf`, `cid_dataexports_tables.tf`,
`cid_dashboards.tf`, `cid_quicksight.tf`, `cid_s3.tf`, `cid_cfn_exception.tf`,
`_locals.tf`, `_variables.tf`.

**Never edit:** `_backend.tf`. `_parked/` holds deliberately disabled
configuration — moving a file out of `_parked/` is an activation, treat it as a
new deployment rather than a refactor.

# Traps

- **Dashboards are CloudFormation, not Terraform resources.**
  `aws_cloudformation_stack` wraps the official CID templates and is declared
  with `CAPABILITY_IAM` and `CAPABILITY_NAMED_IAM`. [^dashboards] Terraform
  reports the stack, not its contents: a plan showing `1 in place` on a stack
  can mean an arbitrarily large change inside it. Read the template version
  delta, not just the Terraform plan.
- The stacks have explicit `depends_on` ordering between exports and
  dashboards. Reordering or removing it produces stack failures at apply, not
  at plan.
- **This root consumes data it does not own.** The CUR/CID source buckets and
  the replication that fills them are owned by `/repos/aws-lz-monitoring.md`.
  A missing-data symptom here is usually a change there.
- The payer account that originates the exports is a different account again;
  it is named in the README narrative but nothing in this root creates it.
- QuickSight is partly identity-scoped: `cid_quicksight_user` is an input, and
  QuickSight objects are not fully reconcilable by Terraform.
- Uses S3 native locking with an explicit backend `assume_role` into the shared
  services account, while the provider assumes a monitoring-account deployment
  role. State and resources therefore live in **different accounts** — do not
  assume the plan's account is the state's account.
- Runs on a dedicated project-scoped GitLab runner defined in a separate
  runners repository. A pipeline that never picks up is a runner problem, not a
  Terraform problem.

# Fields

Root inputs: `environment` · `cid_quicksight_user`.
Root outputs: `cid_athena_foundation` · `cid_dashboard_stacks`.

The CID template URL and version live in `_locals.tf`.

# Plan

Template version bump: `1 in place` per stack, with unbounded change inside.
Athena or Glue edit: `1 in place`. New Glue table: `1 to add`. Moving a file out
of `_parked/`: a full add set.

# Stop

- A CloudFormation stack shows `must be replaced` — replacing a CID stack
  destroys the dashboards it owns.
- The change assumes CUR data will appear without a corresponding change in
  `aws-lz-monitoring`.
- A QuickSight object is being managed that Terraform cannot reconcile.
