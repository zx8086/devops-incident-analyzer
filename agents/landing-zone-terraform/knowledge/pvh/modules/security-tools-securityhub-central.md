---
type: Module
title: security-tools/securityhub-central
description: "Security Hub for the organisation: the account enablement, configuration policies and their associations, the finding aggregator and insights."
resource: aws-lz-security-tools/modules/securityhub-central
change_class: gitops-hcl
tags: [aws-lz, securityhub, security, organization]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-security-tools/modules/securityhub-central
    title: Module source as checked out
  - id: parent
    resource: aws-lz-security-tools
    title: Consuming root — see /repos/aws-lz-security-tools.md
---

# When this applies

A Security Hub standard, configuration policy, policy association, aggregation region or insight changes.

# Surface

**Edit:** `aws-lz-security-tools/modules/securityhub-central/` — `_data.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `main.tf`.

Called from `main.tf` in the security-tools root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-security-tools.md](/repos/aws-lz-security-tools.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- `aws_securityhub_configuration_policy_association` decides which accounts and OUs a policy applies to. Re-associating an OU changes the posture of every account under it; the plan reports one resource.
- `aws_securityhub_finding_aggregator` sets the aggregation region. Changing it moves where findings are visible and can orphan existing cross-region findings.
- `aws_securityhub_organization_configuration` governs auto-enablement for new accounts. Turning it off leaves future vended accounts unprotected silently.
- Disabling a standard removes its controls and their findings history from the console view.
- The organisation admin account registration lives in the root, not here, and runs through the `master` provider alias.

# Fields

Inputs: `aggregation_regions` · `application_name` · `auto_enable_controls` · `configuration_policy` · `control_finding_generator` · `enable_default_standards` · `environment` · `organization_root_id` · `region`

Outputs: `account_id` · `aggregation_regions` · `custom_insights`

# Plan

Standard or policy edit: `1 in place` plus its associations. New insight: `1 to add`. Association change: `1 in place` with org-wide effect.

# Stop

- A plan proposes destroying the account enablement, the aggregator, or an organisation configuration.
- Auto-enablement for new accounts would be turned off.
- A policy association change has not been scoped to the OUs it actually affects.
