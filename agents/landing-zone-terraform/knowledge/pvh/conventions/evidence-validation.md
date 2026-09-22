---
type: Convention
title: Evidence validation for agent answers
description: Required evidence and confidence labels for Landing Zone answers, examples, reviews, and changes.
resource: AGENTS.md
tags: [okf, evidence, validation, freshness, aws-lz]
generated: { by: agent:codex, at: 2026-09-22T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: account-generator
    resource: aws-lz-account-creator/scripts/generate_tf.py
    title: Account configuration generator and validator
    author: team:ccoe-platform
  - id: account-tests
    resource: aws-lz-account-creator/tests
    title: Account creator tests
    author: team:ccoe-platform
---

# When this applies

Apply this convention to every Landing Zone answer, example, review, or change
that states how the estate works or recommends configuration. It is especially
important when values can vary by environment, account type, workload class,
security boundary, or an in-flight merge request.

# Evidence ladder

Use evidence in this order:

1. The user's explicit requirement and constraints.
2. The routed repository concept, including its Stop conditions.
3. The current target file and the code that consumes it: schema, validator,
   generator, template, module, CI, and tests as applicable.
4. Representative active sibling configurations from the same archetype.
5. The live default branch, open merge requests, released contracts, and
   accepted ADRs when the fact can be in flight or exists outside the checkout.
6. README files, guides, historical reports, and prior answers as supporting
   context only.

No lower level can overrule a conflicting higher level. A concept routes the
agent and exposes traps; it does not prove a current field value. [^agents-md]

# Representative comparison

For a proposed configuration, select examples deliberately:

- the target itself, if it exists;
- the closest match by environment and purpose;
- at least two additional active siblings, for a minimum of three when the
  inventory supports it;
- preferably five when the field has multiple patterns;
- one counterexample when it demonstrates that the pattern is conditional.

Exclude commented blocks, generated output, fixtures, and test accounts from
production-precedent counts. They may demonstrate intent or parser behavior,
but label them as such. More examples increase confidence only when they are
independent and semantically comparable; a large count of copied configurations
does not create a standard.

# Contract validation

Validate both shape and meaning:

- **Shape:** confirm required keys, types, allowed structure, generation, and
  test coverage in the current implementation. For account YAML this includes
  `validate_config_schema`, generation logic, and the applicable test path.
  [^account-generator] [^account-tests]
- **Meaning:** confirm that the value belongs to this consumer and environment.
  Existing use of an OU, permission set, IAM role, network segment, or similar
  value proves precedent only; it does not grant authorization.
- **Effect:** trace the value into the generated Terraform or consuming module
  and state the expected plan shape and downstream handoffs.

Do not claim that text search, frequency counting, or successful YAML parsing
is full validation. State exactly what each check established.

# Freshness and work in flight

Before a time-sensitive conclusion, inspect the checkout branch, HEAD, dirty
state, and its relationship to the remote. When access exists, check the live
default branch and relevant open merge requests. Prefer a current accepted MR
or released contract over an older local example. If live access is unavailable,
include the checkout date or known refresh point and label the conclusion
freshness-limited.

# Confidence labels

Use these labels in the answer when a distinction matters:

- **Observed:** directly read from the current target or authoritative contract.
- **Inferred:** conclusion from multiple consistent, comparable observations.
- **Proposed:** recommended configuration that still requires review or approval.
- **Unverified:** plausible, but the required current or authoritative evidence
  was unavailable.

Never silently turn an inferred pattern into an observed rule. Never describe
a proposed governance or security value as safe merely because several files
use it.

# Answer contract

A configuration answer must identify:

1. the concept and repository used for routing;
2. the target, implementation contract, and representative examples inspected;
3. any live or in-flight check performed;
4. what was observed versus inferred or proposed;
5. validators and tests actually run, including anything not run and why;
6. remaining approvals or Stop conditions.

If the available evidence cannot support the requested certainty, provide the
verified shape with placeholders, explain the missing authority, and stop short
of presenting deployable values.

[^agents-md]: `AGENTS.md`, Workspace-default interpretation and source-of-truth order.
[^account-generator]: `aws-lz-account-creator/scripts/generate_tf.py`, current validation and generation contract.
[^account-tests]: `aws-lz-account-creator/tests/`, current account-configuration test coverage.
