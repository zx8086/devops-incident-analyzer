---
type: Convention
title: OKF authoring conventions
description: House rules for writing and maintaining concepts in the aws-lz context bundle.
resource: https://okf.md/spec
tags: [okf, docs, conventions, aws-lz]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2027-02-27
sources:
  - id: okf-spec-v01
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: Open Knowledge Format (OKF) — SPEC.md, v0.1 Draft
    author: team:GoogleCloudPlatform
  - id: elastic-iac-okf
    resource: https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/blob/main/context/conventions/okf-authoring.md
    title: observability-elastic-iac — OKF authoring conventions
    author: team:observability
    last_modified: 2026-08-05
  - id: lz-agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
---

# Why this bundle exists

The estate is 20 `aws-lz-*` repositories with four different archetypes, three
different state-locking mechanisms, three different `required_version`
constraints and two different CI templates. `AGENTS.md` states the rules well
but holds no per-repo facts, so an agent handed a task in one repo cannot tell
which archetype it is in or what that repo's expected plan shape looks like.

This bundle is the missing layer: one instruction-only concept per repository
and per child module, cross-linked, with explicit freshness and provenance, so
an agent can decide what to trust before spending tokens reading it. The
pattern is taken from `observability-elastic-iac`. [^elastic-iac-okf]

# Instructions, not records

**A concept says what to do. It never says what happened.** Run histories,
migration write-ups, dated findings, "as of <date> I confirmed X" notes and
session narratives are records. They belong in agent memory or in
`docs/`, not here. Durable knowledge extracted *from* a record — a threshold, a
mechanism, a standing decision, a correction — is instruction and belongs here,
stripped of the narrative that produced it.

The test: if the sentence would still be worth reading by someone who does not
care when it was written, it is instruction.

Consequence: this bundle does not use OKF's optional `log.md`. Change history
is a record. Omitting it is fully conformant.

Frontmatter is exempt. `generated`, `verified` and `stale_after` are the inputs
a consumer uses to decide whether to trust the concept before reading it.

# The non-duplication rule

**A concept never restates a value that Terraform, YAML config, or CI owns.**
It names the file that owns the value and says what the reader needs to know
*about* it — the trap, the invariant, the reason, the link to the neighbouring
concept.

This rule is not stylistic. It is the specific defect this estate already has.
A README in one repo restated an account ID that `_variables.tf`,
`provider.tf` and `.gitlab-ci.yml` own; the code was corrected and the README
was not, so the document now contradicts the deployment it describes. A
generated inputs table in another repo still names a variable that was renamed.
Every one of those failures is a restated value that drifted.

For this estate that means, concretely — never write into a concept:

- an AWS account ID, role ARN, or permissions-boundary ARN;
- a variable default, a CIDR, an instance type, an AMI id, or a capacity figure;
- a module version tag, a CI template ref, or a provider version constraint;
  the one exception is `shared/`, where the *set* of refs a module is consumed
  at is the concept's whole subject — those entries carry `stale_after` and name
  the consuming files;
- a resource name or a `Name` tag value produced by the naming modules.

Name the owner instead: "the target account comes from `TF_VAR_account_id` in
`.gitlab-ci.yml`", "the pinned ref lives in the `module` block in `main.tf`".
Field *names* are the interface and may be listed; field *values* may not.

Where a restated value is genuinely unavoidable it MUST carry `stale_after` and
a `sources` entry naming the file it was copied from.

# The audience is an agent, not a reviewer

A concept must be self-sufficient. An agent that has to open the repo's
`README.md` and reconcile it against the concept has been given two
instructions.

- **Never write "the README says X, but actually Y."** Write Y. Cite the README
  in `sources`.
- **Never restate a live measurement.** Bucket sizes, instance counts, drift
  state and account inventories decay from the moment they are written. State
  the rule and where to read the current value at run time.
- **Lead with routing.** `change_class` decides what the agent is permitted to
  do at all. Getting it wrong produces confidently useless work.

# Change classes

| `change_class` | Meaning for this estate |
|---|---|
| `gitops-config` | The agent edits YAML/JSON config only; the `.tf` is generated or generic. Author an MR. |
| `gitops-hcl` | The agent edits `.tf` directly. Author an MR. Higher risk: state addresses move. |
| `imperative` | Change is driven by a pipeline or an out-of-band tool, not by a plan/apply of this root. |
| `human-only` | State surgery, backend migration, lock changes, Organizations account deletion. Escalate; never author. |

# Required body shape for actionable concepts

`Stack` and `Module` concepts use these headings so an agent can jump to the
section it needs.

