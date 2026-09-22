---
type: Module
title: account-creator/account-bootstrap
description: "The baseline every vended account receives: KMS, backup vault and plan, Config recorder, budgets, alternate contacts, password policy, EBS default encryption, OAM link, SNS and the Tenable onboarding path."
resource: aws-lz-account-creator/modules/account-bootstrap
change_class: gitops-hcl
tags: [aws-lz, bootstrap, kms, backup, config, budgets, oam]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-account-creator/modules/account-bootstrap
    title: Module source as checked out
  - id: parent
    resource: aws-lz-account-creator
    title: Consuming root — see /repos/aws-lz-account-creator.md
---

# When this applies

The baseline applied to all vended accounts changes, or a new account is vended and needs it.

# Surface

**Edit:** `aws-lz-account-creator/modules/account-bootstrap/` — `_backend.tf`, `_data.tf`, `_locals.tf`, `_outputs.tf`, `_providers.tf`, `_variables.tf`, `account_hardening.tf`, `account_password_policy.tf`.

Called from the generated per-account root, once per vended account. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-account-creator.md](/repos/aws-lz-account-creator.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This module fans out across every vended account.** A one-line change here plans against the whole estate. Scope the MR and state the fan-out explicitly.
- **Six resources carry `prevent_destroy`** across `kms.tf`, `budgets.tf`, `security.tf` and `tenable.tf`. A plan proposing to destroy one is a stop, not a retry.
- The KMS key carries `ignore_changes = [policy]`. The key policy is therefore owned outside Terraform; editing the policy in HCL has no effect, and a policy drift is invisible to the plan.
- A security resource carries `ignore_changes = [name, role_arn]`. Renaming it in HCL will not rename it in AWS.
- `aws_config_configuration_recorder_status` starting or stopping recording is a compliance-visible change even though it plans as a small update.
- `aws_ebs_encryption_by_default` is account-wide. Disabling it affects every future volume in the account.
- The `aws_oam_link` ties the account to the monitoring account's sink — see [/repos/aws-lz-monitoring.md](/repos/aws-lz-monitoring.md). Destroying the sink there breaks the link here.
- A Lambda plus its permission is created for the baseline; its code lives with the module, not in a separate artefact store.

# Fields

Inputs: `account_id` · `account_name` · `additional_tags` · `application_name` · `aws_assume_role_arn` · `backup_mode` · `budget_limit` · `budget_name` · `budget_notifications` · `environment` · `region` · `tags`

Outputs: `budget` · `config` · `finops` · `iam` · `kms` · `oam` · `pam`

# Plan

Baseline edit: `N to change` proportional to the number of vended accounts. New account: the full add set.

# Stop

- The plan proposes destroying any `prevent_destroy` resource.
- A KMS key policy change is expected to take effect while `ignore_changes = [policy]` remains.
- Account-wide encryption or Config recording would be disabled.
- The change was not scoped and plans against every vended account unintentionally.
