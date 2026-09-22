# PVH Landing Zone Terraform Agent Specification

**Status:** Implementing
**Date:** 2026-09-22
**Target repository:** `zx8086/devops-incident-analyzer`
**Agent ID:** `landing-zone-terraform`
**Working title:** PVH Landing Zone Terraform Agent
**Tracking:** [SIO-1867](https://linear.app/siobytes/issue/SIO-1867/implement-pvh-landing-zone-terraform-agent)

## Executive summary

Add a third top-level agent to the existing DevOps Agent application for learning, understanding, reviewing, and safely proposing changes to the PVH AWS Landing Zone Terraform estate. The agent appears in the existing header mode rotation alongside Incident Analyzer and Elastic IaC, uses the existing live graph triage pane, and follows the established LangGraph, Agent Memory, knowledge-graph, GitLab, LangSmith, and human-review patterns.

The agent combines five evidence layers without confusing their authority:

1. Git-tracked PVH standards and OKF knowledge.
2. Live GitLab, AWS, Terraform, and AWS documentation evidence.
3. A deterministic knowledge graph for repository, account, network, DNS, and change-history relationships.
4. Agent Memory for cross-session decisions, lessons, outcomes, and in-flight work.
5. LangGraph checkpoint state for the current conversation and approval flow.

The first release is read-only for learning and review. A later phase may propose changes through GitLab branches and merge requests, but the agent never merges, applies Terraform, mutates state, or changes AWS directly.

## Problem statement

The Landing Zone spans multiple repositories, generators, shared modules, account-vending flows, network components, GitLab project provisioning, and runner infrastructure. Generic Terraform answers can be technically valid while being wrong for PVH because they bypass repository-specific generators, accepted ADRs, platform contracts, or current work in flight.

Engineers need one guided interface that explains the platform, validates answers against live repositories and current standards, recalls prior changes and their outcomes, and can later prepare a reviewable GitOps change without bypassing established controls.

## Goals

1. Provide grounded PVH-specific answers with citations to current repository and standard evidence.
2. Reduce incorrect generic Terraform recommendations by routing every request through the relevant repository concept and evidence workflow.
3. Make prior Landing Zone changes, decisions, pipeline outcomes, network topology, and DNS relationships searchable across sessions.
4. Give operators the same agent-switching and live graph-triage experience used by the existing agents.
5. Prepare safe GitLab merge requests with CI-produced Terraform plans and explicit human approval in a later phase.
6. Preserve provenance, freshness, and confidence so users can distinguish observed facts, inferences, proposals, and unverified claims.

## Non-goals

- The agent does not run `terraform apply`, force-unlock state, import state, or modify state.
- The agent does not merge or approve its own merge requests.
- The agent does not make compensating changes in the AWS console.
- The agent does not mirror all Landing Zone repositories into the agent repository.
- The agent does not treat AWS or HashiCorp recommendations as automatic PVH mandates.
- The agent does not import secrets, Terraform state content, plaintext environment variables, or sensitive plan values into memory or the knowledge graph.
- The first release does not model every AWS resource or generate a complete enterprise network digital twin.

## Personas and user stories

### Platform learner

- As a platform learner, I want to ask how PVH creates an AWS account so that I learn the actual account-vending workflow instead of receiving generic Terraform.
- As a platform learner, I want explanations to link to representative live examples so that I can compare patterns across repositories.
- As a platform learner, I want AWS and Terraform best practices distinguished from PVH requirements so that I understand both the recommendation and the deployed contract.

### Landing Zone engineer

- As a Landing Zone engineer, I want to ask what changed previously in a repository and why so that I do not repeat failed approaches.
- As a Landing Zone engineer, I want to see the modules, accounts, networks, pipelines, and runners affected by a proposed change so that I can assess blast radius.
- As a Landing Zone engineer, I want the agent to prepare a branch and merge request after I approve the plan so that the normal CI and review process remains authoritative.

### Reviewer and approver

- As a reviewer, I want the proposed diff, evidence, risks, policy alignment, and Terraform plan summary in one review card.
- As a reviewer, I want the agent to stop on destructive changes, unresolved backend standards, IAM expansion, public access, or uncertain module contracts.
- As an approver, I want a clear separation between the agent acting as planner/maker and humans acting as checker/executor.

## Product experience

### Agent selection

The Landing Zone agent is a top-level `mode`, not a contextual console.

The existing header agent icon cycles selectable modes in server-registry order:

```text
Incident Analyzer -> Elastic IaC -> Landing Zone Terraform -> Incident Analyzer
```

Required behaviour:

- The same existing header icon control performs the switch.
- The header displays `PVH Landing Zone Terraform` and a concise subtitle.
- Switching agents ends the current Agent Memory session and starts a fresh conversation, matching current behaviour.
- Switching is disabled while a response is streaming.
- Incident-only selectors are hidden in Landing Zone mode.
- Landing Zone-specific guidance and starter prompts appear in the empty state.
- The UI obtains availability and capabilities from `/api/agents`; it does not maintain a separate client-only list.

### Live graph triage

The agent must set `hasTriageGraph: true` in the server registry. The existing Graph Triage button and `GraphTriagePanel` render the compiled Landing Zone graph returned by `/api/agent/topology`.

The pane must show real node execution from the SSE stream. It must not use a manually maintained illustration.

Initial node vocabulary:

```text
bootstrap
classifyRequest
resolveScope
selectPvhKnowledge
recallMemory
queryKnowledgeGraph
gatherGitLabEvidence
gatherTerraformEvidence
gatherAwsGuidance
gatherAwsState
reconcileEvidence
assessRisk
answerQuestion
draftChange
validateCandidate
prepareReview
reviewGate
openMergeRequest
watchPipeline
recordOutcome
teardown
```

Conditional nodes that do not execute remain idle. Human-review nodes show the existing paused state and resume after explicit input.

### Supported modes within the agent

The classifier routes each request to one of four intents:

1. **Learn:** Explain concepts, workflows, standards, and representative examples.
2. **Understand:** Explain a repository, account, module, network, DNS path, pipeline, or historical change.
3. **Review:** Review a proposed change, diff, merge request, plan, configuration, or architectural alignment without modifying anything.
4. **Propose change:** Draft and validate a GitOps change, stop for human review, then optionally open a branch and merge request.

`Propose change` is disabled until the read-only release is accepted and write scopes are separately approved.

## Architecture

```text
Svelte UI
  |-- Agent mode switcher
  |-- Chat and evidence cards
  |-- Human-review cards
  `-- Live Graph Triage
          |
          v
Landing Zone LangGraph
  |-- Policy and intent routing
  |-- Parallel evidence collection
  |-- Evidence reconciliation
  |-- Risk and stop gates
  |-- Read-only response path
  `-- GitOps proposal path
          |
          +-- GitLab MCP / Landing Zone IaC facade
          +-- Terraform MCP, operations disabled
          +-- AWS Documentation MCP
          +-- AWS Estate MCP, read-only
          +-- PVH OKF knowledge
          +-- Agent Memory
          `-- Knowledge Graph
```

### Framework decision

Use a dedicated LangGraph graph inside the existing application. The workflow needs deterministic routing, parallel evidence gathering, human interrupts, resumability, and live graph visualization. Reuse the existing GitAgent agent bundle, lifecycle hooks, checkpointer factory, LangSmith tracing, SSE protocol, and graph registry.

Do not introduce a second frontend, a separate agent runtime, or a new memory service.

## Source authority and evidence reconciliation

Evidence precedence:

1. User request and explicit constraints.
2. Live target repository: code, tests, lock file, CI, tags, and open merge requests.
3. Accepted PVH ADRs and curated PVH OKF knowledge.
4. Released PVH shared-module contracts.
5. Current Terraform provider and module documentation.
6. Official AWS documentation, Well-Architected guidance, and Prescriptive Guidance.
7. Historical OKRs, findings, reports, and superseded guides.

Every substantive answer must distinguish:

| Field | Meaning |
|---|---|
| PVH standard | What the platform requires or has accepted |
| Live implementation | What current repositories or AWS evidence show |
| Terraform contract | What the selected provider or module version supports |
| AWS recommendation | What current official AWS guidance recommends |
| Status | Aligned, divergent, exception, unresolved, or unverified |
| Action | Explain, monitor, propose, or escalate |

Generic guidance cannot silently override a PVH contract. If a conflict affects production behaviour, preserve observed behaviour unless the requested work explicitly includes migration and the required decision is approved.

## Knowledge and document design

### Git-tracked curated knowledge

Move the maintained context bundle into the target repository:

```text
agents/landing-zone-terraform/
  agent.yaml
  SOUL.md
  RULES.md
  DUTIES.md
  hooks/
  skills/
  workflows/
  tools/
  examples/
  memory/
  knowledge/
    index.md
    index.yaml
    pvh/
      conventions/
      repos/
      modules/
      shared/
      workflows/
      decisions/
    standards/
      aws/
      terraform/
    okr/
      current-objectives/
      unresolved-gaps/
    runbooks/
```

The current `context/` OKF bundle becomes `knowledge/pvh/` with its provenance and lifecycle fields preserved. Only current operational OKR findings move into the runtime knowledge set. Historical reports remain archival references and are not prompt-loaded by default.

AWS and Terraform documentation should be retrieved live. The repository stores source catalogs, PVH interpretations, known exceptions, and freshness metadata rather than copies of external manuals.

### Knowledge selection

`knowledge/index.yaml` defines intent- and repository-aware selection. A request loads the smallest relevant concept set. Loading the entire Landing Zone corpus into every prompt is prohibited.

Every selected concept retains:

- source and owner;
- `last_verified` and `stale_after`;
- scope and repository applicability;
- replacement or supersession metadata;
- stop conditions;
- expected plan shape where applicable.

## Agent Memory

Register an independent Agent Memory identity:

```yaml
agent: landing-zone-terraform
user_id: landing-zone-terraform
role: landing-zone-iac-maker
```

Memory categories:

- `terraform-change`
- `account-vending`
- `network-onboarding`
- `dns-design`
- `gitlab-project`
- `runner-onboarding`
- `plan-outcome`
- `key-decision`
- `platform-exception`
- `failed-approach`
- `learned-pattern`
- `in-flight-change`

Memory is semantic and advisory. It answers questions such as “why was this done?” or “was this tried before?” It cannot override live GitLab, AWS, an accepted ADR, or deterministic graph history.

Bootstrap must recall relevant prior memory using the first user query. Teardown must flush a concise daily log, record in-flight MR state, and checkpoint only durable decisions. Routine tool output and secrets are never written to memory.

## Knowledge graph

Reuse the existing `@devops-agent/knowledge-graph` package and `GraphStore` interface. Extend its schema instead of creating a separate graph database.

### Repository and change-history entities

```text
GitLabGroup
Repository
TerraformRoot
TerraformModule
SharedModule
Workflow
Session
Prompt
ConfigChange
MergeRequest
Pipeline
TerraformPlan
Standard
ADR
```

Core relationships:

```text
GitLabGroup CONTAINS Repository
Repository CONTAINS TerraformRoot
TerraformRoot USES_MODULE TerraformModule
TerraformModule USES_MODULE SharedModule
ConfigChange TARGETS TerraformRoot
ConfigChange PROPOSED_IN MergeRequest
ConfigChange VIA_WORKFLOW Workflow
ConfigChange IN_SESSION Session
MergeRequest RAN Pipeline
Pipeline PRODUCED TerraformPlan
Repository GOVERNED_BY Standard
Standard IMPLEMENTS ADR
```

Historical GitLab import establishes the baseline. Incremental agent turns and scheduled reconciliation update it. Merge alone does not mean applied; an `applied` outcome requires deployment-pipeline or verified live-state evidence.

### Account, network, and DNS entities

```text
AwsOrganization
OrganizationalUnit
AwsAccount
Region
AvailabilityZone
Vpc
Subnet
RouteTable
Route
InternetGateway
NatGateway
TransitGateway
CoreNetwork
NetworkAttachment
VpcEndpoint
NetworkAcl
HostedZone
DnsRecord
ResolverEndpoint
ResolverRule
DnsFirewallRuleGroup
IpAddress
CidrBlock
```

Core relationships:

```text
AwsOrganization CONTAINS OrganizationalUnit
OrganizationalUnit CONTAINS AwsAccount
AwsAccount OWNS Vpc
Vpc LOCATED_IN Region
Vpc CONTAINS Subnet
Subnet LOCATED_IN AvailabilityZone
Subnet USES RouteTable
Subnet PROTECTED_BY NetworkAcl
RouteTable HAS_ROUTE Route
Route DESTINATION CidrBlock
Route TARGET InternetGateway | NatGateway | TransitGateway | CoreNetwork | VpcEndpoint
Vpc ATTACHED_TO TransitGateway | CoreNetwork
Vpc ASSOCIATED_WITH HostedZone
Vpc USES ResolverRule
Vpc HOSTS ResolverEndpoint
HostedZone CONTAINS DnsRecord
DnsRecord RESOLVES_TO IpAddress | VpcEndpoint | load-balancer reference | DnsRecord
ResolverRule FORWARDS Domain TO ResolverEndpoint
```

Subnet classification is derived from routing evidence and explicit repository configuration, never from a resource name alone.

### Desired, observed, and proposed state

Every infrastructure node and relationship supports provenance:

```yaml
desired:
  source: terraform
  repository: pvhcorp/dhco/aws/aws-landing-zone/aws-lz-network-workloads
  file_path: environments/prd/example.yaml
  commit_sha: abc123
  terraform_address: module.network.aws_subnet.private["euc1a"]

observed:
  source: aws-api
  resource_id: subnet-0123456789
  observed_at: 2026-09-22T10:30:00Z

proposed:
  source: gitlab-merge-request
  merge_request_url: https://gitlab.example/group/project/-/merge_requests/123
  commit_sha: def456

reconciliation:
  status: aligned
  confidence: verified
```

Permitted reconciliation states are `aligned`, `drifted`, `pending`, `unknown`, and `conflicting-evidence`.

## Network and DNS visualization

The graph supports two filtered diagrams:

1. **Account network topology:** account, regions, VPCs, subnets, route tables, routes, gateways, endpoints, and Core Network or Transit Gateway attachments.
2. **DNS and service resolution:** hosted zones, VPC associations, resolver endpoints and rules, DNS records, and their resolved targets.

An optional path view combines name resolution and packet routing for one hostname or service.

Diagram semantics:

- Solid edges: desired state confirmed by live AWS evidence.
- Dashed edges: proposed in an open merge request.
- Warning styling: desired/observed drift or conflicting evidence.
- Muted styling: unverified because a required live source was unavailable.

The first release may expose the topology as structured text and Mermaid. An interactive Svelte topology card is a later phase. Diagrams are projections of evidence; they are never a source of truth.

## Tool and MCP boundaries

### GitLab

Use GitLab as the live repository system of record. Required read capabilities include repository files, branches, commits, tags, merge requests, pipelines, jobs, and permitted artifacts.

Write capabilities are exposed only through the Landing Zone IaC facade and only in `Propose change` mode:

- create a branch from a verified base SHA;
- create or update allowed files;
- open or amend a merge request;
- read pipeline and plan results.

The facade enforces a repository allowlist and prevents writes to the default branch.

### Terraform

Use the official Terraform MCP for provider and module contracts. Terraform operations remain disabled. Repository CI produces authoritative plans.

Local read-only checks may run in an isolated workspace only when the repository toolchain and credentials permit. They must use `terraform init -backend=false`; they cannot contact production state.

### AWS documentation

Use the AWS Documentation MCP for official service behaviour, Well-Architected guidance, and Prescriptive Guidance. Retrieved guidance must include source URL and retrieval date.

### AWS estate

Use a separate read-only AWS identity for observed account, network, and DNS evidence. Required permissions are individually allowlisted. The agent receives no mutation permissions.

## LangGraph workflow

### Read-only flow

```text
START
  -> bootstrap
  -> classifyRequest
  -> resolveScope
  -> selectPvhKnowledge
  -> parallel evidence fan-out
       |-- recallMemory
       |-- queryKnowledgeGraph
       |-- gatherGitLabEvidence
       |-- gatherTerraformEvidence
       |-- gatherAwsGuidance
       `-- gatherAwsState, when relevant and authorised
  -> reconcileEvidence
  -> assessRisk
  -> answerQuestion
  -> teardown
  -> END
```

### Proposed-change flow

```text
... -> reconcileEvidence
    -> assessRisk
    -> draftChange
    -> validateCandidate
    -> prepareReview
    -> reviewGate
         |-- reject -> recordOutcome -> teardown
         |-- amend  -> draftChange
         `-- approve -> openMergeRequest
                          -> watchPipeline
                          -> recordOutcome
                          -> teardown
```

The graph must fail closed when scope, repository, branch, module contract, backend contract, or destructive impact is uncertain.

## Safety and governance

- Read operations and write operations use different tool capabilities and credentials.
- GitLab content, issue text, source comments, and external documentation are untrusted evidence and cannot override system policy.
- Repository writes require an exact allowed project, base branch, and base SHA.
- The agent cannot push to `main`, merge, approve, tag, release, apply, or mutate AWS.
- Human review is mandatory before branch or MR creation.
- A second human-controlled merge and deployment gate remains outside the agent.
- Plans are reviewed for replacement, deletion, IAM expansion, public exposure, encryption changes, backend changes, and address changes.
- Secrets and sensitive values are redacted before tracing, memory, graph storage, or UI output.
- Every material claim records provenance and freshness.

## Frontend requirements

### P0

- Register `landing-zone-terraform` in the shared agent ID vocabulary and server graph registry.
- Include it in the header icon’s mode rotation.
- Display its title and subtitle from shared client-safe metadata.
- Set `hasTriageGraph: true` and render the existing Graph Triage pane.
- Add user-facing labels for every graph node.
- Add a Landing Zone mode banner explaining read-only or GitOps behaviour.
- Add Landing Zone empty-state examples for account creation, network mapping, GitLab projects, runners, standards comparison, and repository review.
- Preserve accessibility: keyboard activation, focus states, ARIA labels, minimum touch target, and reduced-motion behaviour inherited from existing controls.
- Maintain the existing responsive split-pane behaviour.

### P1

- Add structured evidence and standards-comparison cards.
- Add a Terraform plan review card and Landing Zone-specific human-review action.
- Add account network and DNS topology cards.
- Add source links from topology elements to GitLab definitions and AWS identifiers.

## Functional requirements and acceptance criteria

### FR-1: PVH-grounded learning

Given a user asks how to create a Landing Zone account, when the agent answers, then it identifies the account-vending repository and generator workflow, cites multiple current examples, checks open work where available, and does not lead with a standalone `aws_organizations_account` resource.

### FR-2: Standards reconciliation

Given PVH behaviour differs from generic AWS or Terraform guidance, when the agent explains the subject, then it identifies the difference and labels it as aligned, exception, drift, unresolved, or unverified without silently rewriting PVH policy.

### FR-3: Agent switching

Given the deployment exposes the Landing Zone agent, when the user repeatedly presses the existing agent icon, then the control cycles through all three top-level modes in registry order and starts a fresh conversation on each switch.

### FR-4: Live triage

Given a Landing Zone turn is running, when a graph node starts or completes, then the corresponding node in the existing Graph Triage pane changes state using events from the compiled graph.

### FR-5: Memory recall

Given a prior reviewed change or durable decision exists, when a related question is asked in a later session, then the agent retrieves relevant memory, identifies it as prior experience, and validates current facts against live sources.

### FR-6: Change history

Given GitLab contains historical changes, when the user asks what changed in a repository or account, then the agent returns MR, pipeline, target, and outcome relationships from the graph with source links. It does not equate merge with apply.

### FR-7: Account network map

Given Terraform and permitted AWS evidence are available, when the user asks for an account network map, then the response includes VPCs, subnets, availability zones, route-table associations, route targets, and central-network attachments with reconciliation status.

### FR-8: DNS map

Given Route 53 and Resolver evidence are available, when the user asks how a hostname resolves, then the response separates DNS resolution from IP routing and shows hosted-zone associations, resolver forwarding, the resolved target, and the subsequent network path where known.

### FR-9: Safe proposal

Given write mode is enabled and the user requests a supported change, when the agent prepares it, then no repository write occurs until the review gate is approved, and the resulting change is placed on a branch with an MR and CI plan rather than applied.

### FR-10: Source outage

Given GitLab, AWS, Agent Memory, or the knowledge graph is unavailable, when the agent responds, then it continues only with remaining evidence, labels the unavailable layer, reduces confidence, and blocks a change if the missing source is required for safety.

## Non-functional requirements

### Security

- Least-privilege OAuth and IAM scopes.
- No static AWS credentials.
- Read and write tool separation.
- Repository allowlist.
- Input and output validation with Zod.
- Prompt-injection resistance for repository and documentation content.
- Secret and PII redaction before persistence.

### Reliability

- Memory and knowledge-graph enrichment soft-fail for learning questions.
- Missing authoritative evidence hard-fails change proposals.
- Idempotent historical import and incremental writes.
- Stable IDs for repositories, Terraform addresses, AWS resources, MRs, pipelines, and changes.
- Temporal invalidation instead of deleting previously observed topology.

### Observability

- LangSmith trace for every turn.
- Node timing and outcome events in the existing live triage stream.
- Tool-call audit logs without secret payloads.
- Metrics for source availability, evidence freshness, blocked changes, memory recall, graph coverage, and answer validation.

### Performance

- Parallelize independent evidence collection.
- Select knowledge by intent and repository.
- Cache immutable Git objects by commit SHA.
- Avoid loading complete repositories or the whole OKF corpus into model context.
- Target first visible triage progress within two seconds and read-only answers within the existing graph timeout.

## Success metrics

### Leading indicators

- At least 95% of Landing Zone factual answers include a live or curated source citation.
- At least 90% of benchmark account-vending questions select the correct repository workflow.
- Zero benchmark answers recommend bypassing a verified generator with direct root resources.
- 100% of proposed changes pass through the human review interrupt.
- 100% of topology elements returned by the graph include provenance and freshness.
- Live triage topology and emitted node IDs have automated parity coverage.

### Lagging indicators

- Reduce time to identify the correct repository and workflow for common Landing Zone work by 50%.
- Reduce review comments caused by incorrect module contracts, repository archetypes, or stale examples by 40%.
- No agent-caused direct applies, default-branch writes, state mutations, or AWS mutations.

## Delivery phases

### Phase 1: Read-only agent and user experience

- Agent bundle and curated knowledge migration.
- Third mode in existing icon rotation.
- Dedicated read-only LangGraph.
- Existing live graph triage integration.
- GitLab, Terraform documentation, and AWS documentation evidence.
- Evidence reconciliation and cited answers.

### Phase 2: Memory and change history

- Independent Agent Memory identity and lifecycle.
- Landing Zone knowledge-graph schema.
- Historical GitLab import and scheduled reconciliation.
- Prior-change and prior-decision retrieval.

### Phase 3: Account network and DNS mapping

- Desired-state extraction from Terraform and configuration.
- Read-only AWS topology observation.
- VPC, subnet, routing, central-network, Route 53, and Resolver graph.
- Text/Mermaid topology projections, followed by interactive cards.

### Phase 4: Governed GitOps proposals

- Repository allowlisted write facade.
- Candidate diff generation and validation.
- Human plan-review interrupt.
- Branch and MR creation.
- CI plan observation and outcome recording.

### Phase 5: Governed learning and optimization

- Human-reviewed knowledge promotion.
- Drift and stale-knowledge reporting.
- Evaluation datasets and continuous regression gates.
- Optional interactive blast-radius and path analysis.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Stale curated knowledge | Incorrect guidance | Lifecycle metadata, live validation, stale labels |
| GitLab prompt injection | Policy bypass | Treat content as data, fixed system policy, tool allowlists |
| Graph incompleteness | False “never happened” claims | Label coverage and treat empty as “not recorded” |
| Merge mistaken for apply | Incorrect outcome | Require deployment or live-state evidence |
| Sensitive Terraform data persisted | Security incident | Redaction, field allowlists, no state ingestion |
| Huge topology graph | Slow/noisy diagrams | Account/service filters and phased entity model |
| Generic AWS guidance conflicts with PVH | Unsafe migration | Authority hierarchy and explicit conflict output |
| Write capability expands prematurely | Production risk | Read-only first release and separate approval for Phase 4 |

## Open decisions

1. Which GitLab project will own the implementation and Linear epic?
2. Which PVH team owns approval of promoted Landing Zone knowledge?
3. Which AWS read-only roles and accounts may the agent query initially?
4. Should the initial network view cover only vended workload accounts or also central networking accounts?
5. Which pipeline artifact is the canonical machine-readable Terraform plan contract across repository archetypes?
6. What retention period applies to Landing Zone Agent Memory facts and verbatim prompts?
7. Which historical GitLab time window is required for the initial import?

## Release gate

Phase 1 cannot be considered complete until:

- the agent appears in the existing mode rotation;
- the compiled graph is visible in live triage;
- account-vending evaluation examples return the PVH workflow;
- source precedence and evidence labels are demonstrated;
- missing live sources are surfaced accurately;
- Agent Memory, graph, and GitLab unavailability do not cause fabricated claims;
- no write-capable tool is registered for the read-only release;
- typecheck, lint, unit tests, agent-load tests, graph topology tests, web tests, and evaluation fixtures pass.
