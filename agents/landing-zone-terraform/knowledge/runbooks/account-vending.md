---
type: Runbook
title: Account vending evidence workflow
description: Read-only workflow for explaining or reviewing PVH Landing Zone account creation.
resource: aws-lz-account-creator
tags: [account-vending, organizations, sso]
status: stable
---

# Account vending evidence workflow

## Scope

Use for account examples, account requests, existing account documents, OU
placement, SSO, budgets, and account bootstrap questions.

## Required concepts

Read `repos/aws-lz-account-creator.md`, relevant account module concepts, and
`conventions/evidence-validation.md`.

## Required live evidence

Inspect the target account YAML, README, schema or generator, template, tests,
current branch and remote relationship. Check open merge requests when work in
flight could change the answer.

## Representative examples

Compare at least three active sibling account files when available and prefer
five for environment, classification, criticality, SSO, or network fields.
Include the nearest semantic match and one counterexample.

## Stop conditions

Stop when the OU, owner, cost center, permission set, classification,
criticality, region, budget, or other governance value lacks an authoritative
source. Never invent a value or present a sibling value as approval.

## Permitted outcomes

Explain the supported YAML surface, quote an existing account document, review
a proposal, or produce a placeholder-only draft. Do not apply, create the
account, or edit generated root Terraform.
