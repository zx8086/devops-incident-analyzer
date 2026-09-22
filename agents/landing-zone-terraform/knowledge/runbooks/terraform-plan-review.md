---
type: Runbook
title: Terraform plan review evidence workflow
description: Read-only workflow for deciding when and how a Terraform plan may validate a proposed Landing Zone change.
resource: terraform-plan
tags: [terraform, plan, review, safety]
status: stable
---

# Terraform plan review evidence workflow

## Scope

Use after static validation when the target root, workspace, variables,
credentials, backend behavior, and CI contract are known.

## Required concepts

Read the target repository concept, affected module and shared-contract
concepts, evidence validation, and the Terraform standards catalog.

## Required live evidence

Inspect the repository backend, provider constraints, lock file, CI plan path,
workspace convention, variable sources, generated files, and remote freshness.
Confirm whether `terraform init` or the repository wrapper has side effects.

## Representative examples

Compare the target with at least three recent successful configurations or
plans when available, including a plan with a materially different resource
shape.

## Stop conditions

Do not run a plan when it could migrate state, requires production credentials
not explicitly approved, targets an ambiguous workspace, writes remote state,
or uses an unsafe checkout. Never call a text-only review a validated plan.

## Permitted outcomes

Run format, schema, generation, or validation checks; run a non-mutating plan
only when its side effects are proven and authorization is sufficient; or state
why a plan was not run. Never apply or mutate state.
