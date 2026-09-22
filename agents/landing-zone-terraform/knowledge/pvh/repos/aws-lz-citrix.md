---
type: Stack
title: aws-lz-citrix
description: Citrix Cloud Connector, StoreFront and FAS hosts plus the VM Import role and AD join secrets, built on the shared EC2 and S3 modules.
resource: aws-lz-citrix
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, citrix, ec2, secretsmanager, vmimport]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: domain-join
    resource: aws-lz-citrix/domain-join.tf
    title: Domain-join secret lifecycle, documented in file comments
---

# When this applies

A Cloud Connector, StoreFront or FAS host changes; the VM Import role or its
policy changes; the image bucket changes; the AD join secret contract changes.

# Surface

**Edit:** `cloud_connector_pvhcorp.tf`, `storefront_pvhcorp.tf`,
`fas_pvhcorp.tf`, `domain-join.tf`, `iam.tf`, `vmimport.tf`, `main.tf`,
`_locals.tf`, `_variables.tf`, `templates/connector-domain-join.ps1.tpl`.

**Never edit:** `_backend.tf`, `_versions.tf`, `.terraform.lock.hcl`.

# Traps

- **The domain-join secret's value is deliberately not managed by Terraform.**
  `aws_secretsmanager_secret_version` carries `ignore_changes = [secret_string]`
  because the username and password are set by hand in the console after
  creation. [^domain-join] A plan that proposes to change `secret_string` means
  something upstream regenerated it — stop, do not apply, or you overwrite the
  working credential.
- `random_password` seeds the secret at creation only. Do not treat a new random
  value as drift to reconcile.
- The VM Import role in `vmimport.tf` exists for the EC2 VM Import/Export
  service. It is referenced by out-of-band image imports, not by anything in
  this root. Deleting it because nothing here consumes it breaks the import
  workflow.
- Three separate calls to the shared EC2 module, all pinned to the same tag.
  The pinned tag lives in the `module` blocks; bumping one and not the others is
  a silent inconsistency the plan will not flag.
- The image bucket comes from the shared S3 module, pinned to a different
  module and tag again in the `module` block.
- This repo does **not** instantiate the naming or tagging Core modules. Names
  and tags are assembled locally from `mandatory_tags` / `custom_tags`.
  `AGENTS.md` expects the Core modules. [^agents-md] Treat as observed and
  preserved; changing it is a naming migration, not a tidy-up.
- Its `required_version` is an upper-bounded range and it uses S3 native
  locking, while sibling repos on the same CI template use DynamoDB. Both are
  intentional here.

# Fields

Root inputs: `account_id` · `environment` · `application_name` ·
`domain_join_username` · `mandatory_tags` · `custom_tags`.

Root outputs: `cloud_connector_instance_ids` · `domain_join_secret_arns` ·
`image_buckets` · `vmimport_role_arn`.

Per-environment account and environment values come from `TF_VAR_*` in
`.gitlab-ci.yml`, not from a committed `.tfvars`.

# Plan

Host count or sizing change: changes inside `module.ec2_*`. Adding a secret:
`1 to add` for the secret plus one version. IAM policy edit: `1 in place`.

# Stop

- The plan proposes changing `secret_string` on a domain-join secret.
- The plan proposes destroying the VM Import role.
- A shared-module tag bump is requested for one of the three EC2 calls without
  a stated reason the others stay behind.
