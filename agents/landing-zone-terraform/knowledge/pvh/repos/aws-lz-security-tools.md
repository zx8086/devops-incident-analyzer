---
type: Stack
title: aws-lz-security-tools
description: Central security account — Security Hub, AWS Config and alerting, delegated from the management account and driven by one repo-level security-config.yml.
resource: aws-lz-security-tools
archetype: yaml-driven-root
change_class: gitops-config
tags: [aws-lz, security, securityhub, config, guardduty, sns]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: main
    resource: aws-lz-security-tools/main.tf
    title: Module composition, including the disabled GuardDuty call
---

# When this applies

A Security Hub standard or configuration policy, a Config rule or conformance
pack, a remediation configuration, or a security alert subscription changes.

# Surface

**Edit:** `security-config.yml` — the single configuration file the root reads.
`modules/securityhub-central/`, `modules/config-central/`,
`modules/alerts-central/`, `modules/guardduty-central/` for behaviour changes.
`delegations.tf` and `main.tf` for composition changes.

**Never edit:** `_backend.tf`.

# Traps

- **`modules/guardduty-central` exists on disk but is not called.** The module
  block in `main.tf` is commented out. [^main] GuardDuty is therefore not
  managed by this root today. A request to change GuardDuty configuration is
  either an activation — a full add set, needing a platform decision — or it
  belongs somewhere else. Do not assume the module is live because the directory
  exists.
- **A provider aliased `master` acts in the management account.**
  `aws_organizations_delegated_administrator` and
  `aws_securityhub_organization_admin_account` run there and are organisation
  singletons. Destroying either de-registers the service org-wide.
- The root reads `security-config.yml` with `file()` + `yamldecode` in
  `_locals.tf`. It is the change surface; the three module directories are the
  behaviour.
- **Three resources carry `prevent_destroy`.** A plan proposing to destroy one
  is a stop.
- `aws_config_organization_conformance_pack` and
  `aws_config_organization_managed_rule` apply to every account in the
  organisation. A rule edit is an estate-wide change even though it plans as
  `1 in place`.
- `aws_config_remediation_configuration` can take automatic action on findings.
  Treat any change to it as a production behaviour change.
- The README's hand-written sections do not mention the SNS resources
  `modules/alerts-central` creates. Read the module.
- Uses DynamoDB locking with no backend `assume_role`; the security account and
  environment come from `TF_VAR_*` in `.gitlab-ci.yml`, while the root also
  takes them as variables.

# Fields

Root inputs: `security_account_id` · `management_account_id` ·
`primary_region`.

Root outputs: `security_account_setup` · `security_hub` · `config_rules` ·
`security_alerts_topic_arn`.

`security-config.yml` holds the rule, standard and subscription configuration
the modules consume.

# Plan

Config rule add: `1 to add`, org-wide effect. Security Hub standard change:
`1 in place` on the configuration policy plus its associations. Alert
subscription add: `1 to add`. Enabling GuardDuty: a full add set — not routine.

# Stop

- A plan proposes destroying a delegated administrator registration, an
  organisation admin account, or any `prevent_destroy` resource.
- A remediation configuration change would take automatic action that has not
  been reviewed.
- GuardDuty management is being activated without a platform decision.
