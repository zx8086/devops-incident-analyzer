---
type: Stack
title: aws-lz-f5-ingress
description: F5 BIG-IP ingress pair with CFE failover — static self IPs, secondary-IP VIPs, a CFE state bucket, and route-table entries whose target is owned by CFE at runtime.
resource: aws-lz-f5-ingress
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, f5, bigip, cfe, networking]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: routes
    resource: aws-lz-f5-ingress/route_tables.tf
    title: Failover routes with CFE-owned target
  - id: ci
    resource: aws-lz-f5-ingress/.gitlab-ci.yml
    title: Pipeline variables
---

# When this applies

A BIG-IP instance, self IP, VIP, security group, route-table failover entry or
the CFE state bucket changes.

# Traps

- **This repo is not wired to real accounts.** `.gitlab-ci.yml` still carries
  `REPLACE_WITH_ACCOUNT_ID_PRD` / `REPLACE_WITH_ACCOUNT_ID_STG` as the
  `TF_VAR_account_id` values. [^ci] Any pipeline run resolves the assume-role
  ARN to a literal placeholder and fails. Treat this as a scaffolded, not yet
  deployed root: an MR here is authorable, but do not claim an expected plan
  shape based on live state.
- **Two `ignore_changes` are load-bearing and must not be removed.**
  `aws_instance` ignores `ami` so a BIG-IP image bump does not silently replace
  a live appliance; `aws_route` ignores `network_interface_id` because CFE
  rewrites the failover target at runtime. [^routes] `AGENTS.md` requires any
  ignored field to have a verified external owner — here it is the BIG-IP AMI
  lifecycle and the CFE process respectively. [^agents-md]
- The CFE tag contract is what makes failover work. Tags on the ENIs, EIPs and
  route tables are read by CFE, not just by humans. Renaming or dropping one
  breaks failover without breaking the plan.
- Secondary IPs on the external ENI are how VIPs are placed. Static self IPs are
  what make that placement deterministic; switching to dynamic addressing
  invalidates the VIP layout.
- **This is the only repo whose backend `key` is prefixed with the repo name**
  (`aws-lz-f5-ingress/terraform.tfstate`) rather than the estate-wide bare
  `terraform.tfstate`. Do not "normalise" it — that is a state migration.
- **No `.pre-commit-config.yaml` exists here.** Formatting, credential
  detection, TFLint and terraform-docs are unenforced. Run the checks by hand.
- Uses DynamoDB locking with no backend `assume_role`.
- The README's usage example uses an AWS documentation placeholder account id.
  It is an example, not a target.

# Surface

**Edit:** `bigip_instances.tf`, `network_interfaces.tf`, `route_tables.tf`,
`security_groups.tf`, `iam.tf`, `kms.tf`, `s3_cfe_state.tf`, `_locals.tf`,
`_variables.tf`, `outputs.tf`.

**Never edit:** `_backend.tf`, `_versions.tf`.

Note: outputs live in `outputs.tf`, not `_outputs.tf`, unlike most of the
estate. Follow the file that exists.

# Fields

Root inputs include: `account_id` · `environment` · `region` ·
`application_name` · `name_suffix` · `vpc_id` · `public_subnet_ids` ·
`private_subnet_ids` · `instance_count` · `instance_type` · `f5_ami_id` ·
`ssh_key_name` · `root_volume_size` · `external_self_ips` ·
`internal_self_ips` · `vips` · `external_data_port` ·
`external_ingress_cidr_blocks` · `internal_cidr_blocks` ·
`management_cidr_blocks` · `alien_range_cidrs` · `failover_label` ·
`failover_route_table_ids` · `create_kms_key` · `kms_key_arn` ·
`kms_deletion_window_days` · `cfe_state_bucket_name` · `permissions_boundary` ·
`mandatory_tags` · `custom_tags`.

Root outputs include: `bigip_instance_ids` · `bigip_roles` ·
`external_eni_ids` · `internal_eni_ids` · `vip_eip_allocation_ids` ·
`vip_eip_public_ips` · `security_group_ids` · `cfe_role_arn` ·
`cfe_instance_profile_name` · `cfe_state_bucket` · `kms_key_arn` ·
`failover_label`.

# Plan

Not statable from repo state alone while the CI account ids are placeholders.
For an authored change, state the intended shape and say explicitly that it is
unverified against live.

# Stop

- Any change that removes either `ignore_changes` block.
- Any change to the backend `key`.
- A CI run is expected to succeed while the account-id placeholders remain.
- A VIP or self-IP change is requested without the corresponding BIG-IP-side
  configuration.
