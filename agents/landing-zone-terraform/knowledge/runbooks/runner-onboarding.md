---
type: Runbook
title: GitLab runner onboarding evidence workflow
description: Read-only workflow for diagnosing or planning Landing Zone runner registration.
resource: gitlab-k8s-runners-lzv2
tags: [gitlab, runners, kubernetes, ci]
status: stable
---

# GitLab runner onboarding evidence workflow

## Scope

Use for runner availability, project-scoped runner registration, CI tags,
workspace scope, and AWS deployment-role authorization.

## Required concepts

Read `repos/gitlab-k8s-runners-lzv2.md`, relevant runner module concepts,
`repos/gitlab-k8s-runners-terraform.md` for legacy boundaries, and evidence
validation.

## Required live evidence

Inspect current runner inventories, the verified GitLab project ID and path,
job tags, AWS account scope, workspaces, role names, pipeline status, and open
merge requests.

## Representative examples

Compare at least three active runner definitions in the same team or account
domain, including a narrower project-scoped example and a differing legacy
example where relevant.

## Stop conditions

Stop if the project does not exist, its ID is guessed, tags do not match, AWS
authorization is unclear, or requested permissions widen existing scope.

## Permitted outcomes

Diagnose why a job cannot get a runner, review a minimum-scope definition, or
sequence runner onboarding after project creation. Do not register or deploy a
runner.
