---
type: Runbook
title: GitLab project creation evidence workflow
description: Read-only workflow for reviewing Landing Zone component project declarations.
resource: dhco-gitlab-terraform
tags: [gitlab, project, landing-zone]
status: stable
---

# GitLab project creation evidence workflow

## Scope

Use only when the user requests a new Landing Zone component repository or an
explicit GitLab project, not for ordinary application-account onboarding.

## Required concepts

Read `repos/dhco-gitlab-terraform.md`, its relevant module concept, GitLab
shared contracts, and evidence validation.

## Required live evidence

Search current project declarations and live GitLab paths for duplicates.
Inspect group ownership, protections, approvals, seed files, CI contract, and
open merge requests.

## Representative examples

Compare at least three projects in the same namespace and delivery class,
including one project with different protections or runner needs.

## Stop conditions

Stop if namespace, ownership, visibility, project path, approvals, or runner
model is unverified, or a matching project already exists.

## Permitted outcomes

Explain the project declaration, review a proposal, or provide a dependency
ordered GitOps plan. Do not create the live project or weaken protections.
