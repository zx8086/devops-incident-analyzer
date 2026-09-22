---
type: Stack
title: aws-lz-monitoring
description: Monitoring account — CloudWatch OAM sinks per region, BCM data exports for CID, and cross-account CUR replication feeding aws-lz-finops and Elastic.
resource: aws-lz-monitoring
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, monitoring, oam, cur, cid, s3-replication]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: locals
    resource: aws-lz-monitoring/_locals.tf
    title: All configuration, hard-coded as locals
---

# When this applies

An OAM sink or its resource types change; a BCM data export changes; CUR
replication to the CID or Elastic replica buckets changes; the Elastic billing
IAM user changes.

# Surface

**Edit:** `oam_sink.tf`, `cid_data_exports.tf`, `cid_replication.tf`,
`cur_replication.tf`, `cur_elastic_export.tf`, `cur_elastic_replication.tf`,
`elastic_iam.tf`, `delegations.tf`, `_locals.tf`, `_outputs.tf`.

**Never edit:** `_backend.tf`, `.terraform.lock.hcl`.

# Traps

- **`_variables.tf` is an empty file. This root has no inputs at all.** Every
  value — management account, primary region, source and replica bucket names,
  the permissions-boundary ARN, mandatory tags, OAM resource types and sink
  regions — is hard-coded in `_locals.tf`. [^locals] `AGENTS.md` says not to
  hard-code account IDs, role ARNs or regions. [^agents-md] Treat this as
  observed and preserved: the change surface is `_locals.tf`, and an agent
  looking for a `.tfvars` or `TF_VAR_*` knob will not find one.
- **Two management-account provider aliases exist**, one per region
  (`master`, `master_useast1`). Billing and cost APIs are region-pinned;
  picking the wrong alias fails at apply, not at plan.
- `aws_organizations_delegated_administrator` here is org-wide. Destroying it
  de-registers for the whole organisation.
- **S3 cross-account replication is the mechanism, not a convenience.**
  `aws_bcmdataexports_export` can only write to a same-account destination, so
  the exports land in a payer-account bucket and replicate here. A missing-data
  symptom downstream is usually a replication-rule or bucket-policy change here,
  not a problem in `/repos/aws-lz-finops.md`.
- Replication preserves object keys. Renaming a prefix breaks every consumer
  that reads the old path.
- `aws_iam_access_key` for the Elastic billing user is a long-lived credential
  written to SSM. Rotating it through Terraform invalidates the consumer's
  configuration at the same moment.
- The README does not mention the S3, IAM or SSM resources this root creates.
  Read the `.tf` files.
- Uses DynamoDB locking with no backend `assume_role`.

# Fields

No root inputs. Root outputs: `oam_sink_ids` · `oam_sink_arns` ·
`cid_data_bucket_name` · `cid_data_bucket_arn` · `cid_cur2_s3_path` ·
`cid_focus_s3_path` · `cur_replica_bucket_arn` ·
`cur_elastic_replica_bucket_arn` · `elastic_billing_ssm_access_key_id_path` ·
`elastic_billing_ssm_secret_access_key_path`.

# Plan

Adding an OAM sink region: `N to add` for that region's sink and policy. Adding
an OAM resource type: `1 in place`. Replication-rule edit: `1 in place`. New
data export: `1 to add` plus its bucket and policy wiring.

# Stop

- A plan proposes destroying a delegated administrator registration or an OAM
  sink that source accounts are linked to.
- A bucket prefix or replication destination is being renamed without a
  consumer cutover.
- The Elastic billing access key would be rotated without a consumer plan.
