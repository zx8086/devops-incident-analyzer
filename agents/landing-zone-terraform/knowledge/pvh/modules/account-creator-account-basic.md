---
type: Module
title: account-creator/account-basic
description: Creates the Organizations account itself and its SSO account assignments; the first module every vended account passes through.
resource: aws-lz-account-creator/modules/account-basic
change_class: gitops-hcl
tags: [aws-lz, organizations, sso, account-vending]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-account-creator/modules/account-basic
    title: Module source as checked out
  - id: parent
    resource: aws-lz-account-creator
    title: Consuming root — see /repos/aws-lz-account-creator.md
---

# When this applies

A vended account's OU placement, name, email or SSO assignment changes, or a new account is vended.

# Surface

**Edit:** `aws-lz-account-creator/modules/account-basic/` — `_backend.tf`, `_data.tf`, `_outputs.tf`, `_variables.tf`, `account.tf`, `network_cleanup.tf`, `sso.tf`, `terraform_role.tf`.

Called from the generated per-account root emitted by `scripts/generate_tf.py`. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-account-creator.md](/repos/aws-lz-account-creator.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- `aws_organizations_account` carries `prevent_destroy`. Removing an account from `accounts/*.yml` therefore fails the plan rather than quietly deleting an AWS account — that is the intended safety, not an error to work around.
- Closing an AWS account is a human, out-of-band act. Terraform can create and adopt accounts; it must not be used to close one.
- Changing `ou_id` moves the account between Organizational Units, which changes which SCPs apply. The plan reports an in-place update; the security posture change is not visible in it.
- A `null_resource` is used for sequencing. Its triggers decide when downstream work re-runs; changing them can cause a spurious re-run across every account.
- SSO assignments are per account and per permission set. Removing one revokes access immediately on apply.

# Fields

Inputs: `account_email` · `account_name` · `additional_tags` · `application_name` · `environment` · `ou_id` · `region` · `sso_account_assignments` · `sso_instance_arn` · `tags`

Outputs: `account`

# Plan

New account: `N to add`. OU or SSO change: `1 in place` or an add/destroy pair on the assignment.

# Stop

- The plan proposes destroying or replacing `aws_organizations_account`.
- An OU move is requested without confirming the destination OU's SCPs.
- Account closure is being attempted through Terraform.
