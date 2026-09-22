---
type: Module
title: security-tools/config-central
description: "AWS Config for the organisation: the aggregator, recorder and delivery channel, organisation managed rules and conformance packs, plus remediation configurations."
resource: aws-lz-security-tools/modules/config-central
change_class: gitops-hcl
tags: [aws-lz, config, compliance, remediation, organization]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-security-tools/modules/config-central
    title: Module source as checked out
  - id: parent
    resource: aws-lz-security-tools
    title: Consuming root — see /repos/aws-lz-security-tools.md
---

# When this applies

A Config rule, conformance pack, remediation configuration, recorder or delivery channel changes.

# Surface

**Edit:** `aws-lz-security-tools/modules/config-central/` — `_data.tf`, `_locals.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `main.tf`.

Called from `main.tf` in the security-tools root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-security-tools.md](/repos/aws-lz-security-tools.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`aws_config_organization_managed_rule` and `aws_config_organization_conformance_pack` apply to every account in the organisation.** They plan as one resource and take effect estate-wide.
- **`aws_config_remediation_configuration` can take automatic action on findings.** Any change to it is a production behaviour change, not a compliance-reporting change. Confirm the action before applying.
- `aws_config_configuration_recorder_status` starting or stopping recording changes what is evaluated; stopping it makes the estate look compliant because nothing is being recorded.
- The delivery channel writes to a bucket owned elsewhere — see [/repos/aws-lz-logging.md](/repos/aws-lz-logging.md). A bucket-policy change there stops delivery here.
- Conformance-pack deployment is slow and partially asynchronous: a successful apply does not mean every account has converged.

# Fields

Inputs: `additional_tags` · `aggregation_regions` · `application_name` · `central_config_bucket_name` · `conformance_packs` · `environment` · `organization_managed_rules` · `recorder_settings` · `region` · `remediation_configurations` · `tags`

Outputs: `aggregation_regions` · `config_rules_count` · `organization_aggregator_arn`

# Plan

Rule add: `1 to add`, org-wide. Conformance pack edit: `1 in place`, org-wide, asynchronous. Recorder change: `1 in place` with compliance impact.

# Stop

- A remediation configuration change would take an automatic action that has not been reviewed.
- Recording would be stopped or narrowed.
- The plan proposes destroying the aggregator or an organisation rule that other reporting depends on.
