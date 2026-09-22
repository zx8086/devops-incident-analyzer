---
type: Stack
title: aws-lz-ssm
description: Shared SSM estate — patching documents, a dedicated KMS key for SSM secrets, the AD join password parameter, and its RAM share to other accounts.
resource: aws-lz-ssm
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, ssm, kms, ram, active-directory]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-ssm
    title: Repository contents as checked out
---

# When this applies

An SSM document changes; the SSM secrets KMS key or its policy changes; the AD
join password parameter or the accounts it is shared with change.

# Surface

**Edit:** `documents.tf`, `ssm_documents/**/*.yaml` (the document bodies),
`kms.tf`, `ssm_secrets.tf`, `ram_ad_join_password.tf`, `_locals.tf`,
`_variables.tf`.

**Never edit:** `_backend.tf`, `_versions.tf`, `.terraform.lock.hcl`.

# Traps

- **The README's Status section is stale.** It reports SSM parameters as pending
  and describes the repo as scaffolding only, while the code ships an SSM
  document, a parameter, a KMS key and alias, and three RAM resources. The code
  is authoritative.
- **This root has no outputs.** Consumers reach the shared parameter through
  RAM and by path, not through Terraform outputs. Adding an output does not make
  it consumable cross-account.
- `aws_ram_resource_share` plus the association and principal association are
  three separate resources. Sharing with a new account is a change to the
  principal association only; removing a principal revokes access immediately.
- The KMS key and alias carry destroy protection in this estate's convention;
  `AGENTS.md` treats them as irreversible PVH-owned resources. [^agents-md]
- Document bodies live in YAML under `ssm_documents/` and are read by
  `documents.tf`. SSM documents version on content change: an edit creates a new
  document version rather than mutating the old one, and consumers pinned to a
  version will not pick it up.
- The AD join password parameter is consumed by other repos —
  `/repos/aws-lz-dfs.md` reads AD join secrets by ARN. Changing its path or its
  key breaks those consumers silently.
- Uses S3 native locking with a backend `assume_role` into the shared-services
  account, while the provider assumes a deployment role in the shared-services
  application account.

# Fields

Root inputs: `account_id`. No root outputs.

Document bodies: `ssm_documents/<family>/<document>.yaml`.

# Plan

Document body edit: `1 in place` on `aws_ssm_document`, producing a new
document version. Adding a share principal: `1 to add`. KMS policy edit:
`1 in place`.

# Stop

- A plan proposes destroying the KMS key, its alias, or the resource share.
- A parameter path or key change is requested without identifying the consuming
  repos.
- A RAM principal is being removed without confirmation that the account no
  longer needs the credential.
