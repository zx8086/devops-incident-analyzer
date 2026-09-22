---
type: Stack
title: aws-lz-account-creator
description: Account vending machine — one YAML per application vends Organizations accounts, SSO assignments and the bootstrap baseline; root .tf is generated, never committed.
resource: aws-lz-account-creator
archetype: generated-root
change_class: gitops-config
tags: [aws-lz, account-vending, organizations, sso]
generated: { by: agent:codex, at: 2026-09-22T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-account-creator
    title: Repository contents as checked out
    author: team:ccoe-platform
  - id: evidence-validation
    resource: context/conventions/evidence-validation.md
    title: Evidence validation for agent answers
    author: team:ccoe-platform
---

# When this applies

A new application needs AWS accounts, an existing application needs another
environment, or an account's OU / budget / SSO assignment changes. Also applies
to any change to the bootstrap baseline every vended account receives.

In this workspace, route unqualified requests such as "create an AWS account",
"show Terraform for an account", or "show the <name> account document" here
automatically. The user-facing Terraform interface is the account YAML. A
generic standalone `aws_organizations_account` example is outside this workflow
unless the user explicitly asks for generic AWS.

# Surface

**Edit:** `accounts/<application>.yml` — one file per application, keyed by
environment. `modules/account-basic/`, `modules/account-bootstrap/`,
`modules/account-mgn/` for baseline changes. `templates/account.tf.j2` and
`scripts/generate_tf.py` for generation logic.

**Never edit:** root `*.tf` other than `_backend.tf` and `_providers.tf`. Every
other root `.tf` is emitted by `scripts/generate_tf.py` from the Jinja template
and is not committed. Editing generated HCL is lost on the next generation run.

# Traps

Apply the estate-wide representative-sampling, freshness, and confidence-label
rules in `/conventions/evidence-validation.md` before answering from this
inventory.

- The root has **no resources, variables or outputs of its own** — only
  `_backend.tf` and `_providers.tf` are tracked. An agent grepping the root for
  the resource it is changing will find nothing; the resources live in
  `modules/` and are wired by the generated per-account files.
- `scripts/generate_pipeline.py` emits a child CI pipeline in the same run.
  A YAML edit therefore changes both the Terraform surface and the pipeline
  shape; a plan that looks unexpectedly wide is usually a generation
  difference, not a Terraform difference.
- **This repo runs with state locking disabled** (`use_lockfile = false` in
  `_backend.tf`). `AGENTS.md` names this as a known gap that must never be
  copied into new work. [^agents-md] Treat it as observed and preserved: do not
  change it as part of unrelated work, and do not cite it as precedent.
- Its backend block, unlike the S3-lockfile repos, declares **no
  `assume_role`** — state access depends on the CI identity.
- It and `aws-lz-post-vending` are the only two repos still pinned to an older
  shared CI template ref than the rest of the estate; see `.gitlab-ci.yml`.
- `modules/account-basic` creates `aws_organizations_account`. Account
  resources carry `prevent_destroy`; a plan proposing to destroy one is never
  routine.
- `modules/account-mgn` declares variables and an output but **no resources** —
  it is a wiring shim, not a provisioner.
- **A request phrased as Terraform does not make root HCL the authoring
  surface.** Start with `accounts/<application>.yml`. The generator and template
  own the module calls; `modules/account-basic/account.tf` owns the underlying
  Organizations resource.
- **Do not infer account filenames or configuration from a misspelling.** Search
  `accounts/` case-insensitively, report the exact match, and read it before
  answering. If there are multiple plausible matches, list them rather than
  choosing one silently.
- **Do not invent example values.** OU IDs, contacts, permission-set names,
  classifications, criticalities, cost centers and optional network settings
  must come from a verified existing contract or be explicit placeholders.
  `scripts/generate_tf.py` rejects angle-bracket placeholders so an unfinished
  example cannot be mistaken for deployable configuration.
- **A sibling value is precedent, not approval.** Before explaining or
  proposing an account field, read the target YAML, the validation and
  generation path, and multiple active sibling accounts with the same
  environment and account purpose. Use at least three siblings when available;
  prefer five for fields with visibly inconsistent usage. A raw occurrence
  count does not establish that a value is correct for this application.
- **Comments and fixtures are weaker evidence.** Commented future environments
  record intent but are not deployed configuration. Files whose names or
  metadata identify them as tests prove parser behavior, not production
  authorization. Keep both out of a production-precedent count and label them
  separately when they are still useful.
- **Schema-valid is not platform-approved.** `validate_config_schema` checks
  structure and selected business rules, but it does not prove that an OU,
  permission set, budget, classification, or criticality is authorized for a
  new account. Verify such values with their live owner before calling the
  proposed YAML deployable.
- **Answers can race changes in flight.** Inspect the checkout and, when live
  access is available, relevant open merge requests before asserting that the
  inventory is current. If live status cannot be checked, state that limitation
  and avoid definitive claims about uniqueness or approval.

# Fields

`accounts/<app>.yml`: `application_name` · optional `mgm_account` ·
`common.{cost_center, owner, managed_by, approver, blueprint_id, business_unit,
gitlab_runner_config}` · `environments.<env>.{region, ou_id, budget_limit,
data_classification, business_criticality, account_email, backup_mode,
elevated_access, sso_config, vpc_netmask, subnet_count, subnets}` · optional
`application_metadata`.

Additional string keys under `common` become additional resource tags. Verify
them against sibling files and the current platform vocabulary before adding
one; their presence in YAML does not make them universally mandatory.

`data_classification` and `business_criticality` vocabularies are an unresolved
platform decision. [^agents-md] Preserve the values already present in sibling
`accounts/*.yml`; do not introduce or normalise an enum.

# Plan

New environment for an existing application: adds one account plus its full
bootstrap set — expect a large `N to add, 0 to change, 0 to destroy`. Budget or
SSO edit: `1 in place`. Bootstrap-baseline change in `modules/account-bootstrap`:
fans out across every vended account — expect `N to change` proportional to the
account count, and scope the MR accordingly.

Setting `vpc_netmask` or explicit subnet configuration also triggers the
workload-network handoff. Include the generated `aws-lz-network-workloads`
change in the expected delivery path; account creation is not complete when the
downstream VPC branch or pipeline fails.

# Stop

- The plan proposes destroying or replacing an `aws_organizations_account`.
- A change would flip `use_lockfile`, add or remove `dynamodb_table`, or
  otherwise alter the backend — human-only.
- A new `data_classification` or `business_criticality` value is required that
  no sibling `accounts/*.yml` already uses.
- The requested change needs an edit to a generated root `.tf` rather than to
  the template or the YAML.
- An account name from the request cannot be matched uniquely to a file under
  `accounts/`.
- Required OU, permission-set, contact, classification, criticality, or cost
  values have not been verified from a current source.
- A recommendation relies only on one sibling, a commented block, a fixture,
  an occurrence count, or a README statement when current implementation and
  representative active examples are available.
- A security- or governance-bearing value may be changing in an open merge
  request and its current authoritative state cannot be established.