| Heading | Contains |
|---|---|
| `# When this applies` | The trigger. How the agent knows this is the right concept. |
| `# Surface` | Exactly which paths the agent may create, edit or delete — and which are off-limits. |
| `# Traps` | Non-obvious behaviour that a plan will not warn about. Each trap names the file that proves it. |
| `# Fields` | Input and output *names* only. No values, no defaults. |
| `# Plan` | The expected plan shape per operation. |
| `# Stop` | Conditions that require halting or escalating instead of proceeding. |

This mirrors the change-prompt contract an agent is held to: name the target,
fence the scope, state the expected plan, escalate rather than guess. [^lz-agents-md]

# Frontmatter

`type` is the only required field. [^okf-spec-v01] Everything else is optional,
but absence carries meaning — an unverified concept is distinguishable from a
verified one.

| Field | Use |
|---|---|
| `type` | One of the house types below. Required. |
| `title` | Human-readable name. |
| `description` | One sentence; reused verbatim in the parent `index.md`. |
| `resource` | Repo-relative path of the authoritative file, or an external URL. |
| `archetype` | `Stack` concepts only: `flat-hcl-root`, `yaml-driven-root`, `generated-root`, `orchestration-root`, `bespoke-ci-root`, `gitlab-as-code-root`, `k8s-platform-root`, or `empty-repo`. |
| `change_class` | One of the four above. |
| `tags` | Cross-cutting labels: repo names, AWS services, `incident`, `runbook`. |
| `generated` | `{ by, at }` — who produced the content and when it last meaningfully changed. |
| `verified` | List of `{ by, at }`. `human:<id>` for a human sign-off. |
| `status` | `draft` \| `stable` \| `deprecated`. Absent means stable. |
| `stale_after` | Absolute date, tied to a real control event. Never a TTL. |
| `sources` | What the concept derives from, with `author` and `last_modified` where known. |

Cite a specific source per claim with a markdown footnote keyed to the source
`id` (`[^lz-agents-md]`), not a dangling list at the bottom.

# House types

Type values are not registered centrally, so consumers tolerate anything — but
divergence within one bundle is the failure mode the spec warns
about. [^okf-spec-v01] Use exactly these, and add a new one only by editing
this page first:

`Stack` · `Module` · `Runbook` · `Contract` · `Decision` · `Convention` · `Glossary Term`

`Stack` is one repository in scope — the 20 `aws-lz-*` roots plus the three
platform repos that surround them. `Module` is one child module under a repo's
`modules/` directory. `Contract` is one shared module from
`pvhcorp/terraform/aws-modules` or `pvhcorp/terraform/gitlab-modules`: a
consumed interface this estate does not own, covered in `shared/`.

# Naming and uniqueness

`name` is the path stem and MUST be unique across the whole bundle. Child
module concepts are therefore prefixed with the owning repo's short name:
`storage-fsxn-volume.md`, not `fsxn-volume.md`. Two repos both contain a
module called `monitoring`; unprefixed names would collide silently. Shared
modules under `shared/` keep their upstream repository name unprefixed, because
that name is the thing consumers pin.

# Linking

Use bundle-relative absolute links (`/repos/aws-lz-storage.md`) for
concept-to-concept links — they survive a file move within a subdirectory. Use
ordinary repo-relative paths in prose when pointing at repo files that are not
concepts (`aws-lz-storage/modules/fsxn-volume/main.tf`).

Broken links are permitted and are not a validation failure — referencing a
concept before writing it is the intended way to grow the bundle. [^okf-spec-v01]

# Reserved files

`index.md` and `log.md` are reserved at every level and MUST NOT be used for
concepts. [^okf-spec-v01] `index.md` carries no frontmatter, with one
exception: the bundle-root `index.md` may declare `okf_version`. Keep index
entries in the `* [Title](path.md) - description` shape, reusing the target's
`description` verbatim.

# Unresolved decisions are recorded, not resolved

`AGENTS.md` lists platform decisions the CCoE Platform Team has not made —
DynamoDB versus native S3 locking, control-plane bucket topology,
`DataClassification` / `BusinessCriticality` vocabularies, workspace-name
convergence. [^lz-agents-md] A concept records the behaviour its repo actually
has and marks it as *observed and preserved*, never as target state. An agent
must never resolve one of these by inference during unrelated work.

# Maintenance loop

1. Author or edit concepts on a change branch like any other change.
2. Run `scripts/validate-okf.sh` locally. It is the conformance check, not a
   style linter.
3. Regenerate the affected `index.md` files (`scripts/validate-okf.sh --emit-index <dir>`).
4. Open the MR.
