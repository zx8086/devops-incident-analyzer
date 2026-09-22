---
type: Stack
title: aws-lz-logging
description: Central logging account — organisation CloudTrail, AWS Config and VPC flow-log buckets with per-purpose KMS keys, plus SNS/SQS fan-out to third-party consumers.
resource: aws-lz-logging
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, logging, cloudtrail, config, kms, sqs]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-logging
    title: Repository contents as checked out
---

# When this applies

An organisation trail, Config delivery, flow-log destination, log-retention
rule, KMS key policy, or a third-party log-consumer integration changes.

# Surface

**Edit:** `cloudtrail.tf`, `config.tf`, `vpc_flow_logs.tf`, `s3.tf`, `kms.tf`,
`iam.tf`, `sns.tf`, `sqs.tf`, `delegations.tf`, `_locals.tf`, `_variables.tf`,
`_outputs.tf`.

**Never edit:** `_backend.tf`.

# Traps

- **There is a second provider, aliased `master`, that acts in the management
  account.** `aws_organizations_delegated_administrator` in `delegations.tf`
  runs there. A change that looks account-local can therefore mutate
  organisation-level state. Check which provider a resource uses before
  estimating blast radius.
- Delegated-administrator registrations are org-wide singletons. Destroying one
  de-registers the service for the whole organisation, not just this account.
- **Three KMS keys carry `prevent_destroy`** — trail, Config and flow logs each
  have their own. `AGENTS.md` treats KMS keys as irreversible PVH-owned
  resources. [^agents-md] A plan proposing to replace one is a stop, not a
  retry.
- Bucket policies and KMS key policies both reference the organisation. A change
  that narrows either can silently stop log delivery from member accounts —
  delivery failures surface hours later, not at apply.
- **No `.pre-commit-config.yaml` exists here.** Formatting, credential scanning,
  TFLint and terraform-docs are unenforced.
- The README's hand-written Variables and Outputs sections are incomplete —
  two variables and six outputs that exist in code are absent from them. Read
  `_variables.tf` and `_outputs.tf`, never the README tables.
- Uses DynamoDB locking with no backend `assume_role`; the workspace name is
  set in `.gitlab-ci.yml`.
- `MIGRATION.md` at the root is a record of a past migration, not an
  instruction. Do not treat it as current guidance.

# Fields

Root inputs: `logging_account_id` · `management_account_id` · `environment` ·
`application_name` · `primary_region` · `workbench_uuid` · `mandatory_tags` ·
`additional_tags`.

Root outputs: `cloudtrail_arn` · `cloudtrail_s3_bucket_name` ·
`cloudtrail_s3_kms_key_arn` · `cloudtrail_trail_kms_key_arn` ·
`config_s3_bucket_name` · `config_s3_bucket_arn` · `config_s3_kms_key_arn` ·
`vpc_flow_logs_s3_bucket_name` · `vpc_flow_logs_s3_bucket_arn` ·
`vpc_flow_logs_s3_kms_key_arn` · `expel_sqs_queue_arn`.

# Plan

Retention or lifecycle edit: `1 in place`. New consumer subscription: `1 to
add`. Key-policy edit: `1 in place` on the key. Any organisation-level change
in `delegations.tf`: verify the provider alias and state the org-wide effect.

# Stop

- A plan proposes destroying or replacing a KMS key, or destroying a delegated
  administrator registration.
- A bucket or key policy change would narrow organisation access without a
  stated migration for member-account delivery.
- The change was scoped from the README's variable or output tables.
